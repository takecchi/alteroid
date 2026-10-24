import { describe, expect, it } from 'vitest';

import { setup, waitFor } from './clone-test-harness.js';
import type {
  DelegatedPermissionRuleService,
  PermissionRulesRunnerResult,
} from './delegated-permission-rules.js';
import type { JournalEntryInput, PendingApproval, PermissionGrant } from './schema.js';
import type { Stores } from './store.js';
import { createMemoryStores } from './testing.js';

// 許可の記録は日誌を先に書く（#5241）。許可は分類器の判定より先に効く能力を広げる変更なので、日誌に1行も無いまま効かせない

const VIA = { kind: 'account', accountId: 'acc-1' } as const;
const RULE = 'Bash(make test)';
const GRANT_LINE = `許可を記録する: ${RULE}`;

const APPROVAL = {
  id: 'ap-perm',
  createdAt: new Date().toISOString(),
  question: `以降 ${RULE} を聞かずに通してよいか`,
  permissionRequest: { rule: RULE, allows: ['make test'], denies: ['make test; rm -rf /'] },
};

function isGrantLine(entry: JournalEntryInput): boolean {
  return entry.type === 'decision' && entry.decision === GRANT_LINE;
}

type Hooks = {
  /** この行の日誌への追記を落とす */
  failJournalWhen?: (entry: JournalEntryInput) => boolean;
  /** `permissionGrants.put` の差し替え（元の `put` を渡す） */
  put?: (grant: PermissionGrant, base: Stores['permissionGrants']) => Promise<void>;
};

function storesWith(hooks: Hooks): Stores {
  const base = createMemoryStores();
  return {
    ...base,
    journal: {
      ...base.journal,
      async append(entry) {
        if (hooks.failJournalWhen?.(entry) === true) throw new Error('日誌が書けない（テスト）');
        return base.journal.append(entry);
      },
    },
    permissionGrants: {
      ...base.permissionGrants,
      async put(grant) {
        if (hooks.put !== undefined) return hooks.put(grant, base.permissionGrants);
        return base.permissionGrants.put(grant);
      },
    },
  };
}

async function decisions(stores: Stores): Promise<string[]> {
  return (await stores.journal.list({ types: ['decision'], limit: 100 })).flatMap((entry) =>
    entry.type === 'decision' ? [entry.decision] : [],
  );
}

function fakeService() {
  const triggers: string[] = [];
  const service: DelegatedPermissionRuleService = {
    async syncRunner() {
      return null;
    },
    async pushAll(trigger: string): Promise<PermissionRulesRunnerResult[]> {
      triggers.push(trigger);
      return [];
    },
  };
  return { service, triggers };
}

async function answer(stores: Stores, service?: DelegatedPermissionRuleService) {
  const s = setup(
    undefined,
    stores,
    {},
    {},
    service === undefined ? {} : { permissionRuleService: service },
  );
  await stores.jobs.putApproval(APPROVAL);
  await s.clone.answerApproval('ap-perm', '許可します', VIA);
  return s;
}

describe('許可の記録は日誌を先に書く（#5241）', () => {
  it('日誌に書けないとき許可を書かない。人間への回答は通る', async () => {
    const stores = storesWith({ failJournalWhen: isGrantLine });
    const { service, triggers } = fakeService();
    const s = await answer(stores, service);

    expect(await stores.permissionGrants.list()).toEqual([]);
    expect((await stores.jobs.getApproval('ap-perm'))?.answer).toBe('許可します');
    expect(await decisions(stores)).not.toContain(GRANT_LINE);
    // 委譲先へも配らない
    expect(triggers).toEqual([]);

    await s.clone.stop();
  });

  it('許可を書く瞬間に、日誌に先の行が既に在る', async () => {
    let seenAtPut: string[] | undefined;
    const stores: Stores = storesWith({
      async put(grant, base) {
        seenAtPut = await decisions(stores);
        await base.put(grant);
      },
    });
    const s = await answer(stores);

    expect(seenAtPut).toContain(GRANT_LINE);
    expect(await stores.permissionGrants.list()).toHaveLength(1);

    await s.clone.stop();
  });

  it('put が投げたとき、先の行を打ち消す行が足される。許可は無い', async () => {
    const stores = storesWith({
      async put() {
        throw new Error('put が落ちた（テスト）');
      },
    });
    const { service, triggers } = fakeService();
    const s = await answer(stores, service);

    const lines = await decisions(stores);
    expect(lines).toContain(GRANT_LINE);
    // 並びは store の list の向きに依らないよう見ない（先に書く順は上の「put の瞬間」の歯が持つ）
    expect(
      lines.some((line) => line.startsWith('直前の「許可を記録する」の行は効いていない')),
    ).toBe(true);
    expect(await stores.permissionGrants.list()).toEqual([]);
    expect(triggers).toEqual([]);

    await s.clone.stop();
  });

  it('委譲先へ配るのは、許可が書けた回だけ', async () => {
    const stores = storesWith({});
    const { service, triggers } = fakeService();
    const s = await answer(stores, service);

    const grants = await stores.permissionGrants.list();
    expect(grants).toHaveLength(1);
    expect(triggers).toEqual([
      `許可 ${grants[0]?.id ?? ''} が記録された（人間の request_permission への回答）`,
    ]);

    await s.clone.stop();
  });

  it('起動時の拾い直しでも、日誌に書けなければ許可を作らない', async () => {
    const stores = storesWith({ failJournalWhen: isGrantLine });
    await stores.jobs.putApproval({
      ...APPROVAL,
      answeredAt: '2026-09-01T00:05:00.000Z',
      answer: '許可します',
      answeredVia: VIA,
      answerDelivery: 'pending',
    } as PendingApproval);

    const s = setup(undefined, stores);
    await waitFor(
      async () => (await stores.jobs.getApproval('ap-perm'))?.answerDelivery === 'delivered',
      '拾い直しで行が delivered になる',
    );

    expect(await stores.permissionGrants.list()).toEqual([]);

    await s.clone.stop();
  });
});
