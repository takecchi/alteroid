import { join } from 'node:path';
import { createConnection } from 'node:net';

import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { afterEach, describe, expect, it } from 'vitest';

import { makeTempDirSync } from '../../../vitest.tmpdir.js';
import { createPeerSocketHost, type PeerSocketHost } from './peer-socket-host.js';

describe('peer-socket-host', () => {
  let host: PeerSocketHost | undefined;
  afterEach(() => {
    host?.close();
    host = undefined;
  });

  it('token は使い捨てで、1回目の接続でサーバが作られ、2回目は切られる', async () => {
    const dir = makeTempDirSync('peer-host-');
    host = await createPeerSocketHost({ socketPath: join(dir, 'p.sock') });
    let made = 0;
    let onMade = (): void => undefined;
    const token = host.register(() => {
      made += 1;
      onMade();
      return new McpServer({ name: 'peer', version: '0' });
    });
    expect(token).toMatch(/^[0-9a-f]{64}$/);
    const open = async (): Promise<ReturnType<typeof createConnection>> => {
      const socket = createConnection({ path: join(dir, 'p.sock') });
      await new Promise<void>((resolve) => socket.once('connect', resolve));
      return socket;
    };
    const created = new Promise<void>((resolve) => {
      onMade = resolve;
    });
    const first = await open();
    first.write(`${token}\n`);
    await created;
    expect(made).toBe(1);
    first.destroy();
    // 2回目: 消費済みの token は、サーバが接続を切る（close を待つ。実時間では待たない）。
    const second = await open();
    const closed = new Promise<void>((resolve) => second.once('close', resolve));
    second.write(`${token}\n`);
    await closed;
    expect(made).toBe(1);
  });

  it('register のたびに別の token を返す', async () => {
    const dir = makeTempDirSync('peer-host-');
    host = await createPeerSocketHost({ socketPath: join(dir, 'p.sock') });
    const make = (): McpServer => new McpServer({ name: 'peer', version: '0' });
    expect(host.register(make)).not.toBe(host.register(make));
  });
});
