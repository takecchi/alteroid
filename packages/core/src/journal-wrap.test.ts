import { describe, expect, it, vi } from 'vitest';

import { stampingJournal } from './approval-trace.js';
import { wrapJournalStore } from './journal-wrap.js';
import type { JournalStore } from './store.js';
import { createMemoryStores } from './testing.js';

// pg の器と同じく、口が private な欄を読むクラス: 包みが `this` を中身へ束ねないと、呼んだ時点で TypeError になる
class PrivateFieldStore {
  readonly #ids = ['conv-a', 'conv-b'];
  readonly appended: unknown[] = [];

  conversationIdsWithPrefix(query: { prefix: string; limit: number }): Promise<string[]> {
    return Promise.resolve(this.#ids.filter((id) => id.startsWith(query.prefix)));
  }

  // 型（`JournalStore`）にまだ無い、これから足す口の代わり
  futurePort(): string {
    return `ids:${String(this.#ids.length)}`;
  }

  append(entry: unknown): Promise<unknown> {
    this.appended.push(entry);
    return Promise.resolve(entry);
  }
}

describe('日誌の器の包み（wrapJournalStore, #5140）', () => {
  it('差し替えない口は、型にまだ無い口も含めて、中身の this のまま中身へ届く', async () => {
    const inner = new PrivateFieldStore();
    const wrapped = wrapJournalStore(inner as unknown as JournalStore, {});

    expect(await wrapped.conversationIdsWithPrefix?.({ prefix: 'conv-a', limit: 5 })).toEqual([
      'conv-a',
    ]);
    expect((wrapped as unknown as PrivateFieldStore).futurePort()).toBe('ids:2');
  });

  it('差し替えた口だけが差し替わり、中身の同じ口は呼ばれない', async () => {
    const inner = new PrivateFieldStore();
    const append = vi.fn(() => Promise.resolve('replaced'));
    const wrapped = wrapJournalStore(inner as unknown as JournalStore, {
      append: append as unknown as JournalStore['append'],
    });

    expect(await wrapped.append({ type: 'decision', decision: 'd', grounds: 'g' })).toBe(
      'replaced',
    );
    expect(append).toHaveBeenCalledTimes(1);
    expect(inner.appended).toEqual([]);
  });

  it('中身が持たない任意の口は、包んでも持たない（`undefined` のまま、`in` も偽）', () => {
    const wrapped = wrapJournalStore(createMemoryStores().journal, {});

    expect(wrapped.conversationWindowHeads).toBeUndefined();
    expect('conversationWindowHeads' in wrapped).toBe(false);
  });
});

describe('クローンの道具の日誌の包み（stampingJournal）は、器の速い口を落とさない（#5140）', () => {
  it('humanReplies・conversationWindowHeads を中身のまま渡し、append には印を付ける', async () => {
    const base = createMemoryStores().journal;
    const humanReplies = vi.fn(() => Promise.resolve([{ conversationId: 'c', at: 't' }]));
    const conversationWindowHeads = vi.fn(() => Promise.resolve({ rows: [], next: null }));
    const inner: JournalStore = { ...base, humanReplies, conversationWindowHeads };
    const journal = stampingJournal(inner, () => 'approval-1');

    expect(await journal.humanReplies?.()).toEqual([{ conversationId: 'c', at: 't' }]);
    expect(await journal.conversationWindowHeads?.({ scan: 10 })).toEqual({
      rows: [],
      next: null,
    });

    const appended = await journal.append({ type: 'decision', decision: 'd', grounds: 'g' });
    expect(appended).toMatchObject({ answeredApprovalId: 'approval-1' });
  });
});
