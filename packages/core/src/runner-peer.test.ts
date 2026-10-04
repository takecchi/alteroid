import { EventEmitter } from 'node:events';
import { PassThrough } from 'node:stream';

import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { InMemoryTransport } from '@modelcontextprotocol/sdk/inMemory.js';
import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import type { Query, query as sdkQuery } from '@anthropic-ai/claude-agent-sdk';
import { describe, expect, it, vi } from 'vitest';

import type { AgentChildProcess } from './agent-session.js';
import { PEER_MCP_SERVER_NAME } from './peer-broker.js';
import type { RunnerEvent } from './runner-protocol.js';
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

function capturingPeerHost(): PeerSocketHost & { factory: () => (() => McpServer) | undefined } {
  let captured: (() => McpServer) | undefined;
  return {
    socketPath: '/run/alteroid/peer/peer.sock',
    register: (factory) => {
      captured = factory;
      return 'tok-1';
    },
    close: () => undefined,
    factory: () => captured,
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

/**
 * peer のセッションの承認が、呼び出し元のマネージャーの承認として既存の経路（`ask` / `answer`）で
 * 上がること。出所の印が必ず付き、答えが出るまで `peer_run` は返らない（#486 S7 案A）。
 */
describe('runner: peer の承認をクローンへ上げる', () => {
  type Json = Record<string, unknown>;

  /** `item/commandExecution/requestApproval` を1回上げてから、答えに応じて完了する偽の app-server。 */
  function approvingAppServer(decisions: unknown[]): AgentChildProcess {
    const emitter = new EventEmitter();
    const stdin = new PassThrough();
    const stdout = new PassThrough();
    let buffer = '';
    const send = (message: Json): void => void stdout.write(`${JSON.stringify(message)}\n`);
    let approvalId: number | undefined;
    stdin.setEncoding('utf8');
    stdin.on('data', (chunk: string) => {
      buffer += chunk;
      for (let i = buffer.indexOf('\n'); i !== -1; i = buffer.indexOf('\n')) {
        const message = JSON.parse(buffer.slice(0, i)) as Json;
        buffer = buffer.slice(i + 1);
        const id = message['id'] as number | undefined;
        const method = message['method'];
        if (typeof method !== 'string') {
          if (id !== undefined && id === approvalId) {
            decisions.push((message['result'] as Json | undefined)?.['decision']);
            send({
              method: 'item/completed',
              params: {
                threadId: 'thr-peer',
                turnId: 'turn-1',
                item: { type: 'agentMessage', id: 'm1', text: '終わった' },
              },
            });
            send({
              method: 'turn/completed',
              params: {
                threadId: 'thr-peer',
                turn: { id: 'turn-1', status: 'completed', items: [] },
              },
            });
          }
          continue;
        }
        if (id === undefined) continue;
        if (method === 'account/read') {
          send({
            id,
            result: {
              requiresOpenaiAuth: false,
              account: { type: 'chatgpt', email: null, planType: 'plus' },
            },
          });
        } else if (method === 'thread/start') {
          send({
            id,
            result: {
              thread: { id: 'thr-peer', cwd: '/work' },
              model: 'gpt-5',
              approvalPolicy: 'untrusted',
            },
          });
        } else if (method === 'turn/start') {
          send({ id, result: { turn: { id: 'turn-1', status: 'inProgress', items: [] } } });
          setImmediate(() => {
            approvalId = 900;
            send({
              id: 900,
              method: 'item/commandExecution/requestApproval',
              params: {
                threadId: 'thr-peer',
                turnId: 'turn-1',
                itemId: 'cmd-1',
                command: 'rm -rf build',
              },
            });
          });
        } else {
          send({
            id,
            result: { userAgent: 'codex/0.160.0', platformFamily: 'unix', platformOs: 'linux' },
          });
        }
      }
    });
    return Object.assign(emitter, {
      stdin,
      stdout,
      killed: false,
      exitCode: null,
      pid: 7001,
      kill: () => true,
    }) as unknown as AgentChildProcess;
  }

  async function setupPeerCall() {
    const sdk = capturingQuery();
    const events: RunnerEvent[] = [];
    const decisions: unknown[] = [];
    const peerHost = capturingPeerHost();
    const host = createRunnerHost({
      runnerId: 'runner-test',
      workspacePath: '/work',
      emit: (event) => events.push(event),
      queryFn: sdk.fn,
      env: {},
      childUser: { uid: 1000, gid: 1000 },
      spawnAgentProcessFn: () => approvingAppServer(decisions),
      peer: { host: peerHost, peers: ['codex'], childEntry: '/app/relay.js' },
    });
    await host.start({ managerId: 'mgr-1', request: 'やって', cwd: '/work' });
    const server = peerHost.factory()!();
    const [clientSide, serverSide] = InMemoryTransport.createLinkedPair();
    await server.connect(serverSide);
    const client = new Client({ name: 't', version: '0' });
    await client.connect(clientSide);
    let returned = false;
    const call = client
      .callTool({ name: 'peer_run', arguments: { provider: 'codex', prompt: '掃除して' } })
      .then((result) => {
        returned = true;
        return result as { content: { text: string }[] };
      });
    const asks = (): Extract<RunnerEvent, { type: 'ask' }>[] =>
      events.filter((e): e is Extract<RunnerEvent, { type: 'ask' }> => e.type === 'ask');
    for (let i = 0; i < 20_000 && asks().length === 0; i += 1) {
      await new Promise((resolve) => setImmediate(resolve));
    }
    return { host, client, call, asks, decisions, returned: () => returned };
  }

  it('承認は出所の印つきで ask に上がり、答えが出るまで peer_run は返らない。allow で codex へ accept が返る', async () => {
    const s = await setupPeerCall();
    const ask = s.asks()[0]!;
    expect(ask.source).toEqual({ type: 'peer', provider: 'codex' });
    expect(ask.summary.startsWith('【peer: codex】')).toBe(true);
    expect(ask.summary).toContain('commandExecution');
    expect(ask.requestId.startsWith('peer:codex:')).toBe(true);
    expect(s.returned()).toBe(false);
    await s.host.answer('mgr-1', {
      requestId: ask.requestId,
      message: 'いいよ',
      decision: 'allow',
    });
    const result = await s.call;
    expect(s.decisions).toEqual(['accept']);
    expect(result.content[0]?.text).toContain('終わった');
    expect(result.content[0]?.text).toContain('承認した操作が 1 件');
    await s.client.close();
    await s.host.shutdown();
  });

  it('deny なら codex へ decline が返り、結果に拒否の件数が出る', async () => {
    const s = await setupPeerCall();
    const ask = s.asks()[0]!;
    await s.host.answer('mgr-1', { requestId: ask.requestId, message: 'だめ', decision: 'deny' });
    const result = await s.call;
    expect(s.decisions).toEqual(['decline']);
    expect(result.content[0]?.text).toContain('拒否した');
    await s.client.close();
    await s.host.shutdown();
  });
});
