import { describe, expect, it } from 'vitest';

import { compareArchiveEntriesNewestFirst } from './archive-id.js';
import { createMemoryStores } from './testing.js';

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

describe('インメモリの TranscriptArchive.list() は、違うセッションの同着を fs / pg と同じ規則で並べる', () => {
  it('違うセッションが同じミリ秒で同着のとき、sessionId の昇順で並べる（compareArchiveEntriesNewestFirst と同じ）', async () => {
    const stores = createMemoryStores();
    const frozenMs = Date.now();

    const [aId, zId] = await withFrozenNow(frozenMs, async () => {
      const a = await stores.archive.archive('aaa-session', 'A\n');
      const z = await stores.archive.archive('zzz-session', 'Z\n');
      return [a.id, z.id];
    });

    const entries = (await stores.archive.list()).filter(
      (entry) => entry.sessionId === 'aaa-session' || entry.sessionId === 'zzz-session',
    );

    expect(new Set(entries.map((entry) => entry.at)).size).toBe(1);
    expect(entries).toHaveLength(2);

    const expectedOrder = [...entries].sort(compareArchiveEntriesNewestFirst).map((e) => e.id);

    expect(entries.map((entry) => entry.id)).toEqual(expectedOrder);
    expect(entries.map((entry) => entry.id)).toEqual([aId, zId]);
  });
});
