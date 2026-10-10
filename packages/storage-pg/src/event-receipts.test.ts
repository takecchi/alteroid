import { verifyEventReceiptStoreContract } from '@alteroid/core';
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

describe('EventReceiptStore（pg 実装）', () => {
  it('3実装共通の契約を満たす', async () => {
    await expect(verifyEventReceiptStoreContract(stores.eventReceipts)).resolves.toBeUndefined();
  });

  it('同時に来た同じ組の記録は、どちらも同じ1行を返す', async () => {
    const make = (eventId: string) => ({
      scope: 'integration:k-a',
      source: 'virchamate',
      idempotencyKey: 'delivery-1',
      eventId,
      at: '2026-10-01T00:00:00.000Z',
    });
    const results = await Promise.all([
      stores.eventReceipts.recordEventReceipt(make('ev-1')),
      stores.eventReceipts.recordEventReceipt(make('ev-2')),
    ]);
    expect(results[0].eventId).toBe(results[1].eventId);
  });
});
