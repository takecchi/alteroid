import { describe, expect, it } from 'vitest';

import { JOURNAL_SCAN_PAGE_SIZE, scanJournalPages } from './journal-scan.js';
import { createSyntheticJournalStore } from './journal-scan.test-support.js';
import { JournalAnchorNotFoundError } from './store.js';

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
    // 3ページ（500 + 500 + 3）——最後は短いページで自然終端する。
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
