import { createMemoryStores, type Stores } from '@alteroid/core';
import { describe, expect, it } from 'vitest';

import { ARCHIVE_FOLD_GRACE_MS, foldArchiveOnce } from './archive-folder.js';

const FAR_FUTURE = () => new Date(Date.now() + ARCHIVE_FOLD_GRACE_MS + 60_000);
const noRunningManagers = { runningManagerOwning: () => undefined };

/** 2件目の `remove` だけ例外を投げる置き場（1件目は本当に消す）。 */
function failingSecondRemove(stores: Stores): { stores: Stores; removed: string[] } {
  const removed: string[] = [];
  let calls = 0;
  return {
    removed,
    stores: {
      ...stores,
      archive: {
        ...stores.archive,
        archive: stores.archive.archive.bind(stores.archive),
        list: stores.archive.list.bind(stores.archive),
        sessions: stores.archive.sessions.bind(stores.archive),
        read: stores.archive.read.bind(stores.archive),
        readTail: stores.archive.readTail.bind(stores.archive),
        clear: stores.archive.clear.bind(stores.archive),
        async remove(id) {
          calls += 1;
          if (calls === 2) throw new Error('置き場に書けなかった（試験用）');
          const result = await stores.archive.remove(id);
          if (result.kind === 'removed') removed.push(id);
          return result;
        },
      },
    },
  };
}

describe('退避の自動畳み — 途中で消せない行に当たっても、消した行の日誌は書く（#4607）', () => {
  it('2件目の削除が例外を投げても、既に消した1件目を日誌に残してから失敗を返す', async () => {
    const base = createMemoryStores();
    await base.archive.archive('sess-1', 'A'.repeat(40));
    await base.archive.archive('sess-1', 'A'.repeat(40) + 'B'.repeat(40));
    await base.archive.archive('sess-1', 'A'.repeat(40) + 'B'.repeat(40) + 'C'.repeat(40));
    const { stores, removed } = failingSecondRemove(base);

    await expect(
      foldArchiveOnce({ stores, managers: noRunningManagers, now: FAR_FUTURE }),
    ).rejects.toThrow('置き場に書けなかった');

    // 1件目は本当に消えている（戻せない）。何を消したかが日誌に残っていること
    expect(removed).toHaveLength(1);
    const decisions = (await base.journal.list({ types: ['decision'] })).flatMap((entry) =>
      entry.type === 'decision' ? [entry.decision] : [],
    );
    const folded = decisions.filter((text) => text.includes('自動で畳んだ'));
    expect(folded).toHaveLength(1);
    expect(folded[0]).toContain(removed[0]);
    expect(folded[0]).toContain('途中で止めた');
  });
});
