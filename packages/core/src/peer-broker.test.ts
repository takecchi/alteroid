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
  type PeerCallResult,
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
    noBackground?: boolean;
    cwd?: string;
    scanWorkdir?: PeerBrokerDeps['scanWorkdir'];
    now?: PeerBrokerDeps['now'];
  } = {},
) {
  const seen = { specs: [] as AgentManagerSessionSpec[], closed: 0 };
  const parts: Record<string, unknown>[] = [];
  const notes: string[] = [];
  const usage: PeerUsageReport[] = [];
  const turns: PeerTurnEvent[] = [];
  const stops: { result: PeerTurnResult; liveAtStop: number }[] = [];
  // 作る前に deps を組むので、知らせの口から読む broker は後から入れる入れ物にする
  const ref: { broker?: ReturnType<typeof createPeerBroker> } = {};
  const deps: PeerBrokerDeps = {
    allowed: ['codex'],
    driverOf: () => scriptedDriver(script, seen),
    makeSpec: (_provider, given) => {
      parts.push({ ...given });
      return {
        input: given.input,
        onPermission: given.onPermission,
        onNote: given.onNote,
        onPostToolUse: () => ({ kind: 'continue' }),
        onPostToolUseFailure: () => undefined,
        ...(given.model === undefined ? {} : { model: given.model }),
        ...(options.cwd === undefined ? {} : { cwd: options.cwd }),
      } as unknown as AgentManagerSessionSpec;
    },
    ...(options.scanWorkdir === undefined ? {} : { scanWorkdir: options.scanWorkdir }),
    ...(options.now === undefined ? {} : { now: options.now }),
    reportsUsage: () => options.reportsUsage ?? true,
    onNote: (text) => notes.push(text),
    onUsage: (report) => usage.push(report),
    ...(options.askApproval === undefined ? {} : { askApproval: options.askApproval }),
    ...(options.models === undefined ? {} : { models: options.models }),
    onTurn: (event) => turns.push(event),
    ...(options.closedReason === undefined ? {} : { closedReason: options.closedReason }),
    ...(options.noBackground === true
      ? {}
      : {
          onBackgroundStop: (result: PeerTurnResult) =>
            stops.push({ result, liveAtStop: ref.broker?.backgroundTasks().length ?? -1 }),
        }),
  };
  const broker = createPeerBroker(deps);
  ref.broker = broker;
  return { broker, seen, parts, notes, usage, turns, stops };
}

function deferred(): { promise: Promise<void>; resolve: () => void } {
  let resolve = (): void => undefined;
  const promise = new Promise<void>((r) => {
    resolve = r;
  });
  return { promise, resolve };
}

async function until(condition: () => boolean): Promise<void> {
  for (let i = 0; i < 2000 && !condition(); i += 1) {
    await new Promise((resolve) => setImmediate(resolve));
  }
  if (!condition()) throw new Error('条件が満たされなかった');
}

function foreground(result: PeerCallResult): PeerTurnResult {
  if (typeof result === 'string') throw new Error(result);
  if ('background' in result) throw new Error('背景へ回っている');
  return result;
}

function pendingOf(result: PeerCallResult): string {
  const turn = foreground(result);
  if (turn.pendingApproval === undefined) throw new Error(`確認待ちではない: ${turn.text}`);
  return turn.pendingApproval.approvalId;
}

function settled(result: PeerCallResult): PeerTurnResult {
  const turn = foreground(result);
  if (turn.pendingApproval !== undefined) throw new Error('まだ確認待ちである');
  return turn;
}

describe('peer-broker（マネージャーの MCP peer）', () => {
  it('peer_run は最初の応答を返し、peer_reply で同じセッションを続けられる', async () => {
    const { broker } = makeBroker((turn) => [turnEnded(`答え${turn}`)]);
    const first = foreground(await broker.run('codex', '調べて'));
    expect(first.ok).toBe(true);
    expect(first.text).toBe('答え1');
    const second = foreground(await broker.reply(first.sessionId, '続き'));
    expect(second.text).toBe('答え2');
    broker.closeAll();
  });

  describe('相手が生成したファイル（#4126）', () => {
    const imageDone = (savedPath: unknown) => ({
      toolName: 'imageGeneration',
      toolInput: savedPath === undefined ? {} : { savedPath },
    });

    async function renderedText(broker: ReturnType<typeof makeBroker>['broker']): Promise<string> {
      const server = broker.mcpServer();
      const [clientSide, serverSide] = InMemoryTransport.createLinkedPair();
      await server.instance.connect(serverSide);
      const client = new Client({ name: 't', version: '0' });
      await client.connect(clientSide);
      const result = (await client.callTool({
        name: 'peer_run',
        arguments: { provider: 'codex', prompt: 'x' },
      })) as { content: { text: string }[] };
      await client.close();
      return result.content[0]?.text ?? '';
    }

    it('成功した画像生成の savedPath を、重複なし・出た順で結果に載せ、本文の前に出す', async () => {
      const { broker } = makeBroker(async (_turn, spec) => {
        await spec.onPostToolUse(imageDone('/home/c/.codex/generated_images/a.png'));
        await spec.onPostToolUse(imageDone('/home/c/.codex/generated_images/b.png'));
        await spec.onPostToolUse(imageDone('/home/c/.codex/generated_images/a.png'));
        return [turnEnded('描いた')];
      });
      const text = await renderedText(broker);
      expect(text).toContain(
        [
          '相手が生成したファイル（相手の器の中のパス）:',
          '- /home/c/.codex/generated_images/a.png',
          '- /home/c/.codex/generated_images/b.png',
          '報告に添えて人間へ届けるなら、$ALTEROID_OUTBOX（設定されていれば）の直下へ写すこと（cp など）。',
        ].join('\n'),
      );
      expect(text.indexOf('generated_images/a.png')).toBeLessThan(text.indexOf('描いた'));
      broker.closeAll();
    });

    it('PeerTurnResult の generatedFiles は次のターンへ持ち越さない', async () => {
      const { broker } = makeBroker(async (turn, spec) => {
        if (turn === 1) await spec.onPostToolUse(imageDone('/x/a.png'));
        return [turnEnded(`答え${turn}`)];
      });
      const first = settled(await broker.run('codex', '描いて'));
      expect(first.generatedFiles).toEqual(['/x/a.png']);
      const second = settled(await broker.reply(first.sessionId, '続き'));
      expect(second).not.toHaveProperty('generatedFiles');
      broker.closeAll();
    });

    it('失敗した生成・savedPath の無い生成は載せず、欄も表示も作らない', async () => {
      const { broker } = makeBroker(async (_turn, spec) => {
        await spec.onPostToolUseFailure({ toolName: 'imageGeneration', toolInput: {} });
        await spec.onPostToolUse(imageDone(undefined));
        await spec.onPostToolUse(imageDone(null));
        await spec.onPostToolUse({ toolName: 'webSearch', toolInput: { savedPath: '/x/w.png' } });
        return [turnEnded('だめだった')];
      });
      const text = await renderedText(broker);
      expect(text).not.toContain('相手が生成したファイル');
      const again = settled(await broker.run('codex', 'y'));
      expect(again).not.toHaveProperty('generatedFiles');
      broker.closeAll();
    });

    const fileChange = (changes: { path?: unknown; kind?: unknown }[]) => ({
      toolName: 'fileChange',
      toolInput: { changes },
    });

    it('ファイルの変更（fileChange）の追加・更新を載せ、削除は載せない。相対パスは peer の cwd から解く（#4143）', async () => {
      const { broker } = makeBroker(
        async (_turn, spec) => {
          await spec.onPostToolUse(
            fileChange([
              { path: '/w/a.png', kind: { type: 'add' } },
              { path: 'sub/b.txt', kind: { type: 'update', move_path: null } },
              { path: '/w/gone.txt', kind: { type: 'delete' } },
              { path: '/w/c.txt', kind: 'add' },
            ]),
          );
          await spec.onPostToolUseFailure({
            toolName: 'fileChange',
            toolInput: { changes: [{ path: '/w/failed.txt', kind: { type: 'add' } }] },
          });
          await spec.onPostToolUse(imageDone('/home/c/.codex/generated_images/d.png'));
          return [turnEnded('書いた')];
        },
        { cwd: '/w' },
      );
      const result = settled(await broker.run('codex', '書いて'));
      expect(result.generatedFiles).toEqual([
        '/w/a.png',
        '/w/sub/b.txt',
        '/w/c.txt',
        '/home/c/.codex/generated_images/d.png',
      ]);
      broker.closeAll();
    });

    it('ターンの終わりに作業場を探し、開始の秒以降に変わったものを、道具の記録で拾ったものを除いて別の見出しで出す（#4143）', async () => {
      const calls: { dir: string; since: number }[] = [];
      const { broker } = makeBroker(
        async (_turn, spec) => {
          await spec.onPostToolUse(fileChange([{ path: '/w/a.txt', kind: { type: 'add' } }]));
          return [turnEnded('作った')];
        },
        {
          cwd: '/w',
          now: () => new Date('2026-10-08T12:00:00.750Z'),
          scanWorkdir: async (dir, since) => {
            calls.push({ dir, since });
            return { paths: ['/w/a.txt', '/w/blue-circle.png'] };
          },
        },
      );
      const text = await renderedText(broker);
      expect(calls).toEqual([{ dir: '/w', since: Date.parse('2026-10-08T12:00:00.000Z') }]);
      expect(text).toContain(
        [
          '相手が生成したファイル（相手の器の中のパス）:',
          '- /w/a.txt',
          '',
          'ターンの間に作業場（/w）で変わったもの（相手以外の変更も混ざりうる）:',
          '- /w/blue-circle.png',
          '報告に添えて人間へ届けるなら、$ALTEROID_OUTBOX（設定されていれば）の直下へ写すこと（cp など）。',
        ].join('\n'),
      );
      expect(text.indexOf('blue-circle.png')).toBeLessThan(text.indexOf('作った'));
      broker.closeAll();
    });

    it('並べるのは合わせて50件まで。超えた分は「他 N 件」と言う', async () => {
      const made = Array.from({ length: 30 }, (_, i) => `/w/made-${String(i)}.txt`);
      const found = Array.from({ length: 30 }, (_, i) => `/w/found-${String(i)}.txt`);
      const { broker } = makeBroker(
        async (_turn, spec) => {
          await spec.onPostToolUse(fileChange(made.map((path) => ({ path, kind: 'add' }))));
          return [turnEnded('たくさん')];
        },
        { cwd: '/w', scanWorkdir: async () => ({ paths: found }) },
      );
      const text = await renderedText(broker);
      expect(text).toContain('- /w/made-29.txt');
      expect(text).toContain('- /w/found-19.txt');
      expect(text).not.toContain('- /w/found-20.txt');
      expect(text).toContain('- 他 10 件');
      broker.closeAll();
    });

    it('探索を打ち切った・探せなかったときは、ファイルが無くても黙らずに書く', async () => {
      const { broker } = makeBroker(async () => [turnEnded('a')], {
        cwd: '/w',
        scanWorkdir: async () => ({
          paths: [],
          truncated: '20000 項目を見たところで打ち切った',
          unreadable: 2,
        }),
      });
      const text = await renderedText(broker);
      expect(text).toContain(
        '作業場の探索は途中までしか見ていない（20000 項目を見たところで打ち切った）。',
      );
      expect(text).toContain('作業場の中で読めなかったディレクトリが 2 個あった。');
      expect(text).not.toContain('$ALTEROID_OUTBOX');
      broker.closeAll();

      const failing = makeBroker(async () => [turnEnded('b')], {
        cwd: '/w',
        scanWorkdir: async () => {
          throw new Error('EACCES');
        },
      });
      const result = settled(await failing.broker.run('codex', 'x'));
      expect(result.ok).toBe(true);
      expect(result.workdirChanges).toEqual({
        dir: '/w',
        paths: [],
        truncated: '作業場を探せなかった: EACCES',
      });
      failing.broker.closeAll();
    });

    it('探す口が無い・cwd が無いときは探さず、欄も作らない', async () => {
      const scanned: string[] = [];
      const noCwd = makeBroker(async () => [turnEnded('a')], {
        scanWorkdir: async (dir) => {
          scanned.push(dir);
          return { paths: ['/x'] };
        },
      });
      expect(settled(await noCwd.broker.run('codex', 'x'))).not.toHaveProperty('workdirChanges');
      noCwd.broker.closeAll();
      const noScan = makeBroker(async () => [turnEnded('a')], { cwd: '/w' });
      expect(settled(await noScan.broker.run('codex', 'x'))).not.toHaveProperty('workdirChanges');
      noScan.broker.closeAll();
      expect(scanned).toEqual([]);
    });
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
    const first = foreground(await broker.run('codex', 'ビルドして'));
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

  it('並べて頼んでも、ほかのセッションの答えていない確認は閉じない（#4124）', async () => {
    const decisions: string[] = [];
    let turns = 0;
    const { broker, notes } = makeBroker(async (_t, spec) => {
      turns += 1;
      if (turns === 1) {
        decisions.push((await ask(spec)).behavior);
        return [turnEnded('1本目が済んだ')];
      }
      return [turnEnded('2本目')];
    });
    const oldId = pendingOf(await broker.run('codex', '1本目'));
    const second = settled(await broker.run('codex', '2本目'));
    expect(second.text).toBe('2本目');
    expect(decisions).toEqual([]);
    expect(notes.some((note) => note.includes(oldId) && note.includes('拒否として閉じた'))).toBe(
      false,
    );
    const first = settled(await broker.approve(oldId, 'allow'));
    expect(first.text).toBe('1本目が済んだ');
    expect(decisions).toEqual(['allow']);
    broker.closeAll();
  });

  it('背景へ回すと流し始めた時点で返り、背景処理に数えられ、終わったら知らせる（#4123）', async () => {
    const gate = deferred();
    const { broker, stops } = makeBroker(async () => {
      await gate.promise;
      return [turnEnded('背景で済んだ')];
    });
    const started = await broker.run('codex', '長い仕事', { background: true });
    expect(started).toMatchObject({ background: true, provider: 'codex' });
    const sessionId = (started as { sessionId: string }).sessionId;
    expect(broker.backgroundTasks()).toEqual([{ id: `peer:${sessionId}`, taskType: 'peer:codex' }]);
    expect(await broker.reply(sessionId, '続き')).toContain('前のターンの応答を待っている');
    expect(stops).toEqual([]);
    gate.resolve();
    await until(() => stops.length === 1);
    expect(stops[0]?.result).toMatchObject({ sessionId, ok: true, text: '背景で済んだ' });
    expect(stops[0]?.liveAtStop).toBe(0);
    expect(broker.backgroundTasks()).toEqual([]);
    expect(settled(await broker.reply(sessionId, '続き')).text).toBe('背景で済んだ');
    broker.closeAll();
  });

  it('背景中に確認待ちになったら知らせ、背景の peer_approve で続きをまた背景で受ける（#4123）', async () => {
    const { broker, stops } = makeBroker(async (_t, spec) => {
      await ask(spec);
      return [turnEnded('許可されてやった')];
    });
    await broker.run('codex', 'x', { background: true });
    await until(() => stops.length === 1);
    const approvalId = stops[0]?.result.pendingApproval?.approvalId;
    expect(approvalId).toBeDefined();
    expect(broker.backgroundTasks()).toEqual([]);
    expect(await broker.approve(approvalId!, 'allow', { background: true })).toMatchObject({
      background: true,
    });
    await until(() => stops.length === 2);
    expect(stops[1]?.result).toMatchObject({ ok: true, text: '許可されてやった' });
    broker.closeAll();
  });

  it('背景の止まりどころを受ける口が無ければ、背景実行は断り相手を起こさない（#4123）', async () => {
    const { broker, seen } = makeBroker(() => [turnEnded('x')], { noBackground: true });
    expect(await broker.run('codex', 'x', { background: true })).toContain('背景へ回す口が無い');
    expect(seen.specs).toHaveLength(0);
  });

  it('前景の呼び出しは今までどおり止まりどころまで待ち、知らせは出さない', async () => {
    const { broker, stops } = makeBroker(() => [turnEnded('前景')]);
    expect(settled(await broker.run('codex', 'x')).text).toBe('前景');
    expect(stops).toEqual([]);
    broker.closeAll();
  });

  it('並べた2本の確認は、それぞれに答えられる（#4124）', async () => {
    const { broker } = makeBroker(async (_t, spec) => {
      await ask(spec);
      return [turnEnded('済んだ')];
    });
    const a = pendingOf(await broker.run('codex', 'A'));
    const b = pendingOf(await broker.run('codex', 'B'));
    expect(a).not.toBe(b);
    expect(settled(await broker.approve(b, 'allow')).approved).toHaveLength(1);
    expect(settled(await broker.approve(a, 'allow')).approved).toHaveLength(1);
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
