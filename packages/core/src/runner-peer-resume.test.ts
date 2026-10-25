import { EventEmitter } from 'node:events';
import { appendFileSync, existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { PassThrough } from 'node:stream';

import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { InMemoryTransport } from '@modelcontextprotocol/sdk/inMemory.js';
import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import type { Query, query as sdkQuery } from '@anthropic-ai/claude-agent-sdk';
import { describe, expect, it, vi } from 'vitest';

import { makeTempDirSync } from '../../../vitest.tmpdir.js';
import type { AgentChildProcess } from './agent-session.js';
import { createCredentialStore } from './credentials.js';
import type { PeerSocketHost } from './peer-socket-host.js';
import type { RunnerEvent } from './runner-protocol.js';
import { createRunnerHost } from './runner.js';

// 器の入れ替わりの後に、戻された peer の記録を CODEX_HOME へ置き、peer_reply が thread/resume で続きから起こす（#5257）。
// 本物の Codex は起こさない: app-server は偽物で、受けた要求だけを記録する。

type Json = Record<string, unknown>;

const THREAD = '0199c0a1-2b3c-7d4e-8f50-123456789abc';
const REL = `2026/10/25/rollout-2026-10-25T09-00-00-${THREAD}.jsonl`;
const line = (ordinal: number, text = 'x') => ({
  timestamp: '2026-10-25T09:00:00.000Z',
  ordinal,
  type: 'response_item',
  payload: { text },
});

function readingQuery() {
  let captured: Record<string, unknown> = {};
  const fn = vi.fn((args: { prompt: AsyncIterable<unknown>; options: Record<string, unknown> }) => {
    captured = args.options;
    let close = (): void => undefined;
    const closed = new Promise<void>((resolve) => {
      close = resolve;
    });
    void (async () => {
      for await (const message of args.prompt) void message;
    })().catch(() => undefined);
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

// thread/start・thread/resume に rollout のパスを返し、ターンが始まると rollout に1行足して終わる偽の app-server
function fakeAppServer(requests: { method: string; params: Json }[], rolloutFile: string) {
  const emitter = new EventEmitter();
  const stdin = new PassThrough();
  const stdout = new PassThrough();
  let buffer = '';
  let ordinal = 100;
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
      requests.push({ method, params: (message['params'] ?? {}) as Json });
      if (method === 'account/read') {
        send({
          id,
          result: {
            requiresOpenaiAuth: false,
            account: { type: 'chatgpt', email: null, planType: 'plus' },
          },
        });
      } else if (method === 'thread/start' || method === 'thread/resume') {
        send({
          id,
          result: {
            thread: { id: THREAD, cwd: '/work', path: rolloutFile },
            model: 'gpt-5',
            approvalPolicy: 'untrusted',
          },
        });
      } else if (method === 'turn/start') {
        send({ id, result: { turn: { id: 'turn-1', status: 'inProgress', items: [] } } });
        setImmediate(() => {
          mkdirSync(dirname(rolloutFile), { recursive: true });
          ordinal += 1;
          appendFileSync(rolloutFile, `${JSON.stringify(line(ordinal, 'peer のターン'))}\n`);
          send({
            method: 'item/completed',
            params: {
              threadId: THREAD,
              turnId: 'turn-1',
              item: { type: 'agentMessage', id: 'm1', text: '終わった' },
            },
          });
          send({
            method: 'turn/completed',
            params: { threadId: THREAD, turn: { id: 'turn-1', status: 'completed', items: [] } },
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
    pid: 7002,
    kill: () => true,
  }) as unknown as AgentChildProcess;
}

async function setup() {
  const home = makeTempDirSync('alteroid-peer-resume-home-');
  const rolloutFile = join(home, '.codex', 'sessions', REL);
  const requests: { method: string; params: Json }[] = [];
  const events: RunnerEvent[] = [];
  const sdk = readingQuery();
  let captured: (() => McpServer) | undefined;
  const peerHost: PeerSocketHost = {
    socketPath: '/run/alteroid/peer/peer.sock',
    register: (factory) => {
      captured = factory;
      return 'tok-1';
    },
    close: () => undefined,
  };
  const host = createRunnerHost({
    runnerId: 'runner-test',
    workspacePath: '/work',
    emit: (event) => events.push(event),
    queryFn: sdk.fn,
    // API キーで走る peer の CODEX_HOME は、子の HOME/.codex。chown は自分自身へ（試験は root とは限らない）
    env: {},
    childUser: { uid: process.getuid?.() ?? 0, gid: process.getgid?.() ?? 0, home },
    spawnAgentProcessFn: () => fakeAppServer(requests, rolloutFile),
    credentials: createCredentialStore({
      dir: makeTempDirSync('alteroid-runner-peer-resume-cred-'),
      seed: {},
    }),
    codexHome: makeTempDirSync('alteroid-runner-peer-resume-codex-'),
    peer: {
      openSocket: async () => peerHost,
      reportsUsage: () => true,
      childEntry: '/app/relay.js',
      workdirRoot: makeTempDirSync('alteroid-peer-resume-workdir-'),
    },
  });
  await host.setCredentials([{ name: 'CODEX_API_KEY', value: 'sk-test' }]);
  const connect = async () => {
    const server = captured!();
    const [clientSide, serverSide] = InMemoryTransport.createLinkedPair();
    await server.connect(serverSide);
    const client = new Client({ name: 't', version: '0' });
    await client.connect(clientSide);
    return client;
  };
  const text = (result: unknown): string =>
    ((result as { content: { text: string }[] }).content[0]?.text ?? '') as string;
  const mirrors = () =>
    events.filter((e): e is Extract<RunnerEvent, { type: 'mirror' }> => e.type === 'mirror');
  const peerMirrors = () => mirrors().filter((e) => e.key.subpath?.startsWith('peers/') === true);
  const notes = () => events.flatMap((e) => (e.type === 'note' ? [e.text] : []));
  return { host, sdk, home, rolloutFile, requests, events, connect, text, peerMirrors, notes };
}

const MAIN_KEY = { projectKey: '-work', sessionId: 'sess-main' };

describe('runner: peer の記録を預ける（#5257）', () => {
  it('peer のターンが止まるたびに、増えた行だけを peers/<peerId> へ預ける（メタの行つき・主の鍵で）', async () => {
    const s = await setup();
    mkdirSync(dirname(s.rolloutFile), { recursive: true });
    writeFileSync(s.rolloutFile, `${JSON.stringify(line(0, 'session_meta'))}\n`);
    await s.host.start({ managerId: 'mgr-1', request: 'やって', cwd: '/work' });
    const store = s.sdk.options()['sessionStore'] as {
      append: (key: Json, entries: unknown[]) => Promise<void>;
    };
    await store.append(MAIN_KEY, [{ type: 'user' }]);
    const client = await s.connect();

    const first = s.text(
      await client.callTool({
        name: 'peer_run',
        arguments: { provider: 'codex', prompt: '調べて' },
      }),
    );
    const peerId = /session_id: (peer-[0-9a-f]+)/.exec(first)?.[1];
    expect(peerId).toBeDefined();
    // 預けは止まりどころの後に非同期で行う（peer_run の応答は待たない）
    await vi.waitFor(() => expect(s.peerMirrors().length).toBeGreaterThan(0));
    const entries = s.peerMirrors().flatMap((e) => e.entries) as Json[];
    expect(s.peerMirrors().every((e) => e.key.subpath === `peers/${peerId}`)).toBe(true);
    expect(s.peerMirrors()[0]?.key).toMatchObject(MAIN_KEY);
    expect(entries[0]).toEqual({
      type: 'alteroid_peer_meta',
      provider: 'codex',
      threadId: THREAD,
      relPath: REL,
    });
    expect(entries.slice(1).map((entry) => entry['ordinal'])).toEqual([0, 101]);

    const before = s.peerMirrors().length;
    await client.callTool({
      name: 'peer_reply',
      arguments: { session_id: peerId, message: '続き' },
    });
    await vi.waitFor(() => expect(s.peerMirrors().length).toBeGreaterThan(before));
    const added = s
      .peerMirrors()
      .slice(before)
      .flatMap((e) => e.entries) as Json[];
    expect(added.map((entry) => entry['ordinal'])).toEqual([102]);
    await client.close();
    await s.host.shutdown();
  });

  it('主の記録の鍵が分かる前は預けず、分かったら預ける', async () => {
    const s = await setup();
    mkdirSync(dirname(s.rolloutFile), { recursive: true });
    writeFileSync(s.rolloutFile, `${JSON.stringify(line(0))}\n`);
    await s.host.start({ managerId: 'mgr-1', request: 'やって', cwd: '/work' });
    const client = await s.connect();
    await client.callTool({ name: 'peer_run', arguments: { provider: 'codex', prompt: '調べて' } });
    expect(s.peerMirrors()).toEqual([]);

    const store = s.sdk.options()['sessionStore'] as {
      append: (key: Json, entries: unknown[]) => Promise<void>;
    };
    await store.append(MAIN_KEY, [{ type: 'user' }]);
    await vi.waitFor(() => expect(s.peerMirrors().length).toBeGreaterThan(0));
    const ordinals = (s.peerMirrors().flatMap((e) => e.entries) as Json[]).map(
      (entry) => entry['ordinal'],
    );
    expect(ordinals).toEqual([undefined, 0, 101]);
    await client.close();
    await s.host.shutdown();
  });
});

describe('runner: 戻された peer を置いて、peer_reply が続きから起こす（#5257）', () => {
  const peers = (relPath = REL) => [
    {
      peerId: 'peer-aaaa',
      provider: 'codex',
      threadId: THREAD,
      relPath,
      entries: [line(1, 'b'), line(0, 'a'), line(1, 'b-dup')],
    },
  ];

  it('peer_reply が来たとき、HOME/.codex/sessions/<relPath> へ置き、thread/resume でその thread を起こす', async () => {
    const s = await setup();
    await s.host.resume({
      managerId: 'mgr-1',
      sessionId: 'sess-main',
      cwd: '/work',
      request: 'やって',
      peers: peers(),
    });
    // 来るまで置かない（資格・CODEX_HOME が確かな時点で置く）
    expect(existsSync(s.rolloutFile)).toBe(false);
    const client = await s.connect();

    const reply = s.text(
      await client.callTool({
        name: 'peer_reply',
        arguments: { session_id: 'peer-aaaa', message: '前の続きをお願い' },
      }),
    );

    expect(reply).not.toContain('peer セッションは無い');
    expect(reply).toContain('終わった');
    const lines = readFileSync(s.rolloutFile, 'utf8').trim().split('\n');
    expect(lines.slice(0, 2).map((text) => (JSON.parse(text) as Json)['ordinal'])).toEqual([0, 1]);
    const resumeRequest = s.requests.find((request) => request.method === 'thread/resume');
    expect(resumeRequest?.params['threadId']).toBe(THREAD);
    expect(s.requests.some((request) => request.method === 'thread/start')).toBe(false);
    expect(
      s.notes().some((note) => note.includes('[peer-aaaa]') && note.includes('続きから起こした')),
    ).toBe(true);
    await client.close();
    await s.host.shutdown();
  });

  it('対照: 戻されていない id への peer_reply は、今までどおり断り、相手を起こさない', async () => {
    const s = await setup();
    await s.host.resume({
      managerId: 'mgr-1',
      sessionId: 'sess-main',
      cwd: '/work',
      request: 'やって',
      peers: peers(),
    });
    const client = await s.connect();
    const reply = s.text(
      await client.callTool({
        name: 'peer_reply',
        arguments: { session_id: 'peer-zzzz', message: '続き' },
      }),
    );
    expect(reply).toContain('peer セッションは無い');
    expect(s.requests.some((request) => request.method === 'thread/resume')).toBe(false);
    await client.close();
    await s.host.shutdown();
  });

  it('relPath が危ない peer は置かず、起こさずに今までどおり断る', async () => {
    const s = await setup();
    await s.host.resume({
      managerId: 'mgr-1',
      sessionId: 'sess-main',
      cwd: '/work',
      request: 'やって',
      peers: peers('../auth.json'),
    });
    const client = await s.connect();
    const reply = s.text(
      await client.callTool({
        name: 'peer_reply',
        arguments: { session_id: 'peer-aaaa', message: '続き' },
      }),
    );
    expect(reply).toContain('peer セッションは無い');
    expect(s.requests.some((request) => request.method === 'thread/resume')).toBe(false);
    expect(existsSync(join(s.home, '.codex', 'auth.json'))).toBe(false);
    await client.close();
    await s.host.shutdown();
  });
});
