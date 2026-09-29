import { UnreadableScheduleError, captureStderr } from '@alteroid/core';
import type { ScheduledRequest } from '@alteroid/core';
import { PGlite } from '@electric-sql/pglite';
import { eq } from 'drizzle-orm';
import { drizzle } from 'drizzle-orm/pglite';
import { beforeEach, describe, expect, it } from 'vitest';

import type { Db } from './db.js';
import { createPgStoresFromDb, migrate, type PgStores } from './index.js';
import { schedules } from './schema.js';

/**
 * issue #1944（#1868 / #1928 の線を継続中の依頼にそろえる）。`PgScheduleStore.list()`
 * は行ごとに `parsePlan()` を呼んでいたが、1行でも `scheduledRequestSchema` に
 * 合わなければ `parsePlan` がそのまま投げていた。そのため、**1行でも壊れた
 * `plan` があると `list()` 全体が例外を投げ、正しい依頼も含めて一覧が返らなく
 * なる**——fs 実装（`packages/storage-fs/src/schedules-malformed-row-repro.test.ts`
 * が対の歯を持つ）と同じ形の穴である。
 *
 * **`get(kind)` はこれまでどおり投げる**（`parsePlan` の doc・issue #1944 の方針）。
 * 「消された」（`null`）と「読めない」（throw）を区別できないと、`clone.ts` は
 * 発火した依頼を「人間が手で仕込んだ kind を起こした」と誤解し、本文なしの曖昧な
 * ターンを走らせる。飛ばすのは `list()` だけでよい。
 */
let client: PGlite;
let db: Db;
let stores: PgStores;

beforeEach(async () => {
  client = new PGlite();
  db = drizzle(client);
  await migrate(db);
  stores = createPgStoresFromDb(db);
});

describe('PgScheduleStore — schedules の不正な1行を読み飛ばす（issue #1944）', () => {
  const GOOD_SCHEDULE: ScheduledRequest = {
    kind: 'good-kind',
    spec: { type: 'every', minutes: 60 },
    request: '正常な継続中の依頼の本文（この文字列がそのまま跡に出てはいけない）',
    createdAt: '2026-09-01T00:00:00.000Z',
    updatedAt: '2026-09-01T00:00:00.000Z',
  };

  // `plan.spec.type` が既知の値でない——版ずれ・手編集を模す。`put()` は
  // `scheduledRequestSchema.parse` で拒むので、版ずれを模すために表へ直接書く。
  const BAD_PLAN_RAW = {
    kind: 'bad-kind',
    spec: { type: 'not-a-real-spec-type-from-a-newer-deploy' },
    request: '壊れた継続中の依頼の本文（この文字列も跡に出てはいけない）',
    createdAt: '2026-09-02T00:00:00.000Z',
    updatedAt: '2026-09-02T00:00:00.000Z',
  };

  async function insertBadRow(): Promise<void> {
    await db.insert(schedules).values({
      kind: 'bad-kind',
      createdAt: new Date('2026-09-02T00:00:00.000Z'),
      updatedAt: new Date('2026-09-02T00:00:00.000Z'),
      plan: BAD_PLAN_RAW,
    });
  }

  it('list() は、不正な行があっても落ちず、正しい依頼だけを返す（直す前は例外で赤）', async () => {
    await stores.schedules.put(GOOD_SCHEDULE);
    await insertBadRow();

    let found: ScheduledRequest[] = [];
    await captureStderr(async () => {
      found = await stores.schedules.list();
    });

    expect(found.map((entry) => entry.kind)).toEqual(['good-kind']);
  });

  it('跡: 飛ばした行を stderr へ1行出す。本文（request）の値は絶対に含めない', async () => {
    await stores.schedules.put(GOOD_SCHEDULE);
    await insertBadRow();

    const lines = await captureStderr(async () => {
      await stores.schedules.list();
    });
    const joined = lines.join('');

    expect(joined).toContain('bad-kind');
    expect(joined).not.toContain(GOOD_SCHEDULE.request);
    expect(joined).not.toContain(BAD_PLAN_RAW.request);
  });

  it('get() は、正しい kind は返し、不正な行を kind 指定すると投げる（消されたのとは区別する）', async () => {
    await stores.schedules.put(GOOD_SCHEDULE);
    await insertBadRow();

    expect(await stores.schedules.get('good-kind')).toEqual(GOOD_SCHEDULE);
    await expect(stores.schedules.get('bad-kind')).rejects.toThrow();
    // **issue #2177。** `instanceof` で見分けられる専用の型を投げる
    // （`schedule_list` の tools.ts の catch が使う契約）。文言は変えていない。
    await expect(stores.schedules.get('bad-kind')).rejects.toBeInstanceOf(UnreadableScheduleError);
    // 本当に消された kind（一度も書いていない）は、投げずに null。
    expect(await stores.schedules.get('never-existed')).toBeNull();
  });

  it('行は DELETE されない。同じ kind を put() で書き直せば読める（回復手段）', async () => {
    await insertBadRow();
    await expect(stores.schedules.get('bad-kind')).rejects.toThrow();

    await stores.schedules.put({
      kind: 'bad-kind',
      spec: { type: 'every', minutes: 15 },
      request: '直した継続中の依頼',
      createdAt: '2026-09-02T00:00:00.000Z',
      updatedAt: '2026-09-04T00:00:00.000Z',
    });

    const fixed = await stores.schedules.get('bad-kind');
    expect(fixed?.request).toBe('直した継続中の依頼');
  });

  /**
   * issue #1982。`get(kind)` が読めない行で投げる契約のまま、`DELETE
   * /schedule/:kind`（`apps/daemon/src/app.ts`）と `schedule_remove`
   * （`tools.ts`）は先に `get(kind)` を呼んでいたので、壊れた依頼を外そうと
   * すると例外がそのまま上がっていた——pg の `remove()` はもともと
   * `DELETE … WHERE kind = …` で行の中身を見ないので消せていたが（直上の
   * 「行は DELETE されない」テストが示すのは `remove()` を呼んでいない
   * 経路の話であって `remove()` 自体の能力の話ではない）、`get()` を経由
   * する口の側だけが穴だった。`removeIfPresent()` は `get()` を経由せず、
   * `DELETE … RETURNING` の1文で「無かった／読めた／在ったが読めなかった」
   * を返す。
   */
  it('removeIfPresent() は不正な行も消せて「読めなかった」と返す（get() を経由しない）', async () => {
    await stores.schedules.put(GOOD_SCHEDULE);
    await insertBadRow();

    const badResult = await stores.schedules.removeIfPresent('bad-kind');
    expect(badResult).toBe('unreadable');
    expect(await db.select().from(schedules).where(eq(schedules.kind, 'bad-kind'))).toEqual([]);
    // 消えたので、以後の get() は例外ではなく null。
    await expect(stores.schedules.get('bad-kind')).resolves.toBeNull();

    // 読める行は、消した値そのものを返す。
    const goodResult = await stores.schedules.removeIfPresent('good-kind');
    expect(goodResult).toEqual(GOOD_SCHEDULE);

    // 本当に無い kind（一度も書いていない）は null（404 の材料）。
    expect(await stores.schedules.removeIfPresent('never-existed')).toBeNull();
  });

  it('clear() は正しい依頼も壊れた依頼も両方消す（壊れているかに関係なく DELETE … RETURNING の件数を返す）', async () => {
    await stores.schedules.put(GOOD_SCHEDULE);
    await insertBadRow();

    const removed = await stores.schedules.clear();
    expect(removed).toEqual({ schedules: 2, phases: 0 });
    expect(await db.select().from(schedules)).toEqual([]);
  });
});
