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

  it('peer の道具を出したセッションにだけ、プロンプトで Codex に頼めることを示す（token は1つだけ。#4125）', async () => {
    const appendOf = (options: Record<string, unknown>): string =>
      (options.systemPrompt as { append?: string } | undefined)?.append ?? '';
    const host = fakePeerHost();
    const opened = await startWith({
      host,
      peers: ['codex'],
      reportsUsage: () => true,
      childEntry: '/app/relay.js',
      models: { codex: ['gpt-5.5'] },
    });
    expect(appendOf(opened)).toContain('# Codex（peer）');
    expect(appendOf(opened)).toContain('名指しできるモデル: gpt-5.5');
    // 案内のために peer の口を2回開けない（token は使い捨てで、呼ぶたびに発行される）
    expect(host.tokens).toHaveLength(1);

    const closed = await startWith({ host: fakePeerHost(), peers: [], reportsUsage: () => true });
    expect(appendOf(closed)).not.toContain('Codex');
    expect(appendOf(await startWith(undefined))).not.toContain('Codex');
  });
});

/**
 * peer のセッションの承認が、呼び出し元のマネージャーの承認として既存の経路（`ask` / `answer`）で
 * 上がること。出所の印が必ず付き、答えが出るまで `peer_run` は返らない（#486 S7 案A）。
 *
 * **#3940（2026-10-07 のオーナー決定）で行き先が変わった。** 確認はまず `peer_run` の応答として
 * マネージャーへ返り（`ask` は上がらない）、マネージャーが `peer_approve` で `escalate` を選んだときだけ
 * 既存の経路（`ask` / `answer`。出所の印つき）でクローンへ上がる。下の2本は旧仕様の期待値を反転した。
 */
describe('runner: peer の承認をクローンへ上げる', () => {
  type Json = Record<string, unknown>;

  /** `item/commandExecution/requestApproval` を1回上げてから、答えに応じて完了する偽の app-server。 */
  function approvingAppServer(
    decisions: unknown[],
    toolItems: Json[] = [],
    starts: Json[] = [],
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

  async function setupPeerCall(
    toolItems: Json[] = [],
    options: { env?: NodeJS.ProcessEnv; models?: RunnerPeerOptions['models']; args?: Json } = {},
  ) {
    const sdk = capturingQuery();
    const events: RunnerEvent[] = [];
    const decisions: unknown[] = [];
    const starts: Json[] = [];
    const peerHost = capturingPeerHost();
    const host = createRunnerHost({
      runnerId: 'runner-test',
      workspacePath: '/work',
      emit: (event) => events.push(event),
      queryFn: sdk.fn,
      env: options.env ?? {},
      childUser: { uid: 1000, gid: 1000 },
      spawnAgentProcessFn: () => approvingAppServer(decisions, toolItems, starts),
      peer: {
        host: peerHost,
        peers: ['codex'],
        reportsUsage: () => true,
        childEntry: '/app/relay.js',
        ...(options.models === undefined ? {} : { models: options.models }),
      },
    });
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
      returned: () => returned,
    };
  }

  async function waitFor(condition: () => boolean): Promise<void> {
    for (let i = 0; i < 20_000 && !condition(); i += 1) {
      await new Promise((resolve) => setImmediate(resolve));
    }
  }

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

  /*
   * 以前の名前は「承認は出所の印つきで ask に上がり、答えが出るまで peer_run は返らない。allow で codex へ
   * accept が返る」。いまは escalate を選んだときだけ ask に上がり、答えが出るまで返らないのは
   * peer_approve の側である（#3940）。出所の印・id の前置・accept への写しは同じ強さで測る。
   */
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

  /*
   * 以前の名前は「deny なら codex へ decline が返り、結果に拒否の件数が出る」で、deny はクローンの答えだった。
   * いまはマネージャーがその場で deny できる（クローンへは上がらない）。decline への写しは同じ強さで測る。
   */
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

  it('peer が実行したツールは、actor=peer:<provider> の tool_use として降りる。失敗は note（#2753）', async () => {
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
    expect(toolUses[0]).toMatchObject({ actor: 'peer:codex' });
    expect(JSON.stringify(toolUses[0])).toContain('ls -la');
    const failures = s.events.filter(
      (e) => e.type === 'note' && e.text.includes('actor=peer:codex'),
    );
    expect(failures).toHaveLength(1);
    await s.client.close();
    await s.host.shutdown();
  });
});
