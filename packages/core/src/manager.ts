import { randomUUID } from 'node:crypto';
import { readFile } from 'node:fs/promises';

import { query } from '@anthropic-ai/claude-agent-sdk';
import type {
  Options,
  PermissionResult,
  Query,
  SDKMessage,
  SDKUserMessage,
} from '@anthropic-ai/claude-agent-sdk';

import { buildManagerSystemPrompt, buildWorkerPrompt } from './prompt.js';
import type { InboxEvent, Job, JobStatus, JournalEntryInput } from './schema.js';
import type { Stores } from './store.js';

/**
 * マネージャーと作業者（docs/architecture.md「プロセスモデル」「配線」）。
 *
 * **マネージャーと作業者は実装物ではない。** どちらも実体は Claude Code そのもので
 * あり、ここに書くのは配線だけ — 起こす・話しかける・クローンへ回す・日誌に落とす。
 *
 * ここは2つの禁止（north_star）がまともに効く場所である:
 *
 * - `tools` を**渡さない**（preset 全部）。明示リストで絞った瞬間に能力の削除になる
 * - `maxTurns` を渡さない。暴走はターン数ではなく実行環境の境界で止める
 * - 同時数に人工上限を設けない。上限はマシンリソースそのもの
 * - `permissionMode` を触らない。人間が Claude Code を開いたときと同じ既定のまま、
 *   確認は `canUseTool` でクローンへ回す（人間 → Claude Code の対話の写像）
 */

/** マネージャーのモデル帯。変更には人間の承認が要る（AGENTS.md 地雷5）。 */
export const MANAGER_MODEL = 'opus';

/** 作業者のモデル帯。SDK の既定はマネージャーの継承なので、必ず明示する。 */
export const WORKER_MODEL = 'sonnet';

/** 作業者層の本体はこの `agents` 定義1個だけ。独自のワーカープールを作らない。 */
export const WORKER_AGENT_NAME = 'worker';

/**
 * マネージャー子プロセスへ渡さない環境変数。
 *
 * 上向きの不可視は、ツールを絞ってではなく**認証情報の配布範囲**で守る
 * （architecture.md「非対称な可視性」）。ローカルでは同一ユーザーで動く以上
 * 既知の穴が残るが、その穴をツール削除で塞がないこと。本命の強制は M4。
 */
export const WITHHELD_ENV_KEYS = ['ALTEROID_HOME', 'ALTEROID_PORT'] as const;

export interface ManagerStartInput {
  request: string;
  /** 実プロジェクトの作業ディレクトリ。人間が Claude Code を開く場所と同じ。 */
  cwd?: string;
}

export interface ManagerSummary {
  managerId: string;
  status: JobStatus;
  /** このデーモンの中でセッションが生きているか（再起動を跨ぐと false）。 */
  live: boolean;
  cwd: string;
  request: string;
  startedAt: string;
  updatedAt: string;
  sessionId?: string;
  lastReport?: string;
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

export interface ManagerPool {
  start(input: ManagerStartInput): Promise<ManagerSummary>;
  send(
    managerId: string,
    message: string,
    options?: ManagerSendOptions,
  ): Promise<ManagerSendResult>;
  list(): Promise<ManagerSummary[]>;
  /** manager_id からセッションの生ログへ降りる（可観測性の最下段）。 */
  transcript(managerId: string): Promise<string | null>;
  stop(): Promise<void>;
}

export interface ManagerPoolOptions {
  stores: Stores;
  /** マネージャーからの出来事をクローンの受信箱へ流す。 */
  post: (event: InboxEvent) => void;
  /** 主にテスト用。既定は SDK の `query`。 */
  queryFn?: typeof query;
  /** `cwd` を省いた委譲の既定の作業ディレクトリ。 */
  defaultCwd?: string;
  /** 主にテスト用。既定は `process.env`。 */
  env?: NodeJS.ProcessEnv;
}

export function createManagerPool(options: ManagerPoolOptions): ManagerPool {
  return new Pool(options);
}

/** 返事を待って止まっている1件（許可確認 or 質問）。 */
interface PendingRequest {
  id: string;
  kind: 'question' | 'permission';
  toolName: string;
  input: Record<string, unknown>;
  summary: string;
  settle: (answer: { message: string; decision?: ManagerDecision }) => void;
  /** 同じ確認が再送されたときに同じ結果を返すための約束（SDK は再送しうる）。 */
  result: Promise<PermissionResult>;
}

class Pool implements ManagerPool {
  readonly #stores: Stores;
  readonly #post: (event: InboxEvent) => void;
  readonly #queryFn: typeof query;
  readonly #defaultCwd: string;
  readonly #env: NodeJS.ProcessEnv;
  readonly #sessions = new Map<string, ManagerSession>();
  #stopped = false;

  constructor({ stores, post, queryFn, defaultCwd, env }: ManagerPoolOptions) {
    this.#stores = stores;
    this.#post = post;
    this.#queryFn = queryFn ?? query;
    this.#defaultCwd = defaultCwd ?? process.cwd();
    this.#env = env ?? process.env;
  }

  async start(input: ManagerStartInput): Promise<ManagerSummary> {
    if (this.#stopped) throw new Error('デーモンが停止中のためマネージャーを起こせない');

    const managerId = `mgr-${randomUUID().slice(0, 8)}`;
    const session = new ManagerSession({
      managerId,
      request: input.request,
      cwd: input.cwd ?? this.#defaultCwd,
      stores: this.#stores,
      post: this.#post,
      queryFn: this.#queryFn,
      env: this.#env,
    });
    this.#sessions.set(managerId, session);

    // 委譲はノンブロッキング。起動して即返し、クローンは次の判断へ移る。
    try {
      await session.begin();
    } catch (error) {
      // 起こせなかったものを一覧に残さない。残すと「走っている」と見えるのに
      // 誰も読まない入力待ち行列へ、クローンが指示を送り続けることになる。
      this.#sessions.delete(managerId);
      throw error;
    }
    return session.summary();
  }

  async send(
    managerId: string,
    message: string,
    options: ManagerSendOptions = {},
  ): Promise<ManagerSendResult> {
    const session = this.#sessions.get(managerId);
    if (!session) {
      const known = await this.#stores.jobs.listJobs();
      const stale = known.some((job) => job.id === managerId);
      return {
        outcome: 'unknown',
        detail: stale
          ? `${managerId} のセッションはこのデーモンでは生きていない。新しく起こし直すこと。`
          : `${managerId} というマネージャーは居ない。`,
      };
    }
    return session.send(message, options);
  }

  async list(): Promise<ManagerSummary[]> {
    const live = new Map<string, ManagerSummary>();
    for (const session of this.#sessions.values()) {
      const summary = session.summary();
      live.set(summary.managerId, summary);
    }

    // デーモン再起動を跨いだ分も見えるようにする（セッションは死んでいる）。
    for (const job of await this.#stores.jobs.listJobs()) {
      if (live.has(job.id)) continue;
      live.set(job.id, {
        managerId: job.id,
        status: job.status,
        live: false,
        cwd: job.cwd ?? '',
        request: job.request ?? job.summary,
        startedAt: job.createdAt,
        updatedAt: job.updatedAt,
        // セッションが居ない以上、待っているものも生きていない
        waiting: [],
        ...(job.sessionId === undefined ? {} : { sessionId: job.sessionId }),
        ...(job.lastReport === undefined ? {} : { lastReport: job.lastReport }),
      });
    }

    return [...live.values()].sort((a, b) => b.startedAt.localeCompare(a.startedAt));
  }

  async transcript(managerId: string): Promise<string | null> {
    const job = (await this.#stores.jobs.listJobs()).find((entry) => entry.id === managerId);
    if (!job) return null;

    // 走行中のセッションはまだファイルの上にいる。無ければ退避済みへ降りる。
    if (job.transcriptPath !== undefined) {
      try {
        return await readFile(job.transcriptPath, 'utf8');
      } catch {
        // 消えていればアーカイブへ
      }
    }
    for (const id of [...(job.archiveIds ?? [])].reverse()) {
      const body = await this.#stores.archive.read(id);
      if (body !== null) return body;
    }
    return null;
  }

  async stop(): Promise<void> {
    this.#stopped = true;
    await Promise.all([...this.#sessions.values()].map((session) => session.stop()));
    this.#sessions.clear();
  }
}

interface ManagerSessionOptions {
  managerId: string;
  request: string;
  cwd: string;
  stores: Stores;
  post: (event: InboxEvent) => void;
  queryFn: typeof query;
  env: NodeJS.ProcessEnv;
}

class ManagerSession {
  readonly #id: string;
  readonly #request: string;
  readonly #cwd: string;
  readonly #stores: Stores;
  readonly #post: (event: InboxEvent) => void;
  readonly #queryFn: typeof query;
  readonly #env: NodeJS.ProcessEnv;

  readonly #startedAt = new Date().toISOString();
  readonly #input: SDKUserMessage[] = [];
  readonly #pending: PendingRequest[] = [];
  readonly #archiveIds: string[] = [];

  #inputWaiter: (() => void) | null = null;
  #query: Query | null = null;
  #reader: Promise<void> | null = null;
  #status: JobStatus = 'running';
  #updatedAt = this.#startedAt;
  #sessionId: string | undefined;
  #transcriptPath: string | undefined;
  #lastReport: string | undefined;
  #stopped = false;

  constructor(options: ManagerSessionOptions) {
    this.#id = options.managerId;
    this.#request = options.request;
    this.#cwd = options.cwd;
    this.#stores = options.stores;
    this.#post = options.post;
    this.#queryFn = options.queryFn;
    this.#env = options.env;
  }

  async begin(): Promise<void> {
    this.#push(this.#request);
    const q = this.#queryFn({ prompt: this.#inputStream(), options: this.#buildOptions() });
    this.#query = q;
    this.#reader = this.#read(q);
    await this.#persist();
    await this.#journal({
      type: 'exchange',
      with: 'manager',
      role: 'outbound',
      text: `[${this.#id}] ${this.#request}`,
    });
  }

  summary(): ManagerSummary {
    return {
      managerId: this.#id,
      status: this.#status,
      live: !this.#stopped,
      cwd: this.#cwd,
      request: this.#request,
      startedAt: this.#startedAt,
      updatedAt: this.#updatedAt,
      waiting: this.#pending.map((request) => ({
        requestId: request.id,
        summary: request.summary,
      })),
      ...(this.#sessionId === undefined ? {} : { sessionId: this.#sessionId }),
      ...(this.#lastReport === undefined ? {} : { lastReport: this.#lastReport }),
    };
  }

  /**
   * クローンからの一言。止まっている確認があればそれへの回答として使い、
   * 無ければ追加指示として流す（architecture.md「会話に戻れる」）。
   *
   * **宛先を推測しない。** 1本のマネージャーが複数の確認を同時に待つことがあり
   * （1応答で並列に呼ばれた道具）、そこで先頭に入れてしまうと、拒否のつもりの
   * 一言が別の質問の答えになり、拒否したかった道具は次の一言で通ってしまう。
   */
  async send(message: string, options: ManagerSendOptions = {}): Promise<ManagerSendResult> {
    const { decision, requestId } = options;

    const pending = this.#choosePending(requestId);
    if (pending === 'ambiguous') {
      return {
        outcome: 'unknown',
        detail:
          `${this.#id} は複数の確認を同時に待っている。requestId を指定して答えること: ` +
          this.#pending.map((request) => `${request.id}（${request.summary}）`).join(' / '),
      };
    }
    if (pending === 'gone') {
      return {
        outcome: 'unknown',
        detail: `${requestId ?? ''} という確認は ${this.#id} で待っていない（既に解けたか、別のマネージャーのもの）。`,
      };
    }

    if (pending) {
      pending.settle({ message, ...(decision === undefined ? {} : { decision }) });
      // 追記専用なので新しい行。日誌だけを追っても、誰が何と答えたかまで分かる。
      await this.#journal({
        type: 'escalation',
        question: pending.summary,
        approvalId: pending.id,
        managerId: this.#id,
        answeredAt: new Date().toISOString(),
        answer: decision === undefined ? message : `[${decision}] ${message}`,
      });
      return { outcome: 'answered', detail: `${pending.summary} に回答した。` };
    }

    if (this.#stopped) {
      return { outcome: 'unknown', detail: `${this.#id} のセッションは既に閉じている。` };
    }

    this.#push(message);
    this.#status = 'running';
    await this.#persist();
    await this.#journal({
      type: 'exchange',
      with: 'manager',
      role: 'outbound',
      text: `[${this.#id}] ${message}`,
    });
    return { outcome: 'delivered', detail: '追加指示として届けた。' };
  }

  /**
   * どの確認に答えようとしているのかを決める。
   * `null` = 返事待ちは無い（＝追加指示）。推測が危ういときは答えを返さない。
   */
  #choosePending(requestId: string | undefined): PendingRequest | null | 'ambiguous' | 'gone' {
    if (requestId !== undefined) {
      return this.#pending.find((request) => request.id === requestId) ?? 'gone';
    }
    if (this.#pending.length === 0) return null;
    if (this.#pending.length === 1) return this.#pending[0] ?? null;
    return 'ambiguous';
  }

  /** 待たせたまま消えない。止まっている確認は理由付きで全部解く。 */
  #settleAll(reason: string): void {
    for (const request of [...this.#pending]) {
      request.settle({ message: reason, decision: 'deny' });
    }
    this.#pending.length = 0;
  }

  async stop(): Promise<void> {
    if (this.#stopped) return;
    this.#stopped = true;

    this.#settleAll('デーモンが停止した。');

    this.#wakeInput();
    try {
      this.#query?.close();
    } catch {
      // 既に閉じている
    }
    await this.#reader?.catch(() => undefined);
  }

  // -------------------------------------------------------------------------
  // SDK セッション
  // -------------------------------------------------------------------------

  #buildOptions(): Options {
    return {
      model: MANAGER_MODEL,
      // `tools` は渡さない = preset 全部。明示リストで絞らない（AGENTS.md 地雷1）。
      // `maxTurns` も渡さない（地雷2）。
      systemPrompt: {
        type: 'preset',
        preset: 'claude_code',
        append: buildManagerSystemPrompt({ managerId: this.#id, workerName: WORKER_AGENT_NAME }),
      },
      // 作業者層の本体はこの1個だけ。`tools` を書かない = 親の全ツールを継承。
      agents: {
        [WORKER_AGENT_NAME]: {
          description:
            'コストと文脈のために切り出した実作業の担い手。実装に限らず、調査・下読み・' +
            '外部サービスの確認・レビュー・相談のたたき台づくりまで任せてよい。',
          prompt: buildWorkerPrompt(),
          model: WORKER_MODEL,
        },
      },
      cwd: this.#cwd,
      // 人間が使っているのと同じ設定・同じ .mcp.json を渡す（下向きは同じものが見える）
      settingSources: ['user', 'project', 'local'],
      env: this.#childEnv(),
      canUseTool: (toolName, input, extra) => this.#onPermission(toolName, input, extra),
      hooks: {
        PostToolUse: [{ hooks: [(input) => this.#onPostToolUse(input)] }],
        PreCompact: [{ hooks: [(input) => this.#onPreCompact(input)] }],
      },
    };
  }

  /** 記憶ストアの所在は子プロセスへ渡さない（渡さなければ構造的に触れない）。 */
  #childEnv(): NodeJS.ProcessEnv {
    const env = { ...this.#env };
    for (const key of WITHHELD_ENV_KEYS) delete env[key];
    return env;
  }

  #push(text: string): void {
    this.#input.push({
      type: 'user',
      message: { role: 'user', content: text },
      parent_tool_use_id: null,
    });
    this.#wakeInput();
  }

  #wakeInput(): void {
    const waiter = this.#inputWaiter;
    this.#inputWaiter = null;
    waiter?.();
  }

  async *#inputStream(): AsyncGenerator<SDKUserMessage> {
    for (;;) {
      const next = this.#input.shift();
      if (next !== undefined) {
        yield next;
        continue;
      }
      if (this.#stopped) return;
      await new Promise<void>((resolve) => {
        this.#inputWaiter = resolve;
      });
    }
  }

  async #read(q: Query): Promise<void> {
    try {
      for await (const message of q) {
        await this.#dispatch(message);
      }
      if (!this.#stopped) await this.#finish('done', 'マネージャーのセッションが閉じた。');
    } catch (error) {
      await this.#finish('failed', `マネージャーのセッションが落ちた: ${String(error)}`);
    }
  }

  async #dispatch(message: SDKMessage): Promise<void> {
    if (message.type === 'system' && message.subtype === 'init') {
      this.#sessionId = message.session_id;
      await this.#persist();
      return;
    }

    if (message.type !== 'result') return;

    // 最終報告はクローンの受信箱へ。人間が chat を開いていなくても処理される。
    const text = resultText(message);
    this.#lastReport = text;
    this.#status = this.#pending.length > 0 ? 'waiting_human' : 'done';
    await this.#persist();
    await this.#journal({
      type: 'exchange',
      with: 'manager',
      role: 'inbound',
      text: `[${this.#id}] ${text}`,
    });
    this.#emit('report', text);
  }

  async #finish(status: JobStatus, reason: string): Promise<void> {
    this.#stopped = true;
    this.#settleAll(reason);
    // 読み取りが終わっても、入力側を起こして本体を閉じておく。ここを怠ると
    // `stop()` が「もう停止済み」と見て素通りし、閉じられない Query と
    // 起きない `#inputStream` が残る。
    this.#wakeInput();
    try {
      this.#query?.close();
    } catch {
      // 既に閉じている
    }
    this.#status = status;
    await this.#archiveTranscript();
    await this.#persist();
    if (status === 'failed') this.#emit('report', reason);
  }

  // -------------------------------------------------------------------------
  // 配線 — マネージャーから見た「ユーザー」はクローン
  // -------------------------------------------------------------------------

  /**
   * 許可確認と `AskUserQuestion` をクローンへ回す。
   *
   * ここは追加の関門ではない。人間が画面越しに受け取っていた確認が、そのまま
   * クローンへ届くだけである。だから既定の `permissionMode` を触らず、
   * 待ち時間にも上限を置かない — 止まるのはこの仕事だけで、他は走り続ける。
   */
  async #onPermission(
    toolName: string,
    input: Record<string, unknown>,
    extra: { signal: AbortSignal; requestId?: string; toolUseID?: string },
  ): Promise<PermissionResult> {
    // SDK は同じ確認を再送しうる（通信の切れ目など）。id を SDK 側の識別子に
    // 揃えて、再送では新しい待ちを積まずに同じ結果を返す。積んでしまうと、
    // クローンの1回の回答が二重に消費され、片方が永久に返らない。
    const id = extra.requestId ?? extra.toolUseID ?? randomUUID();
    const already = this.#pending.find((request) => request.id === id);
    if (already) return already.result;

    const kind = toolName === 'AskUserQuestion' ? 'question' : 'permission';
    const summary =
      kind === 'question' ? describeQuestions(input) : `${toolName} の実行許可: ${brief(input)}`;

    let settle!: PendingRequest['settle'];
    const answered = new Promise<{ message: string; decision?: ManagerDecision }>((resolve) => {
      settle = resolve;
    });

    const result = answered.then((answer) => {
      if (kind === 'question') {
        return { behavior: 'allow' as const, updatedInput: withAnswers(input, answer.message) };
      }
      const decision = answer.decision ?? inferDecision(answer.message);
      return decision === 'allow'
        ? { behavior: 'allow' as const }
        : { behavior: 'deny' as const, message: answer.message };
    });

    let done = false;
    let unlisten = () => undefined as void;

    const request: PendingRequest = {
      id,
      kind,
      toolName,
      input,
      summary,
      result,
      // **待ち行列から自分を外すのは settle の責任**。ここを呼び出し側任せに
      // すると、中断で解けた1件が行列に残り、次にクローンが送った言葉を
      // 「誰も待っていない返事」として食い潰す。
      settle: (value) => {
        if (done) return;
        done = true;
        unlisten();
        const at = this.#pending.indexOf(request);
        if (at !== -1) this.#pending.splice(at, 1);
        if (this.#status === 'waiting_human' && this.#pending.length === 0) {
          this.#status = 'running';
        }
        void this.#persist();
        settle(value);
      },
    };

    this.#pending.push(request);
    this.#status = 'waiting_human';
    void this.#persist();

    // マネージャー側で中断されたら宙吊りにしない。
    const onAbort = () =>
      request.settle({ message: 'マネージャー側で中断された。', decision: 'deny' });
    if (extra.signal.aborted) {
      onAbort();
    } else {
      extra.signal.addEventListener('abort', onAbort, { once: true });
      unlisten = () => extra.signal.removeEventListener('abort', onAbort);
    }

    await this.#journal({
      type: 'escalation',
      question: summary,
      approvalId: id,
      managerId: this.#id,
    });
    this.#emit(kind, summary, id);

    return result;
  }

  /** マネージャーと作業者の全ツール実行を日誌へ（監査。既知の穴はここで受ける）。 */
  async #onPostToolUse(input: unknown): Promise<{ continue: true }> {
    const hook = input as {
      tool_name?: string;
      tool_input?: unknown;
      session_id?: string;
      transcript_path?: string;
      agent_id?: string;
      agent_type?: string;
    };

    // 生ログへの入口はここで拾う。manager_id からセッションへ降りられるようになる。
    if (typeof hook.transcript_path === 'string' && hook.transcript_path !== this.#transcriptPath) {
      this.#transcriptPath = hook.transcript_path;
      await this.#persist();
    }

    await this.#journal({
      type: 'tool_use',
      actor:
        hook.agent_id === undefined
          ? `manager:${this.#id}`
          : `worker:${this.#id}:${hook.agent_type ?? WORKER_AGENT_NAME}`,
      tool: hook.tool_name ?? '(不明)',
      input: hook.tool_input,
    });

    return { continue: true };
  }

  /** 要約に潰される前に全文を退避する（監査は日誌＋アーカイブで担保する）。 */
  async #onPreCompact(input: unknown): Promise<{ continue: true }> {
    const { transcript_path: path } = input as { transcript_path?: string };
    if (typeof path === 'string' && path.length > 0) this.#transcriptPath = path;
    await this.#archiveTranscript();
    // 退避先の id をここで台帳に落とす。落とさないままデーモンが死ぬと、
    // manager_id から生ログへ降りる経路（M2 の約束）が切れる。
    await this.#persist();
    return { continue: true };
  }

  async #archiveTranscript(): Promise<void> {
    const path = this.#transcriptPath;
    if (path === undefined) return;
    try {
      const body = await readFile(path, 'utf8');
      this.#archiveIds.push(await this.#stores.archive.archive(this.#id, body));
    } catch {
      // 退避できなくてもマネージャーを止めない
    }
  }

  #emit(kind: 'report' | 'question' | 'permission', text: string, requestId?: string): void {
    this.#post({
      type: 'manager_message',
      id: randomUUID(),
      at: new Date().toISOString(),
      managerId: this.#id,
      kind,
      text,
      ...(requestId === undefined ? {} : { requestId }),
    });
  }

  async #persist(): Promise<void> {
    this.#updatedAt = new Date().toISOString();
    const job: Job = {
      id: this.#id,
      managerId: this.#id,
      createdAt: this.#startedAt,
      updatedAt: this.#updatedAt,
      status: this.#status,
      summary: brief({ request: this.#request }),
      request: this.#request,
      cwd: this.#cwd,
      ...(this.#sessionId === undefined ? {} : { sessionId: this.#sessionId }),
      ...(this.#transcriptPath === undefined ? {} : { transcriptPath: this.#transcriptPath }),
      ...(this.#archiveIds.length === 0 ? {} : { archiveIds: [...this.#archiveIds] }),
      ...(this.#lastReport === undefined ? {} : { lastReport: this.#lastReport }),
    };
    try {
      await this.#stores.jobs.putJob(job);
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

// ---------------------------------------------------------------------------
// 小道具
// ---------------------------------------------------------------------------

function resultText(message: SDKMessage): string {
  const candidate = message as { result?: unknown; subtype?: string; error?: unknown };
  if (typeof candidate.result === 'string' && candidate.result.length > 0) return candidate.result;
  if (candidate.subtype !== undefined && candidate.subtype !== 'success') {
    return `（結果なしで終了: ${candidate.subtype}）`;
  }
  return '（報告なし）';
}

/** `AskUserQuestion` の回答は「質問文 → 回答」の対応で返す（SDK の入力形）。 */
function withAnswers(input: Record<string, unknown>, message: string): Record<string, unknown> {
  const questions = Array.isArray(input.questions) ? input.questions : [];
  const answers: Record<string, string> = {};
  for (const question of questions) {
    const text = (question as { question?: unknown }).question;
    if (typeof text === 'string') answers[text] = message;
  }
  return { ...input, answers };
}

function describeQuestions(input: Record<string, unknown>): string {
  const questions = Array.isArray(input.questions) ? input.questions : [];
  const texts = questions
    .map((question) => (question as { question?: unknown }).question)
    .filter((text): text is string => typeof text === 'string');
  return texts.length > 0 ? texts.join(' / ') : brief(input);
}

/** 否定として読み取る語。日本語は語境界が無いので素直に部分一致で見る。 */
const DENIAL_PHRASES = [
  'やめ',
  'だめ',
  '駄目',
  '不可',
  '中止',
  '却下',
  'しないで',
  '止めて',
  '待って',
  '許可しない',
  '承認しない',
];

/** 英語側は語境界で見る（`nothing` の `no` を否定と読まないため）。 */
const DENIAL_WORDS = /\b(deny|denied|no|nope|don't|do not|stop|cancel)\b/i;

/**
 * `decision` を付け忘れた回答の読み取り。
 *
 * 迷ったら通さない — ではなく、**否定が読み取れたときだけ拒否**する。ここで
 * 保守的に倒すと、クローンが承認したつもりの仕事が黙って止まる（デグレード）。
 * 拒否の場合もメッセージは理由としてマネージャーへ渡るので、会話は続く。
 *
 * 日本語を語境界（`\s` や `\b`）で探してはいけない。「それはやめて」の「やめ」の
 * 前に区切りは無く、探せていないことが**承認**として表に出る。
 */
function inferDecision(message: string): ManagerDecision {
  if (DENIAL_PHRASES.some((phrase) => message.includes(phrase))) return 'deny';
  return DENIAL_WORDS.test(message) ? 'deny' : 'allow';
}

function brief(value: unknown, limit = 200): string {
  const text = typeof value === 'string' ? value : JSON.stringify(value);
  if (text === undefined) return '';
  return text.length > limit ? `${text.slice(0, limit)}…` : text;
}
