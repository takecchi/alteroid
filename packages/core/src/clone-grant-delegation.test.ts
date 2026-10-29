import { describe, expect, it } from 'vitest';

import { setup } from './clone-test-harness.js';
import type {
  DelegatedPermissionRuleService,
  PermissionRulesRunnerResult,
} from './delegated-permission-rules.js';

// 人間が request_permission に許可と答えて許可が記録されたら、委譲先へ配る（#4952）

const VIA = { kind: 'account', accountId: 'acc-1' } as const;

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

async function answerPermission(rule: string, service: DelegatedPermissionRuleService) {
  const s = setup(undefined, undefined, {}, {}, { permissionRuleService: service });
  await s.stores.jobs.putApproval({
    id: 'ap-perm',
    createdAt: new Date().toISOString(),
    question: `以降 ${rule} を聞かずに通してよいか`,
    permissionRequest: { rule, allows: ['make test'], denies: ['make test; rm -rf /'] },
  });
  await s.clone.answerApproval('ap-perm', '許可します', VIA);
  const grants = await s.stores.permissionGrants.list();
  await s.clone.stop();
  return grants;
}

describe('許可の記録の後に委譲先へ配る（#4952）', () => {
  it('完全一致の許可が記録されたら配る', async () => {
    const { service, triggers } = fakeService();
    const grants = await answerPermission('Bash(make test)', service);
    expect(grants).toHaveLength(1);
    expect(triggers).toEqual([
      `許可 ${grants[0]?.id ?? ''} が記録された（人間の request_permission への回答）`,
    ]);
  });

  // 元は「前方一致の許可では配らない（委譲先の一覧は変わらない）」で triggers が空であることを固定していた。
  // #5435 で前方一致も委譲先へ載せる（一覧が変わる）ので、完全一致と同じく配る形に反転した。
  it('前方一致の許可も配る（委譲先の一覧が変わる）', async () => {
    const { service, triggers } = fakeService();
    const grants = await answerPermission('Bash(make:*)', service);
    expect(grants).toHaveLength(1);
    expect(triggers).toEqual([
      `許可 ${grants[0]?.id ?? ''} が記録された（人間の request_permission への回答）`,
    ]);
  });

  it('配れなくても許可の記録は通る', async () => {
    const { service, triggers } = fakeService('reject');
    const grants = await answerPermission('Bash(make test)', service);
    expect(triggers).toHaveLength(1);
    expect(grants).toHaveLength(1);
    expect(grants[0]?.rule).toBe('Bash(make test)');
  });
});
