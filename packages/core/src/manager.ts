import { randomUUID } from 'node:crypto';

import { withDeadline } from './deadline.js';
import type { RunnerClient, RunnerEvent } from './runner-protocol.js';
import type { RunnerHealthState, RunnerRegistry } from './runner-registry.js';
import { brief } from './runner.js';
import type { InboxEvent, Job, JobStatus, JournalEntryInput, WorkspaceLocator } from './schema.js';
import type { Stores } from './store.js';
import {
  DEFAULT_WORKSPACE_POLICY,
  describeLoss,
  isPortable,
  locatorFor,
  relocate,
  type WorkspacePolicy,
} from './workspace.js';

/**
 * 委譲のデーモン側（docs/architecture.md「配線」）。
 *
 * SDK を動かすのはここではない。**マネージャーは manager-runner の中で走り**、
 * ここがするのは「どの runner へ命じるか」「返ってきた出来事をどう記録し、
 * クローンの受信箱へどう回すか」だけである。
 *
 * 分けた理由は認証情報の配布範囲である。同じ器で走らせる限り、マネージャーは
 * `/proc/1/environ` からデーモンの環境変数＝記憶ストアの鍵に届いてしまう。
 * ツールを削って塞ぐのは禁止（north_star 禁止2）なので、実行環境を分ける。
 *
 * 記録（日誌・ジョブ台帳・アーカイブ・セッションの生ログ）は**すべてこちら側**に
 * 残る。runner は記憶へ到達する鍵を持たないので、書けるのはデーモンだけである。
 */

export { MANAGER_MODEL, WORKER_MODEL, WORKER_AGENT_NAME, WITHHELD_ENV_KEYS } from './runner.js';

export interface ManagerStartInput {
  request: string;
  /** 実プロジェクトの作業ディレクトリ。人間が Claude Code を開く場所と同じ。 */
  cwd?: string;
}

export interface ManagerSummary {
  managerId: string;
  status: JobStatus;
  /**
   * このデーモンから話しかけられるか。
   *
   * 再起動を跨いで台帳から拾い直した分も `true` になる（宛先の runner が居て、
   * session_id から resume できる）。宛先を失ったものだけが `false`。
   */
  live: boolean;
  cwd: string;
  request: string;
  startedAt: string;
  updatedAt: string;
  sessionId?: string;
  lastReport?: string;
  /** どの runner で走っているか（`manager_id → runner_id` の対応）。 */
  runnerId?: string;
  workspace?: WorkspaceLocator;
  /**
   * 返事待ちで止まっている件。
   *
   * **1本のマネージャーが同時に複数を待つことがある。** 1回のアシスタント応答で
   * 並列に呼ばれた道具は、それぞれ別の確認として同時に降りてくる。だから配列で持ち、
   * 回答は `requestId` で宛先を指定する。
   */
  waiting: { requestId: string; summary: string }[];
}

export type ManagerDecision = 'allow' | 'deny';

export interface ManagerSendResult {
  /** `answered` = 止まっていた確認を解いた。`delivered` = 追加指示として届けた。 */
  outcome: 'answered' | 'delivered' | 'unknown';
  detail: string;
}

export interface ManagerSendOptions {
  decision?: ManagerDecision;
  /** どの確認への回答か。複数を待っているときは省略できない。 */
  requestId?: string;
}

export interface ManagerMoveOptions {
  /**
   * 元の器が止まっていることを**呼び出し側が請け合う**。
   *
   * 自動の移送は「器が自分でセッションを畳んだ」と言い切れるときにしか起きない
   * （`runnerLeaseSchema`）。器が名簿ごと消えた・貸し出し期限を報告しない器だった、
   * といった場合は確かめる術が無いので、そこを引き取るための口である。
   *
   * **確かめずに立てると、同じ仕事が2か所で走る。** 器が本当に消えていることを
   * 見てから立てること（判断の根拠は日誌に残る）。
   */
  force?: boolean;
}

export interface ManagerMoveResult {
  /** 実際に別の器で開き直せた分。移せなければ null。 */
  moved: ManagerSummary | null;
  detail: string;
}

export interface ManagerAbortResult {
  outcome: 'stopped' | 'unknown';
  detail: string;
}

export interface ManagerPool {
  start(input: ManagerStartInput): Promise<ManagerSummary>;
  send(
    managerId: string,
    message: string,
    options?: ManagerSendOptions,
  ): Promise<ManagerSendResult>;
  /**
   * この仕事をやめさせる（`stop()` の全停止とは別物）。
   *
   * **人間が直接止められること自体が要件である。** 走っているマネージャーを
   * 止める手段がクローン経由しか無いと、クローンが取り込み中のときや、そもそも
   * クローンの判断が間違っているときに、人間が手を出せない層ができる。
   * 止めた事実は日誌に残る（見えない層を作らない）。
   */
  abort(managerId: string, reason?: string): Promise<ManagerAbortResult>;
  list(): Promise<ManagerSummary[]>;
  /** manager_id からセッションの生ログへ降りる（可観測性の最下段）。 */
  transcript(managerId: string): Promise<string | null>;
  /**
   * デーモン起動時に、走行中だったマネージャーを台帳と runner から拾い直す。
   * 戻り値は「中断されていて実際に resume した」分。
   */
  restore(): Promise<ManagerSummary[]>;
  /**
   * 落ちた runner に居た仕事を、別の器へ置き直す（roadmap M5 受け入れ基準4）。
   *
   * 戻り値は**実際に移せた**分。移せなかった分は戻り値に現れず、代わりに
   * クローンの受信箱へ「何が復旧不能なのか」が届く（黙って諦めない）。
   */
  rebalance(): Promise<ManagerSummary[]>;
  /**
   * 1本だけを名指しで置き直す。
   *
   * 自動の移送が「元の器が止まったと言い切れない」で止まったものを、確かめた側が
   * 引き取るための口である（`ManagerMoveOptions.force`）。
   */
  move(managerId: string, options?: ManagerMoveOptions): Promise<ManagerMoveResult>;
  stop(): Promise<void>;
}

export interface ManagerPoolOptions {
  stores: Stores;
  /** マネージャーからの出来事をクローンの受信箱へ流す。 */
  post: (event: InboxEvent) => void;
  /** runner の名簿。宛先の決定はここを通す（固定 URL を前提にしない）。 */
  runners: RunnerRegistry;
  /**
   * workspace の運用選択（M5）。既定は runner ごとの volume（M4 と同じ）。
   *
   * ここが `runner-volume` のままだと、器が落ちた仕事は別の器へ移せない
   * （移せないこと自体は正しく報告される）。
   */
  workspace?: WorkspacePolicy;
  /**
   * 器の貸し出し期限に上乗せする余裕（ミリ秒）。既定 5 秒。
   *
   * 器が「自分で畳む」と約束した時刻ちょうどに移し始めない、というだけの数である。
   * 時計のずれと畳むのにかかる時間を吸収する。
   */
  fenceMarginMs?: number;
  /** 主にテスト用。既定は `Date.now`。 */
  now?: () => number;
}

const DEFAULT_FENCE_MARGIN_MS = 5_000;
/**
 * 「元の器で畳めたか」を確かめる呼び出しの期限（ミリ秒）。
 *
 * ここが返らないことは珍しくない（移送を考えている時点で、その器は怪しい）。
 * 待ち続けると、話しかけた人間がそのまま待たされる。**確認に失敗したことを
 * 短く確定させて、期限（lease）の話へ落とす。**
 */
const STOP_CONFIRM_TIMEOUT_MS = 5_000;

export function createManagerPool(options: ManagerPoolOptions): ManagerPool {
  return new Pool(options);
}

/** デーモン側が持つ1マネージャーの像（正本は JobStore）。 */
interface ManagerRecord {
  job: Job;
  waiting: { requestId: string; summary: string }[];
  /** runner に生きたセッションがあるか。無ければ send のときに resume する。 */
  attached: boolean;
  /**
   * いま移送中なら、その約束。
   *
   * **同じ仕事を2か所で開かないための鍵である。** 移送の契機は2つ（名簿の「落ちた」
   * 通知と、話しかけられたとき）あり、重なると同じ session を別々の器で resume
   * しかける。そうなると1つの仕事に2本のマネージャーが並び、同じ workspace へ
   * 二重に書く。
   *
   * **これが守るのは同じデーモンの中だけである。** 別のプロセスで走り続けている
   * セッションはここでは止められないので、器の側の貸し出し期限（fencing lease）と
   * 組みで初めて「2か所で走らない」が成立する（`#fence` を見よ）。
   */
  moving?: Promise<ManagerSummary | null>;
  /**
   * 直近の移送で何が起きたか（人間とクローンへ返す言葉）。
   *
   * 移せなかった理由は「器が無い」だけではない。**元の器が止まったと言い切れない**
   * ために待っているのか、確かめる術が無いのかで、次にすべきことが変わる。
   */
  moveNote?: string;
  /** 「期限切れを待っている」ことを既に知らせたか（同じ通知を鳴らし続けない）。 */
  fenceNotified?: boolean;
}

/**
 * 元の器が止まったと言い切れるか（fencing の判定）。
 *
 * - `confirmed` — その器へ届いて、実際に畳ませた（いちばん強い確認）
 * - `expired` — 器が約束した貸し出し期限を過ぎた。器は自分で畳んでいる
 * - `forced` — 呼び出し側が止まっていることを請け合った
 * - `wait` — 期限まであと `ms`。**まだ移してはいけない**
 * - `unknown` — 確かめる術が無い。自動では移さず、人間かクローンの確認へ回す
 */
type Fence =
  | { kind: 'confirmed' | 'expired' | 'forced' }
  | { kind: 'wait'; ms: number }
  | { kind: 'unknown'; why: string };

class Pool implements ManagerPool {
  readonly #stores: Stores;
  readonly #post: (event: InboxEvent) => void;
  readonly #runners: RunnerRegistry;
  readonly #workspace: WorkspacePolicy;
  readonly #records = new Map<string, ManagerRecord>();
  /**
   * もう受け口を開いた runner。
   *
   * **数ではなく相手で覚える。** 名簿は増える（M5）ので「1回繋いだら済み」に
   * すると、後から加わった器の出来事が誰にも届かない。逆に同じ相手へ二重に
   * 繋ぐと、同じ確認が2回降りてくる。
   */
  readonly #connected = new WeakSet<RunnerClient>();
  readonly #fenceMarginMs: number;
  readonly #now: () => number;
  /** 期限切れを待っている移送の再試行。`stop()` で片付ける。 */
  readonly #timers = new Set<ReturnType<typeof setTimeout>>();
  /** 名簿の「落ちた」通知の購読を解く手。 */
  #unwatch: (() => void) | null = null;
  #stopped = false;

  constructor({ stores, post, runners, workspace, fenceMarginMs, now }: ManagerPoolOptions) {
    this.#stores = stores;
    this.#post = post;
    this.#runners = runners;
    this.#workspace = workspace ?? DEFAULT_WORKSPACE_POLICY;
    this.#fenceMarginMs = fenceMarginMs ?? DEFAULT_FENCE_MARGIN_MS;
    this.#now = now ?? (() => Date.now());
    // 器が落ちたら、話しかけられるのを待たずに置き直す。人間の不在で止まって
    // よいのは承認待ちの仕事だけである（PRD「自律」）。
    this.#unwatch = this.#runners.onLost(() => {
      void this.rebalance().catch(() => undefined);
    });
  }

  // -------------------------------------------------------------------------
  // 委譲
  // -------------------------------------------------------------------------

  async start(input: ManagerStartInput): Promise<ManagerSummary> {
    if (this.#stopped) throw new Error('デーモンが停止中のためマネージャーを起こせない');
    await this.#ensureConnected();

    const runner = await this.#runners.select({
      ...(input.cwd === undefined ? {} : { cwd: input.cwd }),
    });
    const managerId = `mgr-${randomUUID().slice(0, 8)}`;
    const cwd = input.cwd ?? runner.workspacePath;
    const at = new Date().toISOString();

    const record: ManagerRecord = {
      job: {
        id: managerId,
        managerId,
        createdAt: at,
        updatedAt: at,
        status: 'running',
        summary: brief({ request: input.request }),
        request: input.request,
        cwd,
        runnerId: runner.runnerId,
        // **どの起動に置いたかまで残す。** 器は同じ名前で作り直されるので、
        // 名前だけでは「いま名乗っている器が、置いた器と同じか」が分からない。
        ...(this.#incarnationOf(runner) === undefined
          ? {}
          : { runnerIncarnation: this.#incarnationOf(runner) }),
        workspace: locatorFor(this.#workspace, { runnerId: runner.runnerId, cwd }),
      },
      waiting: [],
      attached: true,
    };
    this.#records.set(managerId, record);

    // 委譲はノンブロッキング。起こして即返し、クローンは次の判断へ移る。
    try {
      await runner.start({ managerId, request: input.request, cwd });
    } catch (error) {
      // 起こせなかったものを一覧に残さない。残すと「走っている」と見えるのに、
      // 誰も読まない相手へクローンが指示を送り続けることになる。
      this.#records.delete(managerId);
      throw error;
    }

    await this.#persist(record);
    await this.#journal({
      type: 'exchange',
      with: 'manager',
      role: 'outbound',
      text: `[${managerId}] ${input.request}`,
    });
    return summaryOf(record);
  }

  /**
   * クローンからの一言。止まっている確認があればその回答として使い、無ければ
   * 追加指示として流す（architecture.md「会話に戻れる」）。
   *
   * **宛先を推測しない。** 1本のマネージャーが複数の確認を同時に待つことがあり、
   * そこで先頭に入れてしまうと、拒否のつもりの一言が別の質問の答えになる。
   */
  async send(
    managerId: string,
    message: string,
    options: ManagerSendOptions = {},
  ): Promise<ManagerSendResult> {
    await this.#ensureConnected();

    const record = this.#records.get(managerId) ?? (await this.#load(managerId));
    if (!record) {
      return { outcome: 'unknown', detail: `${managerId} というマネージャーは居ない。` };
    }

    // 宛先が落ちている / 居ないなら、まず別の器へ置き直す（M5）。ここで諦めると、
    // 器の故障がそのまま人間の待ちになる。
    const found = await this.#runnerOf(record);
    if (found === null || !found.alive || found.replaced) {
      const moved = await this.#failover(record);
      if (moved === null) {
        return {
          outcome: 'unknown',
          detail:
            `${managerId} を走らせていた runner（${record.job.runnerId ?? '不明'}）へ届かない。` +
            // 移せなかった理由はここで確定している。**「届かない」で終わらせない** —
            // 期限待ちなのか、確かめる術が無いのかで、次にすべきことが変わる。
            (record.moveNote ?? describeLoss(record.job.workspace, record.job.runnerId)),
        };
      }
      // 移送先で開き直した。この一言はその続きへ流す。
      const target = await this.#runners.get(moved.runnerId ?? '');
      if (target !== null) await target.send(managerId, message);
      await this.#journal({
        type: 'exchange',
        with: 'manager',
        role: 'outbound',
        text: `[${managerId}] ${message}`,
      });
      return { outcome: 'delivered', detail: `別の runner（${moved.runnerId}）で続きへ届けた。` };
    }
    const runner = found.runner;

    const { decision, requestId } = options;
    const pending = this.#choosePending(record, requestId);
    if (pending === 'ambiguous') {
      return {
        outcome: 'unknown',
        detail:
          `${managerId} は複数の確認を同時に待っている。requestId を指定して答えること: ` +
          record.waiting.map((item) => `${item.requestId}（${item.summary}）`).join(' / '),
      };
    }
    if (pending === 'gone') {
      return {
        outcome: 'unknown',
        detail: `${requestId ?? ''} という確認は ${managerId} で待っていない（既に解けたか、別のマネージャーのもの）。`,
      };
    }

    if (pending) {
      const answered = await runner.answer(managerId, {
        requestId: pending.requestId,
        message,
        ...(decision === undefined ? {} : { decision }),
      });
      if (!answered) {
        return {
          outcome: 'unknown',
          detail: `${pending.requestId} は runner 側で既に解けている。`,
        };
      }
      // 追記専用なので新しい行。日誌だけを追っても、誰が何と答えたかまで分かる。
      await this.#journal({
        type: 'escalation',
        question: pending.summary,
        approvalId: pending.requestId,
        managerId,
        answeredAt: new Date().toISOString(),
        answer: decision === undefined ? message : `[${decision}] ${message}`,
      });
      return { outcome: 'answered', detail: `${pending.summary} に回答した。` };
    }

    // 待機していた（＝runner にセッションが居ない）相手なら、ここで続きへ戻す。
    if (!record.attached) {
      const resumed = await this.#resume(record, runner, message);
      if (!resumed) {
        return {
          outcome: 'unknown',
          detail: `${managerId} は session_id を持っておらず、続きへ戻れない。新しく起こし直すこと。`,
        };
      }
    } else {
      await runner.send(managerId, message);
    }

    record.job.status = 'running';
    await this.#persist(record);
    await this.#journal({
      type: 'exchange',
      with: 'manager',
      role: 'outbound',
      text: `[${managerId}] ${message}`,
    });
    return { outcome: 'delivered', detail: '追加指示として届けた。' };
  }

  async list(): Promise<ManagerSummary[]> {
    await this.#ensureConnected();

    const known = new Map<string, ManagerSummary>();
    for (const record of this.#records.values()) {
      known.set(record.job.id, summaryOf(record));
    }
    // 台帳にしか無い分も見せる（宛先の runner が居ないものは live: false）。
    for (const job of await this.#stores.jobs.listJobs()) {
      if (known.has(job.id)) continue;
      known.set(job.id, summaryOf({ job, waiting: [], attached: false }, false));
    }
    return [...known.values()].sort((a, b) => b.startedAt.localeCompare(a.startedAt));
  }

  async transcript(managerId: string): Promise<string | null> {
    const job = (await this.#stores.jobs.listJobs()).find((entry) => entry.id === managerId);
    if (!job) return null;

    // 走行中なら runner のディスクの上にある。
    const record = this.#records.get(managerId);
    if (record) {
      const found = await this.#runnerOf(record);
      const live = await found?.runner.transcript(managerId).catch(() => null);
      if (live !== null && live !== undefined && live.length > 0) return live;
    }

    // 無ければ退避済みへ降りる。
    for (const id of [...(job.archiveIds ?? [])].reverse()) {
      const body = await this.#stores.archive.read(id);
      if (body !== null) return body;
    }

    // 最後の砦。runner が強制終了されても、生ログ自体は預かってある。
    return this.#fromSessionStore(job);
  }

  /**
   * 起動時に、走っていたマネージャーを拾い直す。
   *
   * 2通りある。**runner が生きていれば、そのセッションはまだ手を動かしている**
   * （デーモンの再起動でマネージャーは死なない）。この場合は繋ぎ直すだけでよい。
   * runner ごと作り直されていたら、JobStore の session_id と預かった生ログから
   * **実際に resume する** — 「話しかけられるまで止めておく」は、人間の不在で
   * 仕事が止まらないという要件（PRD「自律」）に反する。
   */
  async restore(): Promise<ManagerSummary[]> {
    if (this.#stopped) return [];
    await this.#ensureConnected();

    // runner に生きているセッションを先に拾う（繋ぎ直しの相手）。
    const alive = new Map<
      string,
      { runner: RunnerClient; state: Awaited<ReturnType<RunnerClient['list']>>[number] }
    >();
    for (const runner of await this.#runners.list()) {
      for (const state of await runner.list().catch(() => [])) {
        alive.set(state.managerId, { runner, state });
      }
    }

    const resumed: ManagerSummary[] = [];
    for (const job of await this.#stores.jobs.listJobs()) {
      if (this.#records.has(job.id)) continue;

      const living = alive.get(job.id);
      if (living) {
        // まだ走っている。状態は runner のものが正しい。
        const record: ManagerRecord = {
          job: {
            ...job,
            status: living.state.status,
            runnerId: living.runner.runnerId,
            ...(living.state.sessionId === undefined ? {} : { sessionId: living.state.sessionId }),
          },
          waiting: living.state.waiting,
          attached: true,
        };
        this.#records.set(job.id, record);
        await this.#persist(record);
        this.#notifyRestored(record, 'attached');
        resumed.push(summaryOf(record));
        continue;
      }

      if (job.sessionId === undefined) continue;

      const record: ManagerRecord = { job: { ...job }, waiting: [], attached: false };
      this.#records.set(job.id, record);

      // 手を動かしている最中に器が落ちた分だけ、実際に続きへ戻す。待機（`done`）
      // だったものは台帳に載せるだけにする（話しかけられたら resume する）。
      if (job.status !== 'running' && job.status !== 'waiting_human') continue;

      const found = await this.#runnerOf(record);
      // 宛先の器そのものが居ない / 落ちている / 同じ名前で作り直されているなら、
      // 別の器へ置き直す（M5）。デーモンだけでなく runner ごと入れ替わった構成では、
      // これが通常の経路になる。
      if (found === null || !found.alive || found.replaced) {
        const moved = await this.#failover(record);
        if (moved !== null) resumed.push(moved);
        continue;
      }

      const ok = await this.#resume(record, found.runner, restartNudge(job.status));
      if (!ok) continue;
      record.job.status = 'running';
      await this.#persist(record);
      await this.#journal({
        type: 'exchange',
        with: 'manager',
        role: 'outbound',
        text: `[${job.id}] （再起動後の再開）${restartNudge(job.status)}`,
      });
      this.#notifyRestored(record, 'resumed');
      resumed.push(summaryOf(record));
    }
    return resumed;
  }

  /**
   * 落ちた器に居た仕事を、生きている器へ置き直す（M5 受け入れ基準4）。
   *
   * 呼ばれるのは2つ。名簿が「落ちた」と言ったとき（自動）と、デーモンの起動時
   * （`restore` 経由）である。**走行中と返事待ちだけ**を動かす — 待機（`done`）は
   * 話しかけられたときに置き直せばよく、生きている仕事を掴み直す理由が無い。
   */
  async rebalance(): Promise<ManagerSummary[]> {
    if (this.#stopped) return [];
    await this.#ensureConnected();

    const states = this.#runners.states();
    const dead = new Set(states.filter((state) => !state.alive).map((state) => state.runnerId));
    const known = new Set(states.map((state) => state.runnerId));
    /** いまその宛先を名乗っている起動（同じ id が複数居るときは生きている方）。 */
    const current = new Map<string, string | undefined>();
    for (const state of states) {
      if (current.has(state.runnerId) && !state.alive) continue;
      current.set(state.runnerId, state.incarnation);
    }

    const moved: ManagerSummary[] = [];
    for (const record of [...this.#records.values()]) {
      const { runnerId, runnerIncarnation, status } = record.job;
      if (status !== 'running' && status !== 'waiting_human') continue;
      if (runnerId === undefined) continue;
      // 同じ名前で器が作り直されていたら、そこにこの仕事はもう無い。**生きて見えて
      // いても置き直しの対象である** — 話しかけられるまで放っておくと、入れ替わりで
      // 消えた仕事が誰にも気づかれずに止まったままになる（PRD「自律」）。
      const replaced =
        runnerIncarnation !== undefined &&
        current.get(runnerId) !== undefined &&
        current.get(runnerId) !== runnerIncarnation;
      // 名簿に居ない器も「もう届かない」側である（器ごと消えた構成）。
      if (!dead.has(runnerId) && known.has(runnerId) && !replaced) continue;

      const summary = await this.#failover(record).catch(() => null);
      if (summary !== null) moved.push(summary);
    }
    return moved;
  }

  /**
   * 1本だけを名指しで置き直す。
   *
   * `force` は「元の器はもう走っていない」という**確認の代わり**である。自動の
   * 移送が `unknown` で止まったもの（器ごと名簿から消えた、貸し出し期限を報告
   * しない器だった）を、確かめた側が引き取るための口なので、判断を日誌に残す。
   */
  async move(managerId: string, options: ManagerMoveOptions = {}): Promise<ManagerMoveResult> {
    await this.#ensureConnected();

    const record = this.#records.get(managerId) ?? (await this.#load(managerId));
    if (!record) {
      return { moved: null, detail: `${managerId} というマネージャーは居ない。` };
    }

    if (options.force === true) {
      await this.#journal({
        type: 'decision',
        decision:
          `${managerId} を、元の runner（${record.job.runnerId ?? '不明'}）が止まっている前提で` +
          '別の器へ移すと決めた。',
        grounds: '元の器の停止を確かめた上での移送（force）',
      });
    }

    const moved = await this.#failover(record, options.force === true);
    return {
      moved,
      detail:
        moved === null
          ? (record.moveNote ?? `${managerId} は別の器へ移せなかった。`)
          : `${managerId} を ${moved.runnerId ?? '別の器'} で開き直した。`,
    };
  }

  /**
   * この仕事をやめさせる（`stop()` の全停止とは別物）。
   *
   * 人間が直接止められること自体が要件なので、クローンを介さずに通す。
   * 止めた事実は日誌と受信箱に残る（見えない層を作らない）。
   */
  async abort(managerId: string, reason?: string): Promise<ManagerAbortResult> {
    await this.#ensureConnected();

    const record = this.#records.get(managerId) ?? (await this.#load(managerId));
    if (!record) {
      return { outcome: 'unknown', detail: `${managerId} というマネージャーは居ない。` };
    }

    const runner = await this.#runnerOf(record);
    if (!runner) {
      return {
        outcome: 'unknown',
        detail: `${managerId} を走らせていた runner（${record.job.runnerId ?? '不明'}）が居ない。`,
      };
    }

    await runner.stop(managerId);
    record.waiting = [];
    record.attached = false;
    record.job.status = 'done';
    await this.#persist(record);

    // **止めたことを日誌に残す。** 消えた理由が分からないマネージャーを作らない
    // （PRD「可観測性」）。クローンにも知らせるので、次のターンで気づける。
    const detail = reason === undefined ? '人間が停止させた。' : `人間が停止させた: ${reason}`;
    await this.#journal({
      type: 'exchange',
      with: 'manager',
      role: 'outbound',
      text: `[${managerId}] （停止）${detail}`,
    });
    this.#post({
      type: 'manager_message',
      id: randomUUID(),
      at: new Date().toISOString(),
      managerId,
      kind: 'report',
      text: `${managerId} を人間が停止させました。${reason === undefined ? '' : `理由: ${reason}`}`,
    });

    return { outcome: 'stopped', detail };
  }

  async stop(): Promise<void> {
    this.#stopped = true;
    this.#unwatch?.();
    this.#unwatch = null;
    for (const timer of this.#timers) clearTimeout(timer);
    this.#timers.clear();
    // **runner のマネージャーは止めない。** デーモンの都合で人の仕事を殺さない
    // （インプロセス runner だけは、プロセスが消えるので中で畳まれる）。
    for (const runner of await this.#runners.list().catch(() => [])) {
      await runner.close().catch(() => undefined);
    }
    this.#records.clear();
  }

  // -------------------------------------------------------------------------
  // runner との配線
  // -------------------------------------------------------------------------

  /**
   * イベントの受け口を開く。**繋ぎに行くのはデーモン側**である。
   *
   * 名簿にある全部へ繋ぐ。runner が増えても（M5）、上の層は何も変わらない —
   * 増えたぶんの口がここで開くだけである。
   */
  async #ensureConnected(): Promise<void> {
    if (this.#stopped) return;
    for (const runner of await this.#runners.list()) {
      if (this.#connected.has(runner)) continue;
      this.#connected.add(runner);
      try {
        // **どの器から降りてきたのかを覚えたまま渡す。** 移送のあと、古い器から
        // 遅れて届いた出来事で、いまの器の状態を壊さないため。
        await runner.connect((event) => void this.#onEvent(event, runner));
      } catch {
        // 繋げない器は生存判定が拾う。ここで残りの器を諦めない（M5 では
        // 1台の不在が全体を止めてはいけない）。
        this.#connected.delete(runner);
      }
    }
  }

  /**
   * その仕事の宛先（sticky routing）。
   *
   * `manager_id → runner_id` は台帳にあるので、**推測せずにそこへ届ける**。
   * 生きているかどうかは名簿に聞き直す（周期を待たない） — 落ちた器へ命令を
   * 投げると、返らない待ちがそのまま人間の待ちになる。
   */
  async #runnerOf(
    record: ManagerRecord,
  ): Promise<{ runner: RunnerClient; alive: boolean; replaced: boolean } | null> {
    const runnerId = record.job.runnerId;
    // 宛先が書かれていない古いジョブは、いまの器へ寄せる。
    if (runnerId === undefined) {
      const chosen = await this.#runners.select({}).catch(() => null);
      return chosen === null ? null : { runner: chosen, alive: true, replaced: false };
    }
    const runner = await this.#runners.get(runnerId);
    if (runner === null) return null;
    const state = await this.#runners.probe(runnerId).catch(() => null);
    // **同じ名前でも、別の起動ならそこにセッションは無い。** ローリング更新で
    // 入れ替わった器へ「続き」を流すと、古い器がまだ走っている場合に2本になる。
    const placedOn = record.job.runnerIncarnation;
    const current = state?.incarnation;
    const replaced = placedOn !== undefined && current !== undefined && placedOn !== current;
    return { runner, alive: state?.alive ?? true, replaced };
  }

  /** いまその宛先を名乗っている器の起動（報告しない器では undefined）。 */
  #incarnationOf(runner: RunnerClient): string | undefined {
    const states = this.#runners.states().filter((entry) => entry.runnerId === runner.runnerId);
    return (states.find((entry) => entry.alive) ?? states[0])?.incarnation;
  }

  async #resume(
    record: ManagerRecord,
    runner: RunnerClient,
    message: string | undefined,
    cwd?: string,
  ): Promise<boolean> {
    const { sessionId, request, projectKey } = record.job;
    if (sessionId === undefined) return false;

    // 生ログを渡して materialize させる。runner のディスクに残っている前提を
    // 置かない（器は作り直される）。
    const entries = await this.#loadSession(projectKey, sessionId);
    const where = cwd ?? record.job.cwd ?? runner.workspacePath;

    await runner.resume({
      managerId: record.job.id,
      sessionId,
      cwd: where,
      request: request ?? record.job.summary,
      ...(message === undefined ? {} : { message }),
      ...(entries === null ? {} : { entries }),
    });
    record.attached = true;
    record.job.runnerId = runner.runnerId;
    record.job.runnerIncarnation = this.#incarnationOf(runner);
    record.job.cwd = where;
    return true;
  }

  /**
   * 落ちた器に居た1本を、別の器へ置き直す（M5 受け入れ基準4）。
   *
   * 移せるかを決めるのは workspace の運用選択である（`workspace.ts`）。共有 FS なら
   * 同じ場所が見えるのでそのまま、git 再構築なら**マネージャー自身に clone し直させる**。
   * その器の volume の中にしか無いなら移せない — そのときは黙らずに、何が失われた
   * のかをクローンの受信箱へ上げる。
   */
  async #failover(record: ManagerRecord, force = false): Promise<ManagerSummary | null> {
    // 契機が重なっても、移送は1本にまとめる（同じ session を2か所で開かない）。
    const inFlight = record.moving;
    if (inFlight !== undefined) return inFlight;

    const moving = this.#move(record, force).finally(() => {
      record.moving = undefined;
    });
    record.moving = moving;
    return moving;
  }

  async #move(record: ManagerRecord, force: boolean): Promise<ManagerSummary | null> {
    const from = record.job.runnerId;
    const locator = record.job.workspace;

    if (record.job.sessionId === undefined) {
      this.#strand(
        record,
        `${describeLoss(locator, from)} この委譲はまだ session_id を持っていないので、続きへは戻れない。`,
      );
      return null;
    }

    if (!isPortable(locator)) {
      this.#strand(record, describeLoss(locator, from));
      return null;
    }

    // 落ちた器へは戻さない。
    const target = await this.#runners
      .select({ exclude: from === undefined ? [] : [from] })
      .catch(() => null);
    if (target === null || target.runnerId === from) {
      this.#strand(record, `${describeLoss(locator, from)} 置き直せる別の runner が名簿に無い。`);
      return null;
    }

    // **ここから先は「元の器では走っていない」と言い切れるときだけ。**
    const fence = force ? ({ kind: 'forced' } as const) : await this.#fence(record);
    if (fence.kind === 'wait') {
      this.#deferMove(record, from, fence.ms);
      return null;
    }
    if (fence.kind === 'unknown') {
      this.#strand(
        record,
        `${describeLoss(locator, from)} ${fence.why}` +
          '確かめずに別の器で開き直すと、同じ仕事が2か所で走る（同じ workspace への二重書き、' +
          'PR やメッセージの二重送信）。元の器が本当に止まっていることを確かめたなら、' +
          '`manager_move` を force 付きで呼べば引き取れる。',
      );
      return null;
    }

    const moved = relocate(locator, {
      runnerId: target.runnerId,
      workspacePath: target.workspacePath,
    });
    if (moved === null) {
      this.#strand(record, describeLoss(locator, from));
      return null;
    }

    await this.#ensureConnected();
    const ok = await this.#resume(record, target, moved.nudge, moved.cwd).catch(() => false);
    if (!ok) {
      this.#strand(
        record,
        `${describeLoss(locator, from)} 別の runner（${target.runnerId}）で開き直そうとしたが失敗した。`,
      );
      return null;
    }

    record.moveNote = `別の runner（${target.runnerId}）で続きを開いた。`;
    record.fenceNotified = false;
    record.job.workspace = moved.locator;
    record.job.status = 'running';
    // 返事待ちだった確認は落ちた器と一緒に消えている。行列に残すと、次に届いた
    // 言葉を誰も読まない確認が食い潰す。
    record.waiting = [];
    await this.#persist(record);
    await this.#journal({
      type: 'exchange',
      with: 'manager',
      role: 'outbound',
      text: `[${record.job.id}] （${from ?? '不明'} → ${target.runnerId} へ移送）${moved.nudge}`,
    });
    this.#notifyMoved(record, from, target.runnerId);
    return summaryOf(record);
  }

  /**
   * 元の器で本当に止まっているか（fencing）。
   *
   * **生存確認が途絶えたことは、器が死んだことを意味しない。** デーモンとの通信
   * だけが切れて、マネージャーは走り続けている（ネットワーク分断）こともある。
   * そこで同じ session を別の器で resume すれば、1つの仕事が2か所で動く —
   * 共有 workspace への二重書きと、PR 作成やメッセージ送信のような**取り消せない
   * 外部操作の二重実行**が起きる。デーモン側の排他（`record.moving`）は同じ
   * プロセスの中しか守れないので、ここで別プロセスの1本を確かめる。
   *
   * 順に強い方から:
   *
   * 1. その器へまだ届き、**そのセッションを実際に畳めたなら**それが確認になる。
   *    `stop` が「そんなセッションは無い」と答えた場合は確認ではない — 同じ
   *    `runner_id` で作り直された**新しい**器は、古い器が抱えたままのセッションを
   *    知らないまま答えられる（`RunnerClient.stop` を見よ）
   * 2. 器が貸し出し期限を報告していたなら、**その起動を最後に見た時刻**から
   *    `ttlMs + graceMs` ＋余裕を過ぎた時点で、器は畳み終えている
   * 3. どちらも取れないなら**移さない**。二重に走らせるより、止めて人間へ回す
   */
  async #fence(record: ManagerRecord): Promise<Fence> {
    const from = record.job.runnerId;
    if (from === undefined) {
      return { kind: 'unknown', why: 'どの runner で走っていたのかが台帳に無い。' };
    }

    // 1. まだ届くなら、その場で畳ませる（いちばん強い確認）。
    //    **期限を置く。** 届かない器はここで待ち続ける相手になりうるので、確認に
    //    失敗したことを短く確定させて、期限の話（2.）へ落とす。
    const old = await this.#runners.get(from).catch(() => null);
    if (old !== null) {
      // **「畳んだ」と答えたときだけ確認になる。** 届いたこと自体は確認ではない。
      const stopped = await withDeadline(
        `runner ${from} での停止確認`,
        STOP_CONFIRM_TIMEOUT_MS,
        () => old.stop(record.job.id),
      ).catch(() => false);
      if (stopped) return { kind: 'confirmed' };
    }

    // 2. **その仕事を置いた起動が**自分で畳むと約束していた分だけ待つ。
    const placedOn = record.job.runnerIncarnation;
    const anchor = this.#fenceAnchor(from, placedOn);
    const ttlMs = anchor?.lease?.ttlMs;
    if (anchor === null || ttlMs === undefined) {
      return {
        kind: 'unknown',
        why:
          placedOn === undefined
            ? `runner ${from} のどの起動に置いたのかが分からない（貸し出し期限を報告しない器か、` +
              'それを記録する前に置かれた委譲である）ので、いまも走り続けているかどうかを確かめられない。'
            : `runner ${from} の起動 ${placedOn} をこのデーモンは観測していないので、` +
              'その器が自分でセッションを畳んだと言い切れない。',
      };
    }

    // **申告が無ければ TTL ぶん余計に待つ。** 器が期限切れに気づいて畳み終えるまでの
    // 時間を 0 と決めてかかると、デーモンが「もう止まっている」と見なした時刻の方が、
    // 器が畳み始める時刻より先に来る（そこが二重に走る窓になる）。
    const graceMs = anchor.lease?.graceMs ?? ttlMs;
    const safeAt = anchor.since + ttlMs + graceMs + this.#fenceMarginMs;
    const now = this.#now();
    return now >= safeAt ? { kind: 'expired' } : { kind: 'wait', ms: safeAt - now };
  }

  /**
   * 期限を数える基準。**その仕事を置いた起動について観測したものだけ**を使う。
   *
   * 材料は2つとも、その起動に紐づいていなければならない。
   *
   * - 最後に見た時刻 — 新しい器の名乗りで数えると、分断されたまま走っている
   *   古い器の期限が永遠に来ない（または誤って早く来る）
   * - **その起動が名乗っていた期限** — いまの器の値を流用してはいけない。旧器が
   *   `ttl=60s` を名乗って分断され、新器が `ttl=5s` で起きた構成では、旧器が
   *   最大 70 秒走り続けているのに移送してしまう（設定変更を伴うローリング更新で
   *   普通に起きる）
   *
   * **どちらも取れないなら `null`。** 時間だけで安全と決めない。
   */
  #fenceAnchor(
    runnerId: string,
    placedOn: string | undefined,
  ): { lease: RunnerHealthState['lease']; since: number } | null {
    if (placedOn === undefined) return null;

    for (const state of this.#runners.states()) {
      if (state.runnerId !== runnerId) continue;
      const seen = state.incarnations?.find((entry) => entry.incarnation === placedOn);
      if (seen === undefined) continue;
      const since = Date.parse(seen.lastSeenAt);
      if (Number.isNaN(since)) continue;
      return { lease: seen.lease, since };
    }
    return null;
  }

  /**
   * 期限が来るまで移送を待つ。**放置ではない** — 待つと決めた以上、時間が来たら
   * 自分で置き直す（人間の不在で仕事が止まってよいのは承認待ちだけである）。
   */
  #deferMove(record: ManagerRecord, from: string | undefined, ms: number): void {
    const seconds = Math.ceil(ms / 1000);
    record.moveNote =
      `${record.job.id} を走らせていた runner（${from ?? '不明'}）へ届かないが、` +
      `その器が自分でセッションを畳む期限まであと ${seconds} 秒ある。` +
      '先に開き直すと同じ仕事が2か所で走るので、期限が過ぎてから自動で置き直す。';

    if (record.fenceNotified !== true) {
      record.fenceNotified = true;
      this.#emit(record.job.id, 'report', record.moveNote);
    }

    const timer = setTimeout(
      () => {
        this.#timers.delete(timer);
        void this.#retryMove(record, from);
      },
      Math.max(ms, 1),
    );
    timer.unref?.();
    this.#timers.add(timer);
  }

  /**
   * 期限が来たので置き直す — **ただし、まだ必要なら**。
   *
   * 待っているあいだに話しかけられて移送が済んでいることも、器が戻ってくることも
   * ある。確かめずに掴み直すと、いま元気に走っている仕事を別の器へ引き剥がす。
   */
  async #retryMove(record: ManagerRecord, from: string | undefined): Promise<void> {
    if (this.#stopped) return;
    if (record.job.runnerId !== from) return;

    const found = await this.#runnerOf(record).catch(() => null);
    if (found !== null && found.alive) return;

    await this.#failover(record).catch(() => undefined);
  }

  /** 置き直せなかったことを記録して知らせる（`send` の返事にも同じ言葉を使う）。 */
  #strand(record: ManagerRecord, detail: string): void {
    record.moveNote = detail;
    record.fenceNotified = false;
    this.#notifyStranded(record, detail);
  }

  async #loadSession(projectKey: string | undefined, sessionId: string): Promise<unknown[] | null> {
    const store = this.#stores.sessionStore;
    if (store === undefined || projectKey === undefined) return null;
    try {
      return await store.load({ projectKey, sessionId });
    } catch {
      return null;
    }
  }

  async #fromSessionStore(job: Job): Promise<string | null> {
    const entries = await this.#loadSession(job.projectKey, job.sessionId ?? '');
    if (entries === null || entries.length === 0) return null;
    // 生ログの形（1行1 JSON）のまま返す。読む側は runner 由来と区別しなくてよい。
    return `${entries.map((entry) => JSON.stringify(entry)).join('\n')}\n`;
  }

  /**
   * runner から降りてきた出来事をさばく。
   *
   * 記録（日誌・台帳・アーカイブ・生ログ）はすべてここで行う。runner は記憶へ
   * 到達する鍵を持たないので、書けるのはデーモンだけである。
   */
  async #onEvent(event: RunnerEvent, source?: RunnerClient): Promise<void> {
    if (event.type === 'hello') return;

    const record = this.#records.get(event.managerId) ?? (await this.#load(event.managerId));
    if (!record) return;

    // 別の器へ移したあと、元の器が繋がり直して遅れて流してくる分は捨てる。
    // **拾うと、いまの器で走っている仕事が「閉じた」ことにされる**（`closed`）し、
    // 預かる生ログも2本のセッションが混ざる。宛先は台帳が正本である。
    if (
      source !== undefined &&
      record.job.runnerId !== undefined &&
      record.job.runnerId !== source.runnerId
    ) {
      return;
    }

    switch (event.type) {
      case 'session': {
        record.job.sessionId = event.sessionId;
        record.attached = true;
        await this.#persist(record);
        return;
      }

      case 'project_key': {
        if (record.job.projectKey === event.projectKey) return;
        record.job.projectKey = event.projectKey;
        await this.#persist(record);
        return;
      }

      case 'report': {
        record.job.lastReport = event.text;
        record.job.status = event.status;
        await this.#persist(record);
        await this.#journal({
          type: 'exchange',
          with: 'manager',
          role: 'inbound',
          text: `[${event.managerId}] ${event.text}`,
        });
        this.#emit(event.managerId, 'report', event.text);
        return;
      }

      case 'ask': {
        if (!record.waiting.some((item) => item.requestId === event.requestId)) {
          record.waiting.push({ requestId: event.requestId, summary: event.summary });
        }
        record.job.status = 'waiting_human';
        await this.#persist(record);
        await this.#journal({
          type: 'escalation',
          question: event.summary,
          approvalId: event.requestId,
          managerId: event.managerId,
        });
        this.#emit(event.managerId, event.kind, event.summary, event.requestId);
        return;
      }

      case 'settled': {
        record.waiting = record.waiting.filter((item) => item.requestId !== event.requestId);
        if (record.job.status === 'waiting_human' && record.waiting.length === 0) {
          record.job.status = 'running';
        }
        await this.#persist(record);
        return;
      }

      case 'tool_use': {
        await this.#journal({
          type: 'tool_use',
          actor: event.actor,
          tool: event.tool,
          input: event.input,
        });
        return;
      }

      case 'mirror': {
        const store = this.#stores.sessionStore;
        if (store === undefined) return;
        try {
          await store.append(event.key, event.entries as never);
        } catch {
          // 生ログを預かれなくてもマネージャーは止めない
        }
        return;
      }

      case 'archive': {
        try {
          const id = await this.#stores.archive.archive(event.managerId, event.body);
          record.job.archiveIds = [...(record.job.archiveIds ?? []), id];
          await this.#persist(record);
        } catch {
          // 退避できなくてもマネージャーを止めない
        }
        return;
      }

      case 'closed': {
        record.job.status = event.status;
        record.waiting = [];
        record.attached = false;
        await this.#persist(record);
        if (event.status === 'failed') this.#emit(event.managerId, 'report', event.reason);
        return;
      }

      default: {
        const exhaustive: never = event;
        throw new Error(`未知の runner イベント: ${JSON.stringify(exhaustive)}`);
      }
    }
  }

  // -------------------------------------------------------------------------
  // 台帳と受信箱
  // -------------------------------------------------------------------------

  #choosePending(
    record: ManagerRecord,
    requestId: string | undefined,
  ): { requestId: string; summary: string } | null | 'ambiguous' | 'gone' {
    if (requestId !== undefined) {
      return record.waiting.find((item) => item.requestId === requestId) ?? 'gone';
    }
    if (record.waiting.length === 0) return null;
    if (record.waiting.length === 1) return record.waiting[0] ?? null;
    return 'ambiguous';
  }

  /** 台帳から像を作る（再起動後に届いたイベントの受け皿）。 */
  async #load(managerId: string): Promise<ManagerRecord | null> {
    const job = (await this.#stores.jobs.listJobs()).find((entry) => entry.id === managerId);
    if (!job) return null;
    const record: ManagerRecord = { job: { ...job }, waiting: [], attached: false };
    this.#records.set(managerId, record);
    return record;
  }

  #notifyRestored(record: ManagerRecord, how: 'attached' | 'resumed'): void {
    const { job } = record;
    this.#post({
      type: 'manager_message',
      id: randomUUID(),
      at: new Date().toISOString(),
      managerId: job.id,
      kind: 'report',
      text: [
        how === 'attached'
          ? 'デーモンが再起動した。この委譲は runner の中で走り続けている。'
          : 'デーモンが再起動した。中断されていたこの委譲を、前のセッションから再開させた。',
        `依頼: ${job.request ?? job.summary}`,
        `作業ディレクトリ: ${job.cwd ?? '(不明)'}`,
        job.lastReport === undefined ? '' : `直近の報告: ${job.lastReport}`,
        '',
        how === 'attached'
          ? '返事待ちがあれば改めて届く。`manager_send` で追加の指示も送れる。'
          : '再開の指示は送信済みなので、報告を待てばよい。' +
            '返事待ちだった確認は器と一緒に失われているので、必要ならマネージャーが聞き直してくる。',
      ]
        .filter((line) => line !== '')
        .join('\n'),
    });
  }

  /** 別の器へ置き直したことを知らせる（クローンは状況を把握したままでいる）。 */
  #notifyMoved(record: ManagerRecord, from: string | undefined, to: string): void {
    const { job } = record;
    this.#post({
      type: 'manager_message',
      id: randomUUID(),
      at: new Date().toISOString(),
      managerId: job.id,
      kind: 'report',
      text: [
        `走らせていた runner（${from ?? '不明'}）へ届かなくなったので、この委譲を ${to} で開き直した。`,
        `依頼: ${job.request ?? job.summary}`,
        `作業ディレクトリ: ${job.cwd ?? '(不明)'}`,
        job.lastReport === undefined ? '' : `直近の報告: ${job.lastReport}`,
        '',
        '再開の指示は送信済みなので、報告を待てばよい。' +
          '返事待ちだった確認は落ちた器と一緒に失われているので、必要ならマネージャーが聞き直してくる。',
      ]
        .filter((line) => line !== '')
        .join('\n'),
    });
  }

  /**
   * 置き直せなかったことを知らせる（M5 受け入れ基準4 の後段）。
   *
   * **ここで黙ると、失われた作業が「進んでいるつもり」のまま残る。** 判断は
   * クローンがする（記憶に根拠があれば自分で決め、無ければ人間へ回す）ので、
   * ここでは事実だけを渡す。
   */
  #notifyStranded(record: ManagerRecord, detail: string): void {
    const { job } = record;
    this.#post({
      type: 'manager_message',
      id: randomUUID(),
      at: new Date().toISOString(),
      managerId: job.id,
      kind: 'report',
      text: [
        `この委譲は続きを開けない状態になった。${detail}`,
        `依頼: ${job.request ?? job.summary}`,
        `作業ディレクトリ: ${job.cwd ?? '(不明)'}`,
        job.lastReport === undefined ? '' : `直近の報告: ${job.lastReport}`,
        '',
        'どうするか（新しく起こし直す / 諦める / 人間に確認する）を決めること。' +
          'コミットされていない作業が失われている可能性は、記憶に根拠が無ければ人間へ回すのが正しい。',
      ]
        .filter((line) => line !== '')
        .join('\n'),
    });
  }

  #emit(
    managerId: string,
    kind: 'report' | 'question' | 'permission',
    text: string,
    requestId?: string,
  ): void {
    this.#post({
      type: 'manager_message',
      id: randomUUID(),
      at: new Date().toISOString(),
      managerId,
      kind,
      text,
      ...(requestId === undefined ? {} : { requestId }),
    });
  }

  async #persist(record: ManagerRecord): Promise<void> {
    record.job.updatedAt = new Date().toISOString();
    try {
      await this.#stores.jobs.putJob(record.job);
    } catch {
      // ジョブ台帳が書けなくてもマネージャーは走らせる
    }
  }

  async #journal(entry: JournalEntryInput): Promise<void> {
    try {
      await this.#stores.journal.append(entry);
    } catch {
      // 記録できないこと自体は致命ではない
    }
  }
}

/** 再起動後に流す一言。**開き直すだけでは仕事は進まない。** */
function restartNudge(status: JobStatus): string {
  if (status === 'waiting_human') {
    return (
      '[system] デーモンが再起動した。あなたが待っていた確認は器と一緒に失われている。' +
      'まだ必要なら聞き直し、不要なら中断していた作業の続きを進めよ。'
    );
  }
  return '[system] デーモンが再起動した。中断していた作業の続きを進めよ。';
}

function summaryOf(record: ManagerRecord, live = true): ManagerSummary {
  const { job } = record;
  return {
    managerId: job.id,
    status: job.status,
    live,
    cwd: job.cwd ?? '',
    request: job.request ?? job.summary,
    startedAt: job.createdAt,
    updatedAt: job.updatedAt,
    waiting: [...record.waiting],
    ...(job.sessionId === undefined ? {} : { sessionId: job.sessionId }),
    ...(job.lastReport === undefined ? {} : { lastReport: job.lastReport }),
    ...(job.runnerId === undefined ? {} : { runnerId: job.runnerId }),
    ...(job.workspace === undefined ? {} : { workspace: job.workspace }),
  };
}
