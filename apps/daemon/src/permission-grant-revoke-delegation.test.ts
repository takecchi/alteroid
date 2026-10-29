import {
  createMemoryStores,
  type CloneHost,
  type DelegatedPermissionRuleService,
  type PermissionGrant,
  type PermissionRulesRunnerResult,
} from '@alteroid/core';
import { describe, expect, it } from 'vitest';

import { createApp } from './app.js';

// 許可が取り消されたら、委譲先の許可規則の一覧を runner へ配り直す（#4952）

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

function grant(id: string, rule: string): PermissionGrant {
  return {
    id,
    rule,
    allows: ['x'],
    denies: ['y'],
    approvalId: `ap-${id}`,
    answer: '許可します',
    grantedAt: '2026-01-01T00:00:00.000Z',
    route: { principalKind: 'account', accountId: 'acc-1' },
  };
}

function fakeService(behavior: 'ok' | 'reject' = 'ok') {
  const triggers: string[] = [];
  const service: DelegatedPermissionRuleService = {
    async syncRunner() {
      return null;
    },
    async pushAll(trigger: string): Promise<PermissionRulesRunnerResult[]> {
      triggers.push(trigger);
      if (behavior === 'reject') throw new Error('配れない（テスト）');
      return [];
    },
  };
  return { service, triggers };
}

async function revoke(rule: string, behavior: 'ok' | 'reject' = 'ok', times = 1) {
  const stores = createMemoryStores();
  await stores.permissionGrants.put(grant('g1', rule));
  const { service, triggers } = fakeService(behavior);
  const app = createApp({
    clone: stubCloneHost(),
    stores,
    token: 'test-token',
    shutdown: () => undefined,
    permissionRules: service,
  });
  const statuses: number[] = [];
  for (let i = 0; i < times; i += 1) {
    const response = await app.request('/permission-grants/g1/revoke', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: '{}',
    });
    statuses.push(response.status);
  }
  return { statuses, triggers, stored: await stores.permissionGrants.get('g1') };
}

describe('POST /permission-grants/:id/revoke の後に委譲先へ配る（#4952）', () => {
  it('完全一致の許可を取り消したら配る（2回目の取り消しでは配らない）', async () => {
    const { statuses, triggers, stored } = await revoke('Bash(make test)', 'ok', 2);
    expect(statuses).toEqual([200, 200]);
    expect(stored?.revokedAt).toBeDefined();
    expect(triggers).toEqual(['許可 g1 が取り消された（POST /permission-grants/:id/revoke）']);
  });

  // 元は「前方一致の許可の取り消しでは配らない（委譲先の一覧は変わらない）」で triggers が空であることを固定していた。
  // #5435 で前方一致も委譲先へ載せる（取り消すと一覧が変わる）ので、完全一致と同じく配る形に反転した。
  it('前方一致の許可の取り消しも配る（委譲先の一覧が変わる）', async () => {
    const { triggers } = await revoke('Bash(make:*)');
    expect(triggers).toEqual(['許可 g1 が取り消された（POST /permission-grants/:id/revoke）']);
  });

  it('配れなくても取り消しは通る', async () => {
    const { statuses, triggers, stored } = await revoke('Bash(make test)', 'reject');
    expect(statuses).toEqual([200]);
    expect(triggers).toHaveLength(1);
    expect(stored?.revokedAt).toBeDefined();
  });
});
