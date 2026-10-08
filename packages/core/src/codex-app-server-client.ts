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

export type CodexAppServerChild = Pick<AgentChildProcess, 'stdin' | 'stdout'> &
  Partial<Pick<AgentChildProcess, 'on' | 'off'>>;

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

export class CodexAppServerClosedError extends Error {
  constructor(message: string, options?: { cause?: unknown }) {
    super(message, options);
    this.name = 'CodexAppServerClosedError';
  }
}

export type CodexAppServerClientError =
  | { kind: 'invalid-json'; line: string; cause: unknown }
  | { kind: 'unrecognized-message'; line: string }
  | { kind: 'unknown-response-id'; id: CodexRequestId }
  | { kind: 'notification-handler-threw'; method: string; cause: unknown }
  | { kind: 'write-failed'; cause: unknown };

export interface CodexAppServerClientOptions {
  // line は先頭だけにする: 秘密が載りうるため
  onError?: (error: CodexAppServerClientError) => void;
}

export interface CodexNotification {
  readonly method: string;
  readonly params: unknown;
}

export interface CodexServerRequestContext<P> {
  readonly id: CodexRequestId;
  readonly params: P;
  readonly signal: AbortSignal;
}

export type CodexServerRequestHandler<M extends CodexServerRequestMethod> = (
  context: CodexServerRequestContext<CodexServerRequestMap[M]['params']>,
) => CodexServerRequestMap[M]['result'] | Promise<CodexServerRequestMap[M]['result']>;

export interface CodexRequestOptions {
  signal?: AbortSignal;
}

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
  // 遅れて届く答えを「知らない id」と数えないために持つ
  private readonly abandoned = new Set<CodexRequestId>();
  private readonly notificationListeners = new Set<(notification: CodexNotification) => void>();
  private readonly serverRequestHandlers = new Map<string, LooseServerRequestHandler>();
  private readonly inFlightServerRequests = new Map<CodexRequestId, AbortController>();
  private readonly detach: Array<() => void> = [];

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

  notify(method: string, params?: unknown): void {
    if (this.closedError !== null) return;
    this.write(params === undefined ? { method } : { method, params });
  }

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

  onNotification(listener: (notification: CodexNotification) => void): () => void {
    this.notificationListeners.add(listener);
    return () => {
      this.notificationListeners.delete(listener);
    };
  }

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

  // 登録の無いメソッドを無視しない: -32601（Method not found）で答えないと、相手を待たせたままにするため
  setServerRequestHandler<M extends CodexServerRequestMethod>(
    method: M,
    handler: CodexServerRequestHandler<M>,
  ): void {
    this.serverRequestHandlers.set(method, handler as unknown as LooseServerRequestHandler);
  }

  // 子プロセスは殺さない: 起こした側が持つため
  close(
    reason: CodexAppServerClosedError = new CodexAppServerClosedError('クライアントを閉じた'),
  ): void {
    if (this.closedError !== null) return;
    this.closedError = reason;
    for (const off of this.detach) off();
    this.detach.length = 0;
    // 空の受け口を残す: 閉じたあとの stream の 'error' が未処理で落ちるため
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

  private receive(chunk: Buffer | string): void {
    if (this.closedError !== null) return;
    this.buffer += typeof chunk === 'string' ? chunk : this.decoder.write(chunk);
    let newline = this.buffer.indexOf('\n');
    while (newline !== -1) {
      const line = this.buffer.slice(0, newline).replace(/\r$/, '');
      this.buffer = this.buffer.slice(newline + 1);
      if (line.trim() !== '') this.dispatchLine(line);
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
