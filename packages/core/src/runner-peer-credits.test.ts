import { EventEmitter } from 'node:events';
import { PassThrough } from 'node:stream';

import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { InMemoryTransport } from '@modelcontextprotocol/sdk/inMemory.js';
import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import type { Query, query as sdkQuery } from '@anthropic-ai/claude-agent-sdk';
import { afterEach, describe, expect, it, vi } from 'vitest';

import { makeTempDirSync } from '../../../vitest.tmpdir.js';
import type { AgentChildProcess } from './agent-session.js';
import { CODEX_PEER_CREDITS_EXHAUSTED_NOTICE } from './agent-provider-peers.js';
import { createCredentialStore } from './credentials.js';
import { PEER_CREDITS_RETRY_MS } from './peer-credits-hold.js';
import type { PeerSocketHost } from './peer-socket-host.js';
import type { RunnerEvent } from './runner-protocol.js';
import { createRunnerHost } from './runner.js';

type Json = Record<string, unknown>;

const CREDITS_MESSAGE = 'Your workspace is out of credits. Add credits to continue.';

function idleQuery(): typeof sdkQuery {
  const fn = vi.fn(() => {
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
  return fn as unknown as typeof sdkQuery;
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

// Codex の app-server の代役。turn/start のあと、`outcome` のとおりにターンを終える。
function appServer(outcome: () => 'credits' | 'ok'): AgentChildProcess {
  const emitter = new EventEmitter();
  const stdin = new PassThrough();
  const stdout = new PassThrough();
  let buffer = '';
  const send = (message: Json): void => void stdout.write(`${JSON.stringify(message)}\n`);
  stdin.setEncoding('utf8');
  stdin.on('data', (chunk: string) => {
    buffer += chunk;
    for (let i = buffer.indexOf('\n'); i !== -1; i = buffer.indexOf('\n')) {
      const message = JSON.parse(buffer.slice(0, i)) as Json;
      buffer = buffer.slice(i + 1);
      const id = message['id'] as number | undefined;
      const method = message['method'];
      if (typeof method !== 'string' || id === undefined) continue;
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
          if (outcome() === 'ok') {
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
          } else {
            send({
              method: 'turn/completed',
              params: {
                threadId: 'thr-peer',
                turn: {
                  id: 'turn-1',
                  status: 'failed',
                  items: [],
                  error: { message: CREDITS_MESSAGE, codexErrorInfo: 'other' },
                },
              },
            });
          }
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

async function setup(outcome: { current: 'credits' | 'ok' }) {
  const events: RunnerEvent[] = [];
  const peerHost = capturingPeerHost();
  const host = createRunnerHost({
    runnerId: 'runner-test',
    workspacePath: '/work',
    emit: (event) => events.push(event),
    queryFn: idleQuery(),
    env: {},
    childUser: { uid: 1000, gid: 1000 },
    spawnAgentProcessFn: () => appServer(() => outcome.current),
    credentials: createCredentialStore({
      dir: makeTempDirSync('alteroid-runner-peer-credits-cred-'),
      seed: {},
    }),
    codexHome: makeTempDirSync('alteroid-runner-peer-credits-codex-'),
    peer: {
      openSocket: async () => peerHost,
      reportsUsage: () => true,
      childEntry: '/app/relay.js',
      workdirRoot: makeTempDirSync('alteroid-peer-credits-workdir-'),
    },
  });
  await host.setCredentials([{ name: 'CODEX_API_KEY', value: 'sk-test-1' }]);
  await host.start({ managerId: 'mgr-1', request: 'やって', cwd: '/work' });
  const clients: Client[] = [];
  const peerRun = async (): Promise<{ text: string; isError: boolean }> => {
    const server = peerHost.factory()!();
    const [clientSide, serverSide] = InMemoryTransport.createLinkedPair();
    await server.connect(serverSide);
    const client = new Client({ name: 't', version: '0' });
    await client.connect(clientSide);
    clients.push(client);
    const result = (await client.callTool({
      name: 'peer_run',
      arguments: { provider: 'codex', prompt: '掃除して' },
    })) as { content: { text: string }[]; isError?: boolean };
    return { text: result.content[0]?.text ?? '', isError: result.isError === true };
  };
  const peersEvents = (): Extract<RunnerEvent, { type: 'manager_peers' }>[] =>
    events.filter(
      (e): e is Extract<RunnerEvent, { type: 'manager_peers' }> => e.type === 'manager_peers',
    );
  const cloneNotes = (): Extract<RunnerEvent, { type: 'note' }>[] =>
    events.filter(
      (e): e is Extract<RunnerEvent, { type: 'note' }> =>
        e.type === 'note' && e.notifyClone === true && e.text.includes('残高切れ'),
    );
  const close = async (): Promise<void> => {
    for (const client of clients) await client.close();
    await host.shutdown();
  };
  return { host, events, peerRun, peersEvents, cloneNotes, close };
}

async function settleTimers(): Promise<void> {
  for (let i = 0; i < 50; i += 1) await new Promise((resolve) => setImmediate(resolve));
}

afterEach(() => {
  vi.useRealTimers();
});

describe('runner: peer（Codex）の残高切れで、その器の peer を閉じる', () => {
  it('残高切れで落ちた peer_run は案内を返し、残高切れの理由つきで閉じていると名乗り、クローンへの note がちょうど1本出る', async () => {
    const outcome = { current: 'credits' as const };
    const s = await setup(outcome);
    const result = await s.peerRun();
    expect(result.text).toContain(CODEX_PEER_CREDITS_EXHAUSTED_NOTICE);
    expect(result.text).toContain(CREDITS_MESSAGE);
    await settleTimers();
    const last = s.peersEvents().at(-1);
    expect(last?.managerPeers).toEqual([]);
    expect(last?.managerPeersClosed?.[0]?.provider).toBe('codex');
    expect(last?.managerPeersClosed?.[0]?.reason).toContain('残高切れで閉じている');
    expect(last?.managerPeersClosed?.[0]?.reason).toContain(CREDITS_MESSAGE);
    expect(s.host.managerPeers()?.managerPeers).toEqual([]);
    const notes = s.cloneNotes();
    expect(notes).toHaveLength(1);
    expect(notes[0]?.managerId).toBe('mgr-1');
    expect(notes[0]?.text).toContain(CREDITS_MESSAGE);
    await s.close();
  });

  it('時計を進めると1度開き直しを名乗り、また残高切れで落ちても、クローンへの note は増えない', async () => {
    vi.useFakeTimers({ toFake: ['Date', 'setTimeout', 'clearTimeout'] });
    const outcome = { current: 'credits' as 'credits' | 'ok' };
    const s = await setup(outcome);
    await s.peerRun();
    await settleTimers();
    expect(s.host.managerPeers()?.managerPeers).toEqual([]);
    await vi.advanceTimersByTimeAsync(PEER_CREDITS_RETRY_MS);
    await settleTimers();
    expect(s.host.managerPeers()?.managerPeers).toEqual([{ provider: 'codex' }]);
    expect(s.peersEvents().at(-1)?.managerPeers).toEqual([{ provider: 'codex' }]);
    const again = await s.peerRun();
    expect(again.text).toContain(CODEX_PEER_CREDITS_EXHAUSTED_NOTICE);
    await settleTimers();
    expect(s.host.managerPeers()?.managerPeers).toEqual([]);
    expect(s.cloneNotes()).toHaveLength(1);
    await s.close();
  });

  it('開き直して成功すれば残高切れのエピソードは終わり、次の残高切れはまたクローンへ知らせる', async () => {
    vi.useFakeTimers({ toFake: ['Date', 'setTimeout', 'clearTimeout'] });
    const outcome = { current: 'credits' as 'credits' | 'ok' };
    const s = await setup(outcome);
    await s.peerRun();
    await vi.advanceTimersByTimeAsync(PEER_CREDITS_RETRY_MS);
    await settleTimers();
    outcome.current = 'ok';
    const succeeded = await s.peerRun();
    expect(succeeded.text).toContain('終わった');
    expect(succeeded.text).not.toContain(CODEX_PEER_CREDITS_EXHAUSTED_NOTICE);
    outcome.current = 'credits';
    await s.peerRun();
    await settleTimers();
    expect(s.cloneNotes()).toHaveLength(2);
    await s.close();
  });

  it('CODEX_API_KEY が置き直されると、30 分を待たずに開き直し、次の残高切れはまた知らせる', async () => {
    const outcome = { current: 'credits' as const };
    const s = await setup(outcome);
    await s.peerRun();
    await settleTimers();
    expect(s.host.managerPeers()?.managerPeers).toEqual([]);
    await s.host.setCredentials([{ name: 'CODEX_API_KEY', value: 'sk-test-2' }]);
    expect(s.host.managerPeers()?.managerPeers).toEqual([{ provider: 'codex' }]);
    await s.peerRun();
    await settleTimers();
    expect(s.cloneNotes()).toHaveLength(2);
    await s.close();
  });

  it('CODEX_API_KEY と関係のない鍵が変わっても、残高切れの閉じは解けない', async () => {
    const outcome = { current: 'credits' as const };
    const s = await setup(outcome);
    await s.peerRun();
    await settleTimers();
    await s.host.setCredentials([
      { name: 'CODEX_API_KEY', value: 'sk-test-1' },
      { name: 'OTHER_TOKEN', value: 'x' },
    ]);
    expect(s.host.managerPeers()?.managerPeers).toEqual([]);
    await s.close();
  });
});
