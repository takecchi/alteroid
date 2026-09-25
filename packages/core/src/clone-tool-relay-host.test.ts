import { dirname, join } from 'node:path';
import { mkdirSync, statSync } from 'node:fs';
import { createConnection, type Socket } from 'node:net';

import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import type { Transport } from '@modelcontextprotocol/sdk/shared/transport.js';
import { ReadBuffer, serializeMessage } from '@modelcontextprotocol/sdk/shared/stdio.js';
import type { JSONRPCMessage } from '@modelcontextprotocol/sdk/types.js';
import { afterEach, describe, expect, it } from 'vitest';

import { makeTempDirSync } from '../../../vitest.tmpdir.js';
import { CLONE_TOOL_NAMES, createCloneMcpServer, type ToolContext } from './tools.js';
import { createMemoryStores } from './testing.js';
import {
  createCloneToolRelayHost,
  DEFAULT_REGISTRATION_TIMEOUT_MS,
  type CloneToolRelayHost,
} from './clone-tool-relay-host.js';

/**
 * ここで固定するのは、**中継の子プロセスを経由せずに**「host が本物の
 * `createCloneMcpServer` を接げること」——`clone-tool-relay-child.test.ts` が
 * 子プロセスの中継そのものを、`clone-tool-relay-integration.test.ts` が
 * 「子プロセスを実際に spawn した、頭からしっぽまでの経路」を別に固定する。
 * この3本で `net.Socket` 越しの各区間を分担して線を割っている。
 *
 * **一時ディレクトリは `vitest.tmpdir.ts` の `makeTempDirSync` を使う**
 * （`mkdtempSync` を直接呼ばない。`scripts/no-direct-mkdtemp.test.ts` の歯）。
 */
describe('clone-tool-relay-host（クローンの道具の中継・デーモン側）', () => {
  let host: CloneToolRelayHost | undefined;

  afterEach(() => {
    host?.close();
    host = undefined;
  });

  async function openHost(): Promise<CloneToolRelayHost> {
    const dir = makeTempDirSync('clone-tool-relay-host-');
    host = await createCloneToolRelayHost({ socketPath: join(dir, 's.sock') });
    return host;
  }

  function minimalToolContext(): ToolContext {
    return {
      stores: createMemoryStores(),
      emit: () => {},
      conversationId: () => undefined,
      memoryCause: () => 'clone',
    };
  }

  /** `token\n` を送ってから、そのまま `net.Socket` を返す（生の接続）。 */
  async function connectRaw(socketPath: string, token: string): Promise<Socket> {
    const socket = createConnection({ path: socketPath });
    await new Promise<void>((resolve, reject) => {
      socket.once('connect', resolve);
      socket.once('error', reject);
    });
    socket.write(`${token}\n`);
    return socket;
  }

  /** `token\n` を送った後、本物の MCP `Client` として繋ぎ直す。 */
  async function connectClient(socketPath: string, token: string): Promise<Client> {
    const socket = await connectRaw(socketPath, token);
    const client = new Client({ name: 'clone-tool-relay-host.test', version: '0' });
    await client.connect(new SocketTransport(socket));
    return client;
  }

  it('listen 直後、ソケットは mode 0600 である', async () => {
    const h = await openHost();
    const mode = statSync(h.socketPath).mode & 0o777;
    expect(mode).toBe(0o600);
  });

  // Issue #486 48(a) PR2: 「listen〜chmod の窓」（PR1 の留保）を、ソケット単体
  // ではなくディレクトリ側で塞ぐ——同一 UID 以外はそもそも `traverse` できない
  // ので、ソケット自身の mode がまだ緩い一瞬があっても辿り着けない。
  it('ソケットを収めるディレクトリは 0700 である（新規に作る場合）', async () => {
    const dir = makeTempDirSync('clone-tool-relay-host-newdir-');
    // `makeTempDirSync` 自身が作るのは `dir` であって、その1段下の
    // ディレクトリはまだ存在しない——`createCloneToolRelayHost` が
    // `mkdirSync(..., { recursive: true })` で新規に作る場合を確かめる。
    const socketDir = join(dir, 'relay');
    host = await createCloneToolRelayHost({ socketPath: join(socketDir, 's.sock') });

    const mode = statSync(dirname(host.socketPath)).mode & 0o777;
    expect(mode).toBe(0o700);
  });

  it('ソケットを収めるディレクトリが既存で緩い mode だった場合も 0700 へ締め直す', async () => {
    const dir = makeTempDirSync('clone-tool-relay-host-existingdir-');
    const socketDir = join(dir, 'relay');
    // 先に緩い mode で作っておく——`mkdirSync` の `mode` は新規作成時にしか
    // 効かないので、`createCloneToolRelayHost` 側が明示的に締め直さない限り
    // ここが 0755 のまま残る。
    mkdirSync(socketDir, { recursive: true, mode: 0o755 });

    host = await createCloneToolRelayHost({ socketPath: join(socketDir, 's.sock') });

    const mode = statSync(dirname(host.socketPath)).mode & 0o777;
    expect(mode).toBe(0o700);
  });

  it('登録した token で接げば、tools/list が CLONE_TOOL_NAMES と一致する', async () => {
    const h = await openHost();
    const token = h.register(() => createCloneMcpServer(minimalToolContext()).instance);

    const client = await connectClient(h.socketPath, token);
    const { tools } = await client.listTools();
    expect(tools.map((tool) => tool.name).sort()).toEqual([...CLONE_TOOL_NAMES].sort());

    await client.close();
  });

  it('未知の token で接いだ接続は切断される', async () => {
    const h = await openHost();
    h.register(() => createCloneMcpServer(minimalToolContext()).instance);

    const socket = await connectRaw(h.socketPath, 'this-token-was-never-registered');
    await new Promise<void>((resolve) => socket.once('close', resolve));
    // ここへ到達すること自体が固定である（タイムアウトすれば歯が落ちる）。
    expect(socket.destroyed).toBe(true);
  });

  it('token は使い捨て——同じ token で2度目に接いだ接続は切断される', async () => {
    const h = await openHost();
    const token = h.register(() => createCloneMcpServer(minimalToolContext()).instance);

    const first = await connectClient(h.socketPath, token);
    await first.listTools();

    const second = await connectRaw(h.socketPath, token);
    await new Promise<void>((resolve) => second.once('close', resolve));
    expect(second.destroyed).toBe(true);

    await first.close();
  });

  it('子が来ないまま timeoutMs を過ぎたら予約は失効する', async () => {
    const h = await openHost();
    const token = h.register(() => createCloneMcpServer(minimalToolContext()).instance, {
      timeoutMs: 20,
    });

    await new Promise((resolve) => setTimeout(resolve, 60));

    const socket = await connectRaw(h.socketPath, token);
    await new Promise<void>((resolve) => socket.once('close', resolve));
    expect(socket.destroyed).toBe(true);
  });

  it('既定の失効時間は30秒である', () => {
    expect(DEFAULT_REGISTRATION_TIMEOUT_MS).toBe(30_000);
  });
});

/** テスト専用: 生の `net.Socket` を MCP の `Transport` として使う薄いラッパ。 */
class SocketTransport implements Transport {
  onmessage?: (message: JSONRPCMessage) => void;
  onerror?: (error: Error) => void;
  onclose?: () => void;
  readonly #buffer = new ReadBuffer();

  constructor(private readonly socket: Socket) {
    socket.on('data', (chunk: Buffer) => {
      this.#buffer.append(chunk);
      let message: JSONRPCMessage | null;
      while ((message = this.#buffer.readMessage()) !== null) this.onmessage?.(message);
    });
    socket.on('error', (error) => this.onerror?.(error));
    socket.on('close', () => this.onclose?.());
  }

  async start(): Promise<void> {}

  async send(message: JSONRPCMessage): Promise<void> {
    this.socket.write(serializeMessage(message));
  }

  async close(): Promise<void> {
    this.socket.destroy();
  }
}
