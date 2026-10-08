import { describe, expect, it } from 'vitest';

import type { ManagerSummary } from './manager.js';
import type { JobStatus } from './schema.js';
import { describeSituation } from './situation.js';

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

    expect(text).toContain('枠(利用上限)で止まっているのは 1 本');
    expect(text).toContain(
      'セッションそのものが `failed` / `lost` / `stopped` として畳まれることがある',
    );
    expect(text).toContain('#1796');
    expect(text).toContain('通常は鍵が回ってこの委譲が起こし直されるまで');
  });

  it('usageStoppedAt が1本以上あれば、status: stopped でも同じ例外を明記する', () => {
    const manager = { ...summary('mgr-1', 'stopped'), usageStoppedAt: '2026-09-19T09:00:00.000Z' };

    const text = describeSituation({ managers: [manager], runners: [] });

    expect(text).toContain('枠(利用上限)で止まっているのは 1 本');
    expect(text).toContain(
      'セッションそのものが `failed` / `lost` / `stopped` として畳まれることがある',
    );
    expect(text).toContain('#1796');
  });

  it('⭐ 陰性対照。usageStoppedAt が無ければ、この断り書きは1文字も出ない', () => {
    const manager = summary('mgr-1', 'running');

    const text = describeSituation({ managers: [manager], runners: [] });

    expect(text).not.toContain('枠(利用上限)で止まっている');
    expect(text).not.toContain('#1796');
  });
});
