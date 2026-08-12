import { spawn } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import { readFile } from 'node:fs/promises';

import { query } from '@anthropic-ai/claude-agent-sdk';
import type {
  Options,
  PermissionResult,
  Query,
  SDKMessage,
  SDKUserMessage,
  SessionKey,
  SessionStore,
  SessionStoreEntry,
} from '@anthropic-ai/claude-agent-sdk';

import { measureCapacity } from './capacity.js';
import { buildManagerSystemPrompt, buildWorkerPrompt } from './prompt.js';
import type {
  RunnerAnswerCommand,
  RunnerCapacity,
  RunnerEvent,
  RunnerManagerState,
  RunnerResumeCommand,
  RunnerStartCommand,
} from './runner-protocol.js';
import type { JobStatus } from './schema.js';

/**
 * manager-runner — SDK を隔離して走らせる層（roadmap M4）。
 *
 * **マネージャーと作業者は実装物ではない。** ここに書くのは配線だけ — 起こす・
 * 話しかける・出来事をデーモンへ返す・生ログを渡す。
 *
 * この層は**判断をしない**。「これは人間に聞くべきか」「この道具は許してよいか」は
 * 一切持たず、確認をそのままデーモン（＝クローン）へ上げる。ここに行為の一覧を
 * 置いた瞬間、権限境界が設定に化けて人による違いが潰れる（AGENTS.md 地雷3）。
 *
 * 2つの禁止（north_star）が効くのもここである:
 *
 * - `tools` を**渡さない**（preset 全部）。明示リストで絞れば能力の削除になる
 * - `maxTurns` を渡さない。暴走はターン数ではなく実行環境の境界で止める
 * - 同時セッション数に人工上限を設けない。上限はマシンリソースそのもの
 * - `permissionMode` を触らない。確認は `canUseTool` でデーモンへ回す
 */

/** マネージャーのモデル帯。変更には人間の承認が要る（AGENTS.md 地雷5）。 */
export const MANAGER_MODEL = 'opus';

/** 作業者のモデル帯。SDK の既定はマネージャーの継承なので、必ず明示する。 */
export const WORKER_MODEL = 'sonnet';

/** 作業者層の本体はこの `agents` 定義1個だけ。独自のワーカープールを作らない。 */
export const WORKER_AGENT_NAME = 'worker';

/**
 * runner の子プロセスへ渡さない環境変数。
 *
 * 記憶ストアの鍵（ローカルのパス / DB 接続情報）に加えて、**runner の制御面の鍵**も
 * 落とす。マネージャーが runner の API を叩けると、自分宛の許可確認に自分で
 * `allow` を返せてしまう — クローンも人間も通らずに権限境界を迂回できる
 * （「マネージャーから見たユーザーはクローン」という配線が崩れる）。
 *
 * ここは**二重の底**である。本命は実行環境の分離（別コンテナ・別 UID・鍵の非配布）で、
 * ここはその内側でもう一枚落としているだけ。**ここだけを頼りにしないこと。**
 */
export const WITHHELD_ENV_KEYS = [
  'ALTEROID_HOME',
  'ALTEROID_PORT',
  'ALTEROID_DATABASE_URL',
  'ALTEROID_RUNNER_TOKEN',
  'ALTEROID_RUNNER_TOKEN_SHA256',
  'ALTEROID_RUNNER_SOCKET',
] as const;

/**
 * SDK 子プロセス（マネージャーと作業者）を走らせる UID。
 *
 * **同じ UID で走らせると、子プロセスは runner の `/proc/1/environ` を読み、
 * 制御面の鍵も、Unix ソケットへの接続権も手に入れる。** 分けて初めて、
 * 「マネージャーは自分の許可確認に答えられない」が構造として成立する。
 *
 * 落とすには特権が要るので、runner 本体は root で走る（子だけを降ろす）。
 * 特権が無いのに設定されていたら、黙って同じ UID で走らせずに落とすこと —
 * 境界があるつもりで無い状態が、いちばん危ない。
 */
export interface RunnerChildUser {
  uid: number;
  gid: number;
  /** 子プロセスの `HOME`。root の home を渡すと書けずに落ちる。 */
  home?: string;
}

export interface RunnerHostOptions {
  /** 安定した識別子。デーモンが `manager_id → runner_id` を台帳に残す。 */
  runnerId: string;
  /** 出来事の出口。デーモンが繋いでいなければ溜めておく（呼び出し側の責任）。 */
  emit: (event: RunnerEvent) => void;
  /** この runner の作業ディレクトリ（cwd を省いた委譲の既定）。 */
  workspacePath: string;
  /** 主にテスト用。既定は SDK の `query`。 */
  queryFn?: typeof query;
  /** 主にテスト用。既定は `process.env`。 */
  env?: NodeJS.ProcessEnv;
  /** 主にテスト用。既定は実際の器を測る（`measureCapacity`）。 */
  capacityFn?: (activeManagers: number) => RunnerCapacity;
  /** `WITHHELD_ENV_KEYS` に足して伏せる鍵。 */
  withheldEnvKeys?: readonly string[];
  /** SDK 子プロセスを別 UID で走らせる（コンテナ構成の既定）。 */
  childUser?: RunnerChildUser;
}

export interface RunnerHost {
  readonly runnerId: string;
  readonly workspacePath: string;
  /**
   * いまの資源（配置の材料。roadmap M5）。
   *
   * **定員を返す口ではない。** ここに「あと何本置けるか」を足さないこと — 置ける
   * か否かを器が決め始めた瞬間、それは能力の制限になる（禁止2）。
   */
  capacity(): RunnerCapacity;
  start(command: RunnerStartCommand): Promise<void>;
  resume(command: RunnerResumeCommand): Promise<void>;
  send(managerId: string, text: string): Promise<boolean>;
  answer(managerId: string, answer: RunnerAnswerCommand): Promise<boolean>;
  /** `true` = そのセッションが実際にここに在って、畳んだ。 */
  stop(managerId: string): Promise<boolean>;
  list(): RunnerManagerState[];
  transcript(managerId: string): Promise<string | null>;
  /** 全セッションを畳む。プロセスが消えるときだけ呼ぶ。 */
  shutdown(): Promise<void>;
}

export function createRunnerHost(options: RunnerHostOptions): RunnerHost {
  return new Host(options);
}

class Host implements RunnerHost {
  readonly runnerId: string;
  readonly workspacePath: string;
  readonly #emit: (event: RunnerEvent) => void;
  readonly #queryFn: typeof query;
  readonly #env: NodeJS.ProcessEnv;
  readonly #withheldEnvKeys: readonly string[];
  readonly #childUser: RunnerChildUser | undefined;
  readonly #capacityFn: (activeManagers: number) => RunnerCapacity;
  readonly #sessions = new Map<string, RunnerSession>();

  constructor(options: RunnerHostOptions) {
    this.runnerId = options.runnerId;
    this.workspacePath = options.workspacePath;
    this.#emit = options.emit;
    this.#queryFn = options.queryFn ?? query;
    this.#env = options.env ?? process.env;
    this.#withheldEnvKeys = [...WITHHELD_ENV_KEYS, ...(options.withheldEnvKeys ?? [])];
    this.#childUser = options.childUser;
    this.#capacityFn = options.capacityFn ?? ((active) => measureCapacity(active));
  }

  capacity(): RunnerCapacity {
    return this.#capacityFn(this.#sessions.size);
  }

  #create(managerId: string, request: string, cwd: string): RunnerSession {
    const session = new RunnerSession({
      managerId,
      request,
      cwd: cwd.length > 0 ? cwd : this.workspacePath,
      emit: this.#emit,
      queryFn: this.#queryFn,
      env: this.#env,
      withheldEnvKeys: this.#withheldEnvKeys,
      ...(this.#childUser === undefined ? {} : { childUser: this.#childUser }),
      onClosed: () => this.#sessions.delete(managerId),
    });
    this.#sessions.set(managerId, session);
    return session;
  }

  async start(command: RunnerStartCommand): Promise<void> {
    if (this.#sessions.has(command.managerId)) {
      throw new Error(`${command.managerId} は既に走っている`);
    }
    const session = this.#create(command.managerId, command.request, command.cwd);
    try {
      session.begin(command.request);
    } catch (error) {
      this.#sessions.delete(command.managerId);
      throw error;
    }
  }

  /**
   * 中断されたセッションの続きへ戻す。
   *
   * 既に同じ manager が走っているなら（デーモンだけが再起動した場合）、何もせず
   * 追加の一言だけを流す。**走っているものを resume で作り直さない** — 手を
   * 動かしている最中のマネージャーを二重に起こすことになる。
   */
  async resume(command: RunnerResumeCommand): Promise<void> {
    const alive = this.#sessions.get(command.managerId);
    if (alive) {
      if (command.message !== undefined) alive.push(command.message);
      return;
    }
    const session = this.#create(command.managerId, command.request, command.cwd);
    session.resume(command.sessionId, command.entries, command.message);
  }

  async send(managerId: string, text: string): Promise<boolean> {
    const session = this.#sessions.get(managerId);
    if (!session) return false;
    session.push(text);
    return true;
  }

  async answer(managerId: string, answer: RunnerAnswerCommand): Promise<boolean> {
    const session = this.#sessions.get(managerId);
    if (!session) return false;
    return session.answer(answer);
  }

  /**
   * 1本を畳む。**在ったかどうかを返す。**
   *
   * 「無かった」を成功と区別できないと、デーモンの停止確認が意味を失う — 同じ
   * `runner_id` で作り直された新しい器が、古い器の抱えるセッションについて
   * 「畳んだ」と答えてしまう（`RunnerClient.stop` を見よ）。
   */
  async stop(managerId: string): Promise<boolean> {
    const session = this.#sessions.get(managerId);
    if (session === undefined) return false;
    await session.stop('デーモンから停止を指示された。');
    return true;
  }

  list(): RunnerManagerState[] {
    return [...this.#sessions.values()].map((session) => session.state());
  }

  async transcript(managerId: string): Promise<string | null> {
    return (await this.#sessions.get(managerId)?.transcript()) ?? null;
  }

  async shutdown(): Promise<void> {
    await Promise.all(
      [...this.#sessions.values()].map((session) => session.stop('runner が停止した。')),
    );
    this.#sessions.clear();
  }
}

/** 返事を待って止まっている1件（許可確認 or 質問）。 */
interface PendingRequest {
  id: string;
  kind: 'question' | 'permission';
  summary: string;
  settle: (answer: { message: string; decision?: 'allow' | 'deny' }) => void;
  /** 同じ確認が再送されたときに同じ結果を返すための約束（SDK は再送しうる）。 */
  result: Promise<PermissionResult>;
}

interface RunnerSessionOptions {
  managerId: string;
  request: string;
  cwd: string;
  emit: (event: RunnerEvent) => void;
  queryFn: typeof query;
  env: NodeJS.ProcessEnv;
  withheldEnvKeys: readonly string[];
  childUser?: RunnerChildUser;
  onClosed: () => void;
}

class RunnerSession {
  readonly #id: string;
  readonly #request: string;
  readonly #cwd: string;
  readonly #emit: (event: RunnerEvent) => void;
  readonly #queryFn: typeof query;
  readonly #env: NodeJS.ProcessEnv;
  readonly #withheldEnvKeys: readonly string[];
  readonly #childUser: RunnerChildUser | undefined;
  readonly #onClosed: () => void;

  readonly #input: SDKUserMessage[] = [];
  readonly #pending: PendingRequest[] = [];
  /** resume のために預かった生ログ（SDK の `SessionStore.load` が返す素材）。 */
  #seed: SessionStoreEntry[] | undefined;

  #inputWaiter: (() => void) | null = null;
  #query: Query | null = null;
  #reader: Promise<void> | null = null;
  #status: JobStatus = 'running';
  #sessionId: string | undefined;
  #transcriptPath: string | undefined;
  #stopped = false;

  constructor(options: RunnerSessionOptions) {
    this.#id = options.managerId;
    this.#request = options.request;
    this.#cwd = options.cwd;
    this.#emit = options.emit;
    this.#queryFn = options.queryFn;
    this.#env = options.env;
    this.#withheldEnvKeys = options.withheldEnvKeys;
    this.#childUser = options.childUser;
    this.#onClosed = options.onClosed;
  }

  begin(request: string): void {
    this.push(request);
    this.#open();
  }

  /**
   * 前のセッションの続きから開く。
   *
   * `message` を必ず流すのは、**resume が「開き直す」だけでは仕事が進まない**
   * からである。人間の不在で止まってよいのは承認待ちの仕事だけで（PRD「自律」）、
   * 器が落ちたことを理由に止まったままにはしない。
   */
  resume(sessionId: string, entries: unknown[] | undefined, message: string | undefined): void {
    this.#sessionId = sessionId;
    this.#seed = entries as SessionStoreEntry[] | undefined;
    if (message !== undefined) this.push(message);
    this.#open(sessionId);
  }

  state(): RunnerManagerState {
    return {
      managerId: this.#id,
      status: this.#status,
      cwd: this.#cwd,
      request: this.#request,
      waiting: this.#pending.map((request) => ({
        requestId: request.id,
        summary: request.summary,
      })),
      ...(this.#sessionId === undefined ? {} : { sessionId: this.#sessionId }),
    };
  }

  push(text: string): void {
    if (this.#stopped) return;
    this.#input.push({
      type: 'user',
      message: { role: 'user', content: text },
      parent_tool_use_id: null,
    });
    this.#status = 'running';
    this.#wakeInput();
  }

  /** 返事の宛先は `requestId` で指す。推測しない（取り違えは拒否を承認に変える）。 */
  answer(answer: RunnerAnswerCommand): boolean {
    const pending = this.#pending.find((request) => request.id === answer.requestId);
    if (!pending) return false;
    pending.settle({
      message: answer.message,
      ...(answer.decision === undefined ? {} : { decision: answer.decision }),
    });
    return true;
  }

  async transcript(): Promise<string | null> {
    const path = this.#transcriptPath;
    if (path === undefined) return null;
    try {
      return await readFile(path, 'utf8');
    } catch {
      return null;
    }
  }

  async stop(reason: string): Promise<void> {
    if (this.#stopped) return;
    this.#stopped = true;

    // 止まる前に全文を返す。runner のディスクは器と一緒に消えるので、ここで
    // 渡し損ねると manager_id から生ログへ降りる経路が切れる。
    await this.#shipArchive();
    this.#settleAll(reason);
    this.#wakeInput();
    try {
      this.#query?.close();
    } catch {
      // 既に閉じている
    }
    await this.#reader?.catch(() => undefined);
    this.#onClosed();
  }

  // -------------------------------------------------------------------------
  // SDK セッション
  // -------------------------------------------------------------------------

  #open(resume?: string): void {
    if (this.#query) return;
    const q = this.#queryFn({ prompt: this.#inputStream(), options: this.#buildOptions(resume) });
    this.#query = q;
    this.#reader = this.#read(q);
  }

  #buildOptions(resume?: string): Options {
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
      // 生ログはデーモンへ預ける。runner は永続化の器を持たない（記憶ストアの
      // 鍵を runner に置かないため）。
      sessionStore: this.#sessionStore(),
      ...(resume === undefined ? {} : { resume }),
      // 子プロセスを別 UID へ降ろす。**能力は1つも削らない** — 道具も preset も
      // そのままで、変えるのは実行する主体だけである（実行環境の境界）。
      ...(this.#childUser === undefined
        ? {}
        : { spawnClaudeCodeProcess: (options) => this.#spawnAsChildUser(options) }),
      canUseTool: (toolName, input, extra) => this.#onPermission(toolName, input, extra),
      hooks: {
        PostToolUse: [{ hooks: [(input) => this.#onPostToolUse(input)] }],
        PreCompact: [{ hooks: [(input) => this.#onPreCompact(input)] }],
      },
    };
  }

  /**
   * 生ログの預け先。**runner は DB を知らない。**
   *
   * `append` は上へ流すだけ（永続化はデーモン）。`load` は resume 時にデーモンが
   * 渡してきた素材を返す — runner のディスクに前回の生ログが残っている前提を
   * 置かないための口である（器は作り直される）。
   */
  #sessionStore(): SessionStore {
    return {
      append: async (key: SessionKey, entries: SessionStoreEntry[]) => {
        this.#emit({
          type: 'mirror',
          managerId: this.#id,
          key: {
            projectKey: key.projectKey,
            sessionId: key.sessionId,
            ...(key.subpath === undefined ? {} : { subpath: key.subpath }),
          },
          entries,
        });
        this.#emit({ type: 'project_key', managerId: this.#id, projectKey: key.projectKey });
      },
      load: async (key: SessionKey) => {
        if (key.subpath !== undefined) return null;
        return this.#seed ?? null;
      },
    };
  }

  /**
   * SDK の子プロセスを別 UID で起こす。
   *
   * `HOME` を差し替えるのは、root の home のまま降ろすと設定を書けずに落ちるから
   * である。**能力を削るのではなく、走らせる主体を変えているだけ**であることに注意。
   */
  #spawnAsChildUser(options: {
    command: string;
    args: string[];
    cwd?: string;
    env: Record<string, string | undefined>;
    signal: AbortSignal;
  }) {
    const user = this.#childUser as RunnerChildUser;
    return spawn(options.command, options.args, {
      ...(options.cwd === undefined ? {} : { cwd: options.cwd }),
      env: {
        ...options.env,
        ...(user.home === undefined ? {} : { HOME: user.home }),
      },
      signal: options.signal,
      stdio: ['pipe', 'pipe', 'pipe'],
      uid: user.uid,
      gid: user.gid,
    });
  }

  /** 記憶ストアの所在は子プロセスへ渡さない（渡さなければ構造的に触れない）。 */
  #childEnv(): NodeJS.ProcessEnv {
    const env = { ...this.#env };
    for (const key of this.#withheldEnvKeys) delete env[key];
    return env;
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
        this.#dispatch(message);
      }
      if (!this.#stopped) await this.#finish('done', 'マネージャーのセッションが閉じた。');
    } catch (error) {
      await this.#finish('failed', `マネージャーのセッションが落ちた: ${String(error)}`);
    }
  }

  #dispatch(message: SDKMessage): void {
    if (message.type === 'system' && message.subtype === 'init') {
      this.#sessionId = message.session_id;
      this.#emit({ type: 'session', managerId: this.#id, sessionId: message.session_id });
      return;
    }

    if (message.type !== 'result') return;

    const text = resultText(message);
    this.#status = this.#pending.length > 0 ? 'waiting_human' : 'done';
    this.#emit({ type: 'report', managerId: this.#id, text, status: this.#status });
  }

  async #finish(status: JobStatus, reason: string): Promise<void> {
    this.#stopped = true;
    this.#settleAll(reason);
    // 読み取りが終わっても入力側を起こして本体を閉じる。怠ると閉じられない
    // Query と起きない `#inputStream` が残る。
    this.#wakeInput();
    try {
      this.#query?.close();
    } catch {
      // 既に閉じている
    }
    this.#status = status;
    await this.#shipArchive();
    this.#emit({ type: 'closed', managerId: this.#id, status, reason });
    this.#onClosed();
  }

  // -------------------------------------------------------------------------
  // 配線 — マネージャーから見た「ユーザー」はクローン
  // -------------------------------------------------------------------------

  /**
   * 許可確認と `AskUserQuestion` をデーモン（＝クローン）へ回す。
   *
   * ここは追加の関門ではない。人間が画面越しに受け取っていた確認が、そのまま
   * クローンへ届くだけである。だから既定の `permissionMode` を触らず、待ち時間にも
   * 上限を置かない — 止まるのはこの1件だけで、他は走り続ける。
   */
  async #onPermission(
    toolName: string,
    input: Record<string, unknown>,
    extra: { signal: AbortSignal; requestId?: string; toolUseID?: string },
  ): Promise<PermissionResult> {
    // SDK は同じ確認を再送しうる。id を SDK 側の識別子に揃えて、再送では新しい
    // 待ちを積まずに同じ結果を返す（二重に消費されると片方が永久に返らない）。
    const id = extra.requestId ?? extra.toolUseID ?? randomUUID();
    const already = this.#pending.find((request) => request.id === id);
    if (already) return already.result;

    const kind = toolName === 'AskUserQuestion' ? 'question' : 'permission';
    const summary =
      kind === 'question' ? describeQuestions(input) : `${toolName} の実行許可: ${brief(input)}`;

    let settle!: PendingRequest['settle'];
    const answered = new Promise<{ message: string; decision?: 'allow' | 'deny' }>((resolve) => {
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
      summary,
      result,
      // **待ち行列から自分を外すのは settle の責任**。呼び出し側任せにすると、
      // 中断で解けた1件が行列に残り、次に届いた言葉を食い潰す。
      settle: (value) => {
        if (done) return;
        done = true;
        unlisten();
        const at = this.#pending.indexOf(request);
        if (at !== -1) this.#pending.splice(at, 1);
        if (this.#status === 'waiting_human' && this.#pending.length === 0) {
          this.#status = 'running';
        }
        this.#emit({ type: 'settled', managerId: this.#id, requestId: id });
        settle(value);
      },
    };

    this.#pending.push(request);
    this.#status = 'waiting_human';

    // マネージャー側で中断されたら宙吊りにしない。
    const onAbort = () =>
      request.settle({ message: 'マネージャー側で中断された。', decision: 'deny' });
    if (extra.signal.aborted) {
      onAbort();
    } else {
      extra.signal.addEventListener('abort', onAbort, { once: true });
      unlisten = () => extra.signal.removeEventListener('abort', onAbort);
    }

    this.#emit({ type: 'ask', managerId: this.#id, requestId: id, kind, summary });

    return result;
  }

  /** マネージャーと作業者の全ツール実行をデーモンの日誌へ（監査）。 */
  async #onPostToolUse(input: unknown): Promise<{ continue: true }> {
    const hook = input as {
      tool_name?: string;
      tool_input?: unknown;
      transcript_path?: string;
      agent_id?: string;
      agent_type?: string;
    };

    if (typeof hook.transcript_path === 'string') this.#transcriptPath = hook.transcript_path;

    this.#emit({
      type: 'tool_use',
      managerId: this.#id,
      actor:
        hook.agent_id === undefined
          ? `manager:${this.#id}`
          : `worker:${this.#id}:${hook.agent_type ?? WORKER_AGENT_NAME}`,
      tool: hook.tool_name ?? '(不明)',
      input: hook.tool_input,
    });

    return { continue: true };
  }

  /** 要約に潰される前に全文を上げる（監査は日誌＋アーカイブで担保する）。 */
  async #onPreCompact(input: unknown): Promise<{ continue: true }> {
    const { transcript_path: path } = input as { transcript_path?: string };
    if (typeof path === 'string' && path.length > 0) this.#transcriptPath = path;
    await this.#shipArchive();
    return { continue: true };
  }

  async #shipArchive(): Promise<void> {
    const body = await this.transcript();
    if (body === null || body.length === 0) return;
    this.#emit({ type: 'archive', managerId: this.#id, body });
  }

  /** 待たせたまま消えない。止まっている確認は理由付きで全部解く。 */
  #settleAll(reason: string): void {
    for (const request of [...this.#pending]) {
      request.settle({ message: reason, decision: 'deny' });
    }
    this.#pending.length = 0;
  }
}

// ---------------------------------------------------------------------------
// 小道具
// ---------------------------------------------------------------------------

function resultText(message: SDKMessage): string {
  const candidate = message as { result?: unknown; subtype?: string };
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
 *
 * 日本語を語境界（`\s` や `\b`）で探してはいけない。「それはやめて」の「やめ」の
 * 前に区切りは無く、探せていないことが**承認**として表に出る。
 */
export function inferDecision(message: string): 'allow' | 'deny' {
  if (DENIAL_PHRASES.some((phrase) => message.includes(phrase))) return 'deny';
  return DENIAL_WORDS.test(message) ? 'deny' : 'allow';
}

export function brief(value: unknown, limit = 200): string {
  const text = typeof value === 'string' ? value : JSON.stringify(value);
  if (text === undefined) return '';
  return text.length > limit ? `${text.slice(0, limit)}…` : text;
}
