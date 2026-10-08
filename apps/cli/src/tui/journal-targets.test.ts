import { JOURNAL_ENTRY_TYPES, type JournalEntry } from '@alteroid/core';
import { describe, expect, it } from 'vitest';

import { affectsApprovals, affectsCounts, affectsManagers } from './journal-targets.js';

const at = '2026-01-01T00:00:00.000Z';
const toolUse = (actor: string) =>
  ({ id: 't', type: 'tool_use', at, actor, tool: 'Bash' }) as never;
const exchange = (with_: string, role = 'outbound') =>
  ({ id: 'x', type: 'exchange', at, with: with_, role, text: 'x' }) as never;

// 種別ごとの「関係あり」の表（#3987）。日誌の種別が増えたら、ここへ足して判断を残させる
const TABLE: Record<
  (typeof JOURNAL_ENTRY_TYPES)[number],
  { approvals: boolean; managers: boolean }
> = {
  exchange: { approvals: false, managers: true }, // 中身（相手）で決まる。本体が無ければ動く側
  decision: { approvals: false, managers: true }, // 委譲が lost になる遷移はこれで積まれる
  escalation: { approvals: true, managers: true }, // 承認の発生・回答・取り下げ
  tool_use: { approvals: false, managers: true }, // 中身（actor）で決まる。本体が無ければ動く側
  memory_update: { approvals: false, managers: false },
  daily_report: { approvals: false, managers: false },
  external_event: { approvals: false, managers: true },
  worker_wait: { approvals: false, managers: false },
  turn_usage: { approvals: false, managers: false },
  token_rotation: { approvals: false, managers: false },
  subagent_stall: { approvals: false, managers: false },
  context_usage: { approvals: false, managers: false },
  inbox_flow: { approvals: false, managers: false },
  github_observation: { approvals: false, managers: false },
};

describe('journal-targets（どの出来事で取り直すか。#3987）', () => {
  it('日誌の全種別に判断が書いてある（種別が増えたらここが赤くなる）', () => {
    expect(Object.keys(TABLE).sort()).toEqual([...JOURNAL_ENTRY_TYPES].sort());
  });

  it.each(JOURNAL_ENTRY_TYPES)('%s（本体なし）は表のとおり', (type) => {
    expect(affectsApprovals(type)).toBe(TABLE[type].approvals);
    expect(affectsManagers(type, null)).toBe(TABLE[type].managers);
    expect(affectsCounts(type, null)).toBe(TABLE[type].approvals || TABLE[type].managers);
  });

  it('件数が変わる出来事は取りこぼさない（委譲の開始・終了・返信、承認の発生・回答）', () => {
    // 委譲の開始・返信・停止は `exchange(with: manager)` として積まれる
    for (const role of ['outbound', 'inbound']) {
      expect(affectsManagers('exchange', exchange('manager', role) as JournalEntry)).toBe(true);
      expect(affectsCounts('exchange', exchange('manager', role) as JournalEntry)).toBe(true);
    }
    // 担い手・作業者の道具実行は、実行中の状態を動かす
    for (const actor of ['manager:m1', 'worker:m1:a', 'manager:m1:sub:x']) {
      expect(affectsManagers('tool_use', toolUse(actor) as JournalEntry)).toBe(true);
    }
    // 承認の発生・回答はどちらも escalation
    expect(affectsApprovals('escalation')).toBe(true);
    expect(affectsManagers('escalation', null)).toBe(true);
    // lost への遷移
    expect(affectsManagers('decision', null)).toBe(true);
  });

  it('クローン自身の道具実行と人との会話は、件数を動かさない', () => {
    for (const actor of ['clone', 'clone:sub:reviewer']) {
      expect(affectsCounts('tool_use', toolUse(actor) as JournalEntry)).toBe(false);
    }
    expect(affectsCounts('exchange', exchange('human') as JournalEntry)).toBe(false);
    expect(affectsCounts('exchange', exchange('self') as JournalEntry)).toBe(false);
  });
});
