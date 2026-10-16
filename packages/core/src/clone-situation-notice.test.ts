import type { query as sdkQuery, Options, Query, SDKMessage } from '@anthropic-ai/claude-agent-sdk';
import { describe, expect, it } from 'vitest';

import { waitFor } from './clone-test-harness.js';
import {
  ALWAYS_REDELIVER,
  compactionLikelyThisTurn,
  createClone,
  SITUATION_COMPACTION_GROWTH_FLOOR_TOKENS,
  SITUATION_FULL_EVERY_TURNS,
} from './clone.js';
import type { CloneHost } from './host.js';
import type { ManagerPool, ManagerSummary, RunnerFleetOverview } from './manager.js';
import type { RunnerLiveness } from './runner-protocol.js';
import type { JobStatus } from './schema.js';
import type { Stores } from './store.js';
import { createMemoryStores } from './testing.js';
import { createCloneMcpServer } from './tools.js';
import type { ToolContext } from './tools.js';

interface Fake {
  fn: typeof sdkQuery;
  inputs: string[];
}

function fakeSdk(): Fake {
  const inputs: string[] = [];
  const fn = ((params: { prompt: unknown; options?: Options }) => {
    async function* generate(): AsyncGenerator<SDKMessage, void> {
      yield {
        type: 'system',
        subtype: 'init',
        session_id: 'sess-fake',
        uuid: 'uuid-init',
      } as unknown as SDKMessage;
      for await (const message of params.prompt as AsyncIterable<{
        message: { content: unknown };
      }>) {
        inputs.push(String(message.message.content));
        yield {
          type: 'assistant',
          message: { content: [{ type: 'text', text: 'ok' }] },
          parent_tool_use_id: null,
          session_id: 'sess-fake',
          uuid: 'uuid-assistant',
        } as unknown as SDKMessage;
        yield {
          type: 'result',
          subtype: 'success',
          result: 'ok',
          session_id: 'sess-fake',
          uuid: 'uuid-result',
        } as unknown as SDKMessage;
      }
    }
    const generator = generate();
    return Object.assign(generator, {
      close: () => undefined,
      interrupt: async () => undefined,
      // 使用量の観測が取れない回は全文に戻す（#4941）ので、畳みを見る試験では閾値から遠い観測を返す
      getContextUsage: async () => ({
        categories: [],
        totalTokens: 10_000,
        maxTokens: 1_000_000,
        rawMaxTokens: 1_000_000,
        percentage: 1,
        autoCompactThreshold: 200_000,
        isAutoCompactEnabled: true,
      }),
    }) as unknown as Query;
  }) as unknown as typeof sdkQuery;
  return { fn, inputs };
}

function summary(
  id: string,
  status: JobStatus,
  live: boolean,
  awaitingBackground?: { tasks: number; withheldReports: number; breakdown: string; since: string },
): ManagerSummary {
  return {
    managerId: id,
    status,
    live,
    cwd: '/work',
    request: '依頼',
    startedAt: '2026-09-05T00:00:00.000Z',
    updatedAt: '2026-09-05T00:00:00.000Z',
    waiting: [],
    ...(awaitingBackground === undefined ? {} : { awaitingBackground }),
  };
}

function stubPool(input: {
  managers: ManagerSummary[] | (() => never);
  runnerStates: RunnerLiveness[] | (() => never);
}): ManagerPool {
  const notImplemented = () => {
    throw new Error('not implemented');
  };
  return {
    start: notImplemented,
    send: notImplemented,
    abort: notImplemented,
    list: () =>
      typeof input.managers === 'function'
        ? Promise.reject(new Error('list() が壊れている（実測を模す）'))
        : Promise.resolve(input.managers),
    denials: () => [],
    pushHealthOf: () => undefined,
    runnerBacklog: () => [],
    runnerIdOf: () => Promise.resolve(undefined),
    runners: (): Promise<RunnerFleetOverview> =>
      typeof input.runnerStates === 'function'
        ? Promise.reject(new Error('runners() が壊れている（実測を模す）'))
        : Promise.resolve({
            runners: input.runnerStates.map((state, index) => ({
              label: `runner-${index}`,
              state,
              since: '2026-09-05T00:00:00.000Z',
              managers: [],
              revision: { status: 'unheard' as const },
            })),
            unassigned: [],
            daemonRevision: { status: 'unknown' as const, reason: 'テスト' },
          }),
    transcript: notImplemented,
    unpushedWork: notImplemented,
    runningManagerOwning: () => undefined,
    restore: () => Promise.resolve([]),
    resumeStoppedByUsage: () => Promise.resolve([]),
    reattachRunner: () => Promise.resolve(),
    relocateFrom: notImplemented,
    vacate: notImplemented,
    probeTurnEnds: () => Promise.resolve(),
    flushWithheldReports: () => Promise.resolve(),
    settleStalledUsageWakes: () => Promise.resolve([]),
    renotifyStalledDenials: () => Promise.resolve(),
    stop: () => Promise.resolve(),
  };
}

function bootClone(stores: Stores, managers: ManagerPool): Fake & { clone: CloneHost } {
  const fake = fakeSdk();
  const clone = createClone({
    stores,
    queryFn: fake.fn,
    env: {},
    managers,
    redeliveryGate: ALWAYS_REDELIVER,
  });
  return { ...fake, clone };
}

const AT = '2026-09-05T00:00:00.000Z';
const BG = { tasks: 3, withheldReports: 1, breakdown: 'local_agent×3', since: AT };

function busyPool(): ManagerPool {
  return stubPool({
    managers: [
      summary('mgr-run', 'running', true),
      summary('mgr-bg', 'done', true, BG),
      summary('mgr-idle', 'done', true),
    ],
    runnerStates: ['connected', 'vacating'],
  });
}

describe('いまの全体は、ターンの入口に必ず載る（起点を問わない）', () => {
  it('マネージャーの報告で起きたターンにも載る', async () => {
    const s = bootClone(createMemoryStores(), busyPool());
    s.clone.post({
      type: 'manager_message',
      id: 'evt-report',
      at: AT,
      managerId: 'mgr-run',
      kind: 'report',
      text: '終わった',
    });
    await waitFor(() => s.inputs.length > 0, 'マネージャーの報告のターン');

    const text = s.inputs.join('\n');
    expect(text).toContain('[system] いまの全体');
    expect(text).toContain('委譲 全 3 本');
    expect(text).toContain('背景処理待ち 1');
    expect(text).toContain('手が空いている 1');
    expect(text).toContain('器 2 台: connected 1 / vacating 1。');
    // 時刻の値は固定しない: 実時計を通るので、形だけを見る
    expect(
      text,
      '節が「いつ数えた値か」を名乗らないままクローンへ届いている。この赤の意味は' +
        '「会話履歴に溜まった複数の『いまの全体』を、読む側が読み分けられない」（#902）。',
    ).toMatch(/\[system\] いまの全体（\d{2}:\d{2}:\d{2}Z に数えた材料だけ/);

    await s.clone.stop();
  });

  it('人間の発言で起きたターンにも載る', async () => {
    const s = bootClone(createMemoryStores(), busyPool());
    s.clone.post({
      type: 'human_message',
      id: 'evt-human',
      at: AT,
      text: 'やあ',
      conversationId: 'conv-1',
    });
    await waitFor(() => s.inputs.length > 0, '人間のターン');

    expect(s.inputs.join('\n')).toContain('手が空いている 1');

    await s.clone.stop();
  });

  it('蒸留のターンには載せない', async () => {
    const s = bootClone(createMemoryStores(), busyPool());
    s.clone.post({
      type: 'human_message',
      id: 'evt-human',
      at: AT,
      text: 'やあ',
      conversationId: 'conv-1',
    });
    await waitFor(() => s.inputs.length > 0, '人間のターン');
    expect(s.inputs[0]).toContain('[system] いまの全体');

    s.clone.post({ type: 'distill', id: 'evt-distill', at: AT, reason: 'shutdown' });
    await waitFor(() => s.inputs.length > 1, '蒸留のターン');

    expect(s.inputs[1]).not.toContain('[system] いまの全体');

    await s.clone.stop();
  });
});

describe('数えられなかったときは、行を消さず 0 でも埋めない', () => {
  it('list() が投げても、ターンは進み、数えられなかったと名乗る', async () => {
    const s = bootClone(
      createMemoryStores(),
      stubPool({
        managers: () => {
          throw new Error('unused');
        },
        runnerStates: ['connected'],
      }),
    );
    s.clone.post({
      type: 'human_message',
      id: 'evt-human',
      at: AT,
      text: 'やあ',
      conversationId: 'conv-1',
    });
    await waitFor(() => s.inputs.length > 0, '人間のターン');

    const text = s.inputs.join('\n');
    expect(text).toContain('数えられなかった');
    expect(text).toContain('list() が壊れている（実測を模す）');
    expect(text).not.toContain('委譲 全 0 本');
    expect(text).not.toContain('手が空いている 0');
    expect(text).toContain('やあ');

    await s.clone.stop();
  });

  it('runners() が投げても同じく名乗る（器の側だけが読めない回）', async () => {
    const s = bootClone(
      createMemoryStores(),
      stubPool({
        managers: [summary('mgr-idle', 'done', true)],
        runnerStates: () => {
          throw new Error('unused');
        },
      }),
    );
    s.clone.post({
      type: 'human_message',
      id: 'evt-human',
      at: AT,
      text: 'やあ',
      conversationId: 'conv-1',
    });
    await waitFor(() => s.inputs.length > 0, '人間のターン');

    const text = s.inputs.join('\n');
    expect(text).toContain('数えられなかった');
    expect(text).toContain('runners() が壊れている（実測を模す）');
    expect(text).not.toContain('器 0 台');

    await s.clone.stop();
  });
});

describe('状況の節に認証トークンの行が載る', () => {
  it('プールに行が在れば、現役と「見送らない」の1行が状況に出る', async () => {
    const stores = createMemoryStores();
    await stores.tokens.replace([
      { id: 'tok-a', label: 'first', value: 'v-a', order: 0 },
      { id: 'tok-b', label: 'second', value: 'v-b', order: 1 },
    ]);
    await stores.tokens.writeActive({
      tokenId: 'tok-b',
      generation: 2,
      rotatedAt: '2026-09-07T07:33:12.133Z',
    });
    const s = bootClone(stores, busyPool());

    s.clone.post({
      type: 'manager_message',
      id: 'evt-token-line',
      at: AT,
      managerId: 'mgr-run',
      kind: 'report',
      text: '終わった',
    });
    await waitFor(() => s.inputs.length > 0, 'ターンが走ること');

    const text = s.inputs.join('\n');
    expect(text).toContain('認証トークン: 現役は「second」');
    expect(text).toContain('枠を理由に仕事を見送らないこと');
    expect(text).not.toContain('v-a');
    expect(text).not.toContain('v-b');

    await s.clone.stop();
  });

  it('⭐ 鍵が読めなくても、委譲と器の数え上げは消えない', async () => {
    const stores = createMemoryStores();
    stores.tokens.list = () => Promise.reject(new Error('記憶ストアが落ちた'));
    const s = bootClone(stores, busyPool());

    s.clone.post({
      type: 'manager_message',
      id: 'evt-token-unreadable',
      at: AT,
      managerId: 'mgr-run',
      kind: 'report',
      text: '終わった',
    });
    await waitFor(() => s.inputs.length > 0, 'ターンが走ること');

    const text = s.inputs.join('\n');
    expect(text).toContain('委譲 全 3 本');
    expect(text).toContain('器 2 台');
    expect(text).toContain('プールを読めなかった');
    expect(text).toContain('枠を理由に仕事を見送らないこと');

    await s.clone.stop();
  });
});

describe('状況の節に受信箱の滞留の行が載る（#783 段0）', () => {
  it('受信箱に未読があれば、状況の節にその行が出る', async () => {
    const stores = createMemoryStores();
    const s = bootClone(stores, busyPool());
    // boot の後に直接ストアへ置く: boot の前だと起動時の拾い直しに乗って処理され、純粋な滞留を模せないため
    await stores.inbox.put(
      {
        type: 'human_message',
        id: 'evt-backlog',
        at: '2026-09-05T00:00:00.000Z',
        text: '未処理の発言',
        conversationId: 'conv-1',
      },
      '2026-09-05T00:00:00.000Z',
    );

    s.clone.post({
      type: 'manager_message',
      id: 'evt-report',
      at: AT,
      managerId: 'mgr-run',
      kind: 'report',
      text: '終わった',
    });
    await waitFor(() => s.inputs.length > 0, 'ターンが走ること');

    const text = s.inputs.join('\n');
    expect(text).toContain('受信箱の未処理 1 件');
    expect(text).toContain('2026-09-05T00:00:00.000Z');
    const claimed = await stores.inbox.claimPending();
    expect(claimed.map((r) => r.event.id)).toEqual(['evt-backlog']);
    expect(claimed[0]?.deliveries).toBe(1);

    await s.clone.stop();
  });

  it('受信箱が空なら、行そのものが出ない', async () => {
    const s = bootClone(createMemoryStores(), busyPool());

    s.clone.post({
      type: 'manager_message',
      id: 'evt-report',
      at: AT,
      managerId: 'mgr-run',
      kind: 'report',
      text: '終わった',
    });
    await waitFor(() => s.inputs.length > 0, 'ターンが走ること');

    expect(s.inputs.join('\n')).not.toContain('受信箱の未処理');

    await s.clone.stop();
  });

  it('⭐ 受信箱が読めなくても、委譲・器・鍵の数え上げは消えない（ターンを止めない）', async () => {
    const stores = createMemoryStores();
    stores.inbox.pending = () => Promise.reject(new Error('受信箱ストアが落ちた'));
    const s = bootClone(stores, busyPool());

    s.clone.post({
      type: 'manager_message',
      id: 'evt-report',
      at: AT,
      managerId: 'mgr-run',
      kind: 'report',
      text: '終わった',
    });
    await waitFor(() => s.inputs.length > 0, 'ターンが走ること');

    const text = s.inputs.join('\n');
    expect(text).toContain('委譲 全 3 本');
    expect(text).toContain('器 2 台');
    expect(text).toContain('受信箱の未処理を数えられなかった');

    await s.clone.stop();
  });
});

describe('受信箱の内訳（種類）は、閾値を超えた回だけ組む（issue #1140）', () => {
  async function putBacklogRows(
    stores: Stores,
    count: number,
    type: 'human_message' | 'external' = 'human_message',
  ): Promise<void> {
    for (let i = 0; i < count; i += 1) {
      const at = new Date(Date.parse(AT) - (count - i) * 1000).toISOString();
      if (type === 'human_message') {
        await stores.inbox.put(
          {
            type: 'human_message',
            id: `evt-loud-${i}`,
            at,
            text: `本文${i}`,
            conversationId: 'conv-loud',
          },
          at,
        );
      } else {
        await stores.inbox.put(
          { type: 'external', id: `evt-loud-${i}`, at, source: 'load-test', payload: { i } },
          at,
        );
      }
    }
  }

  it('閾値ちょうど（50件）では peekPending() を呼ばず、内訳の行も出ない', async () => {
    const stores = createMemoryStores();
    const s = bootClone(stores, busyPool());
    await putBacklogRows(stores, 50);
    let peekCalls = 0;
    const originalPeekPending = stores.inbox.peekPending.bind(stores.inbox);
    stores.inbox.peekPending = async () => {
      peekCalls += 1;
      return originalPeekPending();
    };

    s.clone.post({
      type: 'manager_message',
      id: 'evt-trigger',
      at: AT,
      managerId: 'mgr-run',
      kind: 'report',
      text: 'trigger',
    });
    await waitFor(() => s.inputs.length > 0, 'ターンが走ること');

    const text = s.inputs.join('\n');
    expect(text).toContain('受信箱の未処理 50 件');
    expect(peekCalls).toBe(0);
    expect(text).not.toContain('種類:');
    expect(text).not.toContain('⚠ 受信箱の未処理');
    expect(text).not.toContain(
      '内訳（種類 / 同一本文 / 器の入れ替え回数 / 齢）は `manager_list` で割れる',
    );

    await s.clone.stop();
  });

  it('閾値を超えたら（51件）peekPending() を呼び、種類の内訳（上位3件＋他）が状況の節に載る', async () => {
    const stores = createMemoryStores();
    const s = bootClone(stores, busyPool());
    await putBacklogRows(stores, 51);
    let peekCalls = 0;
    const originalPeekPending = stores.inbox.peekPending.bind(stores.inbox);
    stores.inbox.peekPending = async () => {
      peekCalls += 1;
      return originalPeekPending();
    };

    s.clone.post({
      type: 'manager_message',
      id: 'evt-trigger',
      at: AT,
      managerId: 'mgr-run',
      kind: 'report',
      text: 'trigger',
    });
    await waitFor(() => s.inputs.length > 0, 'ターンが走ること');

    const text = s.inputs.join('\n');
    expect(text).toContain('受信箱の未処理 51 件');
    expect(peekCalls).toBeGreaterThan(0);
    expect(text).toContain('種類: human_message 51 / manager_message 1');
    expect(text).toContain('器の生の行 52 件を数えた');
    expect(text).toContain(
      'このターン自身の分は引いていないので、上の件数と1件前後ずれることがある',
    );

    await s.clone.stop();
  });
});

describe('状況の節にメモリの配達待ち行列の行が載る（issue #1084）', () => {
  it('先客の処理中に積み上がった分が、メモリの配達待ち行列として載る', async () => {
    const s = bootClone(createMemoryStores(), busyPool());

    s.clone.post({
      type: 'manager_message',
      id: 'evt-a',
      at: AT,
      managerId: 'mgr-a',
      kind: 'report',
      text: 'A',
    });
    s.clone.post({
      type: 'manager_message',
      id: 'evt-b',
      at: AT,
      managerId: 'mgr-b',
      kind: 'report',
      text: 'B',
    });
    s.clone.post({
      type: 'manager_message',
      id: 'evt-c',
      at: AT,
      managerId: 'mgr-c',
      kind: 'report',
      text: 'C',
    });

    await waitFor(() => s.inputs.length > 0, 'A のターンが走ること');

    const text = s.inputs[0] ?? '';
    expect(text).toContain('メモリの配達待ち行列 2 件');

    await s.clone.stop();
  });

  it('他に何も積まれていなければ行が出ない（このターン自身を数えない）', async () => {
    const s = bootClone(createMemoryStores(), busyPool());

    s.clone.post({
      type: 'manager_message',
      id: 'evt-solo',
      at: AT,
      managerId: 'mgr-run',
      kind: 'report',
      text: '終わった',
    });
    await waitFor(() => s.inputs.length > 0, 'ターンが走ること');

    expect(s.inputs.join('\n')).not.toContain('メモリの配達待ち行列');

    await s.clone.stop();
  });
});

describe('状況の節と manager_list は、メモリの配達待ち行列を同じ関数から読む（issue #1133）', () => {
  it('#toolContext().queuedInMemory() は、状況の節が名乗った数と一致する', async () => {
    const inputs: string[] = [];
    const queuedInMemorySamples: (number | undefined)[] = [];
    let captured: ToolContext | undefined;
    const fn = ((params: { prompt: unknown; options?: Options }) => {
      async function* generate(): AsyncGenerator<SDKMessage, void> {
        yield {
          type: 'system',
          subtype: 'init',
          session_id: 'sess-fake',
          uuid: 'uuid-init',
        } as unknown as SDKMessage;
        for await (const message of params.prompt as AsyncIterable<{
          message: { content: unknown };
        }>) {
          inputs.push(String(message.message.content));
          // 同じ同期区間で読む: await を挟むと後続のターン（B・C の配達）が先に進み、値が変わるため
          queuedInMemorySamples.push(captured?.queuedInMemory?.());
          yield {
            type: 'assistant',
            message: { content: [{ type: 'text', text: 'ok' }] },
            parent_tool_use_id: null,
            session_id: 'sess-fake',
            uuid: 'uuid-assistant',
          } as unknown as SDKMessage;
          yield {
            type: 'result',
            subtype: 'success',
            result: 'ok',
            session_id: 'sess-fake',
            uuid: 'uuid-result',
          } as unknown as SDKMessage;
        }
      }
      const generator = generate();
      return Object.assign(generator, {
        close: () => undefined,
        interrupt: async () => undefined,
      }) as unknown as Query;
    }) as unknown as typeof sdkQuery;

    const clone = createClone({
      stores: createMemoryStores(),
      queryFn: fn,
      env: {},
      managers: busyPool(),
      redeliveryGate: ALWAYS_REDELIVER,
      mcpServerFactory: (context) => {
        captured = context;
        return createCloneMcpServer(context);
      },
    });

    clone.post({
      type: 'manager_message',
      id: 'evt-a',
      at: AT,
      managerId: 'mgr-a',
      kind: 'report',
      text: 'A',
    });
    clone.post({
      type: 'manager_message',
      id: 'evt-b',
      at: AT,
      managerId: 'mgr-b',
      kind: 'report',
      text: 'B',
    });
    clone.post({
      type: 'manager_message',
      id: 'evt-c',
      at: AT,
      managerId: 'mgr-c',
      kind: 'report',
      text: 'C',
    });

    await waitFor(() => inputs.length > 0, 'A のターンが走ること');

    const text = inputs[0] ?? '';
    expect(text).toContain('メモリの配達待ち行列 2 件');

    expect(queuedInMemorySamples[0]).toBe(2);

    await clone.stop();
  });
});

describe('同じ会話の2ターン目からは、説明文を要点に畳み、数の行は毎回出す（#4476）', () => {
  const READINGS_HEAD = '**「手が空いている」は「空き枠」ではない**';

  async function humanTurn(s: Fake & { clone: CloneHost }, n: number): Promise<string> {
    s.clone.post({
      type: 'human_message',
      id: `evt-human-${String(n)}`,
      at: AT,
      text: `発言 ${String(n)}`,
      conversationId: 'conv-1',
    });
    await waitFor(() => s.inputs.length >= n, `${String(n)} ターン目`);
    return s.inputs[n - 1] ?? '';
  }

  it('⭐ 1ターン目は全文、2ターン目は要点に畳み、数の行は残る', async () => {
    const s = bootClone(createMemoryStores(), busyPool());

    const first = await humanTurn(s, 1);
    const second = await humanTurn(s, 2);

    expect(first).toContain(READINGS_HEAD);
    expect(second).not.toContain(READINGS_HEAD);
    expect(second).toContain('要点だけにした');
    expect(second).toContain('委譲 全 3 本');
    expect(second).toContain('器 2 台: connected 1 / vacating 1。');
    await s.clone.stop();
  });

  it(`全文を出してから ${String(SITUATION_FULL_EVERY_TURNS)} ターン目に全文へ戻す`, async () => {
    const s = bootClone(createMemoryStores(), busyPool());

    for (let n = 1; n <= SITUATION_FULL_EVERY_TURNS + 2; n += 1) await humanTurn(s, n);

    // 1ターン目が全文、21ターン目が次の全文、その間と後は畳む
    expect(s.inputs[0]).toContain(READINGS_HEAD);
    expect(s.inputs[SITUATION_FULL_EVERY_TURNS - 1]).not.toContain(READINGS_HEAD);
    expect(s.inputs[SITUATION_FULL_EVERY_TURNS]).toContain(READINGS_HEAD);
    expect(s.inputs[SITUATION_FULL_EVERY_TURNS + 1]).not.toContain(READINGS_HEAD);
    await s.clone.stop();
  });

  it('文脈が要約された（compact_boundary）次のターンは全文へ戻す', async () => {
    const inputs: string[] = [];
    const fn = ((params: { prompt: unknown; options?: Options }) => {
      async function* generate(): AsyncGenerator<SDKMessage, void> {
        yield {
          type: 'system',
          subtype: 'init',
          session_id: 'sess-fake',
          uuid: 'uuid-init',
        } as unknown as SDKMessage;
        for await (const message of params.prompt as AsyncIterable<{
          message: { content: unknown };
        }>) {
          inputs.push(String(message.message.content));
          if (inputs.length === 2) {
            yield {
              type: 'system',
              subtype: 'compact_boundary',
              compact_metadata: { trigger: 'auto', pre_tokens: 100_000 },
              session_id: 'sess-fake',
              uuid: 'uuid-compact',
            } as unknown as SDKMessage;
          }
          yield {
            type: 'result',
            subtype: 'success',
            result: 'ok',
            session_id: 'sess-fake',
            uuid: `uuid-result-${String(inputs.length)}`,
          } as unknown as SDKMessage;
        }
      }
      return Object.assign(generate(), {
        close: () => undefined,
        interrupt: async () => undefined,
        // 使用量の観測が取れない回は全文に戻す（#4941）ので、畳みを見るために閾値から遠い観測を返す
        getContextUsage: async () => ({
          categories: [],
          totalTokens: 10_000,
          maxTokens: 1_000_000,
          rawMaxTokens: 1_000_000,
          percentage: 1,
          autoCompactThreshold: 200_000,
          isAutoCompactEnabled: true,
        }),
      }) as unknown as Query;
    }) as unknown as typeof sdkQuery;
    const clone = createClone({
      stores: createMemoryStores(),
      queryFn: fn,
      env: {},
      managers: busyPool(),
      redeliveryGate: ALWAYS_REDELIVER,
    });
    const s = { fn, inputs, clone };

    await humanTurn(s, 1);
    const folded = await humanTurn(s, 2);
    const afterCompaction = await humanTurn(s, 3);

    expect(folded).not.toContain(READINGS_HEAD);
    expect(afterCompaction).toContain(READINGS_HEAD);
    await clone.stop();
  });

  // ターンの終わりに測る文脈の量（トークン）を順に返す偽の SDK。閾値は 200,000
  function cloneWithContextTotals(totals: readonly number[]): {
    inputs: string[];
    clone: CloneHost;
    fn: typeof sdkQuery;
  } {
    const inputs: string[] = [];
    let calls = 0;
    const fn = ((params: { prompt: unknown; options?: Options }) => {
      async function* generate(): AsyncGenerator<SDKMessage, void> {
        yield {
          type: 'system',
          subtype: 'init',
          session_id: 'sess-fake',
          uuid: 'uuid-init',
        } as unknown as SDKMessage;
        for await (const message of params.prompt as AsyncIterable<{
          message: { content: unknown };
        }>) {
          inputs.push(String(message.message.content));
          yield {
            type: 'result',
            subtype: 'success',
            result: 'ok',
            session_id: 'sess-fake',
            uuid: `uuid-result-${String(inputs.length)}`,
          } as unknown as SDKMessage;
        }
      }
      return Object.assign(generate(), {
        close: () => undefined,
        interrupt: async () => undefined,
        getContextUsage: async () => {
          const totalTokens = totals[Math.min(calls, totals.length - 1)] ?? 0;
          calls += 1;
          return {
            categories: [],
            totalTokens,
            maxTokens: 1_000_000,
            rawMaxTokens: 1_000_000,
            percentage: totalTokens / 10_000,
            autoCompactThreshold: 200_000,
            isAutoCompactEnabled: true,
          };
        },
      }) as unknown as Query;
    }) as unknown as typeof sdkQuery;
    const clone = createClone({
      stores: createMemoryStores(),
      queryFn: fn,
      env: {},
      managers: busyPool(),
      redeliveryGate: ALWAYS_REDELIVER,
    });
    return { inputs, clone, fn };
  }

  it('⭐ 自動の要約が走りうるターン（前のターンの量に伸びを足すと閾値に届く）は畳まずに全文を出す（#4489）', async () => {
    // 1ターン目の終わりに 150,000、2ターン目の終わりに 180,000（伸び 30,000）→ 3ターン目は 210,000 の見込みで閾値 200,000 に届く
    const s = cloneWithContextTotals([150_000, 180_000, 185_000]);

    await humanTurn(s, 1);
    const second = await humanTurn(s, 2);
    const third = await humanTurn(s, 3);

    expect(second).not.toContain(READINGS_HEAD);
    expect(third).toContain(READINGS_HEAD);
    await s.clone.stop();
  });

  it('閾値まで遠いターンは、これまでどおり畳む（#4489）', async () => {
    const s = cloneWithContextTotals([50_000, 60_000, 70_000]);

    await humanTurn(s, 1);
    const second = await humanTurn(s, 2);
    const third = await humanTurn(s, 3);

    expect(second).not.toContain(READINGS_HEAD);
    expect(third).not.toContain(READINGS_HEAD);
    await s.clone.stop();
  });

  it('⭐ 入力を SDK へ入れなかった回（重複した human_answer）では、全文を出した扱いにしない', async () => {
    const inputs: string[] = [];
    const fn = ((params: { prompt: unknown; options?: Options }) => {
      async function* generate(): AsyncGenerator<SDKMessage, void> {
        yield {
          type: 'system',
          subtype: 'init',
          session_id: 'sess-fake',
          uuid: 'uuid-init',
        } as unknown as SDKMessage;
        for await (const message of params.prompt as AsyncIterable<{
          message: { content: unknown };
        }>) {
          inputs.push(String(message.message.content));
          // 2ターン目（最初の human_answer）の途中で要約が起きて、控えが空になる
          if (inputs.length === 2) {
            yield {
              type: 'system',
              subtype: 'compact_boundary',
              compact_metadata: { trigger: 'auto', pre_tokens: 100_000 },
              session_id: 'sess-fake',
              uuid: 'uuid-compact',
            } as unknown as SDKMessage;
          }
          yield {
            type: 'result',
            subtype: 'success',
            result: 'ok',
            session_id: 'sess-fake',
            uuid: `uuid-result-${String(inputs.length)}`,
          } as unknown as SDKMessage;
        }
      }
      return Object.assign(generate(), {
        close: () => undefined,
        interrupt: async () => undefined,
      }) as unknown as Query;
    }) as unknown as typeof sdkQuery;
    const clone = createClone({
      stores: createMemoryStores(),
      queryFn: fn,
      env: {},
      managers: busyPool(),
      redeliveryGate: ALWAYS_REDELIVER,
    });
    const s = { fn, inputs, clone };
    const answer = {
      type: 'human_answer' as const,
      id: 'evt-answer-1',
      at: AT,
      approvalId: 'ap-1',
      answer: '許可します',
    };

    await humanTurn(s, 1);
    clone.post(answer);
    await waitFor(() => inputs.length >= 2, '回答のターン');
    // 同じ id の合図をもう一度配る: 二重配達として畳まれ、ターンは回らない
    clone.post({ ...answer });
    // 畳まれたことを、後ろに積んだ発言のターンが走った（= 前の回が終わった）ことで確かめる
    const afterDuplicate = await humanTurn(s, 3);

    expect(inputs).toHaveLength(3);
    // 要約で全文が会話から消えた後、実際に入る最初の入力は全文でなければならない
    expect(afterDuplicate).toContain(READINGS_HEAD);
    await clone.stop();
  });
});

describe('自動の要約が走りうるターンの見込み（#4489）', () => {
  const near = { totalTokens: 195_000, autoCompactThreshold: 200_000, isAutoCompactEnabled: true };

  it('伸びの下限を足して閾値に届けば走りうる', () => {
    expect(SITUATION_COMPACTION_GROWTH_FLOOR_TOKENS).toBe(10_000);
    expect(compactionLikelyThisTurn(near, 0)).toBe(true);
    expect(compactionLikelyThisTurn({ ...near, totalTokens: 189_999 }, 0)).toBe(false);
    expect(compactionLikelyThisTurn({ ...near, totalTokens: 150_000 }, 50_000)).toBe(true);
  });

  it('観測が無い・自動の要約が切ってある・閾値が分からない回は見込まない', () => {
    expect(compactionLikelyThisTurn(null, 0)).toBe(false);
    expect(compactionLikelyThisTurn({ ...near, isAutoCompactEnabled: false }, 0)).toBe(false);
    expect(compactionLikelyThisTurn({ totalTokens: 195_000, isAutoCompactEnabled: true }, 0)).toBe(
      false,
    );
  });
});
