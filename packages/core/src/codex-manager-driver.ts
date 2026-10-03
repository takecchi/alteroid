/**
 * マネージャーのセッションの駆動役の Codex 実装（#486 M7 段 S6 PR-B）。
 *
 * `agent-session.ts` の中立の口（{@link AgentManagerDriver}）の裏で、`codex app-server`
 * （stdio・行区切り JSON-RPC）を子プロセスとして起こし、`initialize` → 認証 →
 * `thread/start`（resume があれば `thread/resume`）→ 入力1件ごとの `turn/start` を回す。
 * 通知を中立の {@link AgentEvent} へ畳み、承認の server request を `spec.onPermission` へ回す。
 *
 * **使う部品は S4 が作ったもの**（JSON-RPC は `codex-app-server-client.ts`、型は
 * `codex-protocol.ts`、鍵の選び方は `codex-auth.ts`、承認の写しは `codex-approval.ts`、
 * 単価は `codex-pricing.ts`、台帳への写しは `codex-usage-ledger.ts`）。
 * **Codex の綴りを読むのはこのファイルまで**で、中立の側（`agent-*.ts`）へは漏らさない。
 *
 * ## 決めたこと（オーナー決定 2026-10-02）
 *
 * - **サンドボックス**: `thread/start` / `thread/resume` へ `sandbox = "danger-full-access"` を
 *   与える。器の中で Codex のサンドボックスが動かない（CI の器では bwrap が NG だった）ため。
 *   境界はコンテナと別ユーザー UID（`spec.spawnProcess`）で、Claude Code と同じ扱い。
 *   `approvalPolicy` は権限モードから写す（{@link codexApprovalPolicyFor}）。
 * - **ephemeral**: API キーで認証するときだけ、app-server を
 *   `-c cli_auth_credentials_store="ephemeral"` で起動し、`account/login/start` で鍵を渡す
 *   （鍵が `CODEX_HOME/auth.json` に書かれない）。**ChatGPT ログインのときは ephemeral にしない。**
 *   ephemeral の保存先は読み込み側もプロセス内のメモリだけで `auth.json` を読まない
 *   （openai/codex rust-v0.160.0 `login/src/auth/storage.rs` の `EphemeralAuthStorage::load`）
 *   ので、付けると既存の ChatGPT ログインが見えなくなる。
 * - **鍵の値は、ログ・例外文・イベントのどこにも載せない。** 載るのは `account/login/start` の
 *   params（子の stdin）だけ。外へ出る文は {@link CodexManagerDriver} の `scrub` を通す。
 * - **中断**: 中立の判断に interrupt は足さない。deny は `decline`。`close()` は進行中の
 *   ターンがあれば `turn/interrupt` を best-effort で送ってから子を止める。
 * - **クローンへ回すのは command / fileChange の承認だけ。** MCP elicitation は内容を持てず
 *   accept を作れないので即座に `decline`、`item/permissions/requestApproval` は allow を
 *   写せないので空の付与、`item/tool/requestUserInput` は JSON-RPC エラーで答える。
 *   どれも止まらずに答え、**日誌の note（`spec.onNote`）で観測を残す**（`permission_denied` にはしない。拒否の累積・クローンへの通知に、クローンが拒否していないものが混ざるため）（嘘の確認を出さない）。
 * - **モデル**: 人間が `ALTEROID_MANAGER_MODEL` を置いたとき（`spec.modelPlaced`）だけ
 *   `thread/start` に model を渡す。置かなければ渡さず Codex の既定（Claude のモデル id を
 *   Codex へ渡さない）。作業者モデルは使わない（subagents=false）。
 * - **使用量**: 価格には app-server が返した実際のモデル名（`thread/start` / `thread/resume`
 *   の応答、`model/rerouted` で更新）を使う。`thread/tokenUsage/updated` の `last` を通知ごとに
 *   集め（`total` は使わない）、モデルごとに {@link codexUsageToLedgerTotals} で台帳の形にする。
 *   **台帳の「累積」の約束に合わせ、このセッション（`open()` 1回）の開始からの累積**を
 *   `turn_ended.usage` と `sessionModelUsage()` で返す。
 */

import { spawn } from 'node:child_process';

import type { AgentContentBlock, AgentEvent } from './agent-events.js';
import type { AgentPermissionRequest } from './agent-session.js';
import type {
  AgentChildProcess,
  AgentContextUsage,
  AgentManagerDriver,
  AgentManagerSession,
  AgentManagerSessionSpec,
  AgentSpawnOptions,
  AgentSpawnProcess,
} from './agent-session.js';
import { mapCodexApproval } from './codex-approval.js';
import {
  CodexAppServerClient,
  CodexAppServerClosedError,
  CodexRpcError,
  type CodexAppServerClientError,
} from './codex-app-server-client.js';
import {
  buildCodexApiKeyLoginParams,
  codexAuthModeFromAccount,
  selectCodexAuth,
} from './codex-auth.js';
import {
  CODEX_RPC_ERROR_CODES,
  type CodexApprovalPolicy,
  type CodexSandboxMode,
  type CodexThreadItem,
  type CodexTurn,
  type CodexTokenUsageBreakdown,
  type CodexCommandExecutionApprovalResponse,
  type CodexFileChangeApprovalResponse,
  type CodexMcpElicitationResponse,
  type CodexPermissionsApprovalResponse,
} from './codex-protocol.js';
import type { CodexUsageForPricing } from './codex-pricing.js';
import { codexUsageToLedgerTotals } from './codex-usage-ledger.js';
import type { PermissionModeName } from './permission-mode.js';
import { redactErrorText } from './redact.js';
import type { UsageTotals } from './usage.js';

/** Codex のサンドボックス。器の中で動かないので、境界はコンテナと別 UID に任せる（上の doc）。 */
export const CODEX_SANDBOX: CodexSandboxMode = 'danger-full-access';

/** API キーで認証するときだけ app-server へ渡す設定（`-c` の値。TOML 文字列）。 */
export const CODEX_EPHEMERAL_AUTH_OVERRIDE = 'cli_auth_credentials_store="ephemeral"';

/** 袋から鍵を読む名前（`credentials.ts` の `ROTATABLE_CREDENTIAL_KEYS`）。 */
export const CODEX_API_KEY_ENV_NAME = 'CODEX_API_KEY';

/**
 * 権限モードから Codex の `approvalPolicy` へ。**純粋関数。**
 *
 * Claude 側で「聞かない」に当たるのは `bypassPermissions` だけなので `never`。それ以外は
 * `on-request`。**`dontAsk` を `never` にしない** — Claude の `dontAsk` は「確認せずに
 * 許可されていないものを拒否」で、Codex の `never`（確認せずに実行）とは逆向きになる。
 */
export function codexApprovalPolicyFor(mode: PermissionModeName): CodexApprovalPolicy {
  return mode === 'bypassPermissions' ? 'never' : 'on-request';
}

/** `codex` の引数。**`-c` は subcommand の前に置く**（root の config override として app-server へ届く）。 */
export function buildCodexAppServerArgs(options: { ephemeralCredentials: boolean }): string[] {
  return [
    ...(options.ephemeralCredentials ? ['-c', CODEX_EPHEMERAL_AUTH_OVERRIDE] : []),
    'app-server',
    '--listen',
    'stdio://',
  ];
}

/** 中立の承認に回す道具名（Codex の item の種類のまま。Claude の道具名には寄せない）。 */
const TOOL_NAME_COMMAND = 'commandExecution';
const TOOL_NAME_FILE_CHANGE = 'fileChange';

/** item のうち、道具の実行に当たるもの（`tool_use` / `tool_result` に畳む）。 */
const TOOL_ITEM_TYPES: ReadonlySet<string> = new Set([
  'commandExecution',
  'fileChange',
  'mcpToolCall',
  'dynamicToolCall',
  'webSearch',
]);

const DEFAULT_CLOSE_GRACE_MS = 1500;

export interface CodexManagerDriverOptions {
  /** 起動するコマンド。既定は `codex`（器の PATH にある）。 */
  command?: string;
  /** `spec.spawnProcess` が無いときの起こし方（テスト用の差し替え口）。既定は同じ UID で `spawn`。 */
  defaultSpawn?: AgentSpawnProcess;
  /** `initialize` の `clientInfo.version`。 */
  clientVersion?: string;
  /** 接続を止めない異常（読み飛ばした行など）の知らせ先。既定は捨てる。値は scrub 済み。 */
  onClientError?: (error: { kind: string }) => void;
  /** `close()` が `turn/interrupt` を送ってから子へ TERM を送るまでの猶予。既定 1500ms。 */
  closeGraceMs?: number;
}

/**
 * 子の env。**`CODEX_API_KEY` は外す**（鍵は `account/login/start` で渡すので子に要らず、
 * モデルが実行するシェルから読めないようにする）。他（`ALTEROID_CODEX_API_KEY_FILE` 等）は
 * Claude 側と同じく素通し。
 */
export function childEnvOf(env: NodeJS.ProcessEnv): Record<string, string | undefined> {
  const out: Record<string, string | undefined> = { ...env };
  delete out[CODEX_API_KEY_ENV_NAME];
  return out;
}

function defaultSpawnProcess(options: AgentSpawnOptions): AgentChildProcess {
  return spawn(options.command, options.args, {
    ...(options.cwd === undefined ? {} : { cwd: options.cwd }),
    env: options.env as NodeJS.ProcessEnv,
    signal: options.signal,
    stdio: ['pipe', 'pipe', 'pipe'],
  });
}

interface Deferred<T> {
  readonly promise: Promise<T>;
  resolve(value: T): void;
  reject(error: unknown): void;
}

function deferred<T>(): Deferred<T> {
  let resolve!: (value: T) => void;
  let reject!: (error: unknown) => void;
  const promise = new Promise<T>((res, rej) => {
    resolve = res;
    reject = rej;
  });
  return { promise, resolve, reject };
}

export class CodexManagerDriver implements AgentManagerDriver {
  readonly providerId = 'codex';
  readonly #options: CodexManagerDriverOptions;

  constructor(options: CodexManagerDriverOptions = {}) {
    this.#options = options;
  }

  open(spec: AgentManagerSessionSpec): AgentManagerSession {
    return new CodexManagerSession(spec, this.#options);
  }
}

/** 送り出すイベント1件と、「消費側が処理し終えた」合図。 */
interface QueuedEvent {
  readonly event: AgentEvent;
  readonly done: Deferred<void>;
}

class CodexManagerSession implements AgentManagerSession {
  readonly #spec: AgentManagerSessionSpec;
  readonly #options: CodexManagerDriverOptions;
  readonly #abort = new AbortController();
  readonly #apiKey: string | undefined;
  readonly #queue: QueuedEvent[] = [];
  #queueWaiter: Deferred<void> | undefined;
  #producerFinished = false;
  #producerError: unknown;
  #started = false;
  #closing = false;
  readonly #closed = deferred<void>();

  #child: AgentChildProcess | undefined;
  #client: CodexAppServerClient | undefined;
  #threadId: string | undefined;
  /** 進行中のターン（無ければ `undefined`）。 */
  #turn: { id: string | undefined; done: Deferred<CodexTurn>; lastText: string } | undefined;

  /** 実際のモデル名（`thread/start` の応答、`model/rerouted` で更新）。 */
  #model: string | undefined;
  /** モデルごとの `last` の列（リクエスト単位）。 */
  readonly #requests = new Map<string, CodexUsageForPricing[]>();
  #inputIterator: AsyncIterator<{ text: string }> | undefined;

  constructor(spec: AgentManagerSessionSpec, options: CodexManagerDriverOptions) {
    this.#spec = spec;
    this.#options = options;
    const raw = spec.env[CODEX_API_KEY_ENV_NAME];
    const trimmed = typeof raw === 'string' ? raw.trim() : '';
    this.#apiKey = trimmed === '' ? undefined : trimmed;
  }

  // -------------------------------------------------------------------------
  // 中立の口
  // -------------------------------------------------------------------------

  async readEvents(onEvent: (event: AgentEvent) => Promise<void>): Promise<void> {
    if (this.#started) throw new Error('readEvents は1セッションにつき1回だけ呼べる');
    this.#started = true;

    const producer = this.#produce().then(
      () => undefined,
      (error: unknown) => {
        this.#producerError = error;
      },
    );
    void producer.then(() => {
      this.#producerFinished = true;
      this.#queueWaiter?.resolve();
    });

    try {
      for (;;) {
        const next = this.#queue.shift();
        if (next === undefined) {
          if (this.#producerFinished) break;
          this.#queueWaiter = deferred<void>();
          await this.#queueWaiter.promise;
          this.#queueWaiter = undefined;
          continue;
        }
        try {
          await onEvent(next.event);
        } finally {
          next.done.resolve();
        }
      }
    } catch (error) {
      // 消費側が投げた。子を止めて、待っている生産側を解き放つ。
      this.#shutdown();
      this.#releaseQueue();
      throw error;
    }
    await producer;
    if (this.#producerError !== undefined) throw this.#producerError;
  }

  close(): void {
    if (this.#closing) return;
    this.#closing = true;
    this.#closed.resolve();
    // 進行中のターンがあれば、止める前に中断を送る（best-effort。答えは待たない）。
    const client = this.#client;
    const threadId = this.#threadId;
    const turnId = this.#turn?.id;
    let interrupted = false;
    if (
      client !== undefined &&
      !client.isClosed &&
      threadId !== undefined &&
      turnId !== undefined
    ) {
      client.request('turn/interrupt', { threadId, turnId }).catch(() => undefined);
      interrupted = true;
    }
    this.#shutdown(interrupted ? (this.#options.closeGraceMs ?? DEFAULT_CLOSE_GRACE_MS) : 0);
    this.#releaseQueue();
  }

  async contextUsage(): Promise<AgentContextUsage> {
    // Codex は文脈の使用状況を `AgentContextUsage` の必須欄（自動圧縮の有無など）で返さない。
    // 作り物を返さず、取れないことを呼び出し側（best-effort）へ伝える。
    throw new Error('Codex は文脈の使用状況（context usage）を提供しない');
  }

  async sessionModelUsage(): Promise<Record<string, UsageTotals> | undefined> {
    return this.#cumulativeModels();
  }

  // -------------------------------------------------------------------------
  // 生産側（app-server とのやり取り）
  // -------------------------------------------------------------------------

  async #produce(): Promise<void> {
    if (this.#closing) return;
    const spec = this.#spec;
    const spawnProcess = spec.spawnProcess ?? this.#options.defaultSpawn ?? defaultSpawnProcess;
    const hasApiKey = this.#apiKey !== undefined;
    const child = spawnProcess({
      command: this.#options.command ?? 'codex',
      args: buildCodexAppServerArgs({ ephemeralCredentials: hasApiKey }),
      cwd: spec.cwd,
      env: childEnvOf(spec.env),
      signal: this.#abort.signal,
    });
    this.#child = child;
    // stderr は読まない（読まれないパイプは詰まって子を止める）。捨てるだけ。
    (child as { stderr?: { resume?: () => void } }).stderr?.resume?.();
    // 起動そのものの失敗（`error`）は client が閉じとして拾う。
    const client = new CodexAppServerClient(child, {
      onError: (error) => this.#options.onClientError?.({ kind: describeClientError(error) }),
    });
    this.#client = client;
    this.#registerHandlers(client);

    try {
      if (this.#closing) return;
      const init = await this.#guard(
        client.initialize({
          name: 'alteroid',
          title: 'alteroid',
          version: this.#options.clientVersion ?? '0',
        }),
      );
      await this.#authenticate(client);
      await this.#openThread(client, init.userAgent);
      await this.#runTurns(client);
    } catch (error) {
      if (this.#closing) return; // 自分で閉じた。
      throw this.#sanitize(error);
    } finally {
      // close() が済んでいれば、中断の猶予つきの止め方を台無しにしない。
      if (!this.#closing) this.#shutdown();
    }
  }

  /** 閉じられた（自分から・子の終了）なら、その理由で待ちを打ち切る。 */
  async #guard<T>(promise: Promise<T>): Promise<T> {
    const client = this.#client;
    if (client === undefined) return promise;
    const closedBy = client.closed.then((reason): never => {
      throw reason;
    });
    const closedLocally = this.#closed.promise.then((): never => {
      throw new CodexAppServerClosedError('セッションを閉じた');
    });
    // どちらの Promise も、負けた側の reject が未処理にならないよう握る。
    closedBy.catch(() => undefined);
    closedLocally.catch(() => undefined);
    return Promise.race([promise, closedBy, closedLocally]);
  }

  async #authenticate(client: CodexAppServerClient): Promise<void> {
    if (this.#apiKey !== undefined) {
      const choice = selectCodexAuth({ apiKey: this.#apiKey, chatgptLogin: false });
      if (choice.kind !== 'apiKey') throw new Error('Codex の認証の選び方が不整合');
      await this.#guard(
        client.request('account/login/start', buildCodexApiKeyLoginParams(choice.apiKey)),
      );
      return;
    }
    // 鍵が無い: 既存の ChatGPT ログイン（`CODEX_HOME`）があるかを app-server に聞く。
    const account = await this.#guard(client.request('account/read', { refreshToken: false }));
    const choice = selectCodexAuth({
      apiKey: undefined,
      chatgptLogin: codexAuthModeFromAccount(account) === 'chatgpt',
    });
    if (choice.kind === 'none') throw new Error(choice.reason);
  }

  async #openThread(client: CodexAppServerClient, userAgent: string): Promise<void> {
    const spec = this.#spec;
    const common = {
      cwd: spec.cwd,
      approvalPolicy: codexApprovalPolicyFor(spec.permissionMode),
      sandbox: CODEX_SANDBOX,
      developerInstructions: spec.systemPromptAppend,
      ...(spec.modelPlaced === true ? { model: spec.model } : {}),
    };
    const response =
      spec.resume === undefined
        ? await this.#guard(client.request('thread/start', common))
        : await this.#guard(client.request('thread/resume', { threadId: spec.resume, ...common }));
    this.#threadId = response.thread.id;
    this.#model = response.model;
    await this.#emit({
      type: 'session_started',
      sessionId: response.thread.id,
      runtime: {
        sessionId: response.thread.id,
        model: response.model,
        agentVersion: userAgent,
        // 資格の出どころ（名前だけ。値は載せない）。
        apiKeySource: this.#apiKey === undefined ? 'chatgpt' : CODEX_API_KEY_ENV_NAME,
        permissionMode: response.approvalPolicy,
        mcpServers: null,
      },
    });
  }

  async #runTurns(client: CodexAppServerClient): Promise<void> {
    const threadId = this.#threadId;
    if (threadId === undefined) return;
    const iterator = this.#spec.input[Symbol.asyncIterator]();
    this.#inputIterator = iterator;
    for (;;) {
      if (this.#closing) return;
      const next = await this.#guard(iterator.next());
      if (next.done === true) return;

      const turn = {
        id: undefined as string | undefined,
        done: deferred<CodexTurn>(),
        lastText: '',
      };
      this.#turn = turn;
      let started;
      try {
        started = await this.#guard(
          client.request('turn/start', {
            threadId,
            input: [{ type: 'text', text: next.value.text, text_elements: [] }],
          }),
        );
      } catch (error) {
        if (error instanceof CodexRpcError) {
          // このターンだけの失敗（モデルが無い等）。次の入力を待つ。
          this.#turn = undefined;
          await this.#emit(this.#failedTurnEvent(this.#sanitizeText(error.message), 'rpc_error'));
          continue;
        }
        throw error;
      }
      turn.id ??= started.turn.id;
      const finished = await this.#guard(turn.done.promise);
      this.#turn = undefined;
      // `turn_ended` を消費側が処理し終えるまで、次の入力を引かない（SDK の順序に合わせる）。
      await this.#emit(this.#turnEndedEvent(finished, turn.lastText));
    }
  }

  // -------------------------------------------------------------------------
  // 通知・server request
  // -------------------------------------------------------------------------

  #registerHandlers(client: CodexAppServerClient): void {
    client.onNotificationOf('item/started', ({ item }) => {
      if (TOOL_ITEM_TYPES.has(item.type)) {
        void this.#emit({
          type: 'assistant_message',
          parentToolUseId: null,
          blocks: [{ type: 'tool_use', name: item.type }],
          id: item.id,
        });
      }
    });
    client.onNotificationOf('item/completed', ({ item }) => this.#onItemCompleted(item));
    client.onNotificationOf('item/agentMessage/delta', ({ delta }) => {
      if (delta.length > 0) void this.#emit({ type: 'text_delta', text: delta });
    });
    client.onNotificationOf('thread/tokenUsage/updated', ({ tokenUsage }) => {
      this.#recordLast(tokenUsage.last);
    });
    client.onNotificationOf('model/rerouted', ({ toModel }) => {
      // 以後のリクエストは、実際に応じたモデルの単価で数える。
      if (typeof toModel === 'string' && toModel.length > 0) this.#model = toModel;
    });
    client.onNotificationOf('turn/completed', ({ turn }) => {
      const current = this.#turn;
      if (current === undefined) return;
      if (current.id !== undefined && current.id !== turn.id) return; // 前のターンの遅れた通知
      current.id = turn.id;
      current.done.resolve(turn);
    });
    client.onNotificationOf('turn/started', ({ turn }) => {
      if (this.#turn !== undefined) this.#turn.id ??= turn.id;
    });

    client.setServerRequestHandler('item/commandExecution/requestApproval', async (context) => {
      const { params } = context;
      const decision = await this.#spec.onPermission({
        requestId: params.approvalId ?? params.itemId,
        kind: 'permission',
        toolName: TOOL_NAME_COMMAND,
        input: {
          ...(params.command == null ? {} : { command: params.command }),
          ...(params.cwd == null ? {} : { cwd: params.cwd }),
          ...(params.reason == null ? {} : { reason: params.reason }),
        },
        signal: context.signal,
      } satisfies AgentPermissionRequest);
      return answerOf(
        mapCodexApproval('item/commandExecution/requestApproval', decision),
      ) as CodexCommandExecutionApprovalResponse;
    });
    client.setServerRequestHandler('item/fileChange/requestApproval', async (context) => {
      const { params } = context;
      const decision = await this.#spec.onPermission({
        requestId: params.itemId,
        kind: 'permission',
        toolName: TOOL_NAME_FILE_CHANGE,
        input: {
          ...(params.reason == null ? {} : { reason: params.reason }),
          ...(params.grantRoot == null ? {} : { grantRoot: params.grantRoot }),
        },
        signal: context.signal,
      } satisfies AgentPermissionRequest);
      return answerOf(
        mapCodexApproval('item/fileChange/requestApproval', decision),
      ) as CodexFileChangeApprovalResponse;
    });

    // ---- 以下はクローンへ回さない。止まらずに答え、観測を残す（上の doc）。 ----
    client.setServerRequestHandler('mcpServer/elicitation/request', (context) => {
      const server = context.params.serverName;
      this.#note(
        `Codex: MCP サーバー「${server}」からの入力要求（elicitation）に、クローンへ回さず decline で答えた。` +
          `alteroid の判断の型は内容を持てず accept を作れない`,
      );
      return answerOf(
        mapCodexApproval('mcpServer/elicitation/request', {
          behavior: 'deny',
          message: 'alteroid は MCP の elicitation に答えられない',
        }),
      ) as CodexMcpElicitationResponse;
    });
    client.setServerRequestHandler('item/permissions/requestApproval', () => {
      this.#note(
        'Codex: 追加の権限の付与要求（item/permissions/requestApproval）に、クローンへ回さず空の付与で答えた。' +
          'alteroid の「許可」は何を付与するかを持たない',
      );
      return answerOf(
        mapCodexApproval('item/permissions/requestApproval', {
          behavior: 'deny',
          message: 'alteroid は追加の権限を付与できない',
        }),
      ) as CodexPermissionsApprovalResponse;
    });
    client.setServerRequestHandler('item/tool/requestUserInput', (context) => {
      const count = context.params.questions.length;
      this.#note(
        `Codex: モデルからの質問（item/tool/requestUserInput、${count} 件）に、JSON-RPC エラーで答えた。人間へ回す口が無い`,
      );
      throw new CodexRpcError({
        code: CODEX_RPC_ERROR_CODES.methodNotFound,
        message:
          'alteroid は item/tool/requestUserInput に答えられない（質問を人間へ回す口が無い）',
      });
    });
  }

  #onItemCompleted(item: CodexThreadItem): void {
    if (item.type === 'agentMessage') {
      const text =
        typeof (item as { text?: unknown }).text === 'string'
          ? (item as { text: string }).text
          : '';
      if (this.#turn !== undefined) this.#turn.lastText = text;
      const blocks: AgentContentBlock[] =
        text.length > 0 ? [{ type: 'text', text }] : [{ type: 'other' }];
      void this.#emit({ type: 'assistant_message', parentToolUseId: null, blocks, id: item.id });
      return;
    }
    if (TOOL_ITEM_TYPES.has(item.type)) void this.#emit({ type: 'tool_result' });
  }

  #recordLast(last: CodexTokenUsageBreakdown): void {
    const model = this.#model;
    // モデル名が分からない回は、名前の無い箱へ。価格は「読めなかった」になる（推測しない）。
    const key = model ?? '';
    const list = this.#requests.get(key) ?? [];
    list.push({
      inputTokens: last.inputTokens,
      cachedInputTokens: last.cachedInputTokens,
      outputTokens: last.outputTokens,
      reasoningOutputTokens: last.reasoningOutputTokens,
      totalTokens: last.totalTokens,
    });
    this.#requests.set(key, list);
  }

  // -------------------------------------------------------------------------
  // 中立イベント
  // -------------------------------------------------------------------------

  #cumulativeModels(): Record<string, UsageTotals> | undefined {
    if (this.#requests.size === 0) return undefined;
    const models: Record<string, UsageTotals> = {};
    for (const [model, requests] of this.#requests) {
      models[model === '' ? 'unknown' : model] = codexUsageToLedgerTotals(
        model === '' ? undefined : model,
        { kind: 'requests', requests },
      );
    }
    return models;
  }

  #turnEndedEvent(turn: CodexTurn, lastText: string): AgentEvent {
    if (turn.status === 'completed') {
      const models = this.#cumulativeModels();
      return {
        type: 'turn_ended',
        succeeded: true,
        body: lastText,
        errorLines: [],
        ...(models === undefined
          ? {}
          : {
              usage: {
                models,
                ...(this.#threadId === undefined ? {} : { sessionId: this.#threadId }),
              },
            }),
        id: turn.id,
        denials: [],
      };
    }
    const message = turn.error?.message;
    const text = this.#sanitizeText(
      typeof message === 'string' && message.length > 0
        ? message
        : `ターンが ${turn.status} で終わった`,
    );
    return this.#failedTurnEvent(text, turn.status, turn.id);
  }

  #failedTurnEvent(text: string, code: string, id?: string): AgentEvent {
    return {
      type: 'turn_ended',
      succeeded: false,
      failure: { via: 'result_subtype', code, text },
      body: '',
      outcome: code,
      errorLines: [text],
      ...(id === undefined ? {} : { id }),
      denials: [],
    };
  }

  /** 拒否として数えさせない観測（日誌の note）。 */
  #note(text: string): void {
    this.#spec.onNote?.(this.#sanitizeText(text));
  }

  /** イベントを送り出し、消費側が処理し終えたら解決する。閉じていれば捨てる。 */
  #emit(event: AgentEvent): Promise<void> {
    if (this.#closing) return Promise.resolve();
    const entry: QueuedEvent = { event, done: deferred<void>() };
    this.#queue.push(entry);
    this.#queueWaiter?.resolve();
    return entry.done.promise;
  }

  #releaseQueue(): void {
    for (const entry of this.#queue.splice(0)) entry.done.resolve();
  }

  // -------------------------------------------------------------------------
  // 後始末・伏せ字
  // -------------------------------------------------------------------------

  /** 鍵の値と環境変数の秘密を伏せる。**外へ出る文は必ずこれを通す。** */
  #sanitizeText(text: string): string {
    let out = redactErrorText(text, this.#spec.env);
    if (this.#apiKey !== undefined) out = out.split(this.#apiKey).join('[redacted]');
    return out;
  }

  #sanitize(error: unknown): Error {
    if (error instanceof Error) {
      const wrapped = new Error(this.#sanitizeText(error.message));
      wrapped.name = error.name;
      // `cause` は引き継がない（元の例外に鍵が載りうる）。
      if (error instanceof CodexRpcError) {
        Object.assign(wrapped, { code: error.code });
      }
      return wrapped;
    }
    return new Error(this.#sanitizeText(String(error)));
  }

  #shutdown(graceMs = 0): void {
    const iterator = this.#inputIterator;
    this.#inputIterator = undefined;
    // 入力の側は待ちっぱなしのことがある。`return()` は待たない。
    if (iterator?.return !== undefined)
      void Promise.resolve(iterator.return()).catch(() => undefined);

    const client = this.#client;
    const child = this.#child;
    client?.close();
    if (child === undefined) return;
    const stop = (): void => {
      if (child.exitCode !== null || child.killed) return;
      try {
        child.kill('SIGTERM');
      } catch {
        // 既に終わっている。
      }
    };
    try {
      child.stdin.end();
    } catch {
      // 既に閉じている。
    }
    if (graceMs <= 0) {
      stop();
    } else {
      const timer = setTimeout(stop, graceMs);
      timer.unref();
      child.once('exit', () => clearTimeout(timer));
    }
  }
}

/** `mapCodexApproval` の結果を応答へ。写せなければ投げる（クライアントが JSON-RPC エラーで答える）。 */
function answerOf(
  mapping:
    | { readonly ok: true; readonly response: unknown }
    | { readonly ok: false; readonly reason: string },
): unknown {
  if (mapping.ok) return mapping.response;
  throw new Error(`承認の判断を Codex の応答へ写せない（${mapping.reason}）`);
}

function describeClientError(error: CodexAppServerClientError): string {
  // 本文（行）は載せない。種類だけ。
  return error.kind;
}
