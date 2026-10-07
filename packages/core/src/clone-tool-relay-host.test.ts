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

  async function connectRaw(socketPath: string, token: string): Promise<Socket> {
    const socket = createConnection({ path: socketPath });
    await new Promise<void>((resolve, reject) => {
      socket.once('connect', resolve);
      socket.once('error', reject);
    });
    socket.write(`${token}\n`);
    return socket;
  }

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

  it('ソケットを収めるディレクトリは 0700 である（新規に作る場合）', async () => {
    const dir = makeTempDirSync('clone-tool-relay-host-newdir-');
    const socketDir = join(dir, 'relay');
    host = await createCloneToolRelayHost({ socketPath: join(socketDir, 's.sock') });

    const mode = statSync(dirname(host.socketPath)).mode & 0o777;
    expect(mode).toBe(0o700);
  });

  it('ソケットを収めるディレクトリが既存で緩い mode だった場合も 0700 へ締め直す', async () => {
    const dir = makeTempDirSync('clone-tool-relay-host-existingdir-');
    const socketDir = join(dir, 'relay');
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
