/**
 * `codex app-server`（stdio・行区切り JSON-RPC）との送受信だけを担うクライアント（#486 M7 段 S6）。
 *
 * **ここがやること**: 行の切り出し、相関 id の採番、request と response の対応づけ、通知の配送、
 * server → client の request への応答口、子プロセスの終わりを保留中の要求へ伝えること。
 * **ここがやらないこと**: 子プロセスを起こす（注入される）、thread / turn の意味づけ、
 * 中立の {@link AgentEvent} への畳み込み、承認を人間（＝クローン）へ回すこと。それは次の段の仕事で、
 * このファイルは runner のどこからも使われていない（挙動不変）。
 *
 * ## ワイヤの形
 *
 * `"jsonrpc":"2.0"` は送らず、付いて来ても読み飛ばす（`codex-protocol.ts` の冒頭と、
 * 生成スキーマの `JSONRPCMessage`）。1行1メッセージ、区切りは `\n`（`\r\n` も許す）。
 *
 * ## 受け取ったメッセージの分類
 *
 * | 形 | 扱い |
 * | --- | --- |
 * | `method` と `id` | server → client の request。登録した応答口へ渡し、答えを `id` つきで返す |
 * | `method` のみ | 通知。登録した購読者へ届いた順に配る |
 * | `id` と `result` / `error` | 自分が送った request への response |
 * | 上のどれでもない・JSON でない行 | 読み飛ばして `onError` に伝える（接続は閉じない） |
 *
 * ## 終わり方
 *
 * 子プロセスの `exit` / `error`、stdout の `end` / `close`、stdin の `error` のどれかで閉じる。
 * 閉じたら保留中の request をすべて {@link CodexAppServerClosedError} で reject し、
 * 以後の `request` も即 reject する。応答口へ渡してある server request の `signal` も abort する。
 */

import { StringDecoder } from 'node:string_decoder';

import type { AgentChildProcess } from './agent-session.js';
import {
  CODEX_RPC_ERROR_CODES,
  type CodexClientInfo,
  type CodexClientRequestMap,
  type CodexClientRequestMethod,
  type CodexInitializeCapabilities,
  type CodexInitializeResponse,
  type CodexRequestId,
  type CodexRpcErrorBody,
  type CodexServerNotificationMap,
  type CodexServerNotificationMethod,
  type CodexServerRequestMap,
  type CodexServerRequestMethod,
} from './codex-protocol.js';

/** 子プロセスのうちクライアントが使う部分。`on` は無くてもよい（終わりを stdout の終了だけで知る）。 */
export type CodexAppServerChild = Pick<AgentChildProcess, 'stdin' | 'stdout'> &
  Partial<Pick<AgentChildProcess, 'on' | 'off'>>;

/** 相手が JSON-RPC のエラーで答えた。 */
export class CodexRpcError extends Error {
  readonly code: number;
  readonly data: unknown;

  constructor(
    body: CodexRpcErrorBody,
    readonly method?: string,
  ) {
    super(body.message);
    this.name = 'CodexRpcError';
    this.code = body.code;
    this.data = body.data;
  }
}

/** 接続が閉じた（子プロセスの終了・stdout の終了・書き込み失敗・自分から閉じた）。 */
export class CodexAppServerClosedError extends Error {
  constructor(message: string, options?: { cause?: unknown }) {
    super(message, options);
    this.name = 'CodexAppServerClosedError';
  }
}

/** 読み飛ばした行・ハンドラの例外など、接続を止めない異常の知らせ。 */
export type CodexAppServerClientError =
  | { kind: 'invalid-json'; line: string; cause: unknown }
  | { kind: 'unrecognized-message'; line: string }
  | { kind: 'unknown-response-id'; id: CodexRequestId }
  | { kind: 'notification-handler-threw'; method: string; cause: unknown }
  | { kind: 'write-failed'; cause: unknown };

export interface CodexAppServerClientOptions {
  /** 接続を止めない異常の知らせ先。既定は捨てる。秘密が載りうるので `line` は先頭だけにする。 */
  onError?: (error: CodexAppServerClientError) => void;
}

export interface CodexNotification {
  readonly method: string;
  readonly params: unknown;
}

/** server → client の request の応答口が受け取るもの。 */
export interface CodexServerRequestContext<P> {
  readonly id: CodexRequestId;
  readonly params: P;
  /**
   * 相手が要求を取り下げたとき（`serverRequest/resolved` が先に届いた）か、接続が閉じたときに
   * abort される。abort 済みの要求には、答えが出来ても返さない。
   */
  readonly signal: AbortSignal;
}

export type CodexServerRequestHandler<M extends CodexServerRequestMethod> = (
  context: CodexServerRequestContext<CodexServerRequestMap[M]['params']>,
) => CodexServerRequestMap[M]['result'] | Promise<CodexServerRequestMap[M]['result']>;

export interface CodexRequestOptions {
  /** abort されたら、保留中の待ちを reject して手放す（相手へは何も送らない）。遅れて届く答えは無視する。 */
  signal?: AbortSignal;
}

/** 登録時に型を外した応答口（メソッドごとの型は `setServerRequestHandler` の入口で守る）。 */
type LooseServerRequestHandler = (context: CodexServerRequestContext<unknown>) => unknown;

interface Pending {
  readonly method: string;
  resolve(value: unknown): void;
  reject(error: unknown): void;
  cleanup(): void;
}

const LOG_LINE_LIMIT = 200;

function clip(line: string): string {
  return line.length > LOG_LINE_LIMIT ? `${line.slice(0, LOG_LINE_LIMIT)}…` : line;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function isRequestId(value: unknown): value is CodexRequestId {
  return typeof value === 'string' || (typeof value === 'number' && Number.isFinite(value));
}

function describeExit(code: number | null, signal: NodeJS.Signals | null): string {
  return signal !== null ? `signal ${signal}` : `code ${code ?? 'unknown'}`;
}

export class CodexAppServerClient {
  private readonly child: CodexAppServerChild;
  private readonly onError: (error: CodexAppServerClientError) => void;
  private readonly decoder = new StringDecoder('utf8');
  private buffer = '';
  private nextId = 1;
  private closedError: CodexAppServerClosedError | null = null;
  private readonly pending = new Map<CodexRequestId, Pending>();
  /** abort で手放した request の id。遅れて届く答えを「知らない id」と数えないため。 */
  private readonly abandoned = new Set<CodexRequestId>();
  private readonly notificationListeners = new Set<(notification: CodexNotification) => void>();
  private readonly serverRequestHandlers = new Map<string, LooseServerRequestHandler>();
  private readonly inFlightServerRequests = new Map<CodexRequestId, AbortController>();
  private readonly detach: Array<() => void> = [];

  /** 閉じたときに解決する（正常・異常を問わず、閉じた理由を渡す）。 */
  readonly closed: Promise<CodexAppServerClosedError>;
  private resolveClosed!: (error: CodexAppServerClosedError) => void;

  constructor(child: CodexAppServerChild, options: CodexAppServerClientOptions = {}) {
    this.child = child;
    this.onError = options.onError ?? (() => undefined);
    this.closed = new Promise((resolve) => {
      this.resolveClosed = resolve;
    });

    const onData = (chunk: Buffer | string): void => this.receive(chunk);
    const onEnd = (): void =>
      this.close(new CodexAppServerClosedError('app-server の stdout が終了した'));
    const onStdoutError = (error: Error): void =>
      this.close(new CodexAppServerClosedError('app-server の stdout でエラー', { cause: error }));
    const onStdinError = (error: Error): void =>
      this.close(new CodexAppServerClosedError('app-server の stdin でエラー', { cause: error }));
    child.stdout.on('data', onData);
    child.stdout.on('end', onEnd);
    child.stdout.on('close', onEnd);
    child.stdout.on('error', onStdoutError);
    child.stdin.on('error', onStdinError);
    this.detach.push(
      () => child.stdout.off('data', onData),
      () => child.stdout.off('end', onEnd),
      () => child.stdout.off('close', onEnd),
      () => child.stdout.off('error', onStdoutError),
      () => child.stdin.off('error', onStdinError),
    );

    if (child.on !== undefined && child.off !== undefined) {
      const onExit = (code: number | null, signal: NodeJS.Signals | null): void =>
        this.close(
          new CodexAppServerClosedError(
            `app-server の子プロセスが終了した（${describeExit(code, signal)}）`,
          ),
        );
      const onChildError = (error: Error): void =>
        this.close(
          new CodexAppServerClosedError('app-server の子プロセスでエラー', { cause: error }),
        );
      child.on('exit', onExit);
      child.on('error', onChildError);
      const off = child.off.bind(child);
      this.detach.push(
        () => off('exit', onExit),
        () => off('error', onChildError),
      );
    }
  }

  get isClosed(): boolean {
    return this.closedError !== null;
  }

  // -------------------------------------------------------------------------
  // client → server
  // -------------------------------------------------------------------------

  /** request を送り、response を待つ。error response は {@link CodexRpcError} で reject する。 */
  request<M extends CodexClientRequestMethod>(
    method: M,
    params: CodexClientRequestMap[M]['params'],
    options: CodexRequestOptions = {},
  ): Promise<CodexClientRequestMap[M]['result']> {
    if (this.closedError !== null) return Promise.reject(this.closedError);
    const signal = options.signal;
    if (signal?.aborted === true) return Promise.reject(signal.reason);

    const id = this.nextId++;
    return new Promise((resolve, reject) => {
      const onAbort = (): void => {
        this.pending.delete(id);
        this.abandoned.add(id);
        reject(signal?.reason);
      };
      signal?.addEventListener('abort', onAbort, { once: true });
      this.pending.set(id, {
        method,
        resolve: (value) => resolve(value as CodexClientRequestMap[M]['result']),
        reject,
        cleanup: () => signal?.removeEventListener('abort', onAbort),
      });
      this.write({ id, method, params });
    });
  }

  /** 通知を送る（答えは無い）。閉じていれば捨てる。 */
  notify(method: string, params?: unknown): void {
    if (this.closedError !== null) return;
    this.write(params === undefined ? { method } : { method, params });
  }

  /**
   * 接続の最初の往復: `initialize` を送り、答えが来たら `initialized` を通知する。
   * app-server は `initialize` の前に他のメソッドを受け付けない。
   */
  async initialize(
    clientInfo: CodexClientInfo,
    capabilities?: CodexInitializeCapabilities,
    options?: CodexRequestOptions,
  ): Promise<CodexInitializeResponse> {
    const response = await this.request(
      'initialize',
      capabilities === undefined ? { clientInfo } : { clientInfo, capabilities },
      options,
    );
    this.notify('initialized');
    return response;
  }

  // -------------------------------------------------------------------------
  // server → client
  // -------------------------------------------------------------------------

  /** 全通知の購読。届いた順に同期で呼ぶ。戻り値で購読をやめる。 */
  onNotification(listener: (notification: CodexNotification) => void): () => void {
    this.notificationListeners.add(listener);
    return () => {
      this.notificationListeners.delete(listener);
    };
  }

  /** 特定の通知だけの購読（params は型の付いた形）。戻り値で購読をやめる。 */
  onNotificationOf<M extends CodexServerNotificationMethod>(
    method: M,
    listener: (params: CodexServerNotificationMap[M]) => void,
  ): () => void {
    return this.onNotification((notification) => {
      if (notification.method === method) {
        listener(notification.params as CodexServerNotificationMap[M]);
      }
    });
  }

  /**
   * server → client の request の応答口を登録する（メソッドごとに1つ。後勝ち）。
   * **登録の無いメソッドには、JSON-RPC の `-32601`（Method not found）で答える**——
   * 相手を待たせたままにしない。ハンドラが throw したら `-32603`（Internal error）で答える。
   */
  setServerRequestHandler<M extends CodexServerRequestMethod>(
    method: M,
    handler: CodexServerRequestHandler<M>,
  ): void {
    this.serverRequestHandlers.set(method, handler as unknown as LooseServerRequestHandler);
  }

  // -------------------------------------------------------------------------
  // 終わり
  // -------------------------------------------------------------------------

  /**
   * 閉じる。保留中の request を reject し、購読を外す。子プロセスは殺さない
   * （起こした側が持つ）。二度目以降は何もしない。
   */
  close(
    reason: CodexAppServerClosedError = new CodexAppServerClosedError('クライアントを閉じた'),
  ): void {
    if (this.closedError !== null) return;
    this.closedError = reason;
    for (const off of this.detach) off();
    this.detach.length = 0;
    // 閉じたあとの stream の 'error' が未処理で落ちないよう、空の受け口を残す
    this.child.stdin.on('error', () => undefined);
    this.child.stdout.on('error', () => undefined);

    const pending = [...this.pending.values()];
    this.pending.clear();
    for (const p of pending) {
      p.cleanup();
      p.reject(reason);
    }
    this.abandoned.clear();
    for (const controller of this.inFlightServerRequests.values()) controller.abort(reason);
    this.inFlightServerRequests.clear();
    this.notificationListeners.clear();
    this.resolveClosed(reason);
  }

  // -------------------------------------------------------------------------
  // 内部: 送信
  // -------------------------------------------------------------------------

  private write(message: Record<string, unknown>): void {
    try {
      this.child.stdin.write(`${JSON.stringify(message)}\n`, (error) => {
        if (error) this.failWrite(error);
      });
    } catch (error) {
      this.failWrite(error);
    }
  }

  private failWrite(cause: unknown): void {
    this.onError({ kind: 'write-failed', cause });
    this.close(new CodexAppServerClosedError('app-server への書き込みに失敗した', { cause }));
  }

  // -------------------------------------------------------------------------
  // 内部: 受信
  // -------------------------------------------------------------------------

  private receive(chunk: Buffer | string): void {
    if (this.closedError !== null) return;
    this.buffer += typeof chunk === 'string' ? chunk : this.decoder.write(chunk);
    let newline = this.buffer.indexOf('\n');
    while (newline !== -1) {
      const line = this.buffer.slice(0, newline).replace(/\r$/, '');
      this.buffer = this.buffer.slice(newline + 1);
      if (line.trim() !== '') this.dispatchLine(line);
      // dispatch の中で閉じられたら、残りは読まない
      if (this.closedError !== null) return;
      newline = this.buffer.indexOf('\n');
    }
  }

  private dispatchLine(line: string): void {
    let message: unknown;
    try {
      message = JSON.parse(line);
    } catch (cause) {
      this.onError({ kind: 'invalid-json', line: clip(line), cause });
      return;
    }
    if (!isRecord(message)) {
      this.onError({ kind: 'unrecognized-message', line: clip(line) });
      return;
    }

    const { id, method } = message;
    if (typeof method === 'string') {
      if (id === undefined) this.dispatchNotification(method, message['params']);
      else if (isRequestId(id)) this.dispatchServerRequest(id, method, message['params']);
      else this.onError({ kind: 'unrecognized-message', line: clip(line) });
      return;
    }
    if (isRequestId(id) && ('result' in message || 'error' in message)) {
      this.dispatchResponse(id, message);
      return;
    }
    this.onError({ kind: 'unrecognized-message', line: clip(line) });
  }

  private dispatchResponse(id: CodexRequestId, message: Record<string, unknown>): void {
    const pending = this.pending.get(id);
    if (pending === undefined) {
      if (!this.abandoned.delete(id)) this.onError({ kind: 'unknown-response-id', id });
      return;
    }
    this.pending.delete(id);
    pending.cleanup();
    const error = message['error'];
    if (error !== undefined && error !== null) {
      const body = isRecord(error)
        ? {
            code:
              typeof error['code'] === 'number'
                ? error['code']
                : CODEX_RPC_ERROR_CODES.internalError,
            message: typeof error['message'] === 'string' ? error['message'] : 'app-server error',
            data: error['data'],
          }
        : { code: CODEX_RPC_ERROR_CODES.internalError, message: String(error) };
      pending.reject(new CodexRpcError(body, pending.method));
      return;
    }
    pending.resolve(message['result']);
  }

  private dispatchNotification(method: string, params: unknown): void {
    if (
      method === 'serverRequest/resolved' &&
      isRecord(params) &&
      isRequestId(params['requestId'])
    ) {
      // 相手が要求を取り下げた。まだ答えを待っている応答口があれば止める
      const controller = this.inFlightServerRequests.get(params['requestId']);
      if (controller !== undefined) {
        this.inFlightServerRequests.delete(params['requestId']);
        controller.abort(new Error('app-server が要求を取り下げた（serverRequest/resolved）'));
      }
    }
    const notification: CodexNotification = { method, params };
    for (const listener of [...this.notificationListeners]) {
      try {
        listener(notification);
      } catch (cause) {
        this.onError({ kind: 'notification-handler-threw', method, cause });
      }
    }
  }

  private dispatchServerRequest(id: CodexRequestId, method: string, params: unknown): void {
    const handler = this.serverRequestHandlers.get(method);
    if (handler === undefined) {
      this.respondError(id, {
        code: CODEX_RPC_ERROR_CODES.methodNotFound,
        message: `Method not found: ${method}`,
      });
      return;
    }
    const controller = new AbortController();
    this.inFlightServerRequests.set(id, controller);
    void (async () => {
      try {
        const result = await handler({
          id,
          params,
          signal: controller.signal,
        });
        if (controller.signal.aborted) return;
        this.inFlightServerRequests.delete(id);
        this.respond(id, result ?? {});
      } catch (error) {
        if (controller.signal.aborted) return;
        this.inFlightServerRequests.delete(id);
        this.respondError(id, {
          code: error instanceof CodexRpcError ? error.code : CODEX_RPC_ERROR_CODES.internalError,
          message: error instanceof Error ? error.message : String(error),
        });
      }
    })();
  }

  private respond(id: CodexRequestId, result: unknown): void {
    if (this.closedError !== null) return;
    this.write({ id, result });
  }

  private respondError(id: CodexRequestId, error: CodexRpcErrorBody): void {
    if (this.closedError !== null) return;
    this.write({ id, error });
  }
}
