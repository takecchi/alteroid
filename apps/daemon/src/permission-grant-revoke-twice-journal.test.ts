import {
  createMemoryStores,
  type CloneHost,
  type PermissionGrant,
  type Stores,
} from '@alteroid/core';
import { createFsStores } from '@alteroid/storage-fs';
import { createPgStoresFromDb } from '@alteroid/storage-pg';
import { beforeAll, describe, expect, it } from 'vitest';

import { makeTempDir } from '../../../vitest.tmpdir.js';
import { createApp } from './app.js';
import { createMigratedPglite, migratedTemplate } from './pglite-template.test-support.js';

function stubCloneHost(): CloneHost {
  return {
    postPersisted: async () => 'persisted',
    post: () => undefined,
    dropQueuedInboxEvents: async () => 0,
    subscribe: () => () => undefined,
    endConversation: async () => undefined,
    answerApproval: async () => undefined,
    managers: {} as CloneHost['managers'],
    usageBlocked: false,
    usageReleasePending: false,
    usageBlockedResetsAt: undefined,
    usageBlockedTokenId: undefined,
    recycleSessionForToken: () => undefined,
    stop: async () => undefined,
  };
}

const GRANT: PermissionGrant = {
  id: 'grant-1',
  rule: 'Bash(git status:*)',
  allows: ['git status'],
  denies: ['git push'],
  approvalId: 'approval-1',
  answer: '許可します',
  grantedAt: '2026-01-01T00:00:00.000Z',
  route: { principalKind: 'account', accountId: 'acc-1' },
};

describe('POST /permission-grants/:id/revoke を2回呼ぶ（3実装。issue #3362）', () => {
  beforeAll(async () => {
    await migratedTemplate();
  }, 30_000);

  const implementations: Array<[string, () => Promise<Stores>]> = [
    ['インメモリ実装', async () => createMemoryStores()],
    ['fs 実装', async () => createFsStores(await makeTempDir('alteroid-test-'))],
    [
      'pg 実装（PGlite）',
      async () => {
        const { db } = await createMigratedPglite();
        return createPgStoresFromDb(db);
      },
    ],
  ];

  it.each(implementations)(
    '操作は毎回残すが、「取り消した」は1件。2回目は「既に取り消し済みだった」と書き分ける——%s',
    async (_label, createStores) => {
      const stores = await createStores();
      await stores.permissionGrants.put(GRANT);
      const app = createApp({
        clone: stubCloneHost(),
        stores,
        token: 'test-token',
        shutdown: () => undefined,
      });
      const call = () =>
        app.request('/permission-grants/grant-1/revoke', {
          method: 'POST',
          headers: { 'content-type': 'application/json' },
          body: '{}',
        });
      const decisions = async () =>
        (await stores.journal.list({ types: ['decision'] })).flatMap((entry) =>
          entry.type === 'decision' ? [entry.decision] : [],
        );

      expect((await call()).status).toBe(200);
      const firstRevokedAt = (await stores.permissionGrants.get('grant-1'))?.revokedAt;
      expect(firstRevokedAt).toBeDefined();
      expect(await decisions()).toEqual([`許可を取り消した: ${GRANT.rule}`]);

      expect((await call()).status).toBe(200);
      expect((await stores.permissionGrants.get('grant-1'))?.revokedAt).toBe(firstRevokedAt);

      const afterSecond = await decisions();
      expect(afterSecond).toHaveLength(2);
      expect(afterSecond.filter((d) => d.startsWith('許可を取り消した'))).toHaveLength(1);
      const second = afterSecond.find((d) => !d.startsWith('許可を取り消した'));
      expect(second).toContain('既に取り消し済みだった');
      expect(second).toContain('revokedAt は変えていない');
      expect(second).toContain(GRANT.rule);

      expect((await call()).status).toBe(200);
      const afterThird = await decisions();
      expect(afterThird).toHaveLength(3);
      expect(afterThird.filter((d) => d.startsWith('許可を取り消した'))).toHaveLength(1);
      expect((await stores.permissionGrants.get('grant-1'))?.revokedAt).toBe(firstRevokedAt);
    },
  );

  it('無い許可の取り消しは 404 で、日誌は書かない', async () => {
    const stores = createMemoryStores();
    const app = createApp({
      clone: stubCloneHost(),
      stores,
      token: 'test-token',
      shutdown: () => undefined,
    });
    const response = await app.request('/permission-grants/nope/revoke', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: '{}',
    });
    expect(response.status).toBe(404);
    expect(await stores.journal.list({ types: ['decision'] })).toHaveLength(0);
  });
});
