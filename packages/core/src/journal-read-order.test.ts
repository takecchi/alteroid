import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import type { Stores } from './store.js';
import { createSyntheticJournalStore } from './journal-scan.test-support.js';
import { createMemoryStores } from './testing.js';
import { createCloneTools } from './tools.js';

function call(stores: Stores) {
  const list = createCloneTools({
    stores,
    emit: () => undefined,
    memoryCause: () => 'clone',
    conversationId: () => undefined,
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

function readCursor(reply: string): { afterId: string; afterAt: string } | null {
  const match = /続きは journal_read afterId=(\S+) afterAt=(\S+)/.exec(reply);
  return match === null ? null : { afterId: match[1]!, afterAt: match[2]! };
}

const HOUR = 60 * 60 * 1000;
const BASE = Date.parse('2026-10-01T00:00:00.000Z');

// 判断-0 が最古、判断-(count-1) が最新。1時間おきに積む
async function appendDecisions(stores: Stores, count: number): Promise<void> {
  for (let i = 0; i < count; i += 1) {
    vi.setSystemTime(new Date(BASE + i * HOUR));
    await stores.journal.append({ type: 'decision', decision: `判断-${i}`, grounds: '記憶' });
  }
}

function idsIn(reply: string): string[] {
  return [...reply.matchAll(/判断-(\d+)/g)].map((match) => match[1]!);
}

beforeEach(() => {
  vi.useFakeTimers({ toFake: ['Date'] });
});

afterEach(() => {
  vi.useRealTimers();
});

describe('journal_read — order', () => {
  it('order を渡さない呼びは新しい順のままで、order=desc と同じ応答になる', async () => {
    const stores = createMemoryStores();
    await appendDecisions(stores, 4);
    const read = call(stores);

    const omitted = await read({});
    const explicit = await read({ order: 'desc' });

    expect(idsIn(omitted)).toEqual(['3', '2', '1', '0']);
    expect(explicit).toBe(omitted);
  });

  it('order=asc は古い順に返す', async () => {
    const stores = createMemoryStores();
    await appendDecisions(stores, 4);

    const reply = await call(stores)({ order: 'asc' });

    expect(idsIn(reply)).toEqual(['0', '1', '2', '3']);
  });

  it('order=asc と q は組めず、日誌を読まずに断る。order=desc の q と q=（空）の asc は今までどおり読む', async () => {
    const stores = createMemoryStores();
    await appendDecisions(stores, 3);
    const read = call(stores);

    const refused = await read({ order: 'asc', q: '判断' });
    expect(refused).toContain('q は新しい側から遡る検索で、order=asc とは合わない');
    expect(refused).toContain('since / until で窓を閉じること');
    expect(refused).toContain('日誌は読んでいない');
    expect(refused).not.toContain('判断-0');

    expect(idsIn(await read({ order: 'desc', q: '判断' }))).toEqual(['2', '1', '0']);
    expect(idsIn(await read({ order: 'asc', q: '' }))).toEqual(['0', '1', '2']);
  });

  it('order=asc の続きの案内は order=asc を名乗り、afterId / afterAt / order を渡すと次の頁が重複・欠けなく取れる', async () => {
    const stores = createMemoryStores();
    await appendDecisions(stores, 5);
    const read = call(stores);

    const first = await read({ order: 'asc', limit: 2 });
    expect(idsIn(first)).toEqual(['0', '1']);
    expect(first).toMatch(/続きは journal_read afterId=\S+ afterAt=\S+ order=asc /);
    const second = await read({ order: 'asc', limit: 2, ...readCursor(first)! });
    expect(idsIn(second)).toEqual(['2', '3']);
    const third = await read({ order: 'asc', limit: 2, ...readCursor(second)! });
    expect(idsIn(third)).toEqual(['4']);
    expect(readCursor(third)).toBeNull();
  });

  it('desc の続きの案内は今までどおりで、order を名乗らない', async () => {
    const stores = createMemoryStores();
    await appendDecisions(stores, 3);

    const first = await call(stores)({ limit: 2 });

    expect(first).toContain('続きは journal_read afterId=');
    expect(first).not.toContain('order=');
  });

  it('asc で最新の行より先を読むと、「古い側」ではなく「新しい側に行は無い」と言う', async () => {
    const stores = createMemoryStores();
    await appendDecisions(stores, 2);
    const read = call(stores);
    const newest = (await stores.journal.list({ limit: 1 }))[0]!;

    const reply = await read({ order: 'asc', afterId: newest.id, afterAt: newest.at });

    expect(reply).toContain('この位置より先（新しい側）に日誌の行は無い');
    expect(reply).not.toContain('古い側');
  });

  it('asc で予算が行を省略したとき、古い順に出したと言い、表示した最後の行を続きにして読み継ぐと全件が順に揃う', async () => {
    const stores = createMemoryStores();
    for (let i = 0; i < 100; i += 1) {
      vi.setSystemTime(new Date(BASE + i * HOUR));
      await stores.journal.append({
        type: 'exchange',
        with: 'manager',
        role: 'inbound',
        text: `[mgr-${i}] ${'長い報告本文。'.repeat(120)}`,
      });
    }
    const read = call(stores);

    const seen: string[] = [];
    let args: Record<string, unknown> = { order: 'asc', limit: 100 };
    let omittedSeen = false;
    for (let page = 0; page < 20; page += 1) {
      const reply = await read(args);
      if (reply.includes('件は省略')) {
        omittedSeen = true;
        expect(reply).toContain('古い順に');
        expect(reply).not.toContain('新しい順に');
      }
      seen.push(...[...reply.matchAll(/\[mgr-(\d+)\]/g)].map((match) => match[1]!));
      const cursor = readCursor(reply);
      if (cursor === null) break;
      expect(reply).toContain(`afterAt=${cursor.afterAt} order=asc`);
      args = { order: 'asc', limit: 100, ...cursor };
    }

    expect(omittedSeen).toBe(true);
    expect(seen).toEqual(Array.from({ length: 100 }, (_, i) => String(i)));
  });

  it('desc で予算が行を省略したときの文言は今までどおり「新しい順に」', async () => {
    const stores = createMemoryStores();
    for (let i = 0; i < 100; i += 1) {
      await stores.journal.append({
        type: 'exchange',
        with: 'manager',
        role: 'inbound',
        text: `[mgr-${i}] ${'長い報告本文。'.repeat(120)}`,
      });
    }

    const reply = await call(stores)({ limit: 100 });

    expect(reply).toMatch(
      /…ほか \d+ 件は省略（この条件で \d+ 件あり、新しい順に \d+ 件だけ出した）。/,
    );
    expect(reply).not.toContain('order=');
  });

  it('asc で頁が読めない行だけのとき、「新しい側」に行が在ると言い、order=asc 付きの続きで先へ進める', async () => {
    const synthetic = createSyntheticJournalStore({
      total: 10,
      entryAt: (index) => ({
        type: 'decision',
        decision: `判断-${String(index).padStart(2, '0')}`,
        grounds: '記憶',
      }),
      // 合成ストアは index が大きいほど古い（index 0 が最新）。asc の最初の頁（古い側の 3 行）を読めなくする
      unreadable: (index) => index >= 7,
    });
    const read = call({ ...createMemoryStores(), journal: synthetic.store });

    const first = await read({ order: 'asc', limit: 3 });
    expect(first).toContain('読めない形の行だけだった');
    expect(first).toContain('さらに新しい側');
    expect(first).not.toContain('さらに古い側');
    const cursor = readCursor(first);
    expect(cursor).not.toBeNull();
    expect(first).toContain('order=asc');

    const second = await read({ order: 'asc', limit: 3, ...cursor! });
    expect(idsIn(second)).toEqual(['06', '05', '04']);
  });

  it('since / until と組むと、窓の中だけが古い順に返る', async () => {
    const stores = createMemoryStores();
    await appendDecisions(stores, 6);
    const read = call(stores);

    const reply = await read({
      order: 'asc',
      since: new Date(BASE + 1 * HOUR).toISOString(),
      until: new Date(BASE + 4 * HOUR).toISOString(),
    });

    expect(idsIn(reply)).toEqual(['1', '2', '3', '4']);
  });

  it('since と組んだ asc の続きも、窓を保ったまま次の頁を返す', async () => {
    const stores = createMemoryStores();
    await appendDecisions(stores, 6);
    const read = call(stores);
    const window = {
      since: new Date(BASE + 1 * HOUR).toISOString(),
      until: new Date(BASE + 4 * HOUR).toISOString(),
    };

    const first = await read({ order: 'asc', limit: 2, ...window });
    const second = await read({ order: 'asc', limit: 2, ...window, ...readCursor(first)! });

    expect(idsIn(first)).toEqual(['1', '2']);
    expect(idsIn(second)).toEqual(['3', '4']);
  });
});
