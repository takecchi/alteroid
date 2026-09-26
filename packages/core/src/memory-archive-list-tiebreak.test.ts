import { describe, expect, it } from 'vitest';

import { compareArchiveEntriesNewestFirst } from './archive-id.js';
import { createMemoryStores } from './testing.js';

/**
 * **インメモリの `list()` は、同じミリ秒の違うセッションの行を、fs / pg と同じ規則
 * （`sessionId` の昇順）で並べる。** fs / pg は同着を `compareArchiveEntriesNewestFirst`
 * （`archive-id.ts`）に委ね、違うセッションなら `sessionId` の昇順で決める。インメモリだけ
 * が同着をセッションを問わず積んだ順の降順で並べていた。契約テスト（`archive-contract.ts`）
 * の同着の検査は、同じセッションの形しか作っていなかった。
 */
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

    // わざと sessionId のアルファベット順どおりに積む
    // （'aaa-session' を先に、'zzz-session' を後に）。
    // fs/pg の tie-break 規則（compareArchiveEntriesNewestFirst）は
    // sessionId 昇順なので、挿入順に関係なく 'aaa-session' が先に来るはず。
    // インメモリは挿入順の逆（seq 降順）で決めるので、後から積んだ
    // 'zzz-session' が先に来る——ここで食い違う。
    const [aId, zId] = await withFrozenNow(frozenMs, async () => {
      const a = await stores.archive.archive('aaa-session', 'A\n');
      const z = await stores.archive.archive('zzz-session', 'Z\n');
      return [a.id, z.id];
    });

    const entries = (await stores.archive.list()).filter(
      (entry) => entry.sessionId === 'aaa-session' || entry.sessionId === 'zzz-session',
    );

    // 前提: 本当に同じ at で積めている（同着を測れていることの確認）。
    expect(new Set(entries.map((entry) => entry.at)).size).toBe(1);
    expect(entries).toHaveLength(2);

    // fs/pg が実際に使っている並び規則を、そのまま「期待する順」として使う
    // ——手で決め打ちした順ではなく、共有関数 compareArchiveEntriesNewestFirst
    // そのものに聞く。
    const expectedOrder = [...entries].sort(compareArchiveEntriesNewestFirst).map((e) => e.id);

    expect(entries.map((entry) => entry.id)).toEqual(expectedOrder);
    // 手で確かめる形でも書いておく（読み手が上の抽象比較を信用できるように）。
    expect(entries.map((entry) => entry.id)).toEqual([aId, zId]);
  });
});
