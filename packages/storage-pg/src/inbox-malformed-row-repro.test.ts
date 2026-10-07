import { captureStderr } from '@alteroid/core';
import type { InboxEvent } from '@alteroid/core';
import { beforeEach, describe, expect, it } from 'vitest';

import type { Db } from './db.js';
import { createPgStoresFromDb, type PgStores } from './index.js';
import { inboxEvents } from './schema.js';
import { createMigratedTestDb } from './test-db.test-support.js';

let db: Db;
let stores: PgStores;

beforeEach(async () => {
  ({ db } = await createMigratedTestDb());
  stores = createPgStoresFromDb(db);
});

const GOOD_EVENT = {
  type: 'human_message',
  id: 'evt-good',
  at: '2026-09-28T00:00:00.000Z',
  text: '正しい合図の本文',
  conversationId: 'conv-1',
} as unknown as InboxEvent;

async function seedWithBadRow(): Promise<void> {
  await stores.inbox.put(GOOD_EVENT, '2026-09-28T00:00:00.000Z');
  await db.insert(inboxEvents).values({
    id: 'evt-bad',
    event: {
      type: 'not-a-real-event-type',
      id: 'evt-bad',
      text: '壊れた合図の本文（跡に出てはいけない）',
    },
    at: new Date('2026-09-27T00:00:00.000Z'),
    deliveries: 0,
  });
}

describe('PgInboxStore — 読めない1行で受信箱ごと落とさない', () => {
  it('peekPending() は正しい行だけを返し、stderr に id だけの跡を残す', async () => {
    await seedWithBadRow();
    let ids: string[] = [];
    const stderr = (
      await captureStderr(async () => {
        ids = (await stores.inbox.peekPending()).entries.map((pending) => pending.event.id);
      })
    ).join('');
    expect(ids).toEqual(['evt-good']);
    expect(stderr).toContain('evt-bad');
    expect(stderr, '壊れた合図の本文そのものは跡に出さない').not.toContain('壊れた合図の本文');
  });

  it('peekPending() は読めない行を unreadable に id・受信時刻・不正な欄名だけで返す（本文は載せない）', async () => {
    await seedWithBadRow();
    let peek: Awaited<ReturnType<typeof stores.inbox.peekPending>> | undefined;
    await captureStderr(async () => {
      peek = await stores.inbox.peekPending();
    });
    expect(peek?.unreadable).toEqual([
      { id: 'evt-bad', at: '2026-09-27T00:00:00.000Z', reason: '不正な欄: event.type' },
    ]);
    expect(JSON.stringify(peek), '壊れた行の本文そのものは載せない').not.toContain(
      '壊れた合図の本文',
    );
    const count = (await stores.inbox.pending()).count;
    expect((peek?.entries.length ?? 0) + (peek?.unreadable.length ?? 0)).toBe(count);
  });

  it('壊れた行しか無い受信箱でも、peekPending() は entries が空・unreadable が1件になる（空とは言わない）', async () => {
    await db.insert(inboxEvents).values({
      id: 'evt-bad',
      event: { type: 'not-a-real-event-type', id: 'evt-bad', text: '壊れた合図の本文' },
      at: new Date('2026-09-27T00:00:00.000Z'),
      deliveries: 0,
    });
    let peek: Awaited<ReturnType<typeof stores.inbox.peekPending>> | undefined;
    await captureStderr(async () => {
      peek = await stores.inbox.peekPending();
    });
    expect(peek?.entries).toEqual([]);
    expect(peek?.unreadable).toHaveLength(1);
  });

  it('claimPending()（起動時の未読の復元）も正しい行だけを配り、読めない行は消さない', async () => {
    await seedWithBadRow();
    let ids: string[] = [];
    await captureStderr(async () => {
      ids = (await stores.inbox.claimPending()).map((pending) => pending.event.id);
    });
    expect(ids).toEqual(['evt-good']);
    const rows = await db.select({ id: inboxEvents.id }).from(inboxEvents);
    expect(rows.map((row) => row.id).sort()).toEqual(['evt-bad', 'evt-good']);
    expect((await stores.inbox.pending()).count).toBe(2);
  });

  it('removeMany() は id で名指しされた読めない行も消し、戻り値に入れる', async () => {
    await seedWithBadRow();
    expect(await stores.inbox.removeMany(['evt-bad'])).toEqual(['evt-bad']);
    const rows = await db.select({ id: inboxEvents.id }).from(inboxEvents);
    expect(rows.map((row) => row.id)).toEqual(['evt-good']);
    expect((await stores.inbox.pending()).count).toBe(1);
  });

  it('remove() も id で名指しされた読めない行を消し、名指しされない行は残す', async () => {
    await seedWithBadRow();
    await stores.inbox.remove('evt-bad');
    const rows = await db.select({ id: inboxEvents.id }).from(inboxEvents);
    expect(rows.map((row) => row.id)).toEqual(['evt-good']);
  });

  it('removeMany() は読めた行と読めない行を1回で消し、無い id は戻り値に入れない', async () => {
    await seedWithBadRow();
    const removed = await stores.inbox.removeMany(['evt-bad', 'evt-good', 'evt-none', 'evt-bad']);
    expect(removed.sort()).toEqual(['evt-bad', 'evt-good']);
    expect(await db.select({ id: inboxEvents.id }).from(inboxEvents)).toEqual([]);
  });

  it('対照: 読めない行が無ければ、今までどおり全部を配り、跡も出さない', async () => {
    await stores.inbox.put(GOOD_EVENT, '2026-09-28T00:00:00.000Z');
    let ids: string[] = [];
    const stderr = (
      await captureStderr(async () => {
        ids = (await stores.inbox.claimPending()).map((pending) => pending.event.id);
      })
    ).join('');
    expect(ids).toEqual(['evt-good']);
    expect(stderr).toBe('');
  });

  it('対照: 読めない行が無ければ unreadable は空', async () => {
    await stores.inbox.put(GOOD_EVENT, '2026-09-28T00:00:00.000Z');
    expect((await stores.inbox.peekPending()).unreadable).toEqual([]);
  });
});
