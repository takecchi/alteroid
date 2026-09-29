import { UnreadableActiveTokenError, UnreadableTokenSettingsError } from '@alteroid/core';
import { PGlite } from '@electric-sql/pglite';
import { drizzle } from 'drizzle-orm/pglite';
import { beforeEach, describe, expect, it } from 'vitest';

import type { Db } from './db.js';
import { createPgStoresFromDb, migrate, type PgStores } from './index.js';
import { agentTokenActive, agentTokenSettings } from './schema.js';

/**
 * issue #2053。`readSettings()` / `readActive()` が読めないときに投げる型を
 * `UnreadableTokenSettingsError` / `UnreadableActiveTokenError`
 * （`@alteroid/core`）へ、fs 実装とそろえて固定する。
 *
 * **この歯には「直す前」に対応する赤が無い**（この2つの型はこの PR で新しく
 * 足したもので、直す前の版にはこの import が解決できる状態が存在しない）。
 * 「投げるか」「値を漏らさないか」の赤/緑は
 * `token-pool-settings-active-unreadable-repro.test.ts`（型を import しない
 * 形）で別に取ってある。
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

describe('PgTokenPoolStore — readSettings() / readActive() が投げる型（issue #2053）', () => {
  it('readSettings() は UnreadableTokenSettingsError を投げる', async () => {
    await db.insert(agentTokenSettings).values({
      id: 'default',
      rotateOn: 'not-a-real-policy',
      cooldownMs: 1000,
      updatedAt: new Date('2026-09-01T00:00:00.000Z'),
    });

    await expect(stores.tokens.readSettings()).rejects.toBeInstanceOf(UnreadableTokenSettingsError);
  });

  it('readActive() は UnreadableActiveTokenError を投げる', async () => {
    await db.insert(agentTokenActive).values({
      id: 'default',
      tokenId: '',
      generation: 1,
      rotatedAt: new Date('2026-09-01T00:00:00.000Z'),
    });

    await expect(stores.tokens.readActive()).rejects.toBeInstanceOf(UnreadableActiveTokenError);
  });
});
