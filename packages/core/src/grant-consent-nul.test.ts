import { describe, expect, it } from 'vitest';

import { setup, waitFor } from './clone-test-harness.js';
import type { PendingApproval } from './schema.js';
import { createMemoryStores } from './testing.js';

describe('許可の同意の検査と NUL（残る値と同じ値で判定する。issue #3385）', () => {
  const approval = {
    id: 'ap-perm-nul',
    createdAt: new Date().toISOString(),
    question: '以降 Bash(gh release edit:*) を聞かずに通してよいか',
    permissionRequest: {
      rule: 'Bash(gh release edit:*)',
      allows: ['gh release edit'],
      denies: ['gh release edit; rm -rf /'],
    },
  };
  const VIA = { kind: 'account', accountId: 'acc-1' } as const;

  async function answerAndRead(answer: string) {
    const s = setup();
    await s.stores.jobs.putApproval(approval);
    await s.clone.answerApproval('ap-perm-nul', answer, VIA);
    const stored = await s.stores.jobs.getApproval('ap-perm-nul');
    const grants = await s.stores.permissionGrants.list();
    const decisions = (await s.stores.journal.list({ types: ['decision'] })).flatMap((entry) =>
      entry.type === 'decision' ? [entry.decision] : [],
    );
    await s.clone.stop();
    return { stored, grants, decisions };
  }

  it.each([
    ['先頭の NUL', '\u0000許可します'],
    ['途中の NUL', '許\u0000可します'],
    ['末尾の NUL と前後の空白', ' \u0000許可します\u0000 '],
    ['NUL が複数', '\u0000許\u0000\u0000可\u0000します'],
  ])('記録に残る回答が定型文ちょうどなら、許可も1件記録される——%s', async (_label, answer) => {
    const { stored, grants, decisions } = await answerAndRead(answer);

    expect(stored?.answer?.trim()).toBe('許可します');
    expect(grants).toHaveLength(1);
    expect(grants[0]?.answer).toBe(stored?.answer);
    expect(grants[0]?.rule).toBe('Bash(gh release edit:*)');
    expect(decisions).toContain('許可を記録した: Bash(gh release edit:*)');
  });

  it('NUL の無い定型文は今までどおり同意になる（前後の空白だけ trim）', async () => {
    const { grants } = await answerAndRead('  許可します ');
    expect(grants).toHaveLength(1);
  });

  it.each([
    ['句点付き', '\u0000許可します。'],
    ['別の言い回し', '\u0000やめておきます'],
    ['NUL だけ', '\u0000'],
    ['NUL を挟んでも定型文にならない', '許\u0000可'],
  ])('NUL を落としても定型文と違うものは、同意にならない——%s', async (_label, answer) => {
    const { grants, decisions } = await answerAndRead(answer);
    expect(grants).toHaveLength(0);
    expect(decisions).toContain('許可を記録しなかった: Bash(gh release edit:*)');
  });

  it('回答の経路から作った許可と、起動時の拾い直しで作った許可は、同じ回答なら同じ結果になる', async () => {
    const viaAnswer = await answerAndRead('\u0000許可します');

    const stores = createMemoryStores();
    const row = {
      ...approval,
      answeredAt: '2026-09-01T00:05:00.000Z',
      answer: viaAnswer.stored?.answer ?? '',
      answeredVia: VIA,
      answerDelivery: 'pending',
    } as PendingApproval;
    await stores.jobs.putApproval(row);
    const s = setup(undefined, stores);
    await waitFor(
      async () => (await stores.permissionGrants.list()).length > 0,
      '許可の記録が作られる',
    );
    const viaReconcile = await stores.permissionGrants.list();
    await s.clone.stop();

    const pick = (grants: typeof viaReconcile) =>
      grants.map(({ rule, allows, denies, approvalId, answer, route }) => ({
        rule,
        allows,
        denies,
        approvalId,
        answer,
        route,
      }));
    expect(pick(viaReconcile)).toEqual(pick(viaAnswer.grants));
    expect(viaReconcile).toHaveLength(1);
  });
});
