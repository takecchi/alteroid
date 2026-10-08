import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

import {
  createMemoryStores,
  type ArchiveEntry,
  type ManagerPool,
  type Stores,
} from '@alteroid/core';
import { describe, expect, it } from 'vitest';

import {
  ARCHIVE_FOLD_EVERY_ENV,
  ARCHIVE_FOLD_GRACE_MS,
  DEFAULT_ARCHIVE_FOLD_EVERY_MINUTES,
  MIN_ARCHIVE_FOLD_EVERY_MINUTES,
  foldArchiveOnce,
  readArchiveFoldConfig,
  startArchiveFolding,
  type FoldArchiveOnceResult,
} from './archive-folder.js';

const __dirname = dirname(fileURLToPath(import.meta.url));

const FAR_FUTURE = () => new Date(Date.now() + ARCHIVE_FOLD_GRACE_MS + 60_000);

const noRunningManagers: Pick<ManagerPool, 'runningManagerOwning'> = {
  runningManagerOwning: () => undefined,
};

function fakeManagers(
  runningOwners: Map<string, string>,
): Pick<ManagerPool, 'runningManagerOwning'> {
  return {
    runningManagerOwning: (archiveId) => runningOwners.get(archiveId),
  };
}

function fakeManagersWithPinning(
  ownedIds: readonly string[],
  managerId: string,
): Pick<ManagerPool, 'runningManagerOwning' | 'runningManagerPinning'> {
  const tail = ownedIds.at(-1);
  return {
    runningManagerOwning: (archiveId) => (ownedIds.includes(archiveId) ? managerId : undefined),
    runningManagerPinning: (archiveId) => (archiveId === tail ? managerId : undefined),
  };
}

function assertInvariant(result: FoldArchiveOnceResult): void {
  const skippedTotal =
    result.skipped.newest +
    result.skipped.alreadyRemoved +
    result.skipped.notContained +
    result.skipped.protected +
    result.skipped.inUse;
  expect(result.matched).toBe(result.folded + result.remaining + skippedTotal + result.raced);
}

function fakeArchiveEntries(initial: readonly ArchiveEntry[]): Stores['archive'] {
  const rows = new Map(initial.map((e) => [e.id, { ...e }]));
  return {
    archive() {
      throw new Error('fakeArchiveEntries: archive() は使わない');
    },
    async list() {
      return [...rows.values()];
    },
    sessions() {
      throw new Error('fakeArchiveEntries: sessions() は使わない');
    },
    async read(id) {
      const row = rows.get(id);
      if (row === undefined) return { kind: 'missing' };
      if (row.removedAt !== undefined) {
        return { kind: 'removed', removedAt: row.removedAt, bytes: row.removedBytes ?? 0 };
      }
      return { kind: 'body', body: '' };
    },
    readTail() {
      throw new Error('fakeArchiveEntries: readTail() は使わない');
    },
    async remove(id) {
      const row = rows.get(id);
      if (row === undefined) return { kind: 'missing' };
      if (row.removedAt !== undefined) {
        return { kind: 'already', removedAt: row.removedAt, bytes: row.removedBytes ?? 0 };
      }
      const removedAt = new Date().toISOString();
      const bytes = row.storedBytes;
      rows.set(id, { ...row, removedAt, removedBytes: bytes });
      return { kind: 'removed', bytes };
    },
    async clear() {
      const n = rows.size;
      rows.clear();
      return n;
    },
  };
}

describe('foldArchiveOnce（issue #698）', () => {
  it('continues の古い行が畳まれ、そのセッションの最新行は残る', async () => {
    const stores = createMemoryStores();
    const row1 = await stores.archive.archive('sess-1', 'A'.repeat(40));
    const row2 = await stores.archive.archive('sess-1', 'A'.repeat(40) + 'B'.repeat(40));
    const row3 = await stores.archive.archive(
      'sess-1',
      'A'.repeat(40) + 'B'.repeat(40) + 'C'.repeat(40),
    );
    expect(row2.continuity).toBe('continues');
    expect(row3.continuity).toBe('continues');

    const result = await foldArchiveOnce({ stores, managers: noRunningManagers, now: FAR_FUTURE });
    assertInvariant(result);

    expect(result.folded).toBe(2);
    expect(result.skipped.newest).toBe(1);

    expect((await stores.archive.read(row1.id)).kind).toBe('removed');
    expect((await stores.archive.read(row2.id)).kind).toBe('removed');
    expect((await stores.archive.read(row3.id)).kind).toBe('body');
  });

  it('diverged / unknown / continuity を持たない行（門より前の残骸）は畳まれない', async () => {
    const base = createMemoryStores();
    const entries: ArchiveEntry[] = [
      { id: 'row-1', sessionId: 'sess-2', at: '2026-01-01T00:00:00.000Z', storedBytes: 100 },
      {
        id: 'row-2',
        sessionId: 'sess-2',
        at: '2026-01-01T00:01:00.000Z',
        storedBytes: 100,
        continuity: 'unknown',
      },
      {
        id: 'row-3',
        sessionId: 'sess-2',
        at: '2026-01-01T00:02:00.000Z',
        storedBytes: 100,
        continuity: 'diverged',
      },
    ];
    const stores: Stores = { ...base, archive: fakeArchiveEntries(entries) };

    const result = await foldArchiveOnce({ stores, managers: noRunningManagers });
    assertInvariant(result);

    expect(result.folded).toBe(0);
    expect(result.skipped.newest).toBe(1);
    expect(result.skipped.notContained).toBe(2);

    expect((await stores.archive.read('row-1')).kind).toBe('body');
    expect((await stores.archive.read('row-2')).kind).toBe('body');
    expect((await stores.archive.read('row-3')).kind).toBe('body');
  });

  it('墓標（TranscriptGrave.archiveId）が指す行は畳まれない', async () => {
    const stores = createMemoryStores();
    const row1 = await stores.archive.archive('sess-3', 'X'.repeat(40));
    await stores.archive.archive('sess-3', 'X'.repeat(40) + 'Y'.repeat(40));
    await stores.sessions.setTranscriptGrave({ archiveId: row1.id });

    const result = await foldArchiveOnce({ stores, managers: noRunningManagers, now: FAR_FUTURE });
    assertInvariant(result);

    expect(result.folded).toBe(0);
    expect(result.skipped.protected).toBe(1);
    expect(result.skipped.newest).toBe(1);
    expect((await stores.archive.read(row1.id)).kind).toBe('body');
  });

  it('走行中のマネージャーが抱える行は畳まれない（runningManagerOwning）。overrideReason は渡さない', async () => {
    const stores = createMemoryStores();
    const row1 = await stores.archive.archive('sess-4', 'P'.repeat(40));
    await stores.archive.archive('sess-4', 'P'.repeat(40) + 'Q'.repeat(40));

    const runningOwners = new Map<string, string>([[row1.id, 'mgr-running']]);
    const result = await foldArchiveOnce({
      stores,
      managers: fakeManagers(runningOwners),
      now: FAR_FUTURE,
    });
    assertInvariant(result);

    expect(result.folded).toBe(0);
    expect(result.skipped.inUse).toBe(1);
    expect(result.skipped.newest).toBe(1);
    expect((await stores.archive.read(row1.id)).kind).toBe('body');
  });

  it('狭めた保護（runningManagerPinning）により、走行中の委譲が抱える古い写しも自動で畳める。末尾は畳まれない（#698）', async () => {
    const stores = createMemoryStores();
    const row1 = await stores.archive.archive('sess-pin', 'F'.repeat(40));
    const row2 = await stores.archive.archive('sess-pin', 'F'.repeat(40) + 'G'.repeat(40));
    const row3 = await stores.archive.archive(
      'sess-pin',
      'F'.repeat(40) + 'G'.repeat(40) + 'H'.repeat(40),
    );
    expect(row2.continuity).toBe('continues');
    expect(row3.continuity).toBe('continues');

    const managers = fakeManagersWithPinning([row1.id, row2.id], 'mgr-pinned');
    const result = await foldArchiveOnce({ stores, managers, now: FAR_FUTURE });
    assertInvariant(result);

    expect((await stores.archive.read(row1.id)).kind).toBe('removed');
    expect(result.folded).toBe(1);
    expect((await stores.archive.read(row2.id)).kind).toBe('body');
    expect(result.skipped.inUse).toBe(1);
    expect((await stores.archive.read(row3.id)).kind).toBe('body');
    expect(result.skipped.newest).toBe(1);
  });

  it('runningManagerPinning を持たない像では、古い写しも末尾も保護されたまま（安全側フォールバック）', async () => {
    const stores = createMemoryStores();
    const row1 = await stores.archive.archive('sess-nopin', 'F'.repeat(40));
    const row2 = await stores.archive.archive('sess-nopin', 'F'.repeat(40) + 'G'.repeat(40));

    const runningOwners = new Map<string, string>([
      [row1.id, 'mgr-nopin'],
      [row2.id, 'mgr-nopin'],
    ]);
    const result = await foldArchiveOnce({
      stores,
      managers: fakeManagers(runningOwners),
      now: FAR_FUTURE,
    });
    assertInvariant(result);

    expect(result.folded).toBe(0);
    expect(result.skipped.inUse).toBe(1);
    expect((await stores.archive.read(row1.id)).kind).toBe('body');
  });

  it('overrideReason を渡す経路がこのファイルに存在せず、第4引数（requireContainment）は常に true（自動の口は開けない・#698）', () => {
    const source = readFileSync(join(__dirname, 'archive-folder.ts'), 'utf8');
    const guardCalls = [...source.matchAll(/guardArchiveRemoval\(([^)]*)\)/g)];
    expect(guardCalls.length).toBe(1);
    const args = (guardCalls[0]?.[1] ?? '').split(',').map((a) => a.trim());
    expect(args[2]).toBe('undefined');
    expect(args[3]).toBe('true');
    expect(source).not.toMatch(/\boverrideReason\s*[:=]/);
  });

  it('猶予（grace）より新しい行は畳まれない', async () => {
    const stores = createMemoryStores();
    await stores.archive.archive('sess-5', 'N'.repeat(40));
    await stores.archive.archive('sess-5', 'N'.repeat(40) + 'M'.repeat(40));

    const result = await foldArchiveOnce({ stores, managers: noRunningManagers });
    assertInvariant(result);

    expect(result.totalRows).toBe(2);
    expect(result.matched).toBe(0);
    expect(result.folded).toBe(0);
  });

  it('冪等: 1周目の後に新しい行を積むと、2周目はその直前の行だけを畳む', async () => {
    const stores = createMemoryStores();
    const rowA = await stores.archive.archive('sess-6', 'first'.repeat(10));
    const rowB = await stores.archive.archive('sess-6', 'first'.repeat(10) + 'second'.repeat(10));

    const first = await foldArchiveOnce({ stores, managers: noRunningManagers, now: FAR_FUTURE });
    assertInvariant(first);
    expect(first.folded).toBe(1);
    expect((await stores.archive.read(rowA.id)).kind).toBe('removed');
    expect((await stores.archive.read(rowB.id)).kind).toBe('body');

    const rowC = await stores.archive.archive(
      'sess-6',
      'first'.repeat(10) + 'second'.repeat(10) + 'third'.repeat(10),
    );

    const second = await foldArchiveOnce({ stores, managers: noRunningManagers, now: FAR_FUTURE });
    assertInvariant(second);

    expect(second.folded).toBe(1);
    expect(second.skipped.alreadyRemoved).toBe(1);
    expect(second.skipped.newest).toBe(1);

    expect((await stores.archive.read(rowB.id)).kind).toBe('removed');
    expect((await stores.archive.read(rowC.id)).kind).toBe('body');
  });

  it('1件も畳まなかった周は、日誌へ1行も書かない', async () => {
    const base = createMemoryStores();
    const entries: ArchiveEntry[] = [
      { id: 'row-1', sessionId: 'sess-7', at: '2026-01-01T00:00:00.000Z', storedBytes: 100 },
      {
        id: 'row-2',
        sessionId: 'sess-7',
        at: '2026-01-01T00:01:00.000Z',
        storedBytes: 100,
        continuity: 'unknown',
      },
    ];
    const stores: Stores = { ...base, archive: fakeArchiveEntries(entries) };

    const result = await foldArchiveOnce({ stores, managers: noRunningManagers });
    expect(result.matched).toBeGreaterThan(0);
    expect(result.folded).toBe(0);

    const journalEntries = await stores.journal.list({ types: ['decision'] });
    expect(journalEntries.length).toBe(0);
  });

  it('raced（guard 通過後に他経路が先に消していた）を隠さず数える', async () => {
    const base = createMemoryStores();
    const rowA = await base.archive.archive('sess-8', 'r'.repeat(30));
    await base.archive.archive('sess-8', 'r'.repeat(30) + 's'.repeat(30));

    let removeCalls = 0;
    const stores: Stores = {
      ...base,
      archive: {
        ...base.archive,
        async remove(id) {
          removeCalls += 1;
          if (id === rowA.id) return { kind: 'missing' };
          return base.archive.remove(id);
        },
      },
    };

    const result = await foldArchiveOnce({ stores, managers: noRunningManagers, now: FAR_FUTURE });
    assertInvariant(result);

    expect(removeCalls).toBe(1);
    expect(result.raced).toBe(1);
    expect(result.folded).toBe(0);
    const journalEntries = await stores.journal.list({ types: ['decision'] });
    expect(journalEntries.length).toBe(0);
  });
});

describe('foldArchiveOnce — 日誌の追記が落ちたとき（issue #2746）', () => {
  const longId = (n: number) => `${n}`.padEnd(2_000, 'x');
  const rowsOf = (): ArchiveEntry[] =>
    [1, 2, 3, 4].map((n) => ({
      id: longId(n),
      sessionId: 'sess-j',
      at: `2026-01-01T00:0${n}:00.000Z`,
      storedBytes: 100,
      continuity: 'continues' as const,
    }));

  it('ある塊の journal.append が落ちても reject せず、残りの塊も畳み、日誌に書けなかった id を返す', async () => {
    const base = createMemoryStores();
    let appendCalls = 0;
    const stores: Stores = {
      ...base,
      archive: fakeArchiveEntries(rowsOf()),
      journal: {
        ...base.journal,
        async append(entry) {
          appendCalls += 1;
          if (appendCalls === 1) throw new Error('pg down');
          return base.journal.append(entry);
        },
      },
    };

    const result = await foldArchiveOnce({ stores, managers: noRunningManagers, now: FAR_FUTURE });
    assertInvariant(result);

    expect(result.folded).toBe(3);
    expect(appendCalls).toBe(3);
    expect(result.journalDroppedIds).toEqual([longId(1)]);
    expect((await stores.journal.list({ types: ['decision'] })).length).toBe(2);
  });
});

describe('readArchiveFoldConfig（issue #698）', () => {
  it('既定は DEFAULT_ARCHIVE_FOLD_EVERY_MINUTES', () => {
    const config = readArchiveFoldConfig({});
    expect(config.everyMinutes).toBe(DEFAULT_ARCHIVE_FOLD_EVERY_MINUTES);
    expect(config.notes).toEqual([]);
  });

  it.each(['off', 'none', 'false', '0', 'OFF', 'None'])(
    '%s で周期を仕込まない（null）',
    (spelling) => {
      const config = readArchiveFoldConfig({ [ARCHIVE_FOLD_EVERY_ENV]: spelling });
      expect(config.everyMinutes).toBeNull();
    },
  );

  it('数として読めない値は既定へ倒し、注意を残す', () => {
    const config = readArchiveFoldConfig({ [ARCHIVE_FOLD_EVERY_ENV]: 'いつか' });
    expect(config.everyMinutes).toBe(DEFAULT_ARCHIVE_FOLD_EVERY_MINUTES);
    expect(config.notes.length).toBe(1);
  });

  it('分数を読む', () => {
    const config = readArchiveFoldConfig({ [ARCHIVE_FOLD_EVERY_ENV]: '15' });
    expect(config.everyMinutes).toBe(15);
  });

  it('下限（1分）未満は notes へ落として既定へ倒す。下限ちょうどと小数は採用する（#4014）', () => {
    const read = (raw: string) => readArchiveFoldConfig({ [ARCHIVE_FOLD_EVERY_ENV]: raw });
    expect(MIN_ARCHIVE_FOLD_EVERY_MINUTES).toBe(1);
    for (const ok of ['1', '1.5']) {
      const config = read(ok);
      expect(config.everyMinutes).toBe(Number(ok));
      expect(config.notes).toEqual([]);
    }
    for (const low of ['0.00001', '0.999999', '-5', 'soon']) {
      const config = read(low);
      expect(config.everyMinutes).toBe(DEFAULT_ARCHIVE_FOLD_EVERY_MINUTES);
      expect(config.notes).toHaveLength(1);
      expect(config.notes[0]).toContain(`"${low}"`);
    }
    expect(read('0.00001').notes[0]).toBe(
      'ALTEROID_ARCHIVE_FOLD_EVERY="0.00001" は下限 1 分を下回っているので既定 60 を使う',
    );
    expect(read('0').everyMinutes).toBeNull();
    expect(read('0').notes).toEqual([]);
  });
});

describe('startArchiveFolding（issue #698）', () => {
  it('ALTEROID_ARCHIVE_FOLD_EVERY=off 相当（everyMinutes: null）で1度も走らない', async () => {
    const stores = createMemoryStores();
    let listCalls = 0;
    const wrapped: Stores = {
      ...stores,
      archive: {
        ...stores.archive,
        async list() {
          listCalls += 1;
          return stores.archive.list();
        },
      },
    };

    const folder = startArchiveFolding({
      stores: wrapped,
      managers: noRunningManagers,
      everyMinutes: null,
    });
    await new Promise((resolve) => setTimeout(resolve, 20));
    expect(listCalls).toBe(0);

    const refreshed = await folder.refresh();
    expect(refreshed).toBeNull();
    expect(listCalls).toBe(0);

    folder.stop();
  });

  it('everyMinutes が指定されていれば起動直後に1回、待たずに叩く', async () => {
    const stores = createMemoryStores();
    const folder = startArchiveFolding({
      stores,
      managers: noRunningManagers,
      everyMinutes: 1,
      intervalMs: 10_000,
      now: FAR_FUTURE,
    });

    const result = await folder.refresh();
    expect(result).not.toBeNull();

    folder.stop();
  });

  it('止めたら以後取りに行かない', async () => {
    const stores = createMemoryStores();
    let listCalls = 0;
    const wrapped: Stores = {
      ...stores,
      archive: {
        ...stores.archive,
        async list() {
          listCalls += 1;
          return stores.archive.list();
        },
      },
    };
    const folder = startArchiveFolding({
      stores: wrapped,
      managers: noRunningManagers,
      everyMinutes: 1,
      intervalMs: 5,
    });
    await folder.refresh();
    folder.stop();

    const after = listCalls;
    await new Promise((resolve) => setTimeout(resolve, 60));
    expect(listCalls).toBe(after);
  });
});

describe('foldArchiveOnce — 選んだ後に他経路が消していた行', () => {
  it('remove() が already を返した行は raced に数え、folded に入れない', async () => {
    const stores = createMemoryStores();
    const row1 = await stores.archive.archive('sess-race', 'A'.repeat(40));
    const row2 = await stores.archive.archive('sess-race', 'A'.repeat(40) + 'B'.repeat(40));
    expect(row2.continuity).toBe('continues');

    const originalRemove = stores.archive.remove.bind(stores.archive);
    let armed = true;
    stores.archive.remove = async (id: string) => {
      if (id === row1.id && armed) {
        armed = false;
        await originalRemove(id);
      }
      return originalRemove(id);
    };

    const result = await foldArchiveOnce({ stores, managers: noRunningManagers, now: FAR_FUTURE });
    assertInvariant(result);

    expect(result.raced).toBe(1);
    expect(result.folded).toBe(0);
    expect((await stores.archive.read(row1.id)).kind).toBe('removed');
    expect((await stores.archive.read(row2.id)).kind).toBe('body');
  });
});
