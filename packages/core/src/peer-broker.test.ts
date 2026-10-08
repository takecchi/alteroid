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
  parsePeerActor,
  peerActorOf,
  type PeerBrokerDeps,
  type PeerTurnEvent,
  type PeerTurnResult,
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
            runtime: { model: 'gpt-from-runtime' } as never,
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
  options: {
    reportsUsage?: boolean;
    askApproval?: PeerBrokerDeps['askApproval'];
    models?: PeerBrokerDeps['models'];
    closedReason?: PeerBrokerDeps['closedReason'];
  } = {},
) {
  const seen = { specs: [] as AgentManagerSessionSpec[], closed: 0 };
  const parts: Record<string, unknown>[] = [];
  const notes: string[] = [];
  const usage: PeerUsageReport[] = [];
  const turns: PeerTurnEvent[] = [];
  const deps: PeerBrokerDeps = {
    allowed: ['codex'],
    driverOf: () => scriptedDriver(script, seen),
    makeSpec: (_provider, given) => {
      parts.push({ ...given });
      return {
        input: given.input,
        onPermission: given.onPermission,
        onNote: given.onNote,
        ...(given.model === undefined ? {} : { model: given.model }),
      } as unknown as AgentManagerSessionSpec;
    },
    reportsUsage: () => options.reportsUsage ?? true,
    onNote: (text) => notes.push(text),
    onUsage: (report) => usage.push(report),
    ...(options.askApproval === undefined ? {} : { askApproval: options.askApproval }),
    ...(options.models === undefined ? {} : { models: options.models }),
    onTurn: (event) => turns.push(event),
    ...(options.closedReason === undefined ? {} : { closedReason: options.closedReason }),
  };
  return { broker: createPeerBroker(deps), seen, parts, notes, usage, turns };
}

/** 確認待ちで止まった結果から approval_id を取り出す（止まっていなければ落とす）。 */
function pendingOf(result: PeerTurnResult | string): string {
  if (typeof result === 'string') throw new Error(result);
  if (result.pendingApproval === undefined) throw new Error(`確認待ちではない: ${result.text}`);
  return result.pendingApproval.approvalId;
}

function settled(result: PeerTurnResult | string): PeerTurnResult {
  if (typeof result === 'string') throw new Error(result);
  if (result.pendingApproval !== undefined) throw new Error('まだ確認待ちである');
  return result;
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

  it('ターンごとに started / ended を知らせる（稼働状況の「実行中」。#4122）', async () => {
    const { broker, turns } = makeBroker((turn) => [turnEnded(`答え${turn}`)]);
    const first = settled(await broker.run('codex', '調べて'));
    settled(await broker.reply(first.sessionId, '続き'));
    expect(turns.map((t) => [t.kind, t.kind === 'started' ? t.tool : '-'])).toEqual([
      ['started', 'peer_run'],
      ['ended', '-'],
      ['started', 'peer_reply'],
      ['ended', '-'],
    ]);
    const [s1, e1, s2] = turns;
    expect(s1?.turnId).toBe(e1?.turnId);
    expect(s1?.turnId).not.toBe(s2?.turnId);
    broker.closeAll();
  });

  it('札のモデルは 名指し → 相手が名乗ったもの の順（#4122）', async () => {
    const named = makeBroker(() => [turnEnded('x')], { models: { codex: ['gpt-5.5'] } });
    settled(await named.broker.run('codex', 'x', { model: 'gpt-5.5' }));
    const started = named.turns.find((t) => t.kind === 'started');
    expect(started?.kind === 'started' && started.model).toBe('gpt-5.5');
    named.broker.closeAll();

    const runtime = makeBroker(() => [turnEnded('x')]);
    settled(await runtime.broker.run('codex', 'x'));
    const fromRuntime = runtime.turns.find((t) => t.kind === 'started');
    expect(fromRuntime?.kind === 'started' && fromRuntime.model).toBe('gpt-from-runtime');
    runtime.broker.closeAll();
  });

  it('peer の actor はどのマネージャーが頼んだかを持ち、逆に解ける（以前の peer:<provider> は解けない）', () => {
    expect(peerActorOf('mgr-1', 'codex')).toBe('peer:mgr-1:codex');
    expect(parsePeerActor('peer:mgr-1:codex')).toEqual({ managerId: 'mgr-1', provider: 'codex' });
    expect(parsePeerActor('peer:codex')).toBeUndefined();
    expect(parsePeerActor('worker:mgr-1:general')).toBeUndefined();
  });

  it('道具を出した後に閉じた provider（資格が外れた）は、相手を起こさずに理由で断る（#4118）', async () => {
    let closed: string | undefined;
    const { broker, seen } = makeBroker(() => [turnEnded('x')], {
      closedReason: () => closed,
    });
    closed = 'この器では peer（codex）がいま閉じている';
    expect(await broker.run('codex', 'x')).toBe('この器では peer（codex）がいま閉じている');
    expect(seen.specs).toHaveLength(0);
    closed = undefined;
    expect(typeof (await broker.run('codex', 'x'))).not.toBe('string');
    expect(seen.specs).toHaveLength(1);
    broker.closeAll();
  });

  /*
   * 承認の行き先（#3940。2026-10-07 のオーナー決定で反転した）。
   *
   * 以前の3本は「peer の確認は askApproval で直接クローンへ上がり、答えが出るまで peer_run は
   * 返らない」を仕様として固定していた（元の名前: 「承認の口が無ければ、承認が要る操作は拒否し、
   * 結果と日誌に出す（素通しにしない）」「askApproval があれば出所つきで上げ、許可はそのまま返して
   * 結果に数える」「askApproval が投げたら拒否に倒す。質問は上げずに拒否する」）。
   * いまは**まずマネージャーへ返り**、`escalate` を選んだときだけクローンへ上がる。消さずに期待値を
   * 反転した: 閉じる側（口が無い・投げた・質問）は escalate の経路で同じ強さのまま測る。
   */
  it('承認の口が無ければ、escalate した確認は拒否し、結果と日誌に出す（素通しにしない）', async () => {
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
    const approvalId = pendingOf(await broker.run('codex', '直して'));
    const result = settled(await broker.approve(approvalId, 'escalate'));
    expect(result.denied).toEqual([{ toolName: 'commandExecution', by: 'auto' }]);
    expect(result.text).toBe('書けなかった');
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
      input: { command: 'pnpm build' },
      signal: new AbortController().signal,
    });

  it('確認はまずマネージャーへ返る（クローンへは上げない）。allow で続きが返り、答えたのは manager と出る', async () => {
    let asked = 0;
    const { broker, notes } = makeBroker(
      async (_t, spec) => {
        expect((await ask(spec)).behavior).toBe('allow');
        return [turnEnded('やった')];
      },
      {
        askApproval: async () => {
          asked += 1;
          return { behavior: 'allow' };
        },
      },
    );
    const first = await broker.run('codex', 'ビルドして');
    if (typeof first === 'string') throw new Error(first);
    expect(first.pendingApproval?.toolName).toBe('commandExecution');
    expect(first.pendingApproval?.summary).toContain('pnpm build');
    expect(first.text).toBe('');
    expect(asked).toBe(0);
    const result = settled(await broker.approve(first.pendingApproval!.approvalId, 'allow'));
    expect(result.text).toBe('やった');
    expect(result.approved).toEqual([{ toolName: 'commandExecution', by: 'manager' }]);
    expect(asked).toBe(0);
    expect(notes.some((note) => note.includes('answeredBy=manager'))).toBe(true);
    broker.closeAll();
  });

  it('マネージャーの deny は理由つきで相手へ届く', async () => {
    const messages: string[] = [];
    const { broker } = makeBroker(async (_t, spec) => {
      const decision = await ask(spec);
      if (decision.behavior === 'deny') messages.push(decision.message);
      return [turnEnded('やめた')];
    });
    const approvalId = pendingOf(await broker.run('codex', 'x'));
    const result = settled(await broker.approve(approvalId, 'deny', { message: '別の方法で' }));
    expect(messages).toEqual(['別の方法で']);
    expect(result.denied).toEqual([{ toolName: 'commandExecution', by: 'manager' }]);
    broker.closeAll();
  });

  it('escalate は出所つきでクローンへ上げ、クローンの許可を clone として数える', async () => {
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
    const first = await broker.run('codex', 'x');
    const approvalId = pendingOf(first);
    expect(sources).toEqual([]);
    const result = settled(await broker.approve(approvalId, 'escalate'));
    expect(result.approved).toEqual([{ toolName: 'commandExecution', by: 'clone' }]);
    expect(result.denied).toEqual([]);
    expect(sources).toEqual([{ provider: 'codex', sessionId: result.sessionId }]);
    broker.closeAll();
  });

  it('答えるたびに、次の確認待ちかターンの結果が返る', async () => {
    const { broker } = makeBroker(async (_t, spec) => {
      await ask(spec);
      await ask(spec);
      return [turnEnded('2つとも済んだ')];
    });
    const firstId = pendingOf(await broker.run('codex', 'x'));
    const secondId = pendingOf(await broker.approve(firstId, 'allow'));
    expect(secondId).not.toBe(firstId);
    const result = settled(await broker.approve(secondId, 'allow'));
    expect(result.text).toBe('2つとも済んだ');
    expect(result.approved).toHaveLength(2);
    broker.closeAll();
  });

  it('askApproval が投げたら拒否に倒す。質問は返さず即座に拒否する', async () => {
    let asked = 0;
    const { broker } = makeBroker(
      async (_t, spec) => {
        expect((await ask(spec, 'question')).behavior).toBe('deny');
        expect((await ask(spec)).behavior).toBe('deny');
        return [turnEnded('だめだった')];
      },
      {
        askApproval: async () => {
          asked += 1;
          throw new Error('口が無い');
        },
      },
    );
    const approvalId = pendingOf(await broker.run('codex', 'x'));
    const result = settled(await broker.approve(approvalId, 'escalate'));
    expect(result.denied).toHaveLength(2);
    expect(result.denied.every((record) => record.by === 'auto')).toBe(true);
    expect(asked).toBe(1);
    broker.closeAll();
  });

  it('答えないまま次の peer_run を呼ぶと、古い確認は拒否として閉じる', async () => {
    const decisions: string[] = [];
    let turns = 0;
    const { broker, notes } = makeBroker(async (_t, spec) => {
      turns += 1;
      if (turns === 1) {
        decisions.push((await ask(spec)).behavior);
        return [turnEnded('放置された')];
      }
      return [turnEnded('2本目')];
    });
    const oldId = pendingOf(await broker.run('codex', '1本目'));
    const second = settled(await broker.run('codex', '2本目'));
    expect(second.text).toBe('2本目');
    expect(decisions).toEqual(['deny']);
    expect(notes.some((note) => note.includes(oldId) && note.includes('拒否として閉じた'))).toBe(
      true,
    );
    expect(await broker.approve(oldId, 'allow')).toContain('無い');
    broker.closeAll();
  });

  it('答えないままセッションを閉じても、確認は拒否で閉じる', async () => {
    const decisions: string[] = [];
    const { broker } = makeBroker(async (_t, spec) => {
      decisions.push((await ask(spec)).behavior);
      return [];
    });
    pendingOf(await broker.run('codex', 'x'));
    broker.closeAll();
    await new Promise((resolve) => setImmediate(resolve));
    expect(decisions).toEqual(['deny']);
  });

  it('知らない approval_id は道具のエラーで返す', async () => {
    const { broker } = makeBroker(() => [turnEnded('x')]);
    expect(await broker.approve('appr-none', 'allow')).toContain('無い');
  });

  it('確認待ちのセッションへ peer_reply はできない（先に peer_approve で答える）', async () => {
    const { broker } = makeBroker(async (_t, spec) => {
      await ask(spec);
      return [turnEnded('ok')];
    });
    const first = await broker.run('codex', 'x');
    const approvalId = pendingOf(first);
    if (typeof first === 'string') return;
    expect(await broker.reply(first.sessionId, '続き')).toContain(approvalId);
    broker.closeAll();
  });

  /*
   * 以前の名前は「peer のセッションは strictApprovals で起こす」で、broker が構えを締めることを
   * 固定していた。#3940 で構えは呼び出し元のマネージャーと同じになった（構えは runner の makeSpec が
   * 持つ。`runner-peer.test.ts` の「構えはマネージャーと同じ」が測る）。broker は makeSpec へ
   * 構えを渡さないことを測る形へ反転した。
   */
  it('broker は構えを決めない（makeSpec へ渡すのは入力・確認の口・note・名指しのモデルだけ）', async () => {
    const { broker, parts } = makeBroker(() => [turnEnded('ok')]);
    await broker.run('codex', 'x');
    expect(Object.keys(parts[0] ?? {}).sort()).toEqual(['input', 'onNote', 'onPermission']);
    broker.closeAll();
  });

  it('model は人間が開けた一覧の中からだけ選べ、選んだモデルが makeSpec へ届く。実際のモデルは結果に出る', async () => {
    const { broker, parts } = makeBroker(() => [turnEnded('ok')], {
      models: { codex: ['gpt-5.5-codex', 'gpt-5.5'] },
    });
    const result = settled(await broker.run('codex', 'x', { model: 'gpt-5.5' }));
    expect(parts[0]?.['model']).toBe('gpt-5.5');
    expect(result.model).toBe('gpt-from-runtime');
    broker.closeAll();
  });

  it('一覧に無いモデルは断る（既定へ黙って倒さない）。一覧が空なら名指しそのものを断る', async () => {
    const opened = makeBroker(() => [turnEnded('ok')], { models: { codex: ['gpt-5.5'] } });
    const refused = await opened.broker.run('codex', 'x', { model: 'gpt-4o' });
    expect(refused).toContain('選べない');
    expect(opened.seen.specs).toHaveLength(0);
    const closed = makeBroker(() => [turnEnded('ok')]);
    expect(await closed.broker.run('codex', 'x', { model: 'gpt-5.5' })).toContain('名指しできない');
    expect(closed.seen.specs).toHaveLength(0);
  });

  it('model を省けば makeSpec へ model を渡さない（provider の既定で動く）', async () => {
    const { broker, parts } = makeBroker(() => [turnEnded('ok')], {
      models: { codex: ['gpt-5.5'] },
    });
    await broker.run('codex', 'x');
    expect(parts[0]).not.toHaveProperty('model');
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

  /*
   * 以前の名前は「MCP サーバは peer_run と peer_reply の2本だけを見せ、呼べる provider だけを選べる」。
   * #3940 で確認に答える peer_approve が増えたので、期待する道具の集合を3本へ反転した。
   */
  it('MCP サーバは peer_run・peer_reply・peer_approve の3本を見せ、呼べる provider だけを選べる', async () => {
    const { broker } = makeBroker((turn) => [turnEnded(`答え${turn}`)]);
    const server = broker.mcpServer();
    expect(server.name).toBe(PEER_MCP_SERVER_NAME);
    const [clientSide, serverSide] = InMemoryTransport.createLinkedPair();
    await server.instance.connect(serverSide);
    const client = new Client({ name: 't', version: '0' });
    await client.connect(clientSide);
    const listed = await client.listTools();
    expect(listed.tools.map((t) => t.name).sort()).toEqual([
      'peer_approve',
      'peer_reply',
      'peer_run',
    ]);
    const run = listed.tools.find((t) => t.name === 'peer_run');
    expect(Object.keys(run?.inputSchema.properties ?? {})).not.toContain('model');
    const result = (await client.callTool({
      name: 'peer_run',
      arguments: { provider: 'codex', prompt: 'hi' },
    })) as { content: { text: string }[] };
    expect(result.content[0]?.text).toContain('答え1');
    expect(result.content[0]?.text).toContain('model: gpt-from-runtime');
    const bad = (await client.callTool({
      name: 'peer_run',
      arguments: { provider: 'claude', prompt: 'hi' },
    })) as { isError?: boolean };
    expect(bad.isError).toBe(true);
    await client.close();
    broker.closeAll();
  });

  it('モデルの一覧が開いていれば peer_run に model を enum で出し、一覧外は道具の段で断る', async () => {
    const { broker, seen } = makeBroker(() => [turnEnded('ok')], {
      models: { codex: ['gpt-5.5'] },
    });
    const server = broker.mcpServer();
    const [clientSide, serverSide] = InMemoryTransport.createLinkedPair();
    await server.instance.connect(serverSide);
    const client = new Client({ name: 't', version: '0' });
    await client.connect(clientSide);
    const listed = await client.listTools();
    const run = listed.tools.find((t) => t.name === 'peer_run');
    const model = (run?.inputSchema.properties as Record<string, { enum?: unknown }>)['model'];
    expect(model?.enum).toEqual(['gpt-5.5']);
    const bad = (await client.callTool({
      name: 'peer_run',
      arguments: { provider: 'codex', prompt: 'hi', model: 'gpt-4o' },
    })) as { isError?: boolean };
    expect(bad.isError).toBe(true);
    expect(seen.specs).toHaveLength(0);
    await client.close();
    broker.closeAll();
  });

  it('確認待ちは MCP の応答で approval_id と内容を返し、peer_approve で続きが返る', async () => {
    const { broker } = makeBroker(async (_t, spec) => {
      await ask(spec);
      return [turnEnded('終わった')];
    });
    const server = broker.mcpServer();
    const [clientSide, serverSide] = InMemoryTransport.createLinkedPair();
    await server.instance.connect(serverSide);
    const client = new Client({ name: 't', version: '0' });
    await client.connect(clientSide);
    const first = (await client.callTool({
      name: 'peer_run',
      arguments: { provider: 'codex', prompt: 'ビルドして' },
    })) as { content: { text: string }[]; isError?: boolean };
    const text = first.content[0]?.text ?? '';
    expect(first.isError).toBeUndefined();
    expect(text).toContain('確認待ち: approval_id=appr-');
    expect(text).toContain('pnpm build');
    const approvalId = /approval_id=(appr-[0-9a-f]+)/.exec(text)?.[1];
    const next = (await client.callTool({
      name: 'peer_approve',
      arguments: { approval_id: approvalId, decision: 'allow' },
    })) as { content: { text: string }[] };
    expect(next.content[0]?.text).toContain('終わった');
    expect(next.content[0]?.text).toContain('commandExecution(manager)');
    await client.close();
    broker.closeAll();
  });
});
