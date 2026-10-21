import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import type { Stores } from './store.js';
import { createMemoryStores } from './testing.js';
import { createCloneTools } from './tools.js';

const DAY = 24 * 60 * 60 * 1000;
const NOW = Date.parse('2026-10-21T00:00:00.000Z');

function steppingClock(step: number): () => number {
  let t = 0;
  return () => {
    t += step;
    return t;
  };
}

function call(stores: Stores, clock: () => number) {
  const list = createCloneTools({
    stores,
    emit: () => undefined,
    memoryCause: () => 'clone',
    conversationId: () => undefined,
    journalSearch: { now: () => new Date(NOW), clock, budgetMs: 8_000 },
  });
  return async (args: Record<string, unknown>): Promise<string> => {
    const found = list.find((entry) => entry.name === 'journal_read');
    if (!found) throw new Error('道具 journal_read が無い');
    const result = (await found.handler(args as never, {} as never)) as {
      content: { text: string }[];
    };
    return result.content.map((part) => part.text).join('');
  };
}

async function appendAt(stores: Stores, at: number, text: string): Promise<void> {
  vi.setSystemTime(new Date(at));
  await stores.journal.append({ type: 'exchange', with: 'human', role: 'inbound', text });
}

beforeEach(() => {
  vi.useFakeTimers({ toFake: ['Date'] });
});

afterEach(() => {
  vi.useRealTimers();
});

describe('journal_read — 語の検索を予算で打ち切ったときの名乗り（#5126）', () => {
  it('⭐ 0件で打ち切ったら、最初の行で「この窓には無い（判定できない）」と未探索の範囲・続きの打ち方を名乗り、「無い」と言い切らない', async () => {
    const stores = createMemoryStores();
    await appendAt(stores, NOW - 5 * DAY, 'ふくろう 窓より古い');
    await appendAt(stores, NOW - 1000, '当たらない行');

    const reply = await call(stores, steppingClock(10_000))({ q: 'ふくろう' });

    const [firstLine] = reply.split('\n');
    expect(firstLine).toContain(
      `"ふくろう" は、この窓（${new Date(NOW - DAY).toISOString()} 〜 ${new Date(NOW).toISOString()}）には無い（判定できない）。`,
    );
    expect(firstLine).toContain('時間の予算（8 秒）を使い切り、それより古い側は見ていない');
    expect(firstLine).toContain(
      `journal_read q="ふくろう" until=${new Date(NOW - DAY - 1).toISOString()}`,
    );
    expect(reply).not.toContain('に当たる日誌は無い');
  });

  it('当たりがあって打ち切ったときも、最初の行に未探索の範囲を出す', async () => {
    const stores = createMemoryStores();
    await appendAt(stores, NOW - 5 * DAY, 'ふくろう 窓より古い');
    await appendAt(stores, NOW - 1000, 'ふくろう 新しい');

    const reply = await call(stores, steppingClock(10_000))({ q: 'ふくろう' });

    const [firstLine] = reply.split('\n');
    expect(firstLine).toContain('時間の予算（8 秒）を使い切った');
    expect(firstLine).toContain(`journal_read until=${new Date(NOW - DAY - 1).toISOString()}`);
    expect(reply).toContain('ふくろう 新しい');
    expect(reply).not.toContain('ふくろう 窓より古い');
  });

  it('予算の内で探し切った0件は、日誌の先頭まで探したと名乗る', async () => {
    const stores = createMemoryStores();
    await appendAt(stores, NOW - 5 * DAY, '当たらない古い行');
    await appendAt(stores, NOW - 1000, '当たらない行');

    const reply = await call(stores, () => 0)({ q: 'ふくろう' });

    expect(reply).toContain('"ふくろう" に当たる日誌は無い（この条件の中では）');
    expect(reply).toContain('（日誌の先頭まで探した）');
  });

  it('since を渡して探し切った0件は、since まで探したと名乗る', async () => {
    const stores = createMemoryStores();
    await appendAt(stores, NOW - 1000, '当たらない行');
    const since = new Date(NOW - 2 * DAY).toISOString();

    const reply = await call(stores, () => 0)({ q: 'ふくろう', since });

    expect(reply).toContain(`（since=${since} まで探した。それより古い側は見ていない）`);
  });
});
