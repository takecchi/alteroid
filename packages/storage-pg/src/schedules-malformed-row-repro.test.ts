import { UnreadableScheduleError, captureStderr } from '@alteroid/core';
import type { ScheduledRequest } from '@alteroid/core';
import { eq } from 'drizzle-orm';
import { beforeEach, describe, expect, it } from 'vitest';

import type { Db } from './db.js';
import { createPgStoresFromDb, type PgStores } from './index.js';
import { schedules } from './schema.js';
import { createMigratedTestDb } from './test-db.test-support.js';

let db: Db;
let stores: PgStores;

beforeEach(async () => {
  ({ db } = await createMigratedTestDb());
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

  it('list() は、不正な行があっても落ちず、正しい依頼を entries に返す（直す前は例外で赤）', async () => {
    await stores.schedules.put(GOOD_SCHEDULE);
    await insertBadRow();

    let found: ScheduledRequest[] = [];
    await captureStderr(async () => {
      found = (await stores.schedules.list()).entries;
    });

    expect(found.map((entry) => entry.kind)).toEqual(['good-kind']);
  });

  it('list() は、不正な行を消さず unreadable に返す（kind と不正な欄名だけ。本文は載せない）', async () => {
    await stores.schedules.put(GOOD_SCHEDULE);
    await insertBadRow();

    let list: Awaited<ReturnType<typeof stores.schedules.list>> | undefined;
    await captureStderr(async () => {
      list = await stores.schedules.list();
    });

    expect(list?.unreadable).toEqual([{ kind: 'bad-kind', reason: '不正な欄: spec' }]);
    expect(JSON.stringify(list?.unreadable)).not.toContain(BAD_PLAN_RAW.request);
  });

  it('list() は、不正な行が無ければ unreadable が空（対照）', async () => {
    await stores.schedules.put(GOOD_SCHEDULE);

    const list = await stores.schedules.list();

    expect(list.entries.map((entry) => entry.kind)).toEqual(['good-kind']);
    expect(list.unreadable).toEqual([]);
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
    await expect(stores.schedules.get('bad-kind')).rejects.toBeInstanceOf(UnreadableScheduleError);
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

  it('removeIfPresent() は不正な行も消せて「読めなかった」と返す（get() を経由しない）', async () => {
    await stores.schedules.put(GOOD_SCHEDULE);
    await insertBadRow();

    const badResult = await stores.schedules.removeIfPresent('bad-kind');
    expect(badResult).toBe('unreadable');
    expect(await db.select().from(schedules).where(eq(schedules.kind, 'bad-kind'))).toEqual([]);
    await expect(stores.schedules.get('bad-kind')).resolves.toBeNull();

    const goodResult = await stores.schedules.removeIfPresent('good-kind');
    expect(goodResult).toEqual(GOOD_SCHEDULE);

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
