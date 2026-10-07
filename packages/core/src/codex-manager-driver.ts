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
  AgentUserInput,
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
  type CodexUserInput,
  type CodexTokenUsageBreakdown,
  type CodexCommandExecutionApprovalResponse,
  type CodexFileChangeApprovalResponse,
  type CodexMcpElicitationResponse,
  type CodexPermissionsApprovalResponse,
} from './codex-protocol.js';
import type { CodexUsageForPricing } from './codex-pricing.js';
import { toCodexMcpServersConfig } from './codex-mcp-config.js';
import { foldCodexRateLimits } from './codex-rate-limits.js';
import { isCodexToolItem, toCodexToolAudit } from './codex-tool-audit.js';
import { codexUsageToLedgerTotals } from './codex-usage-ledger.js';
import type { PermissionModeName } from './permission-mode.js';
import { redactErrorText } from './redact.js';
import type { UsageTotals } from './usage.js';

// Codex のサンドボックスを使わない: 器の中で動かない（bwrap が NG）ため、境界はコンテナと別 UID に任せる
export const CODEX_SANDBOX: CodexSandboxMode = 'danger-full-access';

// ChatGPT ログインのときは付けない: ephemeral は auth.json を読まず、既存の ChatGPT ログインが見えなくなるため
export const CODEX_EPHEMERAL_AUTH_OVERRIDE = 'cli_auth_credentials_store="ephemeral"';

export const CODEX_API_KEY_ENV_NAME = 'CODEX_API_KEY';

// dontAsk を never にしない: Claude の dontAsk は確認せずに拒否で、Codex の never（確認せずに実行）と逆向きになるため
export function codexApprovalPolicyFor(mode: PermissionModeName): CodexApprovalPolicy {
  return mode === 'bypassPermissions' ? 'never' : 'on-request';
}

// -c を subcommand の後ろに置かない: root の config override として app-server へ届かなくなるため
export function buildCodexAppServerArgs(options: { ephemeralCredentials: boolean }): string[] {
  return [
    ...(options.ephemeralCredentials ? ['-c', CODEX_EPHEMERAL_AUTH_OVERRIDE] : []),
    'app-server',
    '--listen',
    'stdio://',
  ];
}

const TOOL_NAME_COMMAND = 'commandExecution';
const TOOL_NAME_FILE_CHANGE = 'fileChange';

const DEFAULT_CLOSE_GRACE_MS = 1500;

export interface CodexManagerDriverOptions {
  command?: string;
  defaultSpawn?: AgentSpawnProcess;
  clientVersion?: string;
  onClientError?: (error: { kind: string }) => void;
  closeGraceMs?: number;
}

// CODEX_API_KEY を子の env に残さない: 鍵は account/login/start で渡すので子に要らず、モデルが実行するシェルから読めてしまうため
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

export interface CodexSession extends AgentManagerSession {
  interrupt(): Promise<void>;
}

export function openCodexSession(
  spec: AgentManagerSessionSpec,
  options: CodexManagerDriverOptions = {},
): CodexSession {
  return new CodexManagerSession(spec, options);
}

interface QueuedEvent {
  readonly event: AgentEvent;
  readonly done: Deferred<void>;
}

class CodexManagerSession implements CodexSession {
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
  #turn: { id: string | undefined; done: Deferred<CodexTurn>; lastText: string } | undefined;

  #model: string | undefined;
  #audit: Promise<void> = Promise.resolve();
  #lastInputTokens: number | undefined;
  // thread/compacted と contextCompaction item の二重計上を避けるために数える
  readonly #compactionSignals = new Map<
    string,
    { notification: number; item: number; emitted: number }
  >();
  #rateLimitReached: string | undefined;
  readonly #requests = new Map<string, CodexUsageForPricing[]>();
  #inputIterator: AsyncIterator<{ text: string }> | undefined;

  constructor(spec: AgentManagerSessionSpec, options: CodexManagerDriverOptions) {
    this.#spec = spec;
    this.#options = options;
    const raw = spec.env[CODEX_API_KEY_ENV_NAME];
    const trimmed = typeof raw === 'string' ? raw.trim() : '';
    this.#apiKey = trimmed === '' ? undefined : trimmed;
  }

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
    // turn/interrupt の答えを待たない: best-effort で送ってから子を止めるため
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

  async interrupt(): Promise<void> {
    const client = this.#client;
    const threadId = this.#threadId;
    const turnId = this.#turn?.id;
    if (client === undefined || client.isClosed || threadId === undefined || turnId === undefined) {
      return;
    }
    await this.#guard(client.request('turn/interrupt', { threadId, turnId }));
  }

  async contextUsage(): Promise<AgentContextUsage> {
    // 作り物を返さない: Codex は AgentContextUsage の必須欄（自動圧縮の有無など）を返さないため
    throw new Error('Codex は文脈の使用状況（context usage）を提供しない');
  }

  async sessionModelUsage(): Promise<Record<string, UsageTotals> | undefined> {
    return this.#cumulativeModels();
  }

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
    // stderr を resume して捨てる: 読まれないパイプは詰まって子を止めるため
    (child as { stderr?: { resume?: () => void } }).stderr?.resume?.();
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
      if (this.#closing) return;
      throw this.#sanitize(error);
    } finally {
      // close() 済みなら shutdown しない: 中断の猶予つきの止め方を台無しにするため
      if (!this.#closing) this.#shutdown();
    }
  }

  async #guard<T>(promise: Promise<T>): Promise<T> {
    const client = this.#client;
    if (client === undefined) return promise;
    const closedBy = client.closed.then((reason): never => {
      throw reason;
    });
    const closedLocally = this.#closed.promise.then((): never => {
      throw new CodexAppServerClosedError('セッションを閉じた');
    });
    // 握る: 負けた側の reject が未処理になるため
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
    const account = await this.#guard(client.request('account/read', { refreshToken: false }));
    const choice = selectCodexAuth({
      apiKey: undefined,
      chatgptLogin: codexAuthModeFromAccount(account) === 'chatgpt',
    });
    if (choice.kind === 'none') throw new Error(choice.reason);
  }

  async #openThread(client: CodexAppServerClient, userAgent: string): Promise<void> {
    const spec = this.#spec;
    const mcp = toCodexMcpServersConfig(spec.mcpServers);
    for (const { name, reason } of mcp.skipped) {
      this.#note(`MCP サーバ「${name}」は Codex へ渡していない: ${reason}`);
    }
    for (const { name, fields } of mcp.droppedFields) {
      this.#note(
        `MCP サーバ「${name}」の欄 ${fields.join(', ')} は Codex へ渡していない（対応する設定欄が未確認）`,
      );
    }
    const common = {
      cwd: spec.cwd,
      approvalPolicy:
        spec.strictApprovals === true ? 'untrusted' : codexApprovalPolicyFor(spec.permissionMode),
      sandbox: CODEX_SANDBOX,
      developerInstructions: spec.systemPromptAppend,
      ...(spec.modelPlaced === true ? { model: spec.model } : {}),
      ...(mcp.config === null ? {} : { config: mcp.config }),
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
        apiKeySource: this.#apiKey === undefined ? 'chatgpt' : CODEX_API_KEY_ENV_NAME,
        permissionMode: response.approvalPolicy,
        // status を 'configured' にする: 繋がったかは読んでいないため、接続済みとは言わない
        mcpServers:
          mcp.passed.length === 0
            ? null
            : mcp.passed.map((name) => ({ name, status: 'configured' })),
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
            input: toCodexInput(next.value),
          }),
        );
      } catch (error) {
        if (error instanceof CodexRpcError) {
          this.#turn = undefined;
          await this.#emit(this.#failedTurnEvent(this.#sanitizeText(error.message), 'rpc_error'));
          continue;
        }
        throw error;
      }
      turn.id ??= started.turn.id;
      const finished = await this.#guard(turn.done.promise);
      this.#turn = undefined;
      // 道具の監査が済む前にターンの終わりを流さない。turn_ended を消費側が処理し終えるまで次の入力を引かない: SDK の順序に合わせるため
      await this.#audit;
      await this.#emit(this.#turnEndedEvent(finished, turn.lastText));
    }
  }

  #registerHandlers(client: CodexAppServerClient): void {
    client.onNotificationOf('item/started', ({ item }) => {
      if (isCodexToolItem(item)) {
        void this.#emit({
          type: 'assistant_message',
          parentToolUseId: null,
          blocks: [{ type: 'tool_use', name: item.type }],
          id: item.id,
        });
      }
    });
    client.onNotificationOf('item/completed', ({ item, turnId }) =>
      this.#onItemCompleted(item, turnId),
    );
    client.onNotificationOf('item/agentMessage/delta', ({ delta }) => {
      if (delta.length > 0) void this.#emit({ type: 'text_delta', text: delta });
    });
    client.onNotificationOf('thread/tokenUsage/updated', ({ tokenUsage }) => {
      this.#recordLast(tokenUsage.last);
    });
    client.onNotificationOf('thread/compacted', ({ turnId }) =>
      this.#onCompactionSignal(turnId, 'notification'),
    );
    client.onNotificationOf('account/rateLimits/updated', ({ rateLimits }) => {
      const folded = foldCodexRateLimits(rateLimits, this.#rateLimitReached);
      this.#rateLimitReached = folded.reached;
      for (const event of folded.events) void this.#emit(event);
    });
    client.onNotificationOf('model/rerouted', ({ toModel }) => {
      if (typeof toModel === 'string' && toModel.length > 0) this.#model = toModel;
    });
    client.onNotificationOf('turn/completed', ({ turn }) => {
      const current = this.#turn;
      if (current === undefined) return;
      if (current.id !== undefined && current.id !== turn.id) return;
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

    client.setServerRequestHandler('mcpServer/elicitation/request', (context) => {
      const server = context.params.serverName;
      // permission_denied にしない: 拒否の累積・クローンへの通知に、クローンが拒否していないものが混ざるため。note で観測だけ残す
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

  #onItemCompleted(item: CodexThreadItem, turnId: string): void {
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
    if (item.type === 'contextCompaction') {
      this.#onCompactionSignal(turnId, 'item');
      return;
    }
    if (isCodexToolItem(item)) {
      void this.#emit({ type: 'tool_result' });
      this.#audit = this.#audit.then(() => this.#auditToolItem(item));
    }
  }

  async #auditToolItem(item: CodexThreadItem): Promise<void> {
    try {
      const audit = toCodexToolAudit(item, (text) => this.#sanitizeText(text));
      if (audit?.outcome === 'success') await this.#spec.onPostToolUse(audit.record);
      else if (audit?.outcome === 'failure') await this.#spec.onPostToolUseFailure(audit.record);
    } catch (error) {
      // 投げ直さない: 観測の失敗でセッションを止めないため
      this.#note(
        `Codex: 道具の実行の記録（${item.type}）でフックが失敗した: ${error instanceof Error ? error.message : String(error)}`,
      );
    }
  }

  // preTokens は直近のリクエストの入力トークン数にする: Codex は圧縮前後のトークン数も契機も運ばないため。読めていなければ作り物を出さず note だけ
  #onCompactionSignal(turnId: string, source: 'notification' | 'item'): void {
    const key = turnId;
    const entry = this.#compactionSignals.get(key) ?? { notification: 0, item: 0, emitted: 0 };
    entry[source] += 1;
    this.#compactionSignals.set(key, entry);
    if (entry[source] <= entry.emitted) return;
    entry.emitted = entry[source];
    if (this.#lastInputTokens === undefined) {
      this.#note(
        'Codex: 文脈の圧縮が起きたが、直前の使用量を読めておらず compaction イベントにできなかった',
      );
      return;
    }
    void this.#emit({ type: 'compaction', trigger: 'auto', preTokens: this.#lastInputTokens });
  }

  #recordLast(last: CodexTokenUsageBreakdown): void {
    this.#lastInputTokens = last.inputTokens;
    const model = this.#model;
    // モデル名が分からない回は名前の無い箱へ入れる: 価格を推測せず「読めなかった」にするため
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

  #note(text: string): void {
    this.#spec.onNote?.(this.#sanitizeText(text));
  }

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

  // 外へ出る文は必ずこれを通す: 鍵の値をログ・例外文・イベントのどこにも載せないため
  #sanitizeText(text: string): string {
    let out = redactErrorText(text, this.#spec.env);
    if (this.#apiKey !== undefined) out = out.split(this.#apiKey).join('[redacted]');
    return out;
  }

  #sanitize(error: unknown): Error {
    if (error instanceof Error) {
      const wrapped = new Error(this.#sanitizeText(error.message));
      wrapped.name = error.name;
      // cause を引き継がない: 元の例外に鍵が載りうるため
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
    // return() を待たない: 入力の側は待ちっぱなしのことがあるため
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
        // 既に終わっている
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

function answerOf(
  mapping:
    | { readonly ok: true; readonly response: unknown }
    | { readonly ok: false; readonly reason: string },
): unknown {
  if (mapping.ok) return mapping.response;
  throw new Error(`承認の判断を Codex の応答へ写せない（${mapping.reason}）`);
}

function describeClientError(error: CodexAppServerClientError): string {
  // 本文（行）は載せない: 秘密が載りうるため
  return error.kind;
}

// 画像を一時ファイル（localImage）にしない: 書き出しと後片付けが要らず、app-server が別のファイル系にいても届き、ターンの途中で落ちても残骸が出ないため
export function toCodexInput(next: AgentUserInput): CodexUserInput[] {
  return [
    { type: 'text', text: next.text, text_elements: [] },
    ...(next.images ?? []).map((image): CodexUserInput => ({
      type: 'image',
      url: `data:${image.mediaType};base64,${image.data}`,
    })),
  ];
}
