import { describe, expect, it } from 'vitest';

import { selectArchiveRemovalTargets } from './archive-prune.js';
import type { ManagerPool } from './manager.js';
import { createMemoryStores } from './testing.js';
import { createCloneTools } from './tools.js';

async function withFrozenNow<T>(frozenMs: number, run: () => Promise<T>): Promise<T> {
  const RealDate = Date;
  const FrozenDate = new Proxy(RealDate, {
    construct(target, args: unknown[]) {
      if (args.length === 0) return new target(frozenMs);
      return Reflect.construct(target, args);
    },
    get(target, prop, receiver) {
      if (prop === 'now') return () => frozenMs;
      return Reflect.get(target, prop, receiver) as unknown;
    },
  });
  globalThis.Date = FrozenDate as unknown as DateConstructor;
  try {
    return await run();
  } finally {
    globalThis.Date = RealDate;
  }
}

describe('インメモリの archive は、同じミリ秒に10本以上積んでも選定が積んだ順と一致する', () => {
  it('12本積む: 本当の最新（12本目）は守られ、対象は積んだ順（古い順）の先頭11本', async () => {
    const stores = createMemoryStores();
    const ids: string[] = [];
    await withFrozenNow(Date.now(), async () => {
      for (let n = 1; n <= 12; n += 1) {
        ids.push((await stores.archive.archive('s', 'A'.repeat(n))).id);
      }
    });

    const entries = await stores.archive.list();
    expect(new Set(entries.map((e) => e.at)).size, '同じミリ秒で積めていない').toBe(1);
    expect(new Set(ids).size, 'id が衝突している').toBe(12);

    const selection = selectArchiveRemovalTargets(entries, {});
    expect(selection.targets.map((e) => e.id)).toEqual(ids.slice(0, 11));
    expect(selection.skipped.newest).toBe(1);
    expect(selection.targets.map((e) => e.id)).not.toContain(ids[11]);
  });

  it('archive_remove_many（dryRun: false）でも、10本目（本当の最新）の本文は消えない', async () => {
    const stores = createMemoryStores();
    const ids: string[] = [];
    await withFrozenNow(Date.now(), async () => {
      for (let n = 1; n <= 10; n += 1) {
        ids.push((await stores.archive.archive('s', 'B'.repeat(n))).id);
      }
    });
    const tool = createCloneTools({
      stores,
      emit: () => undefined,
      memoryCause: () => 'clone',
      conversationId: () => undefined,
      managers: { runningManagerOwning: () => undefined } as unknown as ManagerPool,
    }).find((entry) => entry.name === 'archive_remove_many');
    expect(tool, 'archive_remove_many という道具が無い').toBeDefined();
    await tool?.handler(
      { sessionIds: ['s'], summary: '同着の順を確かめる', dryRun: false } as never,
      {} as never,
    );

    expect(await stores.archive.read(ids[9] as string)).toEqual({
      kind: 'body',
      body: 'B'.repeat(10),
    });
    expect((await stores.archive.read(ids[0] as string)).kind).not.toBe('body');
  });
});
