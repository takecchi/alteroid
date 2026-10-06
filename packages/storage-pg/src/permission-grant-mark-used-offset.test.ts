import type { PermissionGrant } from '@alteroid/core';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import { createPgStoresFromDb, type PgStores } from './index.js';
import { createMigratedTestDb, type TestDbHandle } from './test-db.test-support.js';

/** 実時刻 2026-09-27T00:00:00Z。文字列では LATER_Z より後ろに来る。 */
const EARLIER_JST = '2026-09-27T09:00:00+09:00';
/** 実時刻 2026-09-27T01:00:00Z。 */
const LATER_Z = '2026-09-27T01:00:00Z';

const grant: PermissionGrant = {
  id: 'g1',
  rule: 'Bash(gh release edit:*)',
  allows: ['gh release edit'],
  denies: [],
  approvalId: 'ap-g1',
  answer: '許可します',
  grantedAt: '2026-09-26T00:00:00Z',
  route: { principalKind: 'account', accountId: 'acc-1' },
};

let client: TestDbHandle;
let stores: PgStores;

beforeEach(async () => {
  const migrated = await createMigratedTestDb();
  client = migrated.client;
  stores = createPgStoresFromDb(migrated.db);
});

afterEach(async () => {
  await client.close();
});

describe('markUsed はオフセット表記が混ざっても実時刻で比べる（pg）', () => {
  it('JST 表記の lastUsedAt より実時刻で後の Z の時刻は lastUsedAt を進める', async () => {
    await stores.permissionGrants.put({ ...grant, lastUsedAt: EARLIER_JST });
    expect(await stores.permissionGrants.markUsed('g1', LATER_Z)).toBe(true);
    expect((await stores.permissionGrants.get('g1'))?.lastUsedAt).toBe(LATER_Z);
  });
});
