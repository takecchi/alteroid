import { verifyEventIdempotencyStoreContract } from '@alteroid/core';
import { describe, expect, it } from 'vitest';

import { makeTempDir } from '../../../vitest.tmpdir.js';

import { createFsStores } from './index.js';

describe('EventIdempotencyStore（fs 実装）', () => {
  it('3実装共通の契約を満たす', async () => {
    const stores = createFsStores(await makeTempDir('alteroid-test-'));
    await expect(
      verifyEventIdempotencyStoreContract(stores.eventIdempotency),
    ).resolves.toBeUndefined();
  });

  it('別のインスタンス（再起動）でも覚えている', async () => {
    const root = await makeTempDir('alteroid-test-');
    const scope = { sender: 'integration:k1', source: 'ci', key: 'run-1' };
    const at = '2026-03-01T00:00:00.000Z';
    await createFsStores(root).eventIdempotency.claim(scope, 'e1', at);
    expect(await createFsStores(root).eventIdempotency.claim(scope, 'e2', at)).toEqual({
      status: 'duplicate',
      eventId: 'e1',
    });
  });
});
