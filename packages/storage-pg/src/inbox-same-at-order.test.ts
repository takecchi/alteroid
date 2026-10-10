import { createMemoryStores, type InboxEvent } from '@alteroid/core';
import { beforeEach, describe, expect, it } from 'vitest';

import type { Db } from './db.js';
import { createPgStoresFromDb, type PgStores } from './index.js';
import { createMigratedTestDb } from './test-db.test-support.js';

let db: Db;
let stores: PgStores;

beforeEach(async () => {
  ({ db } = await createMigratedTestDb());
  stores = createPgStoresFromDb(db);
});

const at = '2026-01-01T00:00:00.000Z';
const ev = (id: string): InboxEvent => ({
  type: 'human_message',
  id,
  at,
  conversationId: 'c',
  text: id,
});
const name = (n: number): string => `evt-${String(n).padStart(3, '0')}`;

// remove で空いた行の位置へ再 put の行が入っても、同着の並びは末尾のまま。
async function reproduce(store: PgStores['inbox']): Promise<void> {
  for (let i = 0; i < 40; i += 1) await store.put(ev(name(i)), at);
  await store.claimPending();
  await store.remove(name(36));
  await store.claimPending();
  await store.put(ev('evt-new'), at);
  await store.put(ev(name(0)), at);
}

describe('InboxStore — 同着の並びは remove と再 put を挟んでも行の位置に依らない（#4059）', () => {
  it('claimPending() は再 put した合図を末尾で返す（in-memory と同じ並び）', async () => {
    const memory = createMemoryStores().inbox;
    await reproduce(memory);
    await reproduce(stores.inbox);

    const expected = (await memory.claimPending()).map((entry) => entry.event.id);
    const actual = (await stores.inbox.claimPending()).map((entry) => entry.event.id);
    expect(expected.at(-1)).toBe(name(0));
    expect(actual).toEqual(expected);
  });

  it('peekPending() も同じ並びになる', async () => {
    const memory = createMemoryStores().inbox;
    await reproduce(memory);
    await reproduce(stores.inbox);

    const expected = (await memory.peekPending()).entries.map((entry) => entry.event.id);
    const actual = (await stores.inbox.peekPending()).entries.map((entry) => entry.event.id);
    expect(actual).toEqual(expected);
  });
});
