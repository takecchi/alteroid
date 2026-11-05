import { describe, expect, it } from 'vitest';

import type { ManagerSummary } from './manager.js';
import type { JobStatus } from './schema.js';
import { describeSituation } from './situation.js';

const AT = Date.parse('2026-10-11T04:00:00.000Z');

function summary(id: string, status: JobStatus): ManagerSummary {
  return {
    managerId: id,
    status,
    live: status !== 'lost',
    cwd: '/work',
    request: '依頼',
    startedAt: '2026-10-11T00:00:00.000Z',
    updatedAt: '2026-10-11T00:00:00.000Z',
    waiting: [],
  };
}

function situation(managers: ManagerSummary[]): string {
  return describeSituation({
    managers,
    runners: [{ state: 'connected' }],
    tokens: [{ id: 'tok-a', label: '鍵A' }],
    active: { tokenId: 'tok-a' },
    at: AT,
  });
}

const READINGS_HEAD = '**「手が空いている」は「空き枠」ではない**';
const INVARIANT_HEAD = '**⚠️ 枠を理由に仕事を見送らないこと。**';
const UNCHANGED_HEAD = '[system] いまの全体: 前のターンと変化なし';

describe('「いまの全体」の説明文は毎回全文で出す', () => {
  it('同じ材料で何度組んでも、説明文も不変条件も全文で、「変化なし」にも要点にも省略しない', () => {
    const managers = [summary('mgr-1', 'done')];
    for (let i = 0; i < 3; i += 1) {
      const text = situation(managers);
      expect(text).toContain(READINGS_HEAD);
      expect(text).toContain(INVARIANT_HEAD);
      expect(text).not.toContain(UNCHANGED_HEAD);
      expect(text).not.toContain('要点だけにした');
    }
  });
});
