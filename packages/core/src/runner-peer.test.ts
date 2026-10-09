import { EventEmitter } from 'node:events';
import { statSync } from 'node:fs';
import { PassThrough } from 'node:stream';

import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { InMemoryTransport } from '@modelcontextprotocol/sdk/inMemory.js';
import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import type { Query, query as sdkQuery } from '@anthropic-ai/claude-agent-sdk';
import { describe, expect, it, vi } from 'vitest';

import { makeTempDirSync } from '../../../vitest.tmpdir.js';
import type { AgentChildProcess } from './agent-session.js';
import { CODEX_PEER_CLOSED_REASON } from './agent-provider-peers.js';
import { createCredentialStore } from './credentials.js';
import { PEER_MCP_SERVER_NAME } from './peer-broker.js';
import type { RunnerEvent } from './runner-protocol.js';
import type { PeerSocketHost } from './peer-socket-host.js';
import { createRunnerHost, type RunnerHostPeerOptions, type RunnerHostOptions } from './runner.js';

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

function readingQuery(): {
  fn: typeof sdkQuery;
  options: () => Record<string, unknown>;
  inputs: string[];
} {
  const inputs: string[] = [];
  let captured: Record<string, unknown> = {};
  const fn = vi.fn((args: { prompt: AsyncIterable<unknown>; options: Record<string, unknown> }) => {
    captured = args.options;
    let close = (): void => undefined;
    const closed = new Promise<void>((resolve) => {
      close = resolve;
    });
    void (async () => {
      for await (const message of args.prompt) inputs.push(JSON.stringify(message));
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
  return { fn: fn as unknown as typeof sdkQuery, options: () => captured, inputs };
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

function peerOptions(
  socket: PeerSocketHost,
  extra: Partial<RunnerHostPeerOptions> = {},
): RunnerHostPeerOptions & { opened: () => number } {
  let opened = 0;
  return {
    openSocket: async () => {
      opened += 1;
      return socket;
    },
    reportsUsage: () => true,
    childEntry: '/app/relay.js',
    ...extra,
    opened: () => opened,
  };
}

function vessels(): Pick<RunnerHostOptions, 'credentials' | 'codexHome'> {
  return {
    credentials: createCredentialStore({
      dir: makeTempDirSync('alteroid-runner-peer-cred-'),
      seed: {},
    }),
    codexHome: makeTempDirSync('alteroid-runner-peer-codex-'),
  };
}

function hostWith(options: { peer?: RunnerHostPeerOptions; env?: NodeJS.ProcessEnv }): {
  host: ReturnType<typeof createRunnerHost>;
  sdk: ReturnType<typeof capturingQuery>;
  events: RunnerEvent[];
} {
  const sdk = capturingQuery();
  const events: RunnerEvent[] = [];
  const host = createRunnerHost({
    runnerId: 'runner-test',
    workspacePath: '/work',
    emit: (event) => events.push(event),
    queryFn: sdk.fn,
    env: options.env ?? {},
    ...vessels(),
    ...(options.peer === undefined ? {} : { peer: options.peer }),
  });
  return { host, sdk, events };
}

const peersEvents = (events: RunnerEvent[]): Extract<RunnerEvent, { type: 'manager_peers' }>[] =>
  events.filter(
    (e): e is Extract<RunnerEvent, { type: 'manager_peers' }> => e.type === 'manager_peers',
  );

describe('runner: MCP peer の登録（開く条件は Codex の資格。#4118）', () => {
  it('peer の口が無ければ mcpServers に何も足さず、名乗りも無い（ローカル実行と同じ）', async () => {
    const { host, sdk } = hostWith({});
    await host.start({ managerId: 'mgr-1', request: 'やって', cwd: '/work' });
    expect(sdk.options().mcpServers).toBeUndefined();
    expect(host.managerPeers()).toBeUndefined();
    await host.shutdown();
  });

  it('資格が無ければ何も足さず、ソケットも開かず、閉じている理由を名乗る', async () => {
    const socket = fakePeerHost();
    const peer = peerOptions(socket);
    const { host, sdk, events } = hostWith({ peer });
    await host.start({ managerId: 'mgr-1', request: 'やって', cwd: '/work' });
    expect(sdk.options().mcpServers).toBeUndefined();
    expect(socket.tokens).toEqual([]);
    expect(peer.opened()).toBe(0);
    expect(host.managerPeers()).toEqual({
      managerPeers: [],
      managerPeersClosed: [{ provider: 'codex', reason: CODEX_PEER_CLOSED_REASON }],
    });
    expect(peersEvents(events)).toEqual([]);
    await host.shutdown();
  });

  it('旧い ALTEROID_MANAGER_PEERS=codex は読まない（資格が無ければ閉じたまま）', async () => {
    const socket = fakePeerHost();
    const { host, sdk } = hostWith({
      peer: peerOptions(socket),
      env: { ALTEROID_MANAGER_PEERS: 'codex' },
    });
    await host.start({ managerId: 'mgr-1', request: 'やって', cwd: '/work' });
    expect(sdk.options().mcpServers).toBeUndefined();
    expect(host.managerPeers()?.managerPeers).toEqual([]);
    await host.shutdown();
  });

  it('CODEX_API_KEY が後から届けば、再起動なしで開いて名乗り直し、使い捨て token つきの stdio MCP を足す', async () => {
    const socket = fakePeerHost();
    const peer = peerOptions(socket, { models: { codex: ['gpt-5.5'] } });
    const { host, sdk, events } = hostWith({ peer });
    await host.setCredentials([{ name: 'CODEX_API_KEY', value: 'sk-test' }]);
    expect(peer.opened()).toBe(1);
    expect(peersEvents(events)).toEqual([
      {
        type: 'manager_peers',
        runnerId: 'runner-test',
        managerPeers: [{ provider: 'codex', models: ['gpt-5.5'] }],
      },
    ]);
    expect(host.managerPeers()).toEqual({
      managerPeers: [{ provider: 'codex', models: ['gpt-5.5'] }],
    });

    await host.start({ managerId: 'mgr-1', request: 'やって', cwd: '/work' });
    const servers = sdk.options().mcpServers as Record<string, Record<string, unknown>>;
    expect(Object.keys(servers)).toEqual([PEER_MCP_SERVER_NAME]);
    const entry = servers[PEER_MCP_SERVER_NAME]!;
    expect(entry.type).toBe('stdio');
    expect(entry.args).toEqual(['/app/relay.js']);
    expect(entry.env).toEqual({
      ALTEROID_CLONE_TOOL_RELAY_SOCKET: '/run/alteroid/peer/peer.sock',
      ALTEROID_CLONE_TOOL_RELAY_TOKEN: 'tok-1',
    });
    expect(socket.tokens).toHaveLength(1);
    await host.shutdown();
  });

  it('ChatGPT ログインが後から届いても開き、ログアウトで閉じて理由を名乗る。ソケットは1回だけ開く', async () => {
    const socket = fakePeerHost();
    const peer = peerOptions(socket);
    const { host, events } = hostWith({ peer });
    await host.setCodexAuth({ value: '{}', revision: 'r1' });
    expect(host.managerPeers()).toEqual({ managerPeers: [{ provider: 'codex' }] });
    await host.setCodexAuth({ value: '{"x":1}', revision: 'r2' });
    await host.setCodexAuth(null);
    expect(host.managerPeers()).toEqual({
      managerPeers: [],
      managerPeersClosed: [{ provider: 'codex', reason: CODEX_PEER_CLOSED_REASON }],
    });
    await host.setCodexAuth({ value: '{}', revision: 'r3' });
    expect(peersEvents(events).map((e) => e.managerPeers.length)).toEqual([1, 0, 1]);
    expect(peer.opened()).toBe(1);
    await host.shutdown();
  });

  it('ソケットを開けなければ閉じている側へ倒し、理由を名乗る（次に資格が降りたときにもう一度試す）', async () => {
    let attempts = 0;
    const socket = fakePeerHost();
    const { host } = hostWith({
      peer: {
        openSocket: async () => {
          attempts += 1;
          if (attempts === 1) throw new Error('EACCES');
          return socket;
        },
        reportsUsage: () => true,
      },
    });
    await host.setCredentials([{ name: 'CODEX_API_KEY', value: 'sk-test' }]);
    expect(host.managerPeers()?.managerPeers).toEqual([]);
    expect(host.managerPeers()?.managerPeersClosed?.[0]?.reason).toMatch(
      /peer 用のソケットを開けなかった: .*EACCES/,
    );
    await host.setCodexAuth({ value: '{}', revision: 'r1' });
    expect(host.managerPeers()).toEqual({ managerPeers: [{ provider: 'codex' }] });
    await host.shutdown();
  });

  it('peer の道具を出したセッションにだけ、プロンプトで Codex に頼めることを示す（token は1つだけ。#4125）', async () => {
    const appendOf = (options: Record<string, unknown>): string =>
      (options.systemPrompt as { append?: string } | undefined)?.append ?? '';
    const socket = fakePeerHost();
    const opened = hostWith({ peer: peerOptions(socket, { models: { codex: ['gpt-5.5'] } }) });
    await opened.host.setCredentials([{ name: 'CODEX_API_KEY', value: 'sk-test' }]);
    await opened.host.start({ managerId: 'mgr-1', request: 'やって', cwd: '/work' });
    expect(appendOf(opened.sdk.options())).toContain('# Codex（peer）');
    expect(appendOf(opened.sdk.options())).toContain('名指しできるモデル: gpt-5.5');
    expect(socket.tokens).toHaveLength(1);
    await opened.host.shutdown();

    for (const closed of [hostWith({ peer: peerOptions(fakePeerHost()) }), hostWith({})]) {
      await closed.host.start({ managerId: 'mgr-1', request: 'やって', cwd: '/work' });
      expect(appendOf(closed.sdk.options())).not.toContain('Codex');
      await closed.host.shutdown();
    }
  });
});

describe('runner: peer の承認をクローンへ上げる', () => {
  type Json = Record<string, unknown>;

  function approvingAppServer(
    decisions: unknown[],
    toolItems: Json[] = [],
    starts: Json[] = [],
    gate?: Promise<void>,
  ): AgentChildProcess {
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
            for (const item of toolItems) {
              send({
                method: 'item/completed',
                params: { threadId: 'thr-peer', turnId: 'turn-1', item },
              });
            }
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
          starts.push(message['params'] as Json);
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
          void (gate ?? new Promise<void>((resolve) => setImmediate(resolve))).then(() => {
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

  async function setupPeerCall(
    toolItems: Json[] = [],
    options: {
      env?: NodeJS.ProcessEnv;
      models?: RunnerHostPeerOptions['models'];
      args?: Json;
      sdk?: ReturnType<typeof readingQuery>;
      gate?: Promise<void>;
      childUser?: RunnerHostOptions['childUser'];
    } = {},
  ) {
    const sdk = options.sdk ?? capturingQuery();
    const events: RunnerEvent[] = [];
    const decisions: unknown[] = [];
    const starts: Json[] = [];
    const peerHost = capturingPeerHost();
    const workdirRoot = makeTempDirSync('alteroid-peer-workdir-');
    const host = createRunnerHost({
      runnerId: 'runner-test',
      workspacePath: '/work',
      emit: (event) => events.push(event),
      queryFn: sdk.fn,
      env: options.env ?? {},
      childUser: options.childUser ?? { uid: 1000, gid: 1000 },
      spawnAgentProcessFn: () => approvingAppServer(decisions, toolItems, starts, options.gate),
      ...vessels(),
      peer: {
        openSocket: async () => peerHost,
        reportsUsage: () => true,
        childEntry: '/app/relay.js',
        workdirRoot,
        ...(options.models === undefined ? {} : { models: options.models }),
      },
    });
    await host.setCredentials([{ name: 'CODEX_API_KEY', value: 'sk-test' }]);
    await host.start({ managerId: 'mgr-1', request: 'やって', cwd: '/work' });
    const server = peerHost.factory()!();
    const [clientSide, serverSide] = InMemoryTransport.createLinkedPair();
    await server.connect(serverSide);
    const client = new Client({ name: 't', version: '0' });
    await client.connect(clientSide);
    const first = (await client.callTool({
      name: 'peer_run',
      arguments: { provider: 'codex', prompt: '掃除して', ...options.args },
    })) as { content: { text: string }[]; isError?: boolean };
    const asks = (): Extract<RunnerEvent, { type: 'ask' }>[] =>
      events.filter((e): e is Extract<RunnerEvent, { type: 'ask' }> => e.type === 'ask');
    const firstText = first.content[0]?.text ?? '';
    const approvalId = /approval_id=(appr-[0-9a-f]+)/.exec(firstText)?.[1];
    let returned = false;
    const approve = (decision: 'allow' | 'deny' | 'escalate') =>
      client
        .callTool({ name: 'peer_approve', arguments: { approval_id: approvalId, decision } })
        .then((result) => {
          returned = true;
          return result as { content: { text: string }[] };
        });
    return {
      host,
      client,
      first,
      firstText,
      approvalId,
      approve,
      asks,
      decisions,
      events,
      starts,
      workdirRoot,
      returned: () => returned,
    };
  }

  async function waitFor(condition: () => boolean): Promise<void> {
    for (let i = 0; i < 20_000 && !condition(); i += 1) {
      await new Promise((resolve) => setImmediate(resolve));
    }
  }

  it('背景の peer_run はすぐ返り、確認待ち・ターンの終わりを知らせとしてマネージャーへ入れて起こす（#4123）', async () => {
    const sdk = readingQuery();
    const s = await setupPeerCall([], { args: { run_in_background: true }, sdk });
    expect(s.first.isError).toBeUndefined();
    expect(s.firstText).toContain('背景で流し始めた');
    const notes = (): string[] => s.events.flatMap((e) => (e.type === 'note' ? [e.text] : []));
    await waitFor(() =>
      sdk.inputs.some((input) => input.includes('alteroid が自動で送った知らせ')),
    );
    expect(notes().some((text) => text.includes('確認待ちで止まった'))).toBe(true);
    const notice =
      sdk.inputs.find((input) => input.includes('alteroid が自動で送った知らせ')) ?? '';
    const approvalId = /approval_id=(appr-[0-9a-f]+)/.exec(notice)?.[1];
    expect(approvalId).toBeDefined();
    const answered = (await s.client.callTool({
      name: 'peer_approve',
      arguments: { approval_id: approvalId, decision: 'allow', run_in_background: true },
    })) as { content: { text: string }[] };
    expect(answered.content[0]?.text).toContain('背景で流し始めた');
    await waitFor(() => notes().some((text) => text.includes('ターンが終わった')));
    await waitFor(
      () =>
        sdk.inputs.filter((input) => input.includes('alteroid が自動で送った知らせ')).length === 2,
    );
    expect(sdk.inputs.at(-1)).toContain('終わった');
    expect(s.decisions).toEqual(['accept']);
    expect(s.host.list()[0]?.liveBackgroundTasks).toBe(0);
    await s.client.close();
    await s.host.shutdown();
  });

  it('背景で流れている peer は、作業者の背景処理と同じ一覧（状態の liveBackgroundTasks）に数えられる（#4123）', async () => {
    let release = (): void => undefined;
    const gate = new Promise<void>((resolve) => {
      release = resolve;
    });
    const sdk = readingQuery();
    const s = await setupPeerCall([], { args: { run_in_background: true }, sdk, gate });
    expect(s.firstText).toContain('背景で流し始めた');
    expect(s.host.list()[0]?.liveBackgroundTasks).toBe(1);
    release();
    await waitFor(() =>
      sdk.inputs.some((input) => input.includes('alteroid が自動で送った知らせ')),
    );
    expect(s.host.list()[0]?.liveBackgroundTasks).toBe(0);
    await s.client.close();
    await s.host.shutdown();
  });

  it('マネージャーが確認待ちの間は背景の知らせを溜め、答えが出たら届ける（#4123。#1554 と同じ規則）', async () => {
    const sdk = readingQuery();
    const s = await setupPeerCall([], { sdk });
    const noticeCount = (): number =>
      sdk.inputs.filter((input) => input.includes('alteroid が自動で送った知らせ')).length;
    const escalated = (await s.client.callTool({
      name: 'peer_approve',
      arguments: { approval_id: s.approvalId, decision: 'escalate', run_in_background: true },
    })) as { content: { text: string }[] };
    expect(escalated.content[0]?.text).toContain('背景で流し始めた');
    await waitFor(() => s.asks().length > 0);
    expect(s.host.list()[0]?.status).toBe('waiting_human');
    await s.client.callTool({
      name: 'peer_run',
      arguments: { provider: 'codex', prompt: 'B', run_in_background: true },
    });
    await waitFor(() =>
      s.events.some((e) => e.type === 'note' && e.text.includes('確認待ちで止まった')),
    );
    expect(noticeCount()).toBe(0);
    expect(s.decisions).toEqual([]);
    await s.host.answer('mgr-1', {
      requestId: s.asks()[0]!.requestId,
      message: 'いいよ',
      decision: 'allow',
    });
    await waitFor(() => noticeCount() >= 2);
    expect(sdk.inputs.join('\n')).toMatch(/approval_id=appr-[0-9a-f]+/);
    expect(s.decisions).toEqual(['accept']);
    await s.client.close();
    await s.host.shutdown();
  });

  it('確認はまず peer_run の応答としてマネージャーへ返り、ask は上がらない', async () => {
    const s = await setupPeerCall();
    expect(s.first.isError).toBeUndefined();
    expect(s.firstText).toContain('確認待ち');
    expect(s.firstText).toContain('commandExecution');
    expect(s.firstText).toContain('rm -rf build');
    expect(s.approvalId).toBeDefined();
    expect(s.asks()).toEqual([]);
    expect(s.decisions).toEqual([]);
    const result = await s.approve('allow');
    expect(s.decisions).toEqual(['accept']);
    expect(s.asks()).toEqual([]);
    expect(result.content[0]?.text).toContain('終わった');
    expect(result.content[0]?.text).toContain('commandExecution(manager)');
    await s.client.close();
    await s.host.shutdown();
  });

  it('escalate で出所の印つきの ask に上がり、答えが出るまで peer_approve は返らない。allow で codex へ accept が返る', async () => {
    const s = await setupPeerCall();
    const pending = s.approve('escalate');
    await waitFor(() => s.asks().length > 0);
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
    const result = await pending;
    expect(s.decisions).toEqual(['accept']);
    expect(result.content[0]?.text).toContain('終わった');
    expect(result.content[0]?.text).toContain('承認した操作が 1 件');
    expect(result.content[0]?.text).toContain('commandExecution(clone)');
    await s.client.close();
    await s.host.shutdown();
  });

  it('マネージャーの deny なら ask を上げずに codex へ decline が返り、結果に拒否の件数が出る', async () => {
    const s = await setupPeerCall();
    const result = await s.approve('deny');
    expect(s.decisions).toEqual(['decline']);
    expect(s.asks()).toEqual([]);
    expect(result.content[0]?.text).toContain('拒否した');
    expect(result.content[0]?.text).toContain('commandExecution(manager)');
    await s.client.close();
    await s.host.shutdown();
  });

  it('peer の構えは呼び出し元のマネージャーと同じ（既定は on-request、bypassPermissions なら never。sandbox はマネージャーの Codex と同じ）', async () => {
    const byDefault = await setupPeerCall();
    expect(byDefault.starts[0]?.['approvalPolicy']).toBe('on-request');
    expect(byDefault.starts[0]?.['sandbox']).toBe('danger-full-access');
    await byDefault.approve('allow');
    await byDefault.client.close();
    await byDefault.host.shutdown();
    const bypass = await setupPeerCall([], {
      env: { ALTEROID_MANAGER_PERMISSION_MODE: 'bypassPermissions' },
    });
    expect(bypass.starts[0]?.['approvalPolicy']).toBe('never');
    await bypass.approve('allow');
    await bypass.client.close();
    await bypass.host.shutdown();
  });

  it('peer の cwd はマネージャーの作業場（<根>/mgr-<先頭8桁>）で、無ければ作り、プロンプトで場所を伝える（#4143）', async () => {
    const own = { uid: process.getuid?.() ?? 0, gid: process.getgid?.() ?? 0 };
    const s = await setupPeerCall([], { childUser: own });
    const dir = `${s.workdirRoot}/mgr-1`;
    expect(s.starts[0]?.['cwd']).toBe(dir);
    expect(statSync(dir).isDirectory()).toBe(true);
    expect(String(s.starts[0]?.['developerInstructions'])).toContain(`作業場は ${dir} である`);
    expect(String(s.starts[0]?.['developerInstructions'])).toContain(
      '共有の場所にファイルを作らないこと',
    );
    await s.approve('allow');
    await s.client.close();
    await s.host.shutdown();
  });

  it('作業場を子の uid へ渡せなければ、マネージャーの cwd のままにして note を残す（#4143）', async () => {
    if (process.getuid?.() === 0) return;
    const s = await setupPeerCall([], { childUser: { uid: 1000, gid: 1000 } });
    expect(s.starts[0]?.['cwd']).toBe('/work');
    expect(s.events.some((e) => e.type === 'note' && e.text.includes('peer の作業場'))).toBe(true);
    expect(String(s.starts[0]?.['developerInstructions'])).not.toContain('作業場は');
    await s.approve('allow');
    await s.client.close();
    await s.host.shutdown();
  });

  it('名指しのモデルは thread/start の model に届き、省けば model を渡さない（Codex の既定）', async () => {
    const named = await setupPeerCall([], {
      models: { codex: ['gpt-5.5'] },
      args: { model: 'gpt-5.5' },
    });
    expect(named.starts[0]?.['model']).toBe('gpt-5.5');
    expect(named.firstText).toContain('model: gpt-5');
    await named.approve('allow');
    await named.client.close();
    await named.host.shutdown();
    const plain = await setupPeerCall([], { models: { codex: ['gpt-5.5'] } });
    expect(plain.starts[0]).not.toHaveProperty('model');
    await plain.approve('allow');
    await plain.client.close();
    await plain.host.shutdown();
  });

  it('peer が実行したツールは、actor=peer:<managerId>:<provider> の tool_use として降りる。失敗は note（#2753・#4122）', async () => {
    const s = await setupPeerCall([
      {
        type: 'commandExecution',
        id: 'c1',
        command: 'ls -la',
        cwd: '/work',
        commandActions: [],
        status: 'completed',
        exitCode: 0,
      },
      {
        type: 'commandExecution',
        id: 'c2',
        command: 'false',
        cwd: '/work',
        commandActions: [],
        status: 'failed',
        exitCode: 1,
      },
    ]);
    await s.approve('allow');
    const toolUses = s.events.filter((e) => e.type === 'tool_use');
    expect(toolUses).toHaveLength(1);
    expect(toolUses[0]).toMatchObject({ actor: 'peer:mgr-1:codex' });
    expect(JSON.stringify(toolUses[0])).toContain('ls -la');
    const failures = s.events.filter(
      (e) => e.type === 'note' && e.text.includes('actor=peer:mgr-1:codex'),
    );
    expect(failures).toHaveLength(1);
    await s.client.close();
    await s.host.shutdown();
  });

  it('peer のターンは、作業者と同じ tool_running / tool_end として降りる（ターンの開始ですぐ。#4122）', async () => {
    const s = await setupPeerCall([], {
      models: { codex: ['gpt-5.5'] },
      args: { model: 'gpt-5.5' },
    });
    const running = s.events.filter((e) => e.type === 'tool_running');
    expect(running).toHaveLength(1);
    expect(running[0]).toMatchObject({
      type: 'tool_running',
      managerId: 'mgr-1',
      actor: 'peer:mgr-1:codex',
      tool: 'peer_run',
      model: 'gpt-5.5',
    });
    expect(s.events.filter((e) => e.type === 'tool_end')).toHaveLength(0);
    await s.approve('allow');
    const ended = s.events.filter((e) => e.type === 'tool_end');
    expect(ended).toHaveLength(1);
    expect(ended[0]).toMatchObject({
      managerId: 'mgr-1',
      toolUseId: (running[0] as { toolUseId: string }).toolUseId,
    });
    await s.client.close();
    await s.host.shutdown();
  });
});
