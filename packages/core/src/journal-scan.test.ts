import { describe, expect, it } from 'vitest';

import { JOURNAL_SCAN_PAGE_SIZE, scanJournalPages } from './journal-scan.js';
import { createSyntheticJournalStore } from './journal-scan.test-support.js';
import { JournalAnchorNotFoundError } from './store.js';
import type { JournalStore } from './store.js';

/**
 * `scanJournalPages` そのものの単体の歯。
 *
 * ⚠️ **この足場（`journal-scan.ts`）は、先に実装してから歯を書いた。** 依頼
 * された「先にテストだけを書いて赤を取る」の手順を、この1ファイルについては
 * 守れていない——`digest.ts` / `distill-gap.ts` 側の書き換えに先立って共通の
 * 足場から組み立てたところ、テストより先に実装が固まった。**赤→緑の証拠が
 * 要る本体（OOM を直したことの歯）は `digest.test.ts` / `distill-gap.test.ts`
 * 側にあり、そちらは本当に先にテストを書いて赤を取っている**（両ファイルの
 * 冒頭のコメントを参照）。ここは実装ができた後に足した、通常の単体の歯である。
 */
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
    // 新しい順（index 昇順）で届く——`order` 未指定の既定は `desc`。
    expect(seen[0]).toBe('d-0');
    expect(seen.at(-1)).toBe(`d-${total - 1}`);
    // 3ページ（500 + 500 + 3）。終端は store が言う（`next: null`）ので、空のページを
    // 確かめに行く往復は無い。
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
    // 100 + 100 + 50 の3回で 250 に達して止まる。
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
    /** SQL の LIMIT の後で壊れた行を捨てる store（pg の日誌の list と同じ形）の偽物。 */
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
      // 空ページを確かめに行く往復は要らない（store が next: null を返す）。
      expect(inner.calls).toHaveLength(1);
    });

    it('(d) ページが丸ごと読めなくても、その先の古い行を見る（Issue #2605）', async () => {
      // pageSize 4 の 2 ページ目（index 4..7）が全部読めない。
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
      // 0..3 と 8..11。空ページで「探し切った」と言って 8..11 を取りこぼさない。
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
    // index 3 を錨にする（`id`/`at` は偽物の `entryOf` から取る——本番の
    // 呼び出し側も「直前に自分が受け取った行」を錨にするのと同じ形）。
    const anchor = fake.entryOf(3);
    const seen: string[] = [];
    await scanJournalPages(
      fake.store,
      { order: 'asc', after: { id: anchor.id, at: anchor.at } },
      (page) => {
        for (const entry of page) if (entry.type === 'decision') seen.push(entry.decision);
      },
    );
    // 錨（index 3）より新しい側 = index 2, 1, 0 を古い→新しい順に返す。
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
