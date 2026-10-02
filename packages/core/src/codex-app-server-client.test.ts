import { EventEmitter } from 'node:events';
import { PassThrough } from 'node:stream';

import { describe, expect, it } from 'vitest';

import {
  CodexAppServerClient,
  CodexAppServerClosedError,
  CodexRpcError,
  type CodexAppServerChild,
  type CodexAppServerClientError,
  type CodexNotification,
} from './codex-app-server-client.js';

/**
 * 偽の app-server。`PassThrough` 2本（クライアントの stdin ＝ サーバが読む側、
 * クライアントの stdout ＝ サーバが書く側）と、子プロセスの `exit` / `error` を出せる口。
 * 実時間は待たない（待ちはすべて stream のイベントで進める）。
 */
class FakeServer {
  readonly stdin = new PassThrough();
  readonly stdout = new PassThrough();
  readonly events = new EventEmitter();
  /** クライアントが書いた行（JSON.parse 済み）。 */
  readonly received: Record<string, unknown>[] = [];
  private partial = '';
  private waiters: Array<() => void> = [];

  constructor() {
    this.stdin.on('data', (chunk: Buffer) => {
      this.partial += chunk.toString('utf8');
      let i = this.partial.indexOf('\n');
      while (i !== -1) {
        this.received.push(JSON.parse(this.partial.slice(0, i)) as Record<string, unknown>);
        this.partial = this.partial.slice(i + 1);
        i = this.partial.indexOf('\n');
      }
      const waiters = this.waiters;
      this.waiters = [];
      for (const w of waiters) w();
    });
  }

  get child(): CodexAppServerChild {
    return {
      stdin: this.stdin,
      stdout: this.stdout,
      on: ((event: string, listener: (...args: unknown[]) => void) => {
        this.events.on(event, listener);
      }) as unknown as CodexAppServerChild['on'],
      off: ((event: string, listener: (...args: unknown[]) => void) => {
        this.events.off(event, listener);
      }) as unknown as CodexAppServerChild['off'],
    };
  }

  /** クライアントから n 通目までが届くのを待つ。 */
  async waitForReceived(n: number): Promise<void> {
    while (this.received.length < n) {
      await new Promise<void>((resolve) => this.waiters.push(resolve));
    }
  }

  send(message: unknown): void {
    this.stdout.write(`${JSON.stringify(message)}\n`);
  }

  sendRaw(text: string): void {
    this.stdout.write(text);
  }

  exit(code: number | null, signal: NodeJS.Signals | null = null): void {
    this.events.emit('exit', code, signal);
  }
}

/** イベントループを1周させる（stream のイベントとマイクロタスクを進める）。 */
const tick = (): Promise<void> => new Promise((resolve) => setImmediate(resolve));

function setup(): {
  server: FakeServer;
  client: CodexAppServerClient;
  errors: CodexAppServerClientError[];
} {
  const server = new FakeServer();
  const errors: CodexAppServerClientError[] = [];
  const client = new CodexAppServerClient(server.child, { onError: (e) => errors.push(e) });
  return { server, client, errors };
}

describe('CodexAppServerClient', () => {
  describe('初期化の往復', () => {
    it('initialize を送り、答えを受けてから initialized を通知する（jsonrpc の欄は付けない）', async () => {
      const { server, client } = setup();
      const done = client.initialize({ name: 'alteroid', title: 'Alteroid', version: '1.2.3' });

      await server.waitForReceived(1);
      expect(server.received[0]).toEqual({
        id: 1,
        method: 'initialize',
        params: { clientInfo: { name: 'alteroid', title: 'Alteroid', version: '1.2.3' } },
      });
      // 答えが来るまで initialized は出ない
      await tick();
      expect(server.received).toHaveLength(1);

      server.send({
        id: 1,
        result: { userAgent: 'codex/0.160.0', platformFamily: 'unix', platformOs: 'linux' },
      });
      await expect(done).resolves.toEqual({
        userAgent: 'codex/0.160.0',
        platformFamily: 'unix',
        platformOs: 'linux',
      });
      await server.waitForReceived(2);
      expect(server.received[1]).toEqual({ method: 'initialized' });
      expect(server.received.every((m) => !('jsonrpc' in m))).toBe(true);
    });

    it('capabilities を渡せば initialize の params に載る', async () => {
      const { server, client } = setup();
      void client
        .initialize({ name: 'a', version: '1' }, { experimentalApi: true })
        .catch(() => undefined);
      await server.waitForReceived(1);
      expect(server.received[0]?.['params']).toEqual({
        clientInfo: { name: 'a', version: '1' },
        capabilities: { experimentalApi: true },
      });
    });

    it('相手が jsonrpc: "2.0" を付けて答えても読める', async () => {
      const { server, client } = setup();
      const p = client.request('model/list', {});
      await server.waitForReceived(1);
      server.send({ jsonrpc: '2.0', id: 1, result: { data: [] } });
      await expect(p).resolves.toEqual({ data: [] });
    });
  });

  describe('request と response', () => {
    it('順序を入れ替えて返ってきても、id で正しい呼び出しへ届く', async () => {
      const { server, client } = setup();
      const a = client.request('model/list', { limit: 1 });
      const b = client.request('account/read', {});
      const c = client.request('model/list', { limit: 3 });
      await server.waitForReceived(3);
      expect(server.received.map((m) => m['id'])).toEqual([1, 2, 3]);

      server.send({ id: 3, result: { data: [], nextCursor: 'c' } });
      server.send({ id: 1, result: { data: [], nextCursor: 'a' } });
      server.send({ id: 2, result: { requiresOpenaiAuth: false } });

      await expect(a).resolves.toMatchObject({ nextCursor: 'a' });
      await expect(b).resolves.toEqual({ requiresOpenaiAuth: false });
      await expect(c).resolves.toMatchObject({ nextCursor: 'c' });
    });

    it('error response は CodexRpcError で reject する（code / data を保つ）', async () => {
      const { server, client } = setup();
      const p = client.request('thread/start', {});
      await server.waitForReceived(1);
      server.send({ id: 1, error: { code: -32600, message: 'Not initialized', data: { x: 1 } } });
      const error = await p.catch((e: unknown) => e);
      expect(error).toBeInstanceOf(CodexRpcError);
      expect(error).toMatchObject({ code: -32600, message: 'Not initialized', data: { x: 1 } });
    });

    it('同じ行に複数メッセージ・1メッセージが複数チャンクに割れても組み立てる（\\r\\n と UTF-8 の分割を含む）', async () => {
      const { server, client } = setup();
      const a = client.request('account/read', {});
      const b = client.request('account/read', {});
      await server.waitForReceived(2);

      const line1 = JSON.stringify({ id: 1, result: { requiresOpenaiAuth: true, note: 'あ' } });
      const line2 = JSON.stringify({ id: 2, result: { requiresOpenaiAuth: false } });
      const bytes = Buffer.from(`${line1}\r\n${line2}\n`, 'utf8');
      // 「あ」（3バイト）の途中で切る
      const cut = bytes.indexOf(Buffer.from('あ')) + 1;
      server.stdout.write(bytes.subarray(0, cut));
      server.stdout.write(bytes.subarray(cut));

      await expect(a).resolves.toEqual({ requiresOpenaiAuth: true, note: 'あ' });
      await expect(b).resolves.toEqual({ requiresOpenaiAuth: false });
    });

    it('abort された request は reject し、遅れて届いた答えは無視する（異常として数えない）', async () => {
      const { server, client, errors } = setup();
      const controller = new AbortController();
      const p = client.request('model/list', {}, { signal: controller.signal });
      await server.waitForReceived(1);
      controller.abort(new Error('やめた'));
      await expect(p).rejects.toThrow('やめた');

      server.send({ id: 1, result: { data: [] } });
      await tick();
      expect(errors).toEqual([]);
    });
  });

  describe('通知の配送', () => {
    it('届いた順に全購読者へ配り、型付きの購読はメソッドで絞る', async () => {
      const { server, client } = setup();
      const all: CodexNotification[] = [];
      const deltas: string[] = [];
      client.onNotification((n) => all.push(n));
      client.onNotificationOf('item/agentMessage/delta', (p) => deltas.push(p.delta));

      server.send({ method: 'turn/started', params: { threadId: 't', turn: { id: 'u' } } });
      server.send({
        method: 'item/agentMessage/delta',
        params: { threadId: 't', turnId: 'u', itemId: 'i', delta: 'こん' },
      });
      server.send({
        method: 'item/agentMessage/delta',
        params: { threadId: 't', turnId: 'u', itemId: 'i', delta: 'にちは' },
      });
      await tick();

      expect(all.map((n) => n.method)).toEqual([
        'turn/started',
        'item/agentMessage/delta',
        'item/agentMessage/delta',
      ]);
      expect(deltas).toEqual(['こん', 'にちは']);
    });

    it('購読をやめれば届かない。購読者が throw しても他の購読者と接続は生きる', async () => {
      const { server, client, errors } = setup();
      const seen: string[] = [];
      client.onNotification(() => {
        throw new Error('boom');
      });
      const off = client.onNotification((n) => seen.push(`a:${n.method}`));
      client.onNotification((n) => seen.push(`b:${n.method}`));

      server.send({ method: 'warning', params: { message: 'x' } });
      await tick();
      off();
      server.send({ method: 'warning', params: { message: 'y' } });
      await tick();

      expect(seen).toEqual(['a:warning', 'b:warning', 'b:warning']);
      expect(errors.map((e) => e.kind)).toEqual([
        'notification-handler-threw',
        'notification-handler-threw',
      ]);
      expect(client.isClosed).toBe(false);
    });
  });

  describe('server → client の request', () => {
    it('承認 request を応答口へ渡し、答えを同じ id で返す', async () => {
      const { server, client } = setup();
      const seen: unknown[] = [];
      client.setServerRequestHandler(
        'item/commandExecution/requestApproval',
        async ({ params }) => {
          seen.push(params);
          return { decision: 'accept' };
        },
      );

      server.send({
        id: 'srv-7',
        method: 'item/commandExecution/requestApproval',
        params: { threadId: 't', turnId: 'u', itemId: 'i', command: 'ls' },
      });
      await server.waitForReceived(1);

      expect(seen).toEqual([{ threadId: 't', turnId: 'u', itemId: 'i', command: 'ls' }]);
      expect(server.received[0]).toEqual({ id: 'srv-7', result: { decision: 'accept' } });
    });

    it('応答口が遅れて、その間に別の request と通知が処理される（答えは順不同でよい）', async () => {
      const { server, client } = setup();
      let release: (() => void) | undefined;
      client.setServerRequestHandler('item/fileChange/requestApproval', ({ id }) =>
        id === 1
          ? new Promise((resolve) => {
              release = () => resolve({ decision: 'decline' });
            })
          : { decision: 'accept' },
      );
      server.send({
        id: 1,
        method: 'item/fileChange/requestApproval',
        params: { threadId: 't', turnId: 'u', itemId: 'a' },
      });
      server.send({
        id: 2,
        method: 'item/fileChange/requestApproval',
        params: { threadId: 't', turnId: 'u', itemId: 'b' },
      });
      await server.waitForReceived(1);
      expect(server.received[0]).toEqual({ id: 2, result: { decision: 'accept' } });

      release?.();
      await server.waitForReceived(2);
      expect(server.received[1]).toEqual({ id: 1, result: { decision: 'decline' } });
    });

    it('登録の無いメソッドには -32601 で答える（待たせない）', async () => {
      const { server } = setup();
      server.send({ id: 9, method: 'item/tool/call', params: { tool: 'x' } });
      await server.waitForReceived(1);
      expect(server.received[0]).toEqual({
        id: 9,
        error: { code: -32601, message: 'Method not found: item/tool/call' },
      });
    });

    it('応答口が throw したら -32603 で答える', async () => {
      const { server, client } = setup();
      client.setServerRequestHandler('item/tool/requestUserInput', () => {
        throw new Error('人間が不在');
      });
      server.send({
        id: 4,
        method: 'item/tool/requestUserInput',
        params: { threadId: 't', turnId: 'u', itemId: 'i', isBlocking: true, questions: [] },
      });
      await server.waitForReceived(1);
      expect(server.received[0]).toEqual({
        id: 4,
        error: { code: -32603, message: '人間が不在' },
      });
    });

    it('serverRequest/resolved が先に届いたら signal を abort し、遅れて出来た答えは返さない', async () => {
      const { server, client } = setup();
      let signalSeen: AbortSignal | undefined;
      let release: (() => void) | undefined;
      client.setServerRequestHandler('item/permissions/requestApproval', ({ signal }) => {
        signalSeen = signal;
        return new Promise((resolve) => {
          release = () => resolve({ permissions: {} });
        });
      });
      server.send({
        id: 5,
        method: 'item/permissions/requestApproval',
        params: { threadId: 't', turnId: 'u', itemId: 'i', cwd: '/', permissions: {} },
      });
      await tick();
      expect(signalSeen?.aborted).toBe(false);

      server.send({ method: 'serverRequest/resolved', params: { threadId: 't', requestId: 5 } });
      await tick();
      expect(signalSeen?.aborted).toBe(true);

      release?.();
      await tick();
      expect(server.received).toEqual([]);
    });
  });

  describe('異常終了', () => {
    it('子プロセスの exit で、保留中の request をすべて reject し、以後の request も即 reject する', async () => {
      const { server, client } = setup();
      const a = client.request('model/list', {});
      const b = client.request('account/read', {});
      await server.waitForReceived(2);

      server.exit(1);

      for (const p of [a, b]) {
        const error = await p.catch((e: unknown) => e);
        expect(error).toBeInstanceOf(CodexAppServerClosedError);
        expect((error as Error).message).toContain('code 1');
      }
      await expect(client.request('model/list', {})).rejects.toBeInstanceOf(
        CodexAppServerClosedError,
      );
      await expect(client.closed).resolves.toBeInstanceOf(CodexAppServerClosedError);
      expect(client.isClosed).toBe(true);
    });

    it('signal で殺された exit は理由に signal 名が残る', async () => {
      const { server, client } = setup();
      const p = client.request('model/list', {});
      await server.waitForReceived(1);
      server.exit(null, 'SIGKILL');
      await expect(p).rejects.toThrow('SIGKILL');
    });

    it('stdout の終了でも保留中の request を reject する', async () => {
      const { server, client } = setup();
      const p = client.request('model/list', {});
      await server.waitForReceived(1);
      server.stdout.end();
      await expect(p).rejects.toThrow('stdout が終了');
    });

    it('子プロセスの error でも reject する（cause を保つ）', async () => {
      const { server, client } = setup();
      const p = client.request('model/list', {});
      await server.waitForReceived(1);
      const cause = new Error('spawn ENOENT');
      server.events.emit('error', cause);
      const error = await p.catch((e: unknown) => e);
      expect(error).toBeInstanceOf(CodexAppServerClosedError);
      expect((error as Error).cause).toBe(cause);
    });

    it('stdin への書き込みが失敗したら閉じて reject する', async () => {
      const { server, client } = setup();
      const p = client.request('model/list', {});
      server.stdin.destroy(new Error('EPIPE'));
      await expect(p).rejects.toBeInstanceOf(CodexAppServerClosedError);
      expect(client.isClosed).toBe(true);
    });

    it('閉じたあとに届いた行は無視し、close の二度呼びは害がない', async () => {
      const { server, client } = setup();
      const seen: string[] = [];
      client.onNotification((n) => seen.push(n.method));
      client.close();
      client.close();
      server.send({ method: 'warning', params: { message: 'late' } });
      await tick();
      expect(seen).toEqual([]);
      // 閉じたあとの通知送信は捨てる（書かない）
      client.notify('initialized');
      await tick();
      expect(server.received).toEqual([]);
    });

    it('閉じたとき、応答口に渡してある signal も abort する', async () => {
      const { server, client } = setup();
      let signalSeen: AbortSignal | undefined;
      client.setServerRequestHandler('item/tool/requestUserInput', ({ signal }) => {
        signalSeen = signal;
        return new Promise(() => undefined);
      });
      server.send({
        id: 1,
        method: 'item/tool/requestUserInput',
        params: { threadId: 't', turnId: 'u', itemId: 'i', isBlocking: true, questions: [] },
      });
      await tick();
      server.exit(0);
      expect(signalSeen?.aborted).toBe(true);
    });
  });

  describe('不正な行', () => {
    it('JSON でない行・object でない行・分類できない行は読み飛ばし、接続は生きている', async () => {
      const { server, client, errors } = setup();
      const p = client.request('model/list', {});
      await server.waitForReceived(1);

      server.sendRaw('これは JSON ではない\n');
      server.sendRaw('[1,2,3]\n');
      server.sendRaw('42\n');
      server.sendRaw('{"foo":"bar"}\n');
      server.sendRaw('\n');
      server.send({ id: 1, result: { data: [] } });

      await expect(p).resolves.toEqual({ data: [] });
      expect(errors.map((e) => e.kind)).toEqual([
        'invalid-json',
        'unrecognized-message',
        'unrecognized-message',
        'unrecognized-message',
      ]);
      expect(client.isClosed).toBe(false);
    });

    it('異常の知らせに載る行は長ければ切る', async () => {
      const { server, errors } = setup();
      server.sendRaw(`${'x'.repeat(5000)}\n`);
      await tick();
      const first = errors[0];
      expect(first?.kind).toBe('invalid-json');
      expect(first && 'line' in first ? first.line.length : 0).toBeLessThan(300);
    });

    it('知らない id の response は知らせるだけで、保留中の request には触れない', async () => {
      const { server, client, errors } = setup();
      const p = client.request('model/list', {});
      await server.waitForReceived(1);
      server.send({ id: 99, result: {} });
      server.send({ id: 1, result: { data: [] } });
      await expect(p).resolves.toEqual({ data: [] });
      expect(errors).toEqual([{ kind: 'unknown-response-id', id: 99 }]);
    });
  });
});
