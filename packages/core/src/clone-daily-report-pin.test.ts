import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { createClone } from './clone.js';
import { fakeSdk, flushPendingMicrotasks } from './clone-test-harness.js';
import { createLocalRunner } from './runner-local.js';
import { createRunnerRegistry } from './runner-protocol.js';
import type { Stores } from './store.js';
import { createMemoryStores } from './testing.js';

/**
 * 日報（B2。`clone.ts` の `#dailyReport`）を協力者へ切り出す前に置いた固定。今の作りの出力で通る。
 * 期待の文字列は仕様を先に書いたものではなく、今の作りの出力を生成して目で読んで確かめたものを写した
 * （既存の `clone-daily-report-lookup` は `includes`、`clone-daily-report-retry` は回数だけ。ここは全文・印・回数・枠の保持の枝を足す）。
 * 切り出しの前後でこの試験を変えない。
 */

const DATE = '2026-10-04';
const SPEND_LIMIT = "You've hit your individual spend limit for this account.";

type Row = { type: 'daily_report'; date: string; body: string; unavailable?: string };

function build(options: {
  stores?: Stores;
  failTurns?: (turnIndex: number) => boolean;
  heldTurns?: (turnIndex: number) => boolean;
  retryDelaysMs?: number[];
}) {
  const stores = options.stores ?? createMemoryStores();
  const { fn, calls } = fakeSdk(() => '今日はログイン周りを直した。', {
    resultFor: (turnIndex) =>
      options.heldTurns?.(turnIndex) === true
        ? { subtype: 'error_during_execution', text: SPEND_LIMIT }
        : options.failTurns?.(turnIndex) === true
          ? { subtype: 'error_during_execution', text: 'API の一時的な過負荷' }
          : undefined,
  });
  const clone = createClone({
    stores,
    queryFn: fn,
    env: {},
    runners: createRunnerRegistry([
      createLocalRunner({ workspacePath: '/work', queryFn: fakeSdk().fn, env: {} }),
    ]),
    ...(options.retryDelaysMs === undefined
      ? {}
      : { dailyReportRetryDelaysMs: options.retryDelaysMs }),
  } as Parameters<typeof createClone>[0]);
  return { clone, stores, calls };
}

const post = (clone: ReturnType<typeof createClone>, cause?: string): void =>
  clone.post({
    type: 'timer',
    id: `evt-timer-${DATE}-${cause ?? 'none'}-${Math.random()}`,
    at: new Date().toISOString(),
    kind: 'daily_report',
    target: DATE,
    ...(cause === undefined ? {} : { cause }),
  } as never);

const reportsOf = async (stores: Stores) =>
  (await stores.journal.list({ types: ['daily_report'] })) as Row[];

const selfTexts = async (stores: Stores): Promise<string[]> =>
  ((await stores.journal.list({ types: ['exchange'] })) as { with: string; text: string }[])
    .filter((entry) => entry.with === 'self')
    .map((entry) => entry.text)
    // 日報の2経路の行だけに絞る（同じ journal には他のターンの失敗・入力の行も並ぶ）
    .filter(
      (text) =>
        text.startsWith('[障害] 日報の既存確認') || text.includes('の日報は既に書かれているので'),
    );

const failingLookupStores = (message: string): Stores => {
  const stores = createMemoryStores();
  const rawList = stores.journal.list.bind(stores.journal);
  stores.journal.list = ((query) => {
    const only = query?.types;
    if (only?.length === 1 && only[0] === 'daily_report') return Promise.reject(new Error(message));
    return rawList(query);
  }) as Stores['journal']['list'];
  return stores;
};

const turnsOf = (calls: { inputs: string[] }[]): number =>
  calls.reduce((sum, call) => sum + call.inputs.length, 0);

async function advanceUntil(check: () => Promise<boolean> | boolean, label: string): Promise<void> {
  for (let i = 0; i < 400; i += 1) {
    if (await check()) return;
    await vi.advanceTimersByTimeAsync(5);
  }
  throw new Error(`起きなかった: ${label}`);
}

describe('クローン — 日報の日誌の行（全文）', () => {
  beforeEach(() => {
    vi.useFakeTimers();
  });
  afterEach(() => {
    vi.useRealTimers();
  });

  it('既に書かれている日は走らせず、decision の行を全文で書く（契機: schedule）', async () => {
    const stores = createMemoryStores();
    await stores.journal.append({ type: 'daily_report', date: DATE, body: '道具で書いた日報' });
    const s = build({ stores });
    post(s.clone);
    await advanceUntil(async () => (await selfTexts(stores)).length >= 1, 'decision の行');
    await s.clone.stop();

    expect(s.calls).toHaveLength(0);
    expect(await selfTexts(stores)).toEqual([
      '[判断] 2026-10-04 の日報は既に書かれているので、日報のターンを走らせなかった（契機: schedule）',
    ]);
  });

  it('既存確認で日誌を読めなかった回の failure の行: ターンが成功した回（全文）', async () => {
    const stores = failingLookupStores('connection reset by peer\nsecond-line');
    const s = build({ stores });
    post(s.clone);
    await advanceUntil(async () => (await selfTexts(stores)).length >= 1, 'failure の行');
    await s.clone.stop();

    expect(await selfTexts(stores)).toEqual([
      '[障害] 日報の既存確認（2026-10-04）で日誌を読めなかった（理由: Error: connection reset by peer）。この日の日報が既にあるか確かめられないまま書いた。同じ日に日報が2本あるならこの回の重複（消さずに日誌から辿ること）。',
    ]);
  });

  it('既存確認で日誌を読めなかった回の failure の行: ターンが失敗した回（全文）', async () => {
    const stores = failingLookupStores('lookup timed out');
    const s = build({ stores, failTurns: () => true });
    post(s.clone);
    await advanceUntil(async () => (await selfTexts(stores)).length >= 1, 'failure の行');
    await s.clone.stop();

    expect(await selfTexts(stores)).toEqual([
      '[障害] 日報の既存確認（2026-10-04）で日誌を読めなかった（理由: Error: lookup timed out）。この日の日報が既にあるか確かめられなかったので、「作れなかった」の印は書かなかった。',
    ]);
  });
});

describe('クローン — 日報の失敗の印と作り直しの回数', () => {
  beforeEach(() => {
    vi.useFakeTimers();
  });
  afterEach(() => {
    vi.useRealTimers();
  });

  it('失敗の回の印は、その日の日報の行が1件も無いときだけ書く（既に印がある日には積まない）', async () => {
    const stores = createMemoryStores();
    await stores.journal.append({
      type: 'daily_report',
      date: DATE,
      body: '（この日の日報は作れなかった）',
      unavailable: '前の回の理由',
    });
    const s = build({ stores, failTurns: () => true });
    post(s.clone);
    await advanceUntil(() => turnsOf(s.calls) >= 1, '日報のターンが失敗する');
    await flushPendingMicrotasks();
    await s.clone.stop();

    const rows = await reportsOf(stores);
    expect(rows).toHaveLength(1);
    expect(rows[0]?.unavailable).toBe('前の回の理由');
  });

  it('印の文面は、書けなかった理由（SDK の文言）を置いた全文で、unavailable に同じ理由を持つ', async () => {
    const s = build({ failTurns: () => true });
    post(s.clone);
    await advanceUntil(async () => (await reportsOf(s.stores)).length >= 1, '印が書かれる');
    await s.clone.stop();

    const rows = await reportsOf(s.stores);
    expect(rows).toHaveLength(1);
    expect(rows[0]?.body).toBe(
      '（この日の日報は作れなかった。日誌から直接辿ること。理由: 結果なしで終了: error_during_execution（result_subtype） / API の一時的な過負荷）',
    );
    expect(rows[0]?.unavailable).toBe(
      '結果なしで終了: error_during_execution（result_subtype） / API の一時的な過負荷',
    );
  });

  it('作り直しは間隔の本数で止まる: 間隔 [10, 10] なら初回 + 2 回の 3 ターンで、印は1件のまま', async () => {
    const s = build({ failTurns: () => true, retryDelaysMs: [10, 10] });
    post(s.clone);
    await advanceUntil(() => turnsOf(s.calls) >= 3, '初回 + 2 回');
    await vi.advanceTimersByTimeAsync(500);
    expect(turnsOf(s.calls)).toBe(3);
    expect(await reportsOf(s.stores)).toHaveLength(1);
    await s.clone.stop();
  });

  it('作り直しの間隔は順に使う: 1 回目は 100ms、2 回目は 1000ms 後', async () => {
    const s = build({ failTurns: () => true, retryDelaysMs: [100, 1000] });
    post(s.clone);
    await advanceUntil(() => turnsOf(s.calls) >= 1, '初回');
    await flushPendingMicrotasks();
    await vi.advanceTimersByTimeAsync(90);
    expect(turnsOf(s.calls)).toBe(1);
    await advanceUntil(() => turnsOf(s.calls) >= 2, '1 回目の作り直し');
    await flushPendingMicrotasks();
    await vi.advanceTimersByTimeAsync(900);
    expect(turnsOf(s.calls)).toBe(2);
    await advanceUntil(() => turnsOf(s.calls) >= 3, '2 回目の作り直し');
    await s.clone.stop();
  });

  it('作り直しが途中で成功したら、そこで止まる（本物の日報が1件・印が1件・以後ターンは増えない）', async () => {
    const s = build({ failTurns: (turn) => turn < 2, retryDelaysMs: [10, 10, 10, 10] });
    post(s.clone);
    await advanceUntil(
      async () => (await reportsOf(s.stores)).some((r) => r.unavailable === undefined),
      '3 ターン目で本物が書かれる',
    );
    await vi.advanceTimersByTimeAsync(500);
    expect(turnsOf(s.calls)).toBe(3);
    const rows = await reportsOf(s.stores);
    expect(rows.filter((r) => r.unavailable !== undefined)).toHaveLength(1);
    expect(rows.filter((r) => r.unavailable === undefined)).toHaveLength(1);
    await s.clone.stop();
  });

  it('枠で保持した回は、印も書かず作り直しの timer も仕掛けずに引き下がる', async () => {
    const s = build({ heldTurns: () => true, retryDelaysMs: [10, 10] });
    post(s.clone);
    await advanceUntil(() => s.clone.usageBlocked, '枠で保持される');
    await flushPendingMicrotasks();
    const timers = vi.getTimerCount();
    await vi.advanceTimersByTimeAsync(500);
    expect(turnsOf(s.calls)).toBe(1);
    expect(await reportsOf(s.stores)).toEqual([]);
    expect(timers).toBe(vi.getTimerCount());
    await s.clone.stop();
  });
});
