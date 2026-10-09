import { verifyEventIdempotencyStoreContract } from '@alteroid/core';
import { afterEach, beforeAll, beforeEach, describe, expect, it } from 'vitest';

import { createPgStoresFromDb, type PgStores } from './index.js';
import { createMigratedPglite, migratedTemplate } from './pglite-template.test-support.js';

let client: Awaited<ReturnType<typeof createMigratedPglite>>['client'];
let stores: PgStores;

beforeAll(async () => {
  await migratedTemplate();
}, 60_000);

beforeEach(async () => {
  const made = await createMigratedPglite();
  client = made.client;
  stores = createPgStoresFromDb(made.db);
});

afterEach(async () => {
  await client.close();
});

describe('EventIdempotencyStore（pg 実装）', () => {
  it('3実装共通の契約を満たす（並行の取得は一意索引で1本だけ）', async () => {
    await expect(
      verifyEventIdempotencyStoreContract(stores.eventIdempotency),
    ).resolves.toBeUndefined();
  });

  it('期限切れの行は取って代わった取得のときに片付く', async () => {
    const scope = { sender: 'integration:k1', source: 'ci', key: 'old' };
    await stores.eventIdempotency.claim(scope, 'e1', '2026-01-01T00:00:00.000Z');
    await stores.eventIdempotency.claim({ ...scope, key: 'new' }, 'e2', '2026-03-01T00:00:00.000Z');
    const rows = await stores.db.execute(`select key from event_idempotency_keys order by key`);
    expect(JSON.stringify(rows)).not.toContain('old');
  });
});
