import type {
  query as sdkQuery,
  ModelUsage,
  Options,
  Query,
  SDKMessage,
} from '@anthropic-ai/claude-agent-sdk';
import { writeFile } from 'node:fs/promises';
import { join } from 'node:path';

import { afterAll, afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { makeTempDir } from '../../../vitest.tmpdir.js';
import type { AgentProvider } from './agent-ports.js';
import { fakeSdk, wireEvents, waitFor } from './clone-test-harness.js';
import type { FakeCall } from './clone-test-harness.js';
import { createClone } from './clone.js';
import { createLocalRunner } from './runner-local.js';
import { createRunnerRegistry } from './runner-protocol.js';
import type { Stores } from './store.js';
import { captureStderr, createMemoryStores, humanMessage } from './testing.js';

// `Clone` の「消費の台帳」（`#recordUsage`・`#recordUnmeteredTurn`・`#flushSessionUsage`。呼び元は `#applyTurnEnded` の `finalizeStep('usage', …)`・
// `#distillFromTranscript`・`#read`・`stop()`）を、`createClone` 経由で固定する。観測するのは、日誌（`turn_usage`・exchange）・usage ストアへ渡る引数と状態・stderr。
// 切り出し（`clone-usage-ledger.ts`）の前に置いた。期待の値・文面は仕様を先に書いたものではなく、今の作りの出力を `vitest run <path> -u` で生成して
// 目で読んで確かめた値である。「今の出力から変えない」ための歯であって、文面の正しさの保証ではない。
// 既存の試験（`clone-turn-usage`・`clone-usage-flush`・`clone-usage-unmetered`・`clone-consumption-ledger`）は、値の一部（欄の有無・件数・部分一致）を縛る。
// ここが足すのは、縛っていない枝: `turn_usage` の全欄と欄の並び・`usage.record` / `recordUnmetered` へ渡る引数の全部（`date`・`at`・`accumulation`・`tokenId` の有無）・
// 失敗の日誌2行の全文と stderr の行・差分の欄・畳む直前の読みの行・`#applyTurnEnded` の中の並び。
// 時刻は `Date` だけを止めて動かす（タイマーは本物のまま。実時間の待ちは足さない）。

// 時間帯をテストの側で Asia/Tokyo に固定する: `usageDate` はローカル時刻で日付を切るので、器の時間帯に任せると CI（UTC）と手元（JST）で日付の境目の期待が食い違い、
// UTC の器では「ローカルの日付を UTC の日付に取り違える」変異が通ってしまうため
// vi.hoisted にする: 素の代入だと import が先に評価されて静かに効かなくなる（`apps/web/app/routes/reports.test.tsx` の冒頭と同じ理由）
const tzBeforeThisFile = vi.hoisted(() => {
  const before = process.env.TZ;
  process.env.TZ = 'Asia/Tokyo';
  return before;
});

afterAll(() => {
  if (tzBeforeThisFile === undefined) delete process.env.TZ;
  else process.env.TZ = tzBeforeThisFile;
});

beforeEach(() => {
  vi.useFakeTimers({ toFake: ['Date'] });
  vi.setSystemTime(new Date('2026-11-01T09:00:00.000Z'));
});

afterEach(() => {
  vi.useRealTimers();
});

function usageOf(model: string, costUsd: number, tokens = 10) {
  return {
    [model]: {
      inputTokens: tokens,
      outputTokens: tokens * 2,
      cacheReadInputTokens: 5,
      cacheCreationInputTokens: 3,
      webSearchRequests: 0,
      costUSD: costUsd,
    },
  };
}

type Spied = { readonly kind: 'record' | 'unmetered'; readonly input: Record<string, unknown> };

/** `usage.record` / `recordUnmetered` を包み、渡された引数と呼ばれた順を控える（呼びは元のストアへ通す）。 */
function spyUsage(stores: Stores, log: string[] = []): Spied[] {
  const calls: Spied[] = [];
  const record = stores.usage.record.bind(stores.usage);
  const recordUnmetered = stores.usage.recordUnmetered.bind(stores.usage);
  stores.usage.record = (input) => {
    calls.push({ kind: 'record', input: { ...input } });
    log.push('record');
    return record(input);
  };
  stores.usage.recordUnmetered = (input) => {
    calls.push({ kind: 'unmetered', input: { ...input } });
    log.push('unmetered');
    return recordUnmetered(input);
  };
  return calls;
}

interface BuildOptions {
  readonly sdk?: Parameters<typeof fakeSdk>[1];
  readonly provider?: Pick<AgentProvider, 'id' | 'capabilities'>;
  readonly tokenIdentity?: () => { tokenId: string; generation: number } | undefined;
  readonly onFirstTurnToolSearch?: (line: string) => Promise<void>;
  readonly stores?: Stores;
}

function build(options: BuildOptions = {}) {
  const stores = options.stores ?? createMemoryStores();
  const { fn, calls } = fakeSdk(undefined, options.sdk ?? {});
  const clone = createClone({
    inboxSettleMs: 0,
    reportSettleMs: 0,
    stores,
    queryFn: fn,
    env: {},
    ...(options.provider === undefined ? {} : { provider: options.provider }),
    ...(options.tokenIdentity === undefined ? {} : { tokenIdentity: options.tokenIdentity }),
    ...(options.onFirstTurnToolSearch === undefined
      ? {}
      : { onFirstTurnToolSearch: options.onFirstTurnToolSearch }),
    runners: createRunnerRegistry([
      createLocalRunner({ workspacePath: '/work', queryFn: fakeSdk().fn, env: {} }),
    ]),
  });
  const { events, waitForEvents } = wireEvents(clone, 'conv-1');
  return { clone, stores, calls, events, waitForEvents };
}

type Built = ReturnType<typeof build>;

async function turn(s: Built, text: string, n: number): Promise<void> {
  s.clone.post(humanMessage(text));
  await s.waitForEvents((events) => events.filter((event) => event.type === 'done').length >= n);
}

async function firePreCompact(main: FakeCall): Promise<void> {
  const dir = await makeTempDir('alteroid-usage-ledger-pin-');
  const transcriptPath = join(dir, 'transcript.jsonl');
  await writeFile(transcriptPath, '要約に潰される直前の生ログ', 'utf8');
  const hook = main.options.hooks?.PreCompact?.[0]?.hooks?.[0];
  if (hook === undefined) throw new Error('PreCompact フックが登録されていない');
  await hook({ session_id: 'sess-fake', transcript_path: transcriptPath } as never, undefined, {
    signal: new AbortController().signal,
  } as never);
}

/** 日誌の行から、`id` と `at`（採番と時刻）を除く。 */
function withoutMeta(entry: object): Record<string, unknown> {
  return Object.fromEntries(Object.entries(entry).filter(([key]) => key !== 'id' && key !== 'at'));
}

async function turnUsageRows(stores: Stores): Promise<Record<string, unknown>[]> {
  // `list` は新しい順に返す。読みやすいよう、起きた順に並べ直す
  const rows = await stores.journal.list({ types: ['turn_usage'], limit: 100 });
  return rows.map(withoutMeta).reverse();
}

/** `with: 'self'` の exchange の本文（起きた順）。`only` を渡すと、その語を含む行だけ。 */
async function selfExchangeTexts(stores: Stores, only?: string): Promise<string[]> {
  const rows = await stores.journal.list({ types: ['exchange'], limit: 100 });
  return rows
    .flatMap((row) =>
      row.type === 'exchange' && row.with === 'self' ? [`${row.role}: ${row.text}`] : [],
    )
    .filter((text) => only === undefined || text.includes(only))
    .reverse();
}

const LEDGER_FAILURE = '消費を台帳へ記録できなかった';

const COMPACT_BOUNDARY = {
  type: 'system',
  subtype: 'compact_boundary',
  session_id: 'sess-fake',
  uuid: 'uuid-compact-1',
  compact_metadata: { trigger: 'auto', pre_tokens: 180_000, post_tokens: 42_000 },
} as unknown as SDKMessage;

const CONTEXT_USAGE = {
  totalTokens: 12_000,
  rawMaxTokens: 200_000,
  percentage: 6,
  autoCompactThreshold: 160_000,
  isAutoCompactEnabled: true,
};

describe('turn_usage の行の欄', () => {
  // 欄の並びは見ない（見るのは欄の集合）: メモリの日誌は行をスキーマに通して返すので、並びは書いた式ではなくスキーマが決める
  it('本セッションのターン: 全欄（sessionId・models・compactions）が載り、contextUsage と mainLoopUsage は載せない（文脈占有は context_usage の行、同じ消費は turn_timing.tokens）', async () => {
    const s = build({
      sdk: {
        modelUsage: () => usageOf('claude-fable-5', 0.5),
        resultUsage: () => ({
          input_tokens: 7,
          output_tokens: 3,
          cache_read_input_tokens: 100,
          cache_creation_input_tokens: 40,
        }),
        getContextUsage: () => CONTEXT_USAGE,
        beforeAssistant: () => [COMPACT_BOUNDARY],
      },
    });
    await turn(s, 'やあ', 1);

    const rows = await turnUsageRows(s.stores);
    expect(rows).toHaveLength(1);
    expect(Object.keys(rows[0]!).sort()).toEqual([
      'compactions',
      'layer',
      'managerId',
      'models',
      'sessionId',
      'site',
      'type',
    ]);
    expect(rows[0]).toMatchInlineSnapshot(`
      {
        "compactions": [
          {
            "postTokens": 42000,
            "preTokens": 180000,
            "trigger": "auto",
          },
        ],
        "layer": "clone",
        "managerId": "clone",
        "models": {
          "claude-fable-5": {
            "cacheCreationInputTokens": 3,
            "cacheReadInputTokens": 5,
            "costUsd": 0.5,
            "inputTokens": 10,
            "outputTokens": 20,
            "webSearchRequests": 0,
          },
        },
        "sessionId": "sess-fake",
        "site": "session",
        "type": "turn_usage",
      }
    `);
    await s.clone.stop();
  });

  it('compaction が無い回: compactions の欄そのものが無い（空の値を作らない）', async () => {
    const s = build({
      sdk: {
        modelUsage: () => usageOf('claude-fable-5', 0.5),
        getContextUsage: () => CONTEXT_USAGE,
      },
    });
    await turn(s, 'やあ', 1);

    const rows = await turnUsageRows(s.stores);
    expect(rows).toHaveLength(1);
    expect(Object.keys(rows[0]!).sort()).toEqual([
      'layer',
      'managerId',
      'models',
      'sessionId',
      'site',
      'type',
    ]);
    await s.clone.stop();
  });

  it('差分の欄: 2ターン目の models は累積との差で、reset は付かない（日誌の行を足す順は turn_usage が先）', async () => {
    let n = 0;
    const s = build({
      sdk: {
        modelUsage: () => {
          n += 1;
          return n === 1 ? usageOf('claude-fable-5', 1, 10) : usageOf('claude-fable-5', 1.75, 14);
        },
        getContextUsage: () => CONTEXT_USAGE,
      },
    });
    await turn(s, '1回目', 1);
    await turn(s, '2回目', 2);

    const rows = await turnUsageRows(s.stores);
    expect(rows).toHaveLength(2);
    expect(rows[1]).not.toHaveProperty('reset');
    expect(rows[1]).toMatchInlineSnapshot(`
      {
        "layer": "clone",
        "managerId": "clone",
        "models": {
          "claude-fable-5": {
            "cacheCreationInputTokens": 0,
            "cacheReadInputTokens": 0,
            "costUsd": 0.75,
            "inputTokens": 4,
            "outputTokens": 8,
            "webSearchRequests": 0,
          },
        },
        "sessionId": "sess-fake",
        "site": "session",
        "type": "turn_usage",
      }
    `);
    await s.clone.stop();
  });

  it('累積が数え直された回: reset の欄は fromCostUsd と toCostUsd の2つだけで、turn_usage の行が先、数え直しの行（gauge）が後に載る', async () => {
    let n = 0;
    const s = build({
      sdk: {
        modelUsage: () => {
          n += 1;
          return n === 1
            ? usageOf('claude-fable-5', 5, 10)
            : usageOf('claude-fable-5', 3.1234567, 9);
        },
        getContextUsage: () => CONTEXT_USAGE,
      },
    });
    await turn(s, '1回目', 1);
    await turn(s, '2回目', 2);

    const rows = await turnUsageRows(s.stores);
    expect(rows).toHaveLength(2);
    expect(Object.keys(rows[1]!).sort()).toEqual([
      'layer',
      'managerId',
      'models',
      'reset',
      'sessionId',
      'site',
      'type',
    ]);
    expect(rows[1]).toMatchInlineSnapshot(`
      {
        "layer": "clone",
        "managerId": "clone",
        "models": {
          "claude-fable-5": {
            "cacheCreationInputTokens": 3,
            "cacheReadInputTokens": 5,
            "costUsd": 3.1234567,
            "inputTokens": 9,
            "outputTokens": 18,
            "webSearchRequests": 0,
          },
        },
        "reset": {
          "fromCostUsd": 5,
          "toCostUsd": 3.1234567,
        },
        "sessionId": "sess-fake",
        "site": "session",
        "type": "turn_usage",
      }
    `);

    expect(await selfExchangeTexts(s.stores, '数え直された')).toMatchInlineSnapshot(`
      [
        "outbound: [計器] 自分の消費の累積が数え直された（5.0000 → 3.1235）。resume か /clear で SDK 側の累積が 0 から始まったため。記録済みの分は保持している。",
      ]
    `);

    const all = (await s.stores.journal.list({ limit: 200 })).reverse();
    const order = all.flatMap((row) =>
      row.type === 'turn_usage' || (row.type === 'exchange' && row.text.includes('数え直された'))
        ? [row.type]
        : [],
    );
    expect(order).toEqual(['turn_usage', 'turn_usage', 'exchange']);
    await s.clone.stop();
  });

  it('蒸留（site=distill）: turn_usage に文脈占有も compaction も載らず、台帳へは oneshot で渡る', async () => {
    const stores = createMemoryStores();
    const calls = spyUsage(stores);
    const s = build({
      stores,
      sdk: {
        modelUsage: (index) =>
          index === 0 ? usageOf('claude-fable-5', 1) : usageOf('claude-fable-5', 0.25, 4),
        getContextUsage: () => CONTEXT_USAGE,
      },
    });
    await turn(s, 'やあ', 1);
    await firePreCompact(s.calls[0] as FakeCall);

    const rows = await turnUsageRows(s.stores);
    const distill = rows.filter((row) => row['site'] === 'distill');
    expect(distill).toHaveLength(1);
    expect(distill[0]).toMatchInlineSnapshot(`
      {
        "layer": "clone",
        "managerId": "clone",
        "models": {
          "claude-fable-5": {
            "cacheCreationInputTokens": 3,
            "cacheReadInputTokens": 5,
            "costUsd": 0.25,
            "inputTokens": 4,
            "outputTokens": 8,
            "webSearchRequests": 0,
          },
        },
        "sessionId": "sess-fake",
        "site": "distill",
        "type": "turn_usage",
      }
    `);
    expect(Object.keys(distill[0]!).sort()).toEqual([
      'layer',
      'managerId',
      'models',
      'sessionId',
      'site',
      'type',
    ]);
    expect(calls.map((c) => [c.kind, c.input['site'], c.input['accumulation']])).toEqual([
      ['record', 'session', 'cumulative'],
      ['record', 'distill', 'oneshot'],
    ]);
    await s.clone.stop();
  });
});

describe('usage.record へ渡る引数', () => {
  it('本セッションのターン: 全欄が渡る。tokenId は無ければ欄ごと渡さない', async () => {
    const stores = createMemoryStores();
    const calls = spyUsage(stores);
    const s = build({ stores, sdk: { modelUsage: () => usageOf('claude-fable-5', 0.5) } });
    await turn(s, 'やあ', 1);

    expect(calls).toHaveLength(1);
    expect(calls[0]!.kind).toBe('record');
    expect(Object.keys(calls[0]!.input)).toEqual([
      'layer',
      'site',
      'managerId',
      'date',
      'at',
      'snapshot',
      'accumulation',
    ]);
    expect(calls[0]!.input).toMatchInlineSnapshot(`
      {
        "accumulation": "cumulative",
        "at": "2026-11-01T09:00:00.000Z",
        "date": "2026-11-01",
        "layer": "clone",
        "managerId": "clone",
        "site": "session",
        "snapshot": {
          "models": {
            "claude-fable-5": {
              "cacheCreationInputTokens": 3,
              "cacheReadInputTokens": 5,
              "costUsd": 0.5,
              "inputTokens": 10,
              "outputTokens": 20,
              "webSearchRequests": 0,
            },
          },
          "sessionId": "sess-fake",
        },
      }
    `);
    await s.clone.stop();
  });

  it('身元が在れば tokenId が末尾に付く。値は session が起きた瞬間の身元のまま（回った後の読み直しは渡らない）', async () => {
    let current = { tokenId: 'tok-a', generation: 1 };
    const stores = createMemoryStores();
    const calls = spyUsage(stores);
    const s = build({
      stores,
      tokenIdentity: () => current,
      sdk: { modelUsage: (index) => usageOf('claude-fable-5', index === 0 ? 0.5 : 0.25) },
    });
    await turn(s, '1回目', 1);
    current = { tokenId: 'tok-b', generation: 2 };
    await firePreCompact(s.calls[0] as FakeCall);

    expect(calls.map((c) => [c.input['site'], c.input['tokenId']])).toEqual([
      ['session', 'tok-a'],
      ['distill', 'tok-a'],
    ]);
    expect(Object.keys(calls[0]!.input).at(-1)).toBe('tokenId');
    await s.clone.stop();
  });

  it('usageDate の境目: ローカル時刻の 23:59:59.999 は前の日、翌 0:00:00.000 は次の日。at は ISO 文字列のまま渡る', async () => {
    const stores = createMemoryStores();
    const calls = spyUsage(stores);
    let n = 0;
    const s = build({
      stores,
      sdk: {
        modelUsage: () => {
          n += 1;
          return usageOf('claude-fable-5', n);
        },
      },
    });
    const before = new Date(2026, 10, 1, 23, 59, 59, 999);
    const after = new Date(2026, 10, 2, 0, 0, 0, 0);
    vi.setSystemTime(before);
    await turn(s, '1回目', 1);
    vi.setSystemTime(after);
    await turn(s, '2回目', 2);

    expect(calls.map((c) => [c.input['date'], c.input['at']])).toEqual([
      ['2026-11-01', before.toISOString()],
      ['2026-11-02', after.toISOString()],
    ]);
    const { rows } = await s.stores.usage.aggregate({});
    expect(rows.map((row) => [row.date, row.totals.costUsd]).sort()).toEqual([
      ['2026-11-01', 1],
      ['2026-11-02', 1],
    ]);
    await s.clone.stop();
  });
});

describe('台帳へ積めなかったときの跡', () => {
  async function failing(secret: string, site: 'session' | 'distill') {
    const stores = createMemoryStores();
    stores.usage.record = () =>
      Promise.reject(new Error(`台帳が落ちた Authorization: Bearer ${secret}\nparams: SECRET-ROW`));
    const s = build({
      stores,
      sdk: { modelUsage: () => usageOf('claude-fable-5', 0.5) },
    });
    const stderr = await captureStderr(async () => {
      await turn(s, 'やあ', 1);
      if (site === 'distill') await firePreCompact(s.calls[0] as FakeCall);
      await s.clone.stop();
    });
    return { s, stderr };
  }

  // 3行: 本流のターン（site=session）・要約の蒸留のサイドクエリ（site=distill）・stop() が走らせる畳みの蒸留のターン（本流のセッションなので site=session）
  it('日誌の1行（failure）: 全文。接頭辞・site・理由（1行に畳み、秘密は伏せる）。site ごとに1行ずつ出る', async () => {
    const { s } = await failing('sk-ant-api03-ABCDEFGHIJKLMNOPQRSTUVWX', 'distill');
    expect(await selfExchangeTexts(s.stores, LEDGER_FAILURE)).toMatchInlineSnapshot(`
      [
        "outbound: [障害] [site=session] 消費を台帳へ記録できなかった（この分は集計に出ない）: Error: 台帳が落ちた Authorization: Bearer [REDACTED]",
        "outbound: [障害] [site=distill] 消費を台帳へ記録できなかった（この分は集計に出ない）: Error: 台帳が落ちた Authorization: Bearer [REDACTED]",
        "outbound: [障害] [site=session] 消費を台帳へ記録できなかった（この分は集計に出ない）: Error: 台帳が落ちた Authorization: Bearer [REDACTED]",
      ]
    `);
  });

  it('stderr の行: 台帳の名指しと layer・site', async () => {
    const { stderr } = await failing('sk-ant-api03-ABCDEFGHIJKLMNOPQRSTUVWX', 'distill');
    const lines = stderr.filter((line) => line.includes('利用状況の台帳'));
    expect(lines.map((line) => line.replace(/\d{4}-\d\d-\d\dT[\d:.]+Z/g, '<時刻>')))
      .toMatchInlineSnapshot(`
      [
        "alteroid: <時刻> 利用状況の台帳を記録できませんでした（layer=clone site=session）: Error: 台帳が落ちた Authorization: Bearer [REDACTED]
      ",
        "alteroid: <時刻> 利用状況の台帳を記録できませんでした（layer=clone site=distill）: Error: 台帳が落ちた Authorization: Bearer [REDACTED]
      ",
        "alteroid: <時刻> 利用状況の台帳を記録できませんでした（layer=clone site=session）: Error: 台帳が落ちた Authorization: Bearer [REDACTED]
      ",
      ]
    `);
  });
});

describe('無報告のターン（capabilities.usage === false）', () => {
  const UNMETERED: AgentProvider = {
    id: 'claude',
    displayName: 'Unmetered fake',
    capabilities: { usage: false },
  };

  it('recordUnmetered へ渡る引数の全部。tokenId は無ければ欄ごと渡さない。record は呼ばない', async () => {
    const stores = createMemoryStores();
    const calls = spyUsage(stores);
    const s = build({ stores, provider: UNMETERED });
    await turn(s, 'やあ', 1);

    expect(calls.map((c) => c.kind)).toEqual(['unmetered']);
    expect(Object.keys(calls[0]!.input)).toEqual([
      'layer',
      'site',
      'managerId',
      'date',
      'at',
      'provider',
    ]);
    expect(calls[0]!.input).toMatchInlineSnapshot(`
      {
        "at": "2026-11-01T09:00:00.000Z",
        "date": "2026-11-01",
        "layer": "clone",
        "managerId": "clone",
        "provider": "claude",
        "site": "session",
      }
    `);
    expect(await turnUsageRows(s.stores)).toEqual([]);
    await s.clone.stop();
  });

  it('身元が在れば tokenId が末尾に付く', async () => {
    const stores = createMemoryStores();
    const calls = spyUsage(stores);
    const s = build({
      stores,
      provider: UNMETERED,
      tokenIdentity: () => ({ tokenId: 'tok-a', generation: 1 }),
    });
    await turn(s, 'やあ', 1);

    expect(calls).toHaveLength(1);
    expect(Object.keys(calls[0]!.input).at(-1)).toBe('tokenId');
    expect(calls[0]!.input['tokenId']).toBe('tok-a');
    await s.clone.stop();
  });

  it('蒸留のターンも数える（site=distill）', async () => {
    const stores = createMemoryStores();
    const calls = spyUsage(stores);
    const s = build({ stores, provider: UNMETERED });
    await turn(s, 'やあ', 1);
    await firePreCompact(s.calls[0] as FakeCall);

    expect(calls.map((c) => [c.kind, c.input['site']])).toEqual([
      ['unmetered', 'session'],
      ['unmetered', 'distill'],
    ]);
    await s.clone.stop();
  });

  it('usage が在るなら無報告に数えず record へ渡る（数える条件は usage が無いことではなく capabilities.usage === false かつ usage 無し）', async () => {
    const stores = createMemoryStores();
    const calls = spyUsage(stores);
    const s = build({
      stores,
      provider: UNMETERED,
      sdk: { modelUsage: () => usageOf('claude-fable-5', 0.5) },
    });
    await turn(s, 'やあ', 1);

    expect(calls.map((c) => c.kind)).toEqual(['record']);
    await s.clone.stop();
  });

  it('台帳へ積めなくてもターンは止まらず、跡は stderr の1行だけ（日誌の exchange は出ない）', async () => {
    const stores = createMemoryStores();
    stores.usage.recordUnmetered = () => Promise.reject(new Error('無報告の台帳が書けない'));
    const s = build({ stores, provider: UNMETERED });
    const stderr = await captureStderr(async () => {
      await turn(s, 'やあ', 1);
      await s.clone.stop();
    });

    const lines = stderr.filter((line) => line.includes('利用状況の台帳'));
    expect(lines.map((line) => line.replace(/\d{4}-\d\d-\d\dT[\d:.]+Z/g, '<時刻>')))
      .toMatchInlineSnapshot(`
      [
        "alteroid: <時刻> 利用状況の台帳（無報告のターン）を記録できませんでした（layer=clone site=session）: Error: 無報告の台帳が書けない
      ",
        "alteroid: <時刻> 利用状況の台帳（無報告のターン）を記録できませんでした（layer=clone site=session）: Error: 無報告の台帳が書けない
      ",
      ]
    `);
    expect(await selfExchangeTexts(s.stores, '台帳')).toEqual([]);
  });
});

describe('#applyTurnEnded の中の並び', () => {
  // 文脈占有の観測は `done` の後ろの鎖で走る（`clone-context-usage-after-done.test.ts`）ので、`context_usage` の行は `turn_usage` より後になる
  it('文脈占有の行（context_usage）は turn_usage より後に載り、台帳への積みは ToolSearch の観測より先', async () => {
    const stores = createMemoryStores();
    const log: string[] = [];
    spyUsage(stores, log);
    const s = build({
      stores,
      sdk: {
        modelUsage: () => usageOf('claude-fable-5', 0.5),
        getContextUsage: () => CONTEXT_USAGE,
      },
      onFirstTurnToolSearch: () => {
        log.push('toolSearch');
        return Promise.resolve();
      },
    });
    await turn(s, 'やあ', 1);

    // 観測は `done` の後ろなので、ToolSearch の観測が渡るのを待つ（その前に `context_usage` の行は書き終わっている）
    await vi.waitFor(() => expect(log).toEqual(['record', 'toolSearch']));
    const all = (await s.stores.journal.list({ limit: 200 })).reverse();
    expect(
      all.flatMap((row) =>
        row.type === 'context_usage' || row.type === 'turn_usage' ? [row.type] : [],
      ),
    ).toEqual(['turn_usage', 'context_usage']);
    await s.clone.stop();
  });

  it('失敗したターン（usage 無し）でも、context_usage は残り、台帳へは何も渡らない（Claude）', async () => {
    const stores = createMemoryStores();
    const calls = spyUsage(stores);
    const s = build({
      stores,
      sdk: { resultSubtype: 'error_during_execution', getContextUsage: () => CONTEXT_USAGE },
    });
    s.clone.post(humanMessage('やあ'));
    await waitFor(() => s.events.some((event) => event.type === 'error'), 'error イベントが届く');

    expect(calls).toEqual([]);
    const all = await s.stores.journal.list({ types: ['context_usage'], limit: 10 });
    expect(all).toHaveLength(1);
    await s.clone.stop();
  });
});

// 畳む直前の累積の読み（`#flushSessionUsage`）。SDK の口（`usage_EXPERIMENTAL_MAY_CHANGE_DO_NOT_RELY_ON_THIS_API_YET`）を持つ偽物を作る。
describe('畳む直前の累積の読み（#flushSessionUsage）', () => {
  function sdkModelUsage(costUsd: number, tokens = 100): ModelUsage {
    return {
      inputTokens: tokens,
      outputTokens: tokens,
      cacheReadInputTokens: 0,
      cacheCreationInputTokens: 0,
      webSearchRequests: 0,
      costUSD: costUsd,
      contextWindow: 200_000,
      maxOutputTokens: 64_000,
    };
  }

  function usageResponse(models: Record<string, ModelUsage>): unknown {
    return {
      session: {
        total_cost_usd: 0,
        total_api_duration_ms: 0,
        total_duration_ms: 0,
        total_lines_added: 0,
        total_lines_removed: 0,
        model_usage: models,
      },
      subscription_type: 'max',
      rate_limits_available: false,
      rate_limits: null,
    };
  }

  function flushSdk(options: {
    usage?: () => Promise<unknown>;
    resultUsage?: Record<string, ModelUsage>;
  }) {
    const inputs: string[] = [];
    const fn = ((params: { prompt: unknown; options?: Options }) => {
      async function* generate(): AsyncGenerator<SDKMessage, void> {
        yield {
          type: 'system',
          subtype: 'init',
          session_id: 'sess-clone',
          uuid: 'uuid-init',
        } as unknown as SDKMessage;
        const reader = (params.prompt as AsyncIterable<{ message: { content: unknown } }>)[
          Symbol.asyncIterator
        ]();
        for (;;) {
          const next = await reader.next();
          if (next.done === true) return;
          inputs.push(String(next.value.message.content));
          yield {
            type: 'assistant',
            message: { content: [{ type: 'text', text: 'ok' }] },
            parent_tool_use_id: null,
            session_id: 'sess-clone',
            uuid: 'uuid-assistant',
          } as unknown as SDKMessage;
          yield {
            type: 'result',
            subtype: 'success',
            result: 'ok',
            session_id: 'sess-clone',
            uuid: 'uuid-result',
            ...(options.resultUsage === undefined ? {} : { modelUsage: options.resultUsage }),
          } as unknown as SDKMessage;
        }
      }
      return Object.assign(generate(), {
        close: () => undefined,
        interrupt: async () => undefined,
        ...(options.usage === undefined
          ? {}
          : { usage_EXPERIMENTAL_MAY_CHANGE_DO_NOT_RELY_ON_THIS_API_YET: options.usage }),
      }) as unknown as Query;
    }) as unknown as typeof sdkQuery;
    return { fn, inputs };
  }

  function bootFlush(
    stores: Stores,
    fake: ReturnType<typeof flushSdk>,
    tokenIdentity?: () => { tokenId: string; generation: number } | undefined,
  ) {
    return createClone({
      inboxSettleMs: 0,
      reportSettleMs: 0,
      stores,
      queryFn: fake.fn,
      env: {},
      ...(tokenIdentity === undefined ? {} : { tokenIdentity }),
      runners: createRunnerRegistry([
        createLocalRunner({ workspacePath: '/work', queryFn: fakeSdk().fn, env: {} }),
      ]),
    });
  }

  async function runOneTurn(clone: ReturnType<typeof bootFlush>, fake: { inputs: string[] }) {
    clone.post({
      type: 'self_initiative',
      id: 'evt-flush',
      at: '2026-09-01T00:00:00.000Z',
      reason: '枠切れで落ちる前に少し使う',
    });
    await waitFor(() => fake.inputs.length >= 1, 'セッションが最初の入力を受け取る');
  }

  // 呼びは3回: 本流のターンの result・stop() が走らせる畳みの蒸留のターンの result（累積が同じなので差分は空で、行は書かれない）・畳む直前の読み
  it('result で積んだ累積の後に増えた分だけが、畳む直前に積まれる（欄は sessionId・mainLoopUsage・contextUsage・compactions を持たない）', async () => {
    const stores = createMemoryStores();
    const calls = spyUsage(stores);
    const fake = flushSdk({
      usage: async () => usageResponse({ 'claude-fable-5': sdkModelUsage(0.6, 140) }),
      resultUsage: { 'claude-fable-5': sdkModelUsage(0.42, 100) },
    });
    const clone = bootFlush(stores, fake);
    await runOneTurn(clone, fake);
    await waitFor(() => calls.length >= 1, '本流のターンの累積が台帳へ載る');
    await clone.stop();

    expect(calls.map((c) => [c.kind, c.input['site'], c.input['accumulation']])).toEqual([
      ['record', 'session', 'cumulative'],
      ['record', 'session', 'cumulative'],
      ['record', 'session', 'cumulative'],
    ]);
    const rows = await turnUsageRows(stores);
    expect(rows).toHaveLength(2);
    expect(Object.keys(rows[1]!).sort()).toEqual(['layer', 'managerId', 'models', 'site', 'type']);
    expect(rows[1]).toMatchInlineSnapshot(`
      {
        "layer": "clone",
        "managerId": "clone",
        "models": {
          "claude-fable-5": {
            "cacheCreationInputTokens": 0,
            "cacheReadInputTokens": 0,
            "costUsd": 0.18,
            "inputTokens": 40,
            "outputTokens": 40,
            "webSearchRequests": 0,
          },
        },
        "site": "session",
        "type": "turn_usage",
      }
    `);
  });

  it('畳む直前の読みの引数: snapshot は { models } だけ。tokenId は身元から渡る', async () => {
    const stores = createMemoryStores();
    const calls = spyUsage(stores);
    const fake = flushSdk({
      usage: async () => usageResponse({ 'claude-fable-5': sdkModelUsage(0.42) }),
    });
    const clone = bootFlush(stores, fake, () => ({ tokenId: 'tok-a', generation: 1 }));
    await runOneTurn(clone, fake);
    await clone.stop();

    expect(calls).toHaveLength(1);
    expect(Object.keys(calls[0]!.input)).toEqual([
      'layer',
      'site',
      'managerId',
      'date',
      'at',
      'snapshot',
      'accumulation',
      'tokenId',
    ]);
    expect(calls[0]!.input).toMatchInlineSnapshot(`
      {
        "accumulation": "cumulative",
        "at": "2026-11-01T09:00:00.000Z",
        "date": "2026-11-01",
        "layer": "clone",
        "managerId": "clone",
        "site": "session",
        "snapshot": {
          "models": {
            "claude-fable-5": {
              "cacheCreationInputTokens": 0,
              "cacheReadInputTokens": 0,
              "costUsd": 0.42,
              "inputTokens": 100,
              "outputTokens": 100,
              "webSearchRequests": 0,
            },
          },
        },
        "tokenId": "tok-a",
      }
    `);
  });

  it('セッションが無いまま畳んでも何も積まない（query が無い枝）', async () => {
    const stores = createMemoryStores();
    const calls = spyUsage(stores);
    const fake = flushSdk({ usage: async () => usageResponse({ a: sdkModelUsage(1) }) });
    const clone = bootFlush(stores, fake);
    await clone.stop();

    expect(calls).toEqual([]);
    expect(fake.inputs).toEqual([]);
  });

  it('畳む直前の読みが何も返さない（口が無い）無報告の provider: 畳む直前には数えない。数えるのはターンの2回（本流と畳みの蒸留）だけ', async () => {
    const stores = createMemoryStores();
    const calls = spyUsage(stores);
    const fake = flushSdk({});
    const clone = createClone({
      inboxSettleMs: 0,
      reportSettleMs: 0,
      stores,
      queryFn: fake.fn,
      env: {},
      provider: { id: 'claude', capabilities: { usage: false } },
      runners: createRunnerRegistry([
        createLocalRunner({ workspacePath: '/work', queryFn: fakeSdk().fn, env: {} }),
      ]),
    });
    await runOneTurn(clone, fake);
    await waitFor(() => calls.length >= 1, '本流のターンが無報告として数えられる');
    await clone.stop();

    expect(calls.map((c) => [c.kind, c.input['site']])).toEqual([
      ['unmetered', 'session'],
      ['unmetered', 'session'],
    ]);
  });
});
