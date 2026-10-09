import { describe, expect, it } from 'vitest';

import { JOURNAL_SCAN_PAGE_SIZE, scanJournalPages } from './journal-scan.js';
import { createSyntheticJournalStore } from './journal-scan.test-support.js';
import { JournalAnchorNotFoundError } from './store.js';
import type { JournalStore } from './store.js';

describe('scanJournalPages', () => {
  function threeEntries() {
    return createSyntheticJournalStore({
      total: 3,
      entryAt: (index) => ({
        type: 'decision',
        decision: `decision-${index}`,
        grounds: 'test',
      }),
    });
  }

  it('ページの大きさぶんずつ list() を呼び、全件を onPage へ渡す', async () => {
    const total = JOURNAL_SCAN_PAGE_SIZE * 2 + 3;
    const fake = createSyntheticJournalStore({
      total,
      entryAt: (index) => ({ type: 'decision', decision: `d-${index}`, grounds: 'g' }),
    });
    const seen: string[] = [];
    const result = await scanJournalPages(fake.store, {}, (page) => {
      for (const entry of page) {
        if (entry.type === 'decision') seen.push(entry.decision);
      }
    });

    expect(result).toEqual({ scanned: total, truncated: false });
    expect(seen).toHaveLength(total);
    expect(seen[0]).toBe('d-0');
    expect(seen.at(-1)).toBe(`d-${total - 1}`);
    expect(fake.calls).toHaveLength(3);
  });

  it('渡す limit は常に有限の正の整数である（undefined にも MAX_SAFE_INTEGER にもならない）', async () => {
    const fake = createSyntheticJournalStore({
      total: JOURNAL_SCAN_PAGE_SIZE * 3,
      entryAt: (index) => ({ type: 'decision', decision: `d-${index}`, grounds: 'g' }),
    });
    await scanJournalPages(fake.store, {}, () => {});
    expect(fake.calls.length).toBeGreaterThan(0);
    for (const call of fake.calls) {
      expect(call.limit).toBeDefined();
      expect(Number.isFinite(call.limit)).toBe(true);
      expect(call.limit).toBeGreaterThan(0);
      expect(call.limit).toBeLessThanOrEqual(JOURNAL_SCAN_PAGE_SIZE);
    }
  });

  it('maxScanned に達したら truncated: true で止まり、それ以上 list() を呼ばない', async () => {
    const fake = createSyntheticJournalStore({
      total: 10_000,
      entryAt: (index) => ({ type: 'decision', decision: `d-${index}`, grounds: 'g' }),
    });
    const result = await scanJournalPages(fake.store, {}, () => {}, {
      pageSize: 100,
      maxScanned: 250,
    });

    expect(result).toEqual({ scanned: 250, truncated: true });
    expect(fake.totalReturned).toBe(250);
    expect(fake.calls).toHaveLength(3);
  });

  it('onPage が false を返すと、そこで止まり truncated: false のまま終わる（早期終了と打ち切りを混同しない）', async () => {
    const fake = createSyntheticJournalStore({
      total: 10_000,
      entryAt: (index) => ({ type: 'decision', decision: `d-${index}`, grounds: 'g' }),
    });
    let pages = 0;
    const result = await scanJournalPages(
      fake.store,
      {},
      () => {
        pages += 1;
        return false;
      },
      { pageSize: 100, maxScanned: 5_000 },
    );

    expect(pages).toBe(1);
    expect(result).toEqual({ scanned: 100, truncated: false });
  });

  describe('短いページは終端ではない（Issue #2494）', () => {
    function droppingStore(total: number, broken: ReadonlySet<number>) {
      const inner = createSyntheticJournalStore({
        total,
        entryAt: (index) => ({ type: 'decision', decision: `d-${index}`, grounds: 'g' }),
        unreadable: (index) => broken.has(index),
      });
      const store: Pick<JournalStore, 'listPage'> = inner.store;
      return { store, inner };
    }

    it('(a) 短いページの後にも行があれば、読み続けて全件を見る', async () => {
      const { store } = droppingStore(10, new Set([1, 5]));
      const seen: string[] = [];
      const result = await scanJournalPages(
        store,
        {},
        (page) => {
          for (const e of page) seen.push(e.id);
        },
        { pageSize: 4 },
      );
      expect(seen).toHaveLength(8);
      expect(result).toEqual({ scanned: 8, truncated: false });
    });

    it('(b) store が続きは無いと言えば、1ページで止まり truncated: false になる', async () => {
      const { store, inner } = droppingStore(4, new Set([1]));
      const result = await scanJournalPages(store, {}, () => {}, { pageSize: 4 });
      expect(result).toEqual({ scanned: 3, truncated: false });
      expect(inner.calls).toHaveLength(1);
    });

    it('(d) ページが丸ごと読めなくても、その先の古い行を見る（Issue #2605）', async () => {
      const { store } = droppingStore(12, new Set([4, 5, 6, 7]));
      const seen: string[] = [];
      const result = await scanJournalPages(
        store,
        {},
        (page) => {
          expect(page.length).toBeGreaterThan(0);
          for (const e of page) seen.push(e.id);
        },
        { pageSize: 4 },
      );
      expect(seen).toHaveLength(8);
      expect(seen).toContain('synthetic-000000000011');
      expect(result).toEqual({ scanned: 8, truncated: false });
    });

    it('(e) 末尾の読めない行だけの区間も、終端として終わる（無限に読まない）', async () => {
      const { store } = droppingStore(8, new Set([4, 5, 6, 7]));
      const result = await scanJournalPages(store, {}, () => {}, { pageSize: 4 });
      expect(result).toEqual({ scanned: 4, truncated: false });
    });

    it('(c) maxScanned の打ち切りは truncated: true のまま', async () => {
      const { store } = droppingStore(100, new Set([1]));
      const result = await scanJournalPages(store, {}, () => {}, { pageSize: 4, maxScanned: 6 });
      expect(result.truncated).toBe(true);
      expect(result.scanned).toBe(6);
    });
  });

  it('空ページで自然終端する（total が0件）', async () => {
    const fake = createSyntheticJournalStore({
      total: 0,
      entryAt: () => ({ type: 'decision', decision: 'unreachable', grounds: 'g' }),
    });
    const result = await scanJournalPages(fake.store, {}, () => {});
    expect(result).toEqual({ scanned: 0, truncated: false });
    expect(fake.calls).toHaveLength(1);
  });

  it('maxScanned: 0 は list() を1度も呼ばずに打ち切ったと返す', async () => {
    const fake = threeEntries();
    const result = await scanJournalPages(fake.store, {}, () => {}, { maxScanned: 0 });
    expect(result).toEqual({ scanned: 0, truncated: true });
    expect(fake.calls).toHaveLength(0);
  });

  it('order: asc と after を渡すと、指定した錨の直後（新しい側）から古い順とは逆に進む', async () => {
    const fake = createSyntheticJournalStore({
      total: 5,
      entryAt: (index) => ({ type: 'decision', decision: `d-${index}`, grounds: 'g' }),
    });
    const anchor = fake.entryOf(3);
    const seen: string[] = [];
    await scanJournalPages(
      fake.store,
      { order: 'asc', after: { id: anchor.id, at: anchor.at } },
      (page) => {
        for (const entry of page) if (entry.type === 'decision') seen.push(entry.decision);
      },
    );
    expect(seen).toEqual(['d-2', 'd-1', 'd-0']);
  });

  it('見つからない錨は JournalAnchorNotFoundError を投げる（黙って先頭からに倒さない）', async () => {
    const fake = threeEntries();
    await expect(
      scanJournalPages(
        fake.store,
        { after: { id: 'synthetic-999999999999', at: '2020-01-01T00:00:00.000Z' } },
        () => {},
      ),
    ).rejects.toThrow(JournalAnchorNotFoundError);
  });

  it('pageSize に0以下や非整数を渡すと投げる', async () => {
    const fake = threeEntries();
    await expect(scanJournalPages(fake.store, {}, () => {}, { pageSize: 0 })).rejects.toThrow();
    await expect(scanJournalPages(fake.store, {}, () => {}, { pageSize: -1 })).rejects.toThrow();
    await expect(scanJournalPages(fake.store, {}, () => {}, { pageSize: 1.5 })).rejects.toThrow();
  });
});

describe('createSyntheticJournalStore の oldestAt', () => {
  const entryAt = (index: number) => ({
    type: 'decision' as const,
    decision: `d-${index}`,
    grounds: 'g',
  });

  it('総数 0 なら null', async () => {
    const fake = createSyntheticJournalStore({ total: 0, entryAt });
    expect(await fake.store.oldestAt()).toBeNull();
  });

  it('最古の行（index が最大）の at を返す', async () => {
    const fake = createSyntheticJournalStore({ total: 5, entryAt });
    expect(await fake.store.oldestAt()).toBe(fake.entryOf(4).at);
  });

  it('最古の行が読めない行でも、その at を返す（pg は読めない行も数える）', async () => {
    const fake = createSyntheticJournalStore({
      total: 5,
      entryAt,
      unreadable: (index) => index === 4,
    });
    expect(await fake.store.oldestAt()).toBe(fake.entryOf(4).at);
  });
});
