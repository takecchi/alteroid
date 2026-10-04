import type { Query, query as sdkQuery } from '@anthropic-ai/claude-agent-sdk';
import { describe, expect, it, vi } from 'vitest';

import { PEER_MCP_SERVER_NAME } from './peer-broker.js';
import type { PeerSocketHost } from './peer-socket-host.js';
import { createRunnerHost, type RunnerPeerOptions } from './runner.js';

/**
 * マネージャーの MCP `peer`（#486 S7）が、PEERS が開いているときだけセッションの `mcpServers` に
 * 載ること。空なら1文字も増えない（既定の挙動は変わらない）。
 */

function capturingQuery(): { fn: typeof sdkQuery; options: () => Record<string, unknown> } {
  let captured: Record<string, unknown> = {};
  const fn = vi.fn((args: { options: Record<string, unknown> }) => {
    captured = args.options;
    let close = (): void => undefined;
    const closed = new Promise<void>((resolve) => {
      close = resolve;
    });
    // eslint-disable-next-line require-yield
    async function* generate(): AsyncGenerator<never, void> {
      await closed;
    }
    return Object.assign(generate(), {
      close: () => close(),
      interrupt: async () => undefined,
    }) as unknown as Query;
  });
  return { fn: fn as unknown as typeof sdkQuery, options: () => captured };
}

function fakePeerHost(): PeerSocketHost & { tokens: string[] } {
  const tokens: string[] = [];
  return {
    socketPath: '/run/alteroid/peer/peer.sock',
    tokens,
    register: () => {
      const token = `tok-${tokens.length + 1}`;
      tokens.push(token);
      return token;
    },
    close: () => undefined,
  };
}

async function startWith(peer: RunnerPeerOptions | undefined): Promise<Record<string, unknown>> {
  const sdk = capturingQuery();
  const host = createRunnerHost({
    runnerId: 'runner-test',
    workspacePath: '/work',
    emit: () => undefined,
    queryFn: sdk.fn,
    env: {},
    ...(peer === undefined ? {} : { peer }),
  });
  await host.start({ managerId: 'mgr-1', request: 'やって', cwd: '/work' });
  const options = sdk.options();
  await host.shutdown();
  return options;
}

describe('runner: MCP peer の登録', () => {
  it('peer の口が無ければ mcpServers に何も足さない（今日と同じ）', async () => {
    const options = await startWith(undefined);
    expect(options.mcpServers).toBeUndefined();
  });

  it('peers が空なら何も足さず、token も発行しない', async () => {
    const host = fakePeerHost();
    const options = await startWith({ host, peers: [], reportsUsage: () => true });
    expect(options.mcpServers).toBeUndefined();
    expect(host.tokens).toEqual([]);
  });

  it('自分の provider だけが peers にあるなら、足さない', async () => {
    const host = fakePeerHost();
    const options = await startWith({ host, peers: ['claude'], reportsUsage: () => true });
    expect(options.mcpServers).toBeUndefined();
    expect(host.tokens).toEqual([]);
  });

  it('peers に codex があれば、使い捨て token つきの stdio MCP として足す', async () => {
    const host = fakePeerHost();
    const options = await startWith({
      host,
      peers: ['codex'],
      reportsUsage: () => true,
      childEntry: '/app/relay.js',
    });
    const servers = options.mcpServers as Record<string, Record<string, unknown>>;
    expect(Object.keys(servers)).toEqual([PEER_MCP_SERVER_NAME]);
    const entry = servers[PEER_MCP_SERVER_NAME]!;
    expect(entry.type).toBe('stdio');
    expect(entry.args).toEqual(['/app/relay.js']);
    expect(entry.env).toEqual({
      ALTEROID_CLONE_TOOL_RELAY_SOCKET: '/run/alteroid/peer/peer.sock',
      ALTEROID_CLONE_TOOL_RELAY_TOKEN: 'tok-1',
    });
    expect(host.tokens).toHaveLength(1);
  });
});
