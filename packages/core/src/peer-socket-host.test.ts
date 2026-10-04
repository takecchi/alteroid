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
    const token = host.register(() => {
      made += 1;
      return new McpServer({ name: 'peer', version: '0' });
    });
    expect(token).toMatch(/^[0-9a-f]{64}$/);
    const connect = async (): Promise<void> => {
      const socket = createConnection({ path: join(dir, 'p.sock') });
      await new Promise<void>((resolve) => socket.once('connect', resolve));
      socket.write(`${token}\n`);
      await new Promise((resolve) => setTimeout(resolve, 100));
      socket.destroy();
    };
    await connect();
    expect(made).toBe(1);
    await connect();
    expect(made).toBe(1);
  });

  it('register のたびに別の token を返す', async () => {
    const dir = makeTempDirSync('peer-host-');
    host = await createPeerSocketHost({ socketPath: join(dir, 'p.sock') });
    const make = (): McpServer => new McpServer({ name: 'peer', version: '0' });
    expect(host.register(make)).not.toBe(host.register(make));
  });
});
