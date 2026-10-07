import { UnreadableActiveTokenError, UnreadableTokenSettingsError } from '@alteroid/core';
import { beforeEach, describe, expect, it } from 'vitest';

import type { Db } from './db.js';
import { createPgStoresFromDb, type PgStores } from './index.js';
import { agentTokenActive, agentTokenSettings } from './schema.js';
import { createMigratedTestDb } from './test-db.test-support.js';

let db: Db;
let stores: PgStores;

beforeEach(async () => {
  ({ db } = await createMigratedTestDb());
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
