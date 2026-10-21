import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { searchJournalBackwardInSlices } from './journal-sliced-search.js';
import type { Stores } from './store.js';
import { createMemoryStores } from './testing.js';

const DAY = 24 * 60 * 60 * 1000;
const NOW = Date.parse('2026-10-21T00:00:00.000Z');

async function appendAt(stores: Stores, at: number, text: string): Promise<string> {
  vi.setSystemTime(new Date(at));
  const entry = await stores.journal.append({
    type: 'exchange',
    with: 'human',
    role: 'inbound',
    text,
  });
  return entry.id;
}

// 呼ぶたびに step ms 進む時計: 窓を1つ終えるたびに予算を見るので、窓の数で打ち切りを決められる
function steppingClock(step: number): () => number {
  let t = 0;
  return () => {
    t += step;
    return t;
  };
}

beforeEach(() => {
  vi.useFakeTimers({ toFake: ['Date'] });
});

afterEach(() => {
  vi.useRealTimers();
});

describe('searchJournalBackwardInSlices — 語の検索を窓で区切って遡る（#5126）', () => {
  it('⭐ 予算の内なら、窓をまたいだ当たりを新しい順に全部返し、先頭まで探し切ったと言う', async () => {
    const stores = createMemoryStores();
    const old = await appendAt(stores, NOW - 4 * DAY - 1000, 'ふくろう 古い');
    await appendAt(stores, NOW - 2 * DAY, '当たらない行');
    const recent = await appendAt(stores, NOW - 1000, 'ふくろう 新しい');

    const result = await searchJournalBackwardInSlices(
      stores.journal,
      { q: 'ふくろう', limit: 20 },
      { now: () => new Date(NOW), clock: () => 0 },
    );

    expect(result.entries.map((entry) => entry.id)).toEqual([recent, old]);
    expect(result.coverage).toEqual({ kind: 'complete' });
    expect(result.next).toBeNull();
  });

  it('⭐ 予算を使い切ったら打ち切り、探した範囲（from〜to）を返す', async () => {
    const stores = createMemoryStores();
    await appendAt(stores, NOW - 5 * DAY, 'ふくろう 古すぎて届かない');
    await appendAt(stores, NOW - 1000, '当たらない行');

    const result = await searchJournalBackwardInSlices(
      stores.journal,
      { q: 'ふくろう', limit: 20 },
      { now: () => new Date(NOW), clock: steppingClock(5_000), budgetMs: 8_000 },
    );

    // 時計は呼ぶたびに 5 秒進む: 始め 5 秒、1つ目の窓の後 10 秒（使ったのは 5 秒で予算の内）、2つ目の窓の後 15 秒（10 秒で使い切り）。
    // 2つ目の窓は、1つ目の下端の 1ms 手前から1日ぶんなので、下端は NOW - 2日 - 1ms
    expect(result.entries).toEqual([]);
    expect(result.coverage).toEqual({
      kind: 'budget',
      from: new Date(NOW - 2 * DAY - 1).toISOString(),
      to: new Date(NOW).toISOString(),
    });
  });

  it('窓の境目ちょうどの行を二重に返さない', async () => {
    const stores = createMemoryStores();
    const edge = await appendAt(stores, NOW - DAY, 'ふくろう 境目');
    await appendAt(stores, NOW - 3 * DAY, '最古の行');

    const result = await searchJournalBackwardInSlices(
      stores.journal,
      { q: 'ふくろう', limit: 20 },
      { now: () => new Date(NOW), clock: () => 0 },
    );

    expect(result.entries.map((entry) => entry.id)).toEqual([edge]);
  });

  it('件数が埋まったら、続きの位置（最後に返した行）を返す', async () => {
    const stores = createMemoryStores();
    await appendAt(stores, NOW - 3 * DAY, 'ふくろう 3');
    const second = await appendAt(stores, NOW - 2 * DAY, 'ふくろう 2');
    const first = await appendAt(stores, NOW - DAY / 2, 'ふくろう 1');

    const result = await searchJournalBackwardInSlices(
      stores.journal,
      { q: 'ふくろう', limit: 2 },
      { now: () => new Date(NOW), clock: () => 0 },
    );

    expect(result.entries.map((entry) => entry.id)).toEqual([first, second]);
    expect(result.next?.id).toBe(second);
  });

  it('since を渡されたら、そこより古い側へは進まずに探し切ったと言う', async () => {
    const stores = createMemoryStores();
    await appendAt(stores, NOW - 5 * DAY, 'ふくろう since より古い');
    const inside = await appendAt(stores, NOW - DAY - 1000, 'ふくろう since の内');

    const result = await searchJournalBackwardInSlices(
      stores.journal,
      { q: 'ふくろう', limit: 20, since: new Date(NOW - 2 * DAY).toISOString() },
      { now: () => new Date(NOW), clock: () => 0 },
    );

    expect(result.entries.map((entry) => entry.id)).toEqual([inside]);
    expect(result.coverage).toEqual({ kind: 'complete' });
  });

  it('続きの位置（after）から、より古い側を窓で遡る', async () => {
    const stores = createMemoryStores();
    const older = await appendAt(stores, NOW - 3 * DAY, 'ふくろう 古い');
    const anchorId = await appendAt(stores, NOW - DAY / 2, 'ふくろう 錨');
    await appendAt(stores, NOW - 1000, 'ふくろう 新しい');
    const anchor = await stores.journal.get(anchorId);
    if (anchor === null) throw new Error('錨が無い');

    const result = await searchJournalBackwardInSlices(
      stores.journal,
      { q: 'ふくろう', limit: 20, after: { id: anchor.id, at: anchor.at } },
      { now: () => new Date(NOW), clock: () => 0 },
    );

    expect(result.entries.map((entry) => entry.id)).toEqual([older]);
  });
});
