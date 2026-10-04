import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { InMemoryTransport } from '@modelcontextprotocol/sdk/inMemory.js';
import { describe, expect, it } from 'vitest';

import type { AgentEvent } from './agent-events.js';
import type {
  AgentManagerDriver,
  AgentManagerSession,
  AgentManagerSessionSpec,
} from './agent-session.js';
import {
  createPeerBroker,
  PEER_MCP_SERVER_NAME,
  type PeerBrokerDeps,
  type PeerUsageReport,
} from './peer-broker.js';
import type { UsageTotals } from './usage.js';

function totals(input: number, output: number): UsageTotals {
  return {
    inputTokens: input,
    outputTokens: output,
    cacheReadInputTokens: 0,
    cacheCreationInputTokens: 0,
    webSearchRequests: 0,
    costUsd: 0,
  };
}

function turnEnded(body: string, models?: Record<string, UsageTotals>): AgentEvent {
  return {
    type: 'turn_ended',
    succeeded: true,
    body,
    errorLines: [],
    denials: [],
    ...(models === undefined ? {} : { usage: { models } }),
  };
}

/** 入力を1通引くたびに、台本の次の応答を返す偽の駆動役。 */
function scriptedDriver(
  script: (turn: number, spec: AgentManagerSessionSpec) => Promise<AgentEvent[]> | AgentEvent[],
  seen: { specs: AgentManagerSessionSpec[]; closed: number },
): AgentManagerDriver {
  return {
    providerId: 'codex',
    open(spec) {
      seen.specs.push(spec);
      const session: AgentManagerSession = {
        readEvents: async (onEvent) => {
          let turn = 0;
          await onEvent({
            type: 'session_started',
            sessionId: 'thr-1',
            runtime: {} as never,
          });
          for await (const input of spec.input) {
            void input;
            turn += 1;
            for (const event of await script(turn, spec)) await onEvent(event);
          }
        },
        close: () => {
          seen.closed += 1;
        },
        contextUsage: async () => {
          throw new Error('unused');
        },
        sessionModelUsage: async () => undefined,
      };
      return session;
    },
  };
}

function makeBroker(
  script: Parameters<typeof scriptedDriver>[0],
  options: { reportsUsage?: boolean; askApproval?: PeerBrokerDeps['askApproval'] } = {},
) {
  const seen = { specs: [] as AgentManagerSessionSpec[], closed: 0 };
  const notes: string[] = [];
  const usage: PeerUsageReport[] = [];
  const deps: PeerBrokerDeps = {
    allowed: ['codex'],
    driverOf: () => scriptedDriver(script, seen),
    makeSpec: (_provider, parts) =>
      ({
        input: parts.input,
        onPermission: parts.onPermission,
        onNote: parts.onNote,
        strictApprovals: true,
      }) as unknown as AgentManagerSessionSpec,
    reportsUsage: () => options.reportsUsage ?? true,
    onNote: (text) => notes.push(text),
    onUsage: (report) => usage.push(report),
    ...(options.askApproval === undefined ? {} : { askApproval: options.askApproval }),
  };
  return { broker: createPeerBroker(deps), seen, notes, usage };
}

describe('peer-broker（マネージャーの MCP peer）', () => {
  it('peer_run は最初の応答を返し、peer_reply で同じセッションを続けられる', async () => {
    const { broker } = makeBroker((turn) => [turnEnded(`答え${turn}`)]);
    const first = await broker.run('codex', '調べて');
    expect(typeof first).not.toBe('string');
    if (typeof first === 'string') return;
    expect(first.ok).toBe(true);
    expect(first.text).toBe('答え1');
    const second = await broker.reply(first.sessionId, '続き');
    expect(typeof second !== 'string' && second.text).toBe('答え2');
    broker.closeAll();
  });

  it('開けていない provider と、知らない session_id は道具のエラーで返す', async () => {
    const { broker } = makeBroker(() => [turnEnded('x')]);
    expect(await broker.run('claude', 'x')).toContain('呼べない');
    expect(await broker.reply('peer-none', 'x')).toContain('無い');
  });

  it('承認の口が無ければ、承認が要る操作は拒否し、結果と日誌に出す（素通しにしない）', async () => {
    const { broker, notes } = makeBroker(async (_turn, spec) => {
      const decision = await spec.onPermission({
        requestId: 'r1',
        kind: 'permission',
        toolName: 'commandExecution',
        input: { command: 'rm -rf /' },
        signal: new AbortController().signal,
      });
      expect(decision.behavior).toBe('deny');
      return [turnEnded('書けなかった')];
    });
    const result = await broker.run('codex', '直して');
    if (typeof result === 'string') throw new Error(result);
    expect(result.denied).toEqual(['commandExecution']);
    expect(
      notes.some((note) => note.includes('拒否した') && note.includes('commandExecution')),
    ).toBe(true);
    broker.closeAll();
  });

  const ask = async (
    spec: AgentManagerSessionSpec,
    kind: 'permission' | 'question' = 'permission',
  ) =>
    spec.onPermission({
      requestId: 'r1',
      kind,
      toolName: 'commandExecution',
      input: {},
      signal: new AbortController().signal,
    });

  it('askApproval があれば出所つきで上げ、許可はそのまま返して結果に数える', async () => {
    const sources: unknown[] = [];
    const { broker } = makeBroker(
      async (_t, spec) => {
        expect((await ask(spec)).behavior).toBe('allow');
        return [turnEnded('やった')];
      },
      {
        askApproval: async (source) => {
          sources.push(source);
          return { behavior: 'allow' };
        },
      },
    );
    const result = await broker.run('codex', 'x');
    if (typeof result === 'string') throw new Error(result);
    expect(result.approved).toEqual(['commandExecution']);
    expect(result.denied).toEqual([]);
    expect(sources).toEqual([{ provider: 'codex', sessionId: result.sessionId }]);
    broker.closeAll();
  });

  it('askApproval が投げたら拒否に倒す。質問は上げずに拒否する', async () => {
    let asked = 0;
    const { broker } = makeBroker(
      async (_t, spec) => {
        expect((await ask(spec)).behavior).toBe('deny');
        expect((await ask(spec, 'question')).behavior).toBe('deny');
        return [turnEnded('だめだった')];
      },
      {
        askApproval: async () => {
          asked += 1;
          throw new Error('口が無い');
        },
      },
    );
    const result = await broker.run('codex', 'x');
    if (typeof result === 'string') throw new Error(result);
    expect(result.denied).toHaveLength(2);
    expect(asked).toBe(1);
    broker.closeAll();
  });

  it('peer のセッションは strictApprovals で起こす', async () => {
    const { broker, seen } = makeBroker(() => [turnEnded('ok')]);
    await broker.run('codex', 'x');
    expect(seen.specs[0]?.strictApprovals).toBe(true);
    broker.closeAll();
  });

  it('消費は peer セッションごとの基準で増分にして降ろす（累積の二重計上をしない）', async () => {
    const { broker, usage } = makeBroker((turn) => [
      turnEnded('ok', { 'gpt-5': totals(turn === 1 ? 100 : 250, turn === 1 ? 10 : 30) }),
    ]);
    const first = await broker.run('codex', 'a');
    if (typeof first === 'string') throw new Error(first);
    await broker.reply(first.sessionId, 'b');
    expect(usage.map((u) => u.models['gpt-5']?.inputTokens)).toEqual([100, 150]);
    expect(usage.every((u) => !u.unmetered)).toBe(true);
    broker.closeAll();
  });

  it('消費を報告しない provider は 0 を積まず、取れなかったターンとして降ろす', async () => {
    const { broker, usage } = makeBroker(() => [turnEnded('ok')], { reportsUsage: false });
    await broker.run('codex', 'a');
    expect(usage).toHaveLength(1);
    expect(usage[0]?.unmetered).toBe(true);
    expect(usage[0]?.models).toEqual({});
    broker.closeAll();
  });

  it('closeAll は開いた peer セッションを全部閉じる', async () => {
    const { broker, seen } = makeBroker(() => [turnEnded('ok')]);
    await broker.run('codex', 'a');
    await broker.run('codex', 'b');
    broker.closeAll();
    expect(seen.closed).toBe(2);
  });

  it('MCP サーバは peer_run と peer_reply の2本だけを見せ、呼べる provider だけを選べる', async () => {
    const { broker } = makeBroker((turn) => [turnEnded(`答え${turn}`)]);
    const server = broker.mcpServer();
    expect(server.name).toBe(PEER_MCP_SERVER_NAME);
    const [clientSide, serverSide] = InMemoryTransport.createLinkedPair();
    await server.instance.connect(serverSide);
    const client = new Client({ name: 't', version: '0' });
    await client.connect(clientSide);
    const listed = await client.listTools();
    expect(listed.tools.map((t) => t.name).sort()).toEqual(['peer_reply', 'peer_run']);
    const result = (await client.callTool({
      name: 'peer_run',
      arguments: { provider: 'codex', prompt: 'hi' },
    })) as { content: { text: string }[] };
    expect(result.content[0]?.text).toContain('答え1');
    const bad = (await client.callTool({
      name: 'peer_run',
      arguments: { provider: 'claude', prompt: 'hi' },
    })) as { isError?: boolean };
    expect(bad.isError).toBe(true);
    await client.close();
    broker.closeAll();
  });
});
