import { describe, expect, it } from 'vitest';

import { APPROVAL_TRACE_SCAN_LIMIT, traceApproval } from './approval-trace.js';
import type { PendingApproval } from './schema.js';
import type { JournalStore, Stores } from './store.js';
import { createMemoryStores } from './testing.js';
import { CLONE_ACTOR_ID } from './usage.js';

// 答えの後の走査を1本で読む（#5089）。頁をまたいでいた行の数え方が変わらないこと・上限で打ち切ることを測る

function past(ms: number): string {
  return new Date(Date.now() - ms).toISOString();
}

async function answered(stores: Stores, id: string): Promise<void> {
  const approval: PendingApproval = {
    id,
    createdAt: past(2_000),
    question: `質問 ${id}`,
    answeredAt: past(1_000),
    answer: `答え ${id}`,
  };
  await stores.jobs.putApproval(approval);
  await stores.journal.append({ type: 'escalation', question: approval.question, approvalId: id });
  await stores.journal.append({
    type: 'escalation',
    question: approval.question,
    approvalId: id,
    answeredAt: approval.answeredAt,
    answer: approval.answer,
  });
}

/** 答えの後の走査（`tool_use` を含む読み出し）が何本打たれたかを数える */
function countingActionScans(stores: Stores): { stores: Stores; calls: () => number } {
  let calls = 0;
  const journal: JournalStore = {
    ...stores.journal,
    append: (entry) => stores.journal.append(entry),
    list: (query) => stores.journal.list(query),
    get: (id) => stores.journal.get(id),
    oldestAt: () => stores.journal.oldestAt(),
    clear: () => stores.journal.clear(),
    listPage: (query) => {
      if (query?.types?.includes('tool_use') === true) calls += 1;
      return stores.journal.listPage(query);
    },
  };
  return { stores: { ...stores, journal }, calls: () => calls };
}

describe('traceApproval の答えの後の走査（#5089）', () => {
  it('⭐ 500 行を超えても1本で読み、印のある行動と印の無い行動の数え方は変わらない', async () => {
    const stores = createMemoryStores();
    await answered(stores, 'ap-1');
    await stores.journal.append({
      type: 'exchange',
      with: 'self',
      role: 'inbound',
      text: 'ターンの入力: human_answer approvalId=ap-1',
      answeredApprovalId: 'ap-1',
    });
    // 旧来の頁の境目（500 行目）をまたいで、印のある行動と印の無い行動を混ぜる
    for (let i = 0; i < 1_200; i += 1) {
      await stores.journal.append(
        i % 3 === 0
          ? { type: 'tool_use', actor: CLONE_ACTOR_ID, tool: 'Bash', answeredApprovalId: 'ap-1' }
          : { type: 'tool_use', actor: CLONE_ACTOR_ID, tool: 'Read' },
      );
    }

    const { stores: counted, calls } = countingActionScans(stores);
    const trace = await traceApproval(counted, 'ap-1');

    expect(calls()).toBe(1);
    expect(trace?.state).toBe('paired');
    expect(trace?.actions).toHaveLength(400);
    expect(trace?.unstampedInTurn).toBe(800);
    expect(trace?.scanned).toBe(1_201);
    expect(trace?.truncated).toBe(false);
  });

  it('上限（5,000 行）で打ち切り、truncated を立てる', async () => {
    const stores = createMemoryStores();
    await answered(stores, 'ap-2');
    for (let i = 0; i < APPROVAL_TRACE_SCAN_LIMIT + 3; i += 1) {
      await stores.journal.append({ type: 'tool_use', actor: CLONE_ACTOR_ID, tool: 'Read' });
    }
    const trace = await traceApproval(stores, 'ap-2');
    expect(trace?.scanned).toBe(APPROVAL_TRACE_SCAN_LIMIT);
    expect(trace?.truncated).toBe(true);
  });
});
