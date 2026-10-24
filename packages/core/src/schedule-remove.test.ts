import { describe, expect, it } from 'vitest';

import type { JournalEntryInput } from './schema.js';
import { removeScheduleJournalFirst } from './schedule-remove.js';
import { ScheduleConflictError, UnreadableScheduleError } from './store.js';
import type { Stores } from './store.js';
import { captureStderr, createMemoryStores } from './testing.js';
import { createCloneTools } from './tools.js';

const SEEN = '2026-10-01T00:00:00.000Z';
const spec = { type: 'daily', at: '09:00' } as const;

async function seed(stores: Stores, kind = 'watch'): Promise<void> {
  await stores.schedules.put({
    kind,
    spec,
    request: '見張る本文',
    createdAt: SEEN,
    updatedAt: SEEN,
  });
}

async function decisions(stores: Stores): Promise<string[]> {
  return (await stores.journal.list({ types: ['decision'], order: 'asc' })).map((entry) =>
    entry.type === 'decision' ? entry.decision : '',
  );
}

function withFailingJournal(inner: Stores): Stores {
  return {
    ...inner,
    journal: {
      ...inner.journal,
      append: () => {
        throw new Error('journal store unavailable (test)');
      },
    },
  };
}

function buildEntry(before: unknown): JournalEntryInput {
  return {
    type: 'decision',
    decision: before === 'unreadable' ? '外す(読めない)' : '外す',
    grounds: 'テスト',
  };
}

function toolsOf(stores: Stores) {
  const tools = createCloneTools({
    stores,
    emit: () => undefined,
    conversationId: () => undefined,
    memoryCause: () => 'clone',
  });
  return async (name: string, args: Record<string, unknown>) => {
    const found = tools.find((entry) => entry.name === name);
    if (!found) throw new Error(`ツール ${name} が無い`);
    const result = await found.handler(args as never, {});
    return (result.content ?? []).map((b) => (b.type === 'text' ? b.text : '')).join('');
  };
}

describe('removeScheduleJournalFirst（#5234）', () => {
  it('外す瞬間に、先の行が日誌に既に在る（順序の歯）', async () => {
    const stores = createMemoryStores();
    await seed(stores);
    const real = stores.schedules;
    let seenAtRemove: string[] | undefined;
    stores.schedules = {
      ...real,
      async removeIfPresent(kind, options) {
        seenAtRemove = await decisions(stores);
        return real.removeIfPresent(kind, options);
      },
    };

    const result = await removeScheduleJournalFirst(stores, 'watch', { buildEntry });

    expect(result.kind).toBe('removed');
    expect(seenAtRemove).toEqual(['外す']);
    expect(await stores.schedules.get('watch')).toBeNull();
  });

  it('日誌に書けないとき外さない（行が残る）', async () => {
    const inner = createMemoryStores();
    await seed(inner);
    const stores = withFailingJournal(inner);

    const result = await removeScheduleJournalFirst(stores, 'watch', { buildEntry });

    expect(result.kind).toBe('journal-failed');
    expect((await inner.schedules.get('watch'))?.request).toBe('見張る本文');
  });

  it('無い kind は not-found で、日誌も書かない', async () => {
    const stores = createMemoryStores();
    const result = await removeScheduleJournalFirst(stores, 'nope', { buildEntry });
    expect(result.kind).toBe('not-found');
    expect(await decisions(stores)).toEqual([]);
  });

  it('外す直前にほかで消えていたら、先の行を打ち消す行が足される', async () => {
    const stores = createMemoryStores();
    await seed(stores);
    const real = stores.schedules;
    stores.schedules = {
      ...real,
      async removeIfPresent(kind, options) {
        await real.remove(kind); // 割り込み
        return real.removeIfPresent(kind, options);
      },
    };

    const result = await removeScheduleJournalFirst(stores, 'watch', { buildEntry });

    expect(result.kind).toBe('not-found');
    const rows = await decisions(stores);
    expect(rows).toHaveLength(2);
    expect(rows[0]).toBe('外す');
    expect(rows[1]).toContain('効いていない');
  });

  it('外す直前に版が変わっていたら（衝突）、先の行を打ち消す行が足される。外していない', async () => {
    const stores = createMemoryStores();
    await seed(stores);
    const real = stores.schedules;
    stores.schedules = {
      ...real,
      async removeIfPresent(kind) {
        throw new ScheduleConflictError(kind, null);
      },
    };

    const result = await removeScheduleJournalFirst(stores, 'watch', {
      ifMatch: SEEN,
      buildEntry,
    });

    expect(result.kind).toBe('conflict');
    const rows = await decisions(stores);
    expect(rows).toHaveLength(2);
    expect(rows[1]).toContain('効いていない');
    expect((await real.get('watch'))?.request).toBe('見張る本文');
  });

  it('打ち消す行も書けなければ、跡だけ残して元の結果を返す', async () => {
    const stores = createMemoryStores();
    await seed(stores);
    const real = stores.schedules;
    let appended = 0;
    const journal = stores.journal;
    stores.journal = {
      ...journal,
      append: (entry) => {
        appended += 1;
        if (appended > 1) throw new Error('journal store unavailable (test)');
        return journal.append(entry);
      },
    };
    stores.schedules = {
      ...real,
      async removeIfPresent() {
        return null;
      },
    };

    const result = await captureStderr(async () => {
      expect((await removeScheduleJournalFirst(stores, 'watch', { buildEntry })).kind).toBe(
        'not-found',
      );
    });
    expect(result.join('\n')).toContain('kind=watch');
  });

  it('読んだ時点で版が合わないと分かれば、日誌を書かずに衝突を返す', async () => {
    const stores = createMemoryStores();
    await seed(stores);

    const result = await removeScheduleJournalFirst(stores, 'watch', {
      ifMatch: '2000-01-01T00:00:00.000Z',
      buildEntry,
    });

    expect(result).toMatchObject({ kind: 'conflict', current: { request: '見張る本文' } });
    expect(await decisions(stores)).toEqual([]);
    expect(await stores.schedules.get('watch')).not.toBeNull();
  });

  it('読めない行も外せる。先の行は「読めない形」の文で、本文を持たない', async () => {
    const stores = createMemoryStores();
    const real = stores.schedules;
    let present = true;
    stores.schedules = {
      ...real,
      async get(kind) {
        if (present) throw new UnreadableScheduleError('読めない', { kind });
        return null;
      },
      async removeIfPresent() {
        if (!present) return null;
        present = false;
        return 'unreadable';
      },
    };

    const result = await removeScheduleJournalFirst(stores, 'broken', { buildEntry });

    expect(result).toEqual({ kind: 'removed', removed: 'unreadable' });
    expect(await decisions(stores)).toEqual(['外す(読めない)']);
  });

  it('読む口の障害（読めない行以外の例外）は握らず投げる。外さない', async () => {
    const stores = createMemoryStores();
    stores.schedules = {
      ...stores.schedules,
      async get() {
        throw new Error('storage down (test)');
      },
    };
    await expect(removeScheduleJournalFirst(stores, 'watch', { buildEntry })).rejects.toThrow(
      'storage down',
    );
    expect(await decisions(stores)).toEqual([]);
  });

  it('読んだ後に本文が書き換わっていたら、実際に外した本文を補いの行へ残す', async () => {
    const stores = createMemoryStores();
    await seed(stores);
    const real = stores.schedules;
    stores.schedules = {
      ...real,
      async removeIfPresent(kind, options) {
        await real.editRequest(kind, { request: '割り込みで直された本文', spec }, SEEN);
        return real.removeIfPresent(kind, options);
      },
    };

    const result = await removeScheduleJournalFirst(stores, 'watch', { buildEntry });

    expect(result.kind).toBe('removed');
    const rows = await decisions(stores);
    expect(rows).toHaveLength(2);
    expect(rows[1]).toContain('割り込みで直された本文');
  });
});

describe('schedule_remove（#5234）', () => {
  it('外す前に日誌へ「外す」を残す。外した後の行は足さない', async () => {
    const stores = createMemoryStores();
    await seed(stores);
    const call = toolsOf(stores);

    expect(await call('schedule_remove', { kind: 'watch' })).toContain('外した');

    const rows = await decisions(stores);
    expect(rows).toEqual(['定期の依頼を外す: watch: 見張る本文']);
  });

  it('外す瞬間に、先の行が日誌に既に在る（順序の歯）', async () => {
    const stores = createMemoryStores();
    await seed(stores);
    const real = stores.schedules;
    let seenAtRemove: string[] | undefined;
    stores.schedules = {
      ...real,
      async removeIfPresent(kind, options) {
        seenAtRemove = await decisions(stores);
        return real.removeIfPresent(kind, options);
      },
    };

    await toolsOf(stores)('schedule_remove', { kind: 'watch' });

    expect(seenAtRemove).toEqual(['定期の依頼を外す: watch: 見張る本文']);
  });

  it('日誌に書けないとき外さず、行為は起きていないと投げる', async () => {
    const inner = createMemoryStores();
    await seed(inner);
    const call = toolsOf(withFailingJournal(inner));

    await captureStderr(async () => {
      await expect(call('schedule_remove', { kind: 'watch' })).rejects.toThrow(
        '⚠⚠ 未記録・行為は起きていない・やり直してよい',
      );
    });
    expect((await inner.schedules.get('watch'))?.request).toBe('見張る本文');
  });

  it('割り込みで外せなかったとき、打ち消しの行を足して「無い」と返す', async () => {
    const stores = createMemoryStores();
    await seed(stores);
    const real = stores.schedules;
    stores.schedules = {
      ...real,
      async removeIfPresent(kind, options) {
        await real.remove(kind);
        return real.removeIfPresent(kind, options);
      },
    };

    const reply = await toolsOf(stores)('schedule_remove', { kind: 'watch' });

    expect(reply).toContain('無い');
    const rows = await decisions(stores);
    expect(rows).toHaveLength(2);
    expect(rows[1]).toContain('効いていない');
  });
});
