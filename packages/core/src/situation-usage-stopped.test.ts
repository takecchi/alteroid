import { describe, expect, it } from 'vitest';

import type { ManagerSummary } from './manager.js';
import type { JobStatus } from './schema.js';
import { describeSituation } from './situation.js';

/**
 * Issue #1796: `situation.ts` の `USAGE_STOPPED_NOTICE`
 * （`describeSituation` の集計節）も、`describeUsageStopped`（`tools.ts`）と
 * 同じ「セッションは生きているので status は動かさない（それは仕様である）」
 * を言い切っていた。`usageStoppedAt` を下ろす前にセッションそのものが
 * `failed` / `lost` として畳まれることがある（同じ Issue）ため、この断定は
 * 集計節にもそのまま効く——直したのは、この本文に例外（#1796）を明記した
 * ことだけである（本数の内訳を新設してはいない。`manager_list` の各行の
 * 注記で個々の委譲は見分けられる、という案内を残した）。
 *
 * **既存の `situation.test.ts` は触らない。** 同じファイルを PR #1855
 * （#1794 のトークン内訳の分割）が同時に触っているため、そちらと衝突しない
 * 新規ファイルにこの歯を置く。
 */
function summary(id: string, status: JobStatus): ManagerSummary {
  return {
    managerId: id,
    status,
    live: true,
    cwd: '/work',
    request: '依頼',
    startedAt: '2026-09-05T00:00:00.000Z',
    updatedAt: '2026-09-05T00:00:00.000Z',
    waiting: [],
  };
}

describe('describeSituation: USAGE_STOPPED_NOTICE は「ずっと done/running のまま」を保証と言い切らない（#1796）', () => {
  it('usageStoppedAt が1本以上あれば、#1796 の例外（failed/lost で畳まれうる）を明記する', () => {
    const manager = { ...summary('mgr-1', 'failed'), usageStoppedAt: '2026-09-19T09:00:00.000Z' };

    const text = describeSituation({ managers: [manager], runners: [] });

    // 本数そのものは引き続き出す。
    expect(text).toContain('枠(利用上限)で止まっているのは 1 本');
    // **例外を明記している**——「ずっと done/running のまま座る」だけを言い切らない。
    expect(text).toContain('セッションそのものが `failed` / `lost` として畳まれることがある');
    expect(text).toContain('#1796');
    // 断定そのものは「通常は」に弱めてある。
    expect(text).toContain('通常は鍵が回ってこの委譲が起こし直されるまで');
  });

  it('⭐ 陰性対照。usageStoppedAt が無ければ、この断り書きは1文字も出ない', () => {
    const manager = summary('mgr-1', 'running');

    const text = describeSituation({ managers: [manager], runners: [] });

    expect(text).not.toContain('枠(利用上限)で止まっている');
    expect(text).not.toContain('#1796');
  });
});
