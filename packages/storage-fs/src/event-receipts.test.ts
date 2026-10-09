import { readFile, writeFile } from 'node:fs/promises';
import { join } from 'node:path';

import { verifyEventReceiptStoreContract } from '@alteroid/core';
import { describe, expect, it } from 'vitest';

import { makeTempDir } from '../../../vitest.tmpdir.js';

import { createFsStores } from './index.js';

describe('EventReceiptStore（fs 実装）', () => {
  it('3実装共通の契約を満たす', async () => {
    const stores = createFsStores(await makeTempDir('alteroid-test-'));
    await expect(verifyEventReceiptStoreContract(stores.eventReceipts)).resolves.toBeUndefined();
  });

  it('読めないファイルを空として上書きせず、記録を断る', async () => {
    const root = await makeTempDir('alteroid-test-');
    const stores = createFsStores(root);
    const file = join(root, 'jobs', 'event-receipts.json');
    await stores.eventReceipts.recordEventReceipt({
      scope: 'integration:k-a',
      source: 'virchamate',
      idempotencyKey: 'delivery-1',
      eventId: 'ev-1',
      at: '2026-10-01T00:00:00.000Z',
    });
    await writeFile(file, '{"receipts":[{"scope":1}]}\n');

    await expect(
      stores.eventReceipts.recordEventReceipt({
        scope: 'integration:k-a',
        source: 'virchamate',
        idempotencyKey: 'delivery-2',
        eventId: 'ev-2',
        at: '2026-10-01T00:00:01.000Z',
      }),
    ).rejects.toThrow(/読めない/);
    expect(await readFile(file, 'utf8')).toBe('{"receipts":[{"scope":1}]}\n');
  });
});
