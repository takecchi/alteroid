import { describe, expect, it } from 'vitest';

import type { JournalEntryInput } from './schema.js';
import { createMemoryStores } from './testing.js';

/**
 * `JournalStore.append()` の3実装の食い違い（issue #1668）。
 *
 * fs / pg の `append()` はどちらも `journalEntrySchema.parse({ ...input, id, at })`
 * を通してから書く（`packages/storage-fs/src/journal.ts` の `append()` /
 * `packages/storage-pg/src/journal.ts` の `append()`）。**インメモリ実装だけが
 * 検査を持たず**、`{ ...input, id, at } as JournalEntry` と型で押し切るだけで、
 * 形の崩れた entry（`exchange` の `with` が許可された3値のどれでもない等）も
 * そのまま保存していた——`InboxStore.put()`（issue #1668 本題）と同じ穴が、
 * 依頼者の見立てどおり `InboxStore` 以外のストアにも残っていた1件。
 *
 * ここは fs / pg を基準にした期待値（形式不正な entry は throw する）を
 * インメモリにも当てる歯——`createMemoryStores()` の `journal.append` が
 * `journalEntrySchema.parse` を通すようになったので緑になる
 * （`packages/storage-fs/src/journal-append-validation.test.ts` /
 * `packages/storage-pg/src/journal-append-validation.test.ts` と同じ形）。
 */
describe('JournalStore.append() — 形式不正な entry の扱い（インメモリ実装）', () => {
  const badInput = {
    type: 'exchange',
    with: 'nobody', // journalEntrySchema は with を 'human' | 'manager' | 'self' に限る
    role: 'inbound',
    text: '本文はなんでもよい',
  } as unknown as JournalEntryInput;

  it('append() は fs / pg と同じく、with が許可された値でない entry を拒む（throw する）', async () => {
    const stores = createMemoryStores();
    await expect(stores.journal.append(badInput)).rejects.toThrow();
  });
});
