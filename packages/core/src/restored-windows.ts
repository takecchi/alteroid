import { randomUUID } from 'node:crypto';
import { DAEMON_RUNNER_REGISTRY_SOURCE } from './daemon-self-notice.js';
import { noteDroppedRecord } from './dropped-record.js';
import { NOTIFY_REPORT_EXCERPT, excerptLine } from './excerpt.js';
import { EXCHANGE_KIND_RECOVERY_PREFIX, EXCHANGE_KIND_THINNING_PREFIX } from './exchange-kind.js';
import type { ManagerRecord } from './manager.js';
import {
  cloneWorkspaceAfterSwapLine,
  workspaceAfterSwap,
  type RestartCause,
} from './manager-notices.js';
import {
  renderRestoredNotice,
  resumeConfirmationGuidance,
  RESUMED_WITHOUT_LOG_CLAUSE,
  type RestoredEntry,
  type RestoredListItem,
} from './restored-notice.js';
import {
  endsResumeConfirmation,
  RESUME_EVIDENCE_DESCRIPTION,
  resumeConfirmMinutes,
  resumeEvidenceOf,
  type ResumeConfirmationState,
} from './resume-confirmation.js';
import type { RunnerEvent } from './runner-protocol.js';
import type { InboxEvent, Job, TextMarkup } from './schema.js';
import type { FoldWhenBack, RestoredWindow, SynthesizedNoticeLabel } from './synthesized-notice.js';

interface ResumeConfirmation {
  state: ResumeConfirmationState;
  /** resume を出した先。印はこの器から届いたものだけ数える（移送の前の器から遅れて届いた出来事で確定しないため）。 */
  runnerId: string;
  requestedAt: number;
  /** `RestoredWindows#notify` が知らせた回。期限を数え、確定を日誌に残すのはこの回だけ。 */
  restored: boolean;
  timer?: ReturnType<typeof setTimeout>;
}

export interface RestoredWindowsDeps {
  records: ReadonlyMap<string, ManagerRecord>;
  /** `Pool#journalExchange` を束ねたもの（呼び出しの形は `exchange-kind-coverage.test.ts` が数える）。 */
  journalExchange: (role: 'inbound' | 'outbound', text: string) => Promise<void>;
  post: (event: InboxEvent) => void;
  postReport: (
    managerId: string,
    text: string,
    extra?: { markup?: TextMarkup; foldWhenBack?: FoldWhenBack },
  ) => void;
  queueNotice: (managerId: string, label: SynthesizedNoticeLabel, text: string) => void;
  notifyExcerptLines: (job: Job) => string[];
  listJobsOrNote: (skipped: string) => Promise<Job[] | null>;
  /** Map から外した窓の flush を `QuotaStopWindows#trackFlush`（枠の窓と共有。`stop()` が待つ）へ載せる。 */
  trackFlush: (flush: Promise<void>) => Promise<void>;
  now: () => number;
  nowIso: () => string;
  stopped: () => boolean;
  /** 窓の長さ。枠の窓（`QuotaStopWindows`）と同じ値を共有する。 */
  windowMs: number;
  /** resume が戻れたかの確定を待つ時間。 */
  confirmTimeoutMs: number;
}

/**
 * 「取り戻した」知らせ（`notify`）の窓と、resume が前の会話へ戻れたかの確認（#4501）。
 * 共有の欄（flush の集合）は `QuotaStopWindows` が持ち、口（`trackFlush`）で渡す。
 */
export class RestoredWindows {
  /**
   * 「取り戻した」知らせの窓。**cause ごとに1本**（器が何台続けて作り直されても同じ出来事）。
   * 窓の長さは枠の窓と同じ値を共有する。
   */
  readonly #windows = new Map<RestartCause, RestoredWindow>();
  /**
   * resume が前の会話へ戻れたかの確定（#4501）。`Pool#resume` が runner へ出す直前に `pending` で立て、新しいセッションから最初の印
   * （`resumeEvidenceOf`）が届いたら `confirmed`、`resume_failed` / `closed` が届いたら外す。期限を数えるのは、器の作り直し・移送・
   * デーモンの再起動の後の再開（`notify`）の回だけである（`restored`）。**プロセス内にしか置かない**。
   */
  readonly #confirmations = new Map<string, ResumeConfirmation>();
  readonly #records: RestoredWindowsDeps['records'];
  readonly #journalExchange: RestoredWindowsDeps['journalExchange'];
  readonly #post: RestoredWindowsDeps['post'];
  readonly #postReport: RestoredWindowsDeps['postReport'];
  readonly #queueNotice: RestoredWindowsDeps['queueNotice'];
  readonly #notifyExcerptLines: RestoredWindowsDeps['notifyExcerptLines'];
  readonly #listJobsOrNote: RestoredWindowsDeps['listJobsOrNote'];
  readonly #trackFlush: RestoredWindowsDeps['trackFlush'];
  readonly #now: RestoredWindowsDeps['now'];
  readonly #nowIso: RestoredWindowsDeps['nowIso'];
  readonly #stopped: RestoredWindowsDeps['stopped'];
  readonly #windowMs: number;
  readonly #confirmTimeoutMs: number;

  constructor(deps: RestoredWindowsDeps) {
    this.#records = deps.records;
    this.#journalExchange = deps.journalExchange;
    this.#post = deps.post;
    this.#postReport = deps.postReport;
    this.#queueNotice = deps.queueNotice;
    this.#notifyExcerptLines = deps.notifyExcerptLines;
    this.#listJobsOrNote = deps.listJobsOrNote;
    this.#trackFlush = deps.trackFlush;
    this.#now = deps.now;
    this.#nowIso = deps.nowIso;
    this.#stopped = deps.stopped;
    this.#windowMs = deps.windowMs;
    this.#confirmTimeoutMs = deps.confirmTimeoutMs;
  }

  notify(record: ManagerRecord, how: 'attached' | 'resumed', cause: RestartCause = 'daemon'): void {
    const { job } = record;
    const head =
      cause === 'runner'
        ? 'runner の器が作り直された'
        : cause === 'relocated'
          ? '走らせていた runner が黙ったので、別の器で開き直した'
          : 'デーモンが再起動した';
    // デーモンの再起動は除く: 器はそのままなので、器の中に残った会話から戻れうる。
    const withoutLog = how === 'resumed' && cause !== 'daemon' && record.resumedWithoutLog === true;
    // 知らせる前に期限を数え始める。知らせる時点で既に印が届いていれば、確定として書く。
    const confirmed = how === 'resumed' && this.#arm(job.id) === 'confirmed';
    // 日誌は呼び出し元に委ねない: `attached` の呼び出し元は書かず、`resumed` 側が書くのは別の事実（再開の指示）で、この知らせ自体の跡ではない。
    void this.#journalExchange(
      'outbound',
      `${EXCHANGE_KIND_RECOVERY_PREFIX}${
        how === 'attached'
          ? `[${job.id}] （走行中を確認）${head}。runner の中で走り続けている。`
          : confirmed
            ? `[${job.id}] （再開を知らせた）${head}。前のセッションから再開した（新しいセッションから最初の印が届き、戻れたことを確かめた）。`
            : `[${job.id}] （再開の指示を知らせた）${head}。前のセッションからの再開を指示した（受理まで。会話が戻ったかは確定待ち）。` +
              (withoutLog ? ` ${RESUMED_WITHOUT_LOG_CLAUSE}` : '')
      }`,
    );
    // 「1本目はすぐ・同じ出来事の残りは1通」（枠の窓 `QuotaStopWindow` と同じ考え方）。鍵は cause: 器が何台続けて作り直されても同じ出来事。
    // 窓が開いていて別の担当なら、担当ごとには配らず窓へ貯める（日誌の上の行は担当ごとに書いた）。窓が無ければ今までどおり配って窓を開ける。
    const entry: RestoredEntry = {
      managerId: job.id,
      runnerId: job.runnerId,
      how,
      withoutLog,
      cwd: job.cwd,
      excerpt:
        job.lastReport === undefined
          ? undefined
          : excerptLine(job.lastReport, NOTIFY_REPORT_EXCERPT),
      workspaceLine:
        cause !== 'daemon'
          ? cloneWorkspaceAfterSwapLine(
              workspaceAfterSwap(job.workspace, job.lastUnpushedWorkObservation, job.lastRescue),
            )
          : '',
    };
    const open = cause === 'daemon' ? undefined : this.#windows.get(cause);
    if (open !== undefined && open.openerId !== job.id) {
      open.entries.set(job.id, entry);
      void this.#journalExchange(
        'outbound',
        `${EXCHANGE_KIND_THINNING_PREFIX}[${job.id}] ${head}の知らせは、この担当だけの知らせとしては受信箱へ行かず、` +
          '同じ出来事の1通（「N 本の委譲に当たった」）へ回した。',
      );
      return;
    }
    if (cause === 'daemon') {
      // デーモンの再起動（`restore()` の引き取り）はまとめない: 束ねると決めたのは器の作り直しの後の知らせだけで、引き取りの知らせは担当ごとに1通ずつ届く前提の作りが残っているため。
    } else if (open === undefined) {
      const timer = setTimeout(() => {
        void this.#flush(cause);
      }, this.#windowMs);
      timer.unref?.();
      this.#windows.set(cause, {
        timer,
        openedAt: this.#now(),
        openerId: job.id,
        head,
        entries: new Map([[job.id, entry]]),
      });
    } else {
      open.entries.set(job.id, entry);
    }
    this.#postReport(
      job.id,
      [
        how === 'attached'
          ? `${head}。この委譲は runner の中で走り続けている。`
          : confirmed
            ? `${head}。中断されていたこの委譲を、前のセッションから再開した（新しいセッションから最初の印が届き、戻れたことを確かめた）。`
            : // 「再開させた」と言い切らない: runner の受理は「戻れた」ではなく、前の会話が無ければ後から lost になる（#4501）。
              `${head}。中断されていたこの委譲に、前のセッションからの再開を指示した（runner は受け付けた。前の会話が戻ったかは確定待ち）。`,
        withoutLog && !confirmed ? `⚠ ${RESUMED_WITHOUT_LOG_CLAUSE}` : '',
        `作業ディレクトリ: ${job.cwd ?? '(不明)'}`,
        ...this.#notifyExcerptLines(job),
        '',
        how === 'attached'
          ? '返事待ちがあれば改めて届く。`manager_send` で追加の指示も送れる。'
          : // 「戻せなかった」の語を使わない: 失敗の知らせを見分ける語なので、受理の知らせに混ぜると読み手と試験の両方が取り違える。
            (confirmed ? '' : resumeConfirmationGuidance(this.#confirmTimeoutMs)) +
            '返事待ちだった確認は器と一緒に失われているので、必要ならマネージャーが聞き直してくる。',
        // 判定は `workspaceAfterSwap` に委ねる（`restartNudge` と同じ判定を二重に書かない）。
        // path は出さない: 直前の行で作業ディレクトリを出しており、重ねると読む側が2つの値を突き合わせることになる。
        cause !== 'daemon'
          ? cloneWorkspaceAfterSwapLine(
              workspaceAfterSwap(job.workspace, job.lastUnpushedWorkObservation, job.lastRescue),
            )
          : '',
      ]
        .filter((line) => line !== '')
        .join('\n'),
      // デーモン再起動の引き取り直し（`attached`）だけに付ける: 担当の状態が変わった印（移送・器の作り直し・resume）は畳まない。
      // 日誌には上で全文を書いてあり、畳むかはクローンが配る時点の担当の状態で決める（live かつ running のときだけ）。
      how === 'attached' && cause === 'daemon' ? { foldWhenBack: { attached: true as const } } : {},
    );
  }

  begin(managerId: string, runnerId: string): void {
    this.end(managerId);
    this.#confirmations.set(managerId, {
      state: 'pending',
      runnerId,
      requestedAt: this.#now(),
      restored: false,
    });
  }

  end(managerId: string): void {
    const entry = this.#confirmations.get(managerId);
    if (entry?.timer !== undefined) clearTimeout(entry.timer);
    this.#confirmations.delete(managerId);
  }

  /** `Pool#stop` 用: 張ってあるタイマーを全部解いて、確認の欄を空にする。 */
  clearConfirmations(): void {
    for (const entry of this.#confirmations.values()) {
      if (entry.timer !== undefined) clearTimeout(entry.timer);
    }
    this.#confirmations.clear();
  }

  /**
   * `notify` の回だけ期限を数える: ふつうの `manager_send` の resume は、確定待ちを知らせていないので、期限の知らせも要らない。
   * 追っていなければ（`Pool#resume` を通らない経路）、いまから追う。宛先は台帳の `runnerId`。
   */
  #arm(managerId: string): ResumeConfirmationState {
    let entry = this.#confirmations.get(managerId);
    if (entry === undefined) {
      const runnerId = this.#records.get(managerId)?.job.runnerId;
      if (runnerId === undefined) return 'pending';
      entry = { state: 'pending', runnerId, requestedAt: this.#now(), restored: false };
      this.#confirmations.set(managerId, entry);
    }
    entry.restored = true;
    if (entry.state === 'pending' && entry.timer === undefined) {
      const armed = entry;
      const timer = setTimeout(() => {
        void this.#onTimeout(managerId, armed);
      }, this.#confirmTimeoutMs);
      timer.unref?.();
      entry.timer = timer;
    }
    return entry.state;
  }

  observe(record: ManagerRecord, event: RunnerEvent, fromRunnerId: string): void {
    const managerId = record.job.id;
    const entry = this.#confirmations.get(managerId);
    if (entry === undefined) return;
    // 打ち切る出来事は、宛先を問わず畳む: この後はそれぞれの経路（lost・引き継ぎ・終了）が自分で知らせる。
    if (endsResumeConfirmation(event)) {
      if (fromRunnerId === entry.runnerId) this.end(managerId);
      return;
    }
    if (entry.state === 'confirmed' || fromRunnerId !== entry.runnerId) return;
    const via = resumeEvidenceOf(event);
    if (via === undefined) return;
    const wasUnconfirmed = entry.state === 'unconfirmed';
    if (entry.timer !== undefined) clearTimeout(entry.timer);
    entry.timer = undefined;
    entry.state = 'confirmed';
    if (!entry.restored) return;
    const seconds = Math.max(0, Math.round((this.#now() - entry.requestedAt) / 1000));
    void this.#journalExchange(
      'inbound',
      `${EXCHANGE_KIND_RECOVERY_PREFIX}[${managerId}] （戻れたことを確かめた）前のセッションからの再開が効いた: ` +
        `新しいセッションから最初の印（${via}）が、resume を出してから ${String(seconds)} 秒で届いた。` +
        (wasUnconfirmed ? '期限の後に届いた（期限の知らせは先に出してある）。' : ''),
    );
  }

  /**
   * 期限までに印が1つも届かなかった。**止めない・lost とも決めない**（長く考えているだけのこともある）。日誌に残し、担当ごとに1通知らせる。
   * 知らせは合流窓（`Pool#queueSynthesizedNotice`）を通す: 同じ出来事の `resume_failed` などと「一枠落ち一合図」に揃えるため。
   */
  async #onTimeout(managerId: string, armed: ResumeConfirmation): Promise<void> {
    if (this.#stopped()) return;
    if (this.#confirmations.get(managerId) !== armed || armed.state !== 'pending') return;
    armed.timer = undefined;
    armed.state = 'unconfirmed';
    const job = this.#records.get(managerId)?.job;
    // 既に終端していれば、その経路が知らせている。
    if (
      job === undefined ||
      job.status === 'lost' ||
      job.status === 'failed' ||
      job.status === 'stopped'
    ) {
      return;
    }
    const minutes = resumeConfirmMinutes(this.#confirmTimeoutMs);
    await this.#journalExchange(
      'outbound',
      `${EXCHANGE_KIND_RECOVERY_PREFIX}[${managerId}] （戻れたか確かめられないまま）前のセッションからの再開を指示してから ${minutes} 分、` +
        `新しいセッションから戻れた印（${RESUME_EVIDENCE_DESCRIPTION}）が1つも届いていない。止めず、lost とも決めていない（状態 ${job.status}）。`,
    );
    // 「戻せなかった」の語を使わない: 失敗の知らせを見分ける語で、ここでは失敗を観測していない。
    this.#queueNotice(
      managerId,
      'resume_unconfirmed',
      [
        `前のセッションからの再開を指示してから ${minutes} 分たったが、新しいセッションから戻れた印（${RESUME_EVIDENCE_DESCRIPTION}）が1つも届いていない。`,
        `止めてはおらず、lost とも決めていない（いまの状態: ${job.status}）。長く考えているだけのこともある。`,
        `作業ディレクトリ: ${job.cwd ?? '(不明)'}`,
        ...this.#notifyExcerptLines(job),
        '',
        `様子を確かめるなら manager_list / manager_report managerId=${managerId}、本人に聞くなら manager_send。` +
          '印が後から届けば、日誌に「（戻れたことを確かめた）」が残る。',
      ]
        .filter((line) => line !== '')
        .join('\n'),
    );
  }

  // 窓が閉じたとき、貯めた担当（窓を開けた担当以外）が居なければ何も配らない: 委譲1本だけの回は今までと完全に同じ。
  // 状態は枠の1通と同じ読み方（`QuotaStopWindows` の `#deliver`）: 像に無いものだけジョブ台帳から読み、読めなければ「不明」と言う。
  // 窓は読む前に外す。`stop()` はこれを待つ。
  #flush(cause: RestartCause): Promise<void> {
    const window = this.#windows.get(cause);
    if (window === undefined) return Promise.resolve();
    this.#windows.delete(cause);
    clearTimeout(window.timer);
    return this.#trackFlush(this.#deliverWindow(cause, window));
  }

  async #deliverWindow(cause: RestartCause, window: RestoredWindow): Promise<void> {
    if ([...window.entries.keys()].every((id) => id === window.openerId)) return;
    const missing = [...window.entries.keys()].filter((id) => !this.#records.has(id));
    const ledger =
      missing.length === 0
        ? []
        : ((await this.#listJobsOrNote(
            '取り戻した委譲の1通に載せる担当の状態を「不明」として配る',
          )) ?? []);
    const items: RestoredListItem[] = [...window.entries.values()].map((entry) => ({
      ...entry,
      first: entry.managerId === window.openerId,
      status:
        this.#records.get(entry.managerId)?.job.status ??
        ledger.find((job) => job.id === entry.managerId)?.status,
      ...(entry.how === 'resumed'
        ? { resume: this.#confirmations.get(entry.managerId)?.state ?? 'pending' }
        : {}),
    }));
    const openedAt = new Date(window.openedAt).toISOString();
    try {
      this.#post({
        type: 'external',
        id: randomUUID(),
        at: this.#nowIso(),
        // `runner-registry` を流用する: 枠の1通と同じ理由（専用の source は予約語の一覧・入口の拒否・OpenAPI の説明を一緒に直す別の変更が要る）。
        source: DAEMON_RUNNER_REGISTRY_SOURCE,
        identity: `restored:${cause}:${openedAt}`,
        payload: {
          text: renderRestoredNotice(window.head, items, this.#confirmTimeoutMs),
        },
      });
    } catch (error) {
      noteDroppedRecord(
        '受信箱',
        `restored cause=${cause} managers=${String(items.length)}`,
        error,
      );
    }
    void this.#journalExchange(
      'outbound',
      `${EXCHANGE_KIND_THINNING_PREFIX}[プール全体] ${window.head}: ${String(items.length)} 本の委譲の知らせを、` +
        `1通にまとめて配った（内訳: ${items.map((i) => i.managerId).join('、')}。窓の開始 ${openedAt}）。`,
    );
  }

  async flushAll(): Promise<void> {
    for (const cause of [...this.#windows.keys()]) {
      await this.#flush(cause);
    }
  }
}
