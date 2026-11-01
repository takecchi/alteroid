import { randomUUID } from 'node:crypto';
import { DAEMON_RUNNER_REGISTRY_SOURCE } from './daemon-self-notice.js';
import { noteDroppedRecord } from './dropped-record.js';
import { EXCHANGE_KIND_THINNING_PREFIX } from './exchange-kind.js';
import type { ManagerRecord } from './manager.js';
import {
  QUOTA_SESSION_WINDOW_KEY,
  QUOTA_STOP_MANAGER_IDS_KEY,
  allSessionWindow,
  renderQuotaStopNotice,
  type QuotaStopEntry,
} from './quota-stop-notice.js';
import type { InboxEvent, Job } from './schema.js';
import type { QuotaStopWindow, SynthesizedNoticeWindow } from './synthesized-notice.js';

export interface QuotaStopWindowsDeps {
  records: ReadonlyMap<string, ManagerRecord>;
  /** `Pool#journalExchange` を束ねたもの（呼び出しの形は `exchange-kind-coverage.test.ts` が数える）。 */
  journalExchange: (role: 'inbound' | 'outbound', text: string) => Promise<void>;
  post: (event: InboxEvent) => void;
  listJobsOrNote: (skipped: string) => Promise<Job[] | null>;
  /** 窓へ移した「畳んでいた報告」の在庫（`Pool#withheldCarriedToWindow`）。`join` が読んで外す。 */
  withheldCarriedToWindow: Map<string, NonNullable<Job['withheldReports']>>;
  now: () => number;
  nowIso: () => string;
  /** 固定窓の長さ。 */
  windowMs: number;
}

/**
 * 枠だけの束をプール全体で1通にまとめる窓（{@link QuotaStopWindow}）。
 * 窓を Map から外した後の flush の集合（`stop()` が待つ）もここが持つ: 使うのは枠の窓と `RestoredWindows`（口 `trackFlush` で渡す）だけで、
 * 合成した知らせの個別の窓は使わない。
 */
export class QuotaStopWindows {
  /**
   * 枠だけの束の、プール全体の窓。**トークンごとに1本**（鍵は `QuotaMark.tokenKey`、分からない担当は1つの「不明」の鍵）:
   * 別のトークンの枠は別の出来事なので同じ窓へまとめない。開いていない鍵は無い。
   */
  readonly #windows = new Map<string, QuotaStopWindow>();
  /**
   * 窓を Map から外した後、配り終えるまでの flush。`stop()` はこれも待つ: 窓は読む前に外すので、タイマーが閉じて台帳を読んでいる最中に
   * `stop()` が来ると Map は空で、待つものが無いまま止まり、一覧が配られない。
   */
  readonly #flushesInFlight = new Set<Promise<void>>();
  readonly #records: QuotaStopWindowsDeps['records'];
  readonly #journalExchange: QuotaStopWindowsDeps['journalExchange'];
  readonly #post: QuotaStopWindowsDeps['post'];
  readonly #listJobsOrNote: QuotaStopWindowsDeps['listJobsOrNote'];
  readonly #withheldCarriedToWindow: QuotaStopWindowsDeps['withheldCarriedToWindow'];
  readonly #now: QuotaStopWindowsDeps['now'];
  readonly #nowIso: QuotaStopWindowsDeps['nowIso'];
  readonly #windowMs: number;

  constructor(deps: QuotaStopWindowsDeps) {
    this.#records = deps.records;
    this.#journalExchange = deps.journalExchange;
    this.#post = deps.post;
    this.#listJobsOrNote = deps.listJobsOrNote;
    this.#withheldCarriedToWindow = deps.withheldCarriedToWindow;
    this.#now = deps.now;
    this.#nowIso = deps.nowIso;
    this.#windowMs = deps.windowMs;
  }

  isOpen(windowKey: string): boolean {
    return this.#windows.has(windowKey);
  }

  /** 窓が開いていて、窓を開けた担当とは別の担当か。 */
  isOpenedByOther(windowKey: string, managerId: string): boolean {
    const open = this.#windows.get(windowKey);
    return open !== undefined && open.openerId !== managerId;
  }

  // 担当ごとの窓が閉じた枠だけの束を、プール全体の窓へ入れる。日誌は担当ごとに残す（受信箱へはここからは行かない旨を書く）。
  join(
    windowKey: string,
    managerId: string,
    entry: SynthesizedNoticeWindow,
    breakdown: string,
    arrived: number,
  ): void {
    void this.#journalExchange(
      'inbound',
      `${EXCHANGE_KIND_THINNING_PREFIX}[${managerId}] 機構が合成した知らせを ${String(arrived)} 件、` +
        `1件にまとめた（内訳: ${breakdown}）。枠だけが理由の知らせなので、この担当だけの知らせとしては受信箱へ行かず、` +
        'プール全体の1通（「枠に当たって N 本の担当が止まった」）へ回した。',
    );
    this.#add(windowKey, managerId, entry, arrived);
    // 窓へ移した在庫は、ここで一覧の行へ運んだものとして外す（担当ごとの `#deliver` は通らないので、残すと失われる）。
    const carried = this.#withheldCarriedToWindow.get(managerId);
    if (carried === undefined) return;
    this.#withheldCarriedToWindow.delete(managerId);
    const joined = this.#windows.get(windowKey)?.entries.get(managerId);
    if (joined !== undefined && carried.count > 0) {
      joined.withheld = {
        count: carried.count,
        lastExcerpt: carried.excerpts.at(-1)?.line ?? '',
      };
    }
  }

  // この鍵の窓が無ければ、この担当を「窓を開けた担当」として開く。窓を開けた担当の束は担当ごとに配るので、ここは一覧の材料を覚えるだけ。
  // 窓を開けた担当は、受信箱へ先に届けた（枠の1通の行に「最初の1本」と添える）。
  noteOpener(
    windowKey: string,
    managerId: string,
    entry: SynthesizedNoticeWindow,
    arrived: number,
  ): void {
    if (!this.#windows.has(windowKey)) {
      const timer = setTimeout(() => {
        void this.#flushOne(windowKey);
      }, this.#windowMs);
      timer.unref?.();
      this.#windows.set(windowKey, {
        timer,
        openedAt: this.#now(),
        openerId: managerId,
        entries: new Map(),
      });
    }
    this.#add(windowKey, managerId, entry, arrived);
  }

  #add(
    windowKey: string,
    managerId: string,
    entry: SynthesizedNoticeWindow,
    arrived: number,
  ): void {
    const window = this.#windows.get(windowKey);
    if (window === undefined) return;
    const joined = window.entries.get(managerId);
    if (joined === undefined) {
      window.entries.set(managerId, { fragments: [...entry.fragments], arrived });
    } else {
      joined.fragments.push(...entry.fragments);
      joined.arrived += arrived;
    }
  }

  // 窓が閉じたら1通にして配る。`#emit()` の「先に全部 flush」には含めない: 固定窓を、無関係な担当の報告のたびに閉じないため（`stop()` では閉じる）。
  // 担当に紐づかないので `manager_message` ではなく、`scratch_sweep` と同じ `external`（デーモン自身の合図）で積む。
  // `identity` に窓の開いた時刻を入れる: 受信箱の畳み込みが同じ本文の別の出来事（次の枠落ち）を同じものと読まないため。
  // 状態は配る時点の台帳から読む。畳まれた委譲は `#retire()` で像が消えるので、像に無いものだけジョブ台帳から読む（読めなければ「不明」と言う。既定値は作らない）。
  // 窓は読む前に外す: 読んでいる間に来た束が、配り終えた窓へ紛れ込まない。`stop()` はこれを待つ。
  async flushAll(): Promise<void> {
    for (const windowKey of [...this.#windows.keys()]) {
      await this.#flushOne(windowKey);
    }
  }

  /** `stop()` が最後に待つ: Map から外した窓の flush が配り終えるまで。 */
  async settleInFlight(): Promise<void> {
    await Promise.allSettled([...this.#flushesInFlight]);
  }

  #flushOne(windowKey: string): Promise<void> {
    const window = this.#windows.get(windowKey);
    if (window === undefined) return Promise.resolve();
    this.#windows.delete(windowKey);
    clearTimeout(window.timer);
    return this.trackFlush(this.#deliver(windowKey, window));
  }

  // Map から外した窓を `#flushesInFlight` に載せる。`stop()` が待つのはこの集合である。
  trackFlush(flush: Promise<void>): Promise<void> {
    this.#flushesInFlight.add(flush);
    void flush.finally(() => this.#flushesInFlight.delete(flush)).catch(() => undefined);
    return flush;
  }

  async #deliver(windowKey: string, window: QuotaStopWindow): Promise<void> {
    // 貯めた担当（窓を開けた担当以外）が居なければ何も配らない: 担当1本だけの回は今までと完全に同じ。
    if ([...window.entries.keys()].every((id) => id === window.openerId)) return;
    const missing = [...window.entries.keys()].filter((id) => !this.#records.has(id));
    const ledger =
      missing.length === 0
        ? []
        : ((await this.#listJobsOrNote('枠の1通に載せる担当の状態を「不明」として配る')) ?? []);
    const entries: QuotaStopEntry[] = [...window.entries].map(([managerId, joined]) => ({
      managerId,
      ...(managerId === window.openerId ? { first: true as const } : {}),
      ...(joined.withheld === undefined ? {} : { withheld: joined.withheld }),
      status:
        this.#records.get(managerId)?.job.status ??
        ledger.find((job) => job.id === managerId)?.status,
      fragments: joined.fragments.flatMap((fragment) =>
        fragment.quota === undefined ? [] : [{ label: fragment.label, quota: fragment.quota }],
      ),
    }));
    const arrived = [...window.entries.values()].reduce((sum, joined) => sum + joined.arrived, 0);
    const { text, resetGroups } = renderQuotaStopNotice(entries);
    const openedAt = new Date(window.openedAt).toISOString();
    try {
      this.#post({
        type: 'external',
        id: randomUUID(),
        at: this.#nowIso(),
        // `runner-registry` を流用する: 専用の source は予約語の一覧・入口の拒否・OpenAPI の説明を一緒に直す別の変更が要るため（`scratch_sweep` と同じ形で積む）。
        source: DAEMON_RUNNER_REGISTRY_SOURCE,
        identity: `quota-stop:${windowKey}:${openedAt}`,
        // 担当の id を本文とは別に載せる: クローンが配る直前に回復を添えるとき、表示用の本文から読み直さないため（#4497）
        payload: {
          text,
          [QUOTA_STOP_MANAGER_IDS_KEY]: entries.map((e) => e.managerId),
          // 全員が5時間枠の印を持つときだけ載せる: 1本でも週の上限などが混ざれば、クローンは畳まずに届ける（#4499）
          ...(entries.every((e) => allSessionWindow(e.fragments))
            ? { [QUOTA_SESSION_WINDOW_KEY]: true }
            : {}),
        },
      });
    } catch (error) {
      noteDroppedRecord('受信箱', `quota_stop managers=${String(entries.length)}`, error);
    }
    void this.#journalExchange(
      'inbound',
      `${EXCHANGE_KIND_THINNING_PREFIX}[プール全体] 枠に当たった ${String(entries.length)} 本の担当の知らせ ` +
        `${String(arrived)} 件を、1件にまとめて配った（内訳: ${entries.map((e) => e.managerId).join('、')}。` +
        `リセット時刻 ${String(resetGroups)} 通り、窓の開始 ${openedAt}）。`,
    );
  }
}
