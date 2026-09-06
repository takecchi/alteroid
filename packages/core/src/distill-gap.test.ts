import { describe, expect, it } from 'vitest';

import { countsAsUndistilledActivity } from './distill-gap.js';
import type { JournalEntry } from './schema.js';

/**
 * `countsAsUndistilledActivity` の allowlist を直に当てる単体の歯。
 *
 * **`clone.test.ts` の「クローン — 蒸留が間に合わなかった区間の検出」は、
 * クローンのループ全体を通した end-to-end の歯を持つが、`token_rotation` /
 * `subagent_stall` のように「器の記帳であって数えない」型を単独で
 * 押す歯は無い。** ここでは `deriveDistillGapFromJournal` の下請けである
 * `countsAsUndistilledActivity` へ直に当て、allowlist に無い型が `false` を
 * 返すことを固定する（Issue #357 — `subagent_stall` を足したとき、
 * `distill-gap.ts` の switch に `case 'subagent_stall': return false;` を
 * 明示で足した。その決定を検算する）。
 */
describe('countsAsUndistilledActivity（allowlist の外は false）', () => {
  it('subagent_stall は「まだ記憶へ移っていない活動」に数えない（器の記帳）', () => {
    const entry: JournalEntry = {
      type: 'subagent_stall',
      id: 'j-1',
      at: '2026-09-06T00:00:00.000Z',
      agentId: 'agent-1',
      agentType: 'worker',
      ownedTaskCount: 1,
      sessionTaskCount: 2,
      wakeupCount: 1,
      outcome: 'woken',
      text: '起こし直した（1回目 / 上限 2）。',
    };

    expect(countsAsUndistilledActivity(entry)).toBe(false);
  });

  it('subagent_stall（limit_reached）も同様に false（outcome で分岐しない）', () => {
    const entry: JournalEntry = {
      type: 'subagent_stall',
      id: 'j-2',
      at: '2026-09-06T00:00:00.000Z',
      agentId: 'agent-1',
      ownedTaskCount: 1,
      sessionTaskCount: 1,
      wakeupCount: 2,
      outcome: 'limit_reached',
      text: '起こし直さなかった。',
    };

    expect(countsAsUndistilledActivity(entry)).toBe(false);
  });

  // **対照。** allowlist に在る型は今までどおり数える——この歯だけで
  // 「何を渡しても false を返す壊れた実装」に強くならないようにする。
  it('（対照）exchange with!==self は数える', () => {
    const entry: JournalEntry = {
      type: 'exchange',
      id: 'j-3',
      at: '2026-09-06T00:00:00.000Z',
      with: 'human',
      role: 'inbound',
      text: '人間からの発言',
    };

    expect(countsAsUndistilledActivity(entry)).toBe(true);
  });
});
