import { describe, expect, it } from 'vitest';

import {
  classifyManagerActivity,
  describeManagerActivityForFlush,
  describeReportDrift,
  type ManagerActivityInput,
  type ManagerActivityKind,
} from './manager-activity.js';

function pending(id = 'toolu_1'): ManagerActivityInput['toolUseStallPending'] {
  return [{ id, name: 'AskUserQuestion' }];
}

// モジュール scope に1つだけ置く: 2つの describe が同じ一覧を回すので、一覧を2つ持つと状態が増えたとき片方だけ更新されてずれる。
const ALL_MANAGER_ACTIVITY_KINDS = {
  'stalled-turn-end': true,
  'stalled-tool-use': true,
  'tool-running': true,
  active: true,
  unknown: true,
} satisfies Record<NonNullable<ManagerActivityKind>, true>;

describe('classifyManagerActivity — 5状態の網羅（依頼者の守る線: 「無い」の種類を潰さない）', () => {
  it('5状態すべてがこの一覧に載っている（Object.keys で数え上げる歯）', () => {
    expect(Object.keys(ALL_MANAGER_ACTIVITY_KINDS).sort()).toEqual(
      ['active', 'stalled-tool-use', 'stalled-turn-end', 'tool-running', 'unknown'].sort(),
    );
  });

  describe('判定できない（unknown）', () => {
    it('turnEndReason も toolUseStallPending も無ければ unknown', () => {
      expect(classifyManagerActivity({ waitingCount: 0 })).toBe('unknown');
    });

    it('waiting が非空でも、観測そのものが無ければ unknown のまま（active へ倒さない）', () => {
      expect(classifyManagerActivity({ waitingCount: 3 })).toBe('unknown');
    });
  });

  describe('止まっている（ターン終わり型）', () => {
    it('turnEndedAt が無い ⟹ 止まっている（分からないだけで症状ではないとは言えない）', () => {
      expect(
        classifyManagerActivity({
          turnEndReason: 'end_turn',
          waitingCount: 0,
        }),
      ).toBe('stalled-turn-end');
    });

    it('lastReportAt が無い ⟹ 止まっている', () => {
      expect(
        classifyManagerActivity({
          turnEndReason: 'end_turn',
          turnEndedAt: '2026-08-28T09:10:00.000Z',
          waitingCount: 0,
        }),
      ).toBe('stalled-turn-end');
    });

    it('turnEndedAt > lastReportAt ⟹ 止まっている', () => {
      expect(
        classifyManagerActivity({
          turnEndReason: 'end_turn',
          turnEndedAt: '2026-08-28T09:10:00.000Z',
          lastReportAt: '2026-08-28T09:00:00.000Z',
          waitingCount: 0,
        }),
      ).toBe('stalled-turn-end');
    });

    it('turnEndedAt が Date.parse できない ⟹ 止まっている（「分からない」を「症状ではない」へ倒さない）', () => {
      expect(
        classifyManagerActivity({
          turnEndReason: 'end_turn',
          turnEndedAt: 'not-a-timestamp',
          lastReportAt: '2026-08-28T09:59:59.000Z',
          waitingCount: 0,
        }),
      ).toBe('stalled-turn-end');
    });

    it('lastReportAt が Date.parse できない ⟹ 止まっている', () => {
      expect(
        classifyManagerActivity({
          turnEndReason: 'end_turn',
          turnEndedAt: '2026-08-28T09:00:00.000Z',
          lastReportAt: 'not-a-timestamp',
          waitingCount: 0,
        }),
      ).toBe('stalled-turn-end');
    });
  });

  describe('止まっている（道具待ち型）', () => {
    it('toolUseStallPending が非空 かつ waitingCount === 0 ⟹ 止まっている', () => {
      expect(
        classifyManagerActivity({
          toolUseStallPending: pending(),
          waitingCount: 0,
        }),
      ).toBe('stalled-tool-use');
    });

    it('waiting が非空なら止まっていない扱い（確認は届いていて、まだ答えていないだけの正常な状態）', () => {
      expect(
        classifyManagerActivity({
          toolUseStallPending: pending(),
          waitingCount: 1,
        }),
      ).toBe('active');
    });

    it('toolUseStallPending が空配列なら「観測なし」と同じ扱い', () => {
      expect(
        classifyManagerActivity({
          toolUseStallPending: [],
          waitingCount: 0,
        }),
      ).toBe('unknown');
    });
  });

  describe('道具を実行中（tool-running。Issue #2173）', () => {
    it('Bash が pending で waiting が空 ⟹ tool-running（stalled-tool-use ではない）', () => {
      expect(
        classifyManagerActivity({
          toolUseStallPending: [{ id: 'toolu_bash', name: 'Bash' }],
          waitingCount: 0,
        }),
      ).toBe('tool-running');
    });

    it('Agent が pending で waiting が空 ⟹ tool-running（作業者が走っている最中でも矛盾ではない）', () => {
      expect(
        classifyManagerActivity({
          toolUseStallPending: [{ id: 'toolu_agent', name: 'Agent' }],
          waitingCount: 0,
        }),
      ).toBe('tool-running');
    });

    it('AskUserQuestion と Bash が混ざっていれば stalled-tool-use（Bash の存在で覆い隠さない）', () => {
      expect(
        classifyManagerActivity({
          toolUseStallPending: [
            { id: 'toolu_bash', name: 'Bash' },
            { id: 'toolu_ask', name: 'AskUserQuestion' },
          ],
          waitingCount: 0,
        }),
      ).toBe('stalled-tool-use');
    });

    it('name の無い pending なら stalled-tool-use（判定できないものを tool-running へ倒さない）', () => {
      expect(
        classifyManagerActivity({
          toolUseStallPending: [{ id: 'toolu_noname' }],
          waitingCount: 0,
        }),
      ).toBe('stalled-tool-use');
    });

    it.each(['', '   '])(
      'name が空（%j）の pending なら stalled-tool-use（tool-running へ倒さない）',
      (name) => {
        expect(
          classifyManagerActivity({
            toolUseStallPending: [{ id: 'toolu_empty', name }],
            waitingCount: 0,
          }),
        ).toBe('stalled-tool-use');
      },
    );

    it('waiting が非空なら tool-running にもならず active（正常な待ち）', () => {
      expect(
        classifyManagerActivity({
          toolUseStallPending: [{ id: 'toolu_bash', name: 'Bash' }],
          waitingCount: 1,
        }),
      ).toBe('active');
    });
  });

  describe('進んでいる／正常な待ち（active）', () => {
    it('turnEndedAt <= lastReportAt（ターンが終わった後に報告が届いている）⟹ 進んでいる', () => {
      expect(
        classifyManagerActivity({
          turnEndReason: 'end_turn',
          turnEndedAt: '2026-08-28T09:00:00.000Z',
          lastReportAt: '2026-08-28T09:10:00.000Z',
          waitingCount: 0,
        }),
      ).toBe('active');
    });

    it('turnEndedAt === lastReportAt（境界。以下 = 正常）⟹ 進んでいる', () => {
      expect(
        classifyManagerActivity({
          turnEndReason: 'end_turn',
          turnEndedAt: '2026-08-28T09:00:00.000Z',
          lastReportAt: '2026-08-28T09:00:00.000Z',
          waitingCount: 0,
        }),
      ).toBe('active');
    });
  });
});

describe('describeManagerActivityForFlush — flush が配る短い1行', () => {
  it('stalled-turn-end は ⚠ を出す', () => {
    const line = describeManagerActivityForFlush('stalled-turn-end');
    expect(line).toContain('⚠');
    expect(line).toContain('#567');
  });

  it('stalled-tool-use は ⚠ を出す', () => {
    const line = describeManagerActivityForFlush('stalled-tool-use');
    expect(line).toContain('⚠');
    expect(line).toContain('#572');
  });

  it('active は「進んでいる」と読める字を出す。⚠ は付けない（警告ではない）', () => {
    const line = describeManagerActivityForFlush('active');
    expect(line).toContain('進んでいる');
    expect(line).not.toContain('⚠');
  });

  it('tool-running は「実行中」と読める字を出す。⚠ は付けない（Issue #2173）', () => {
    const line = describeManagerActivityForFlush('tool-running');
    expect(line).toContain('実行中');
    expect(line).not.toContain('⚠');
    expect(line).not.toBe(describeManagerActivityForFlush('active'));
  });

  it('unknown は「判定できない」と分かる文字を出す。⚠ は付けない（症状の断定ではないため字面で区別する）', () => {
    const line = describeManagerActivityForFlush('unknown');
    expect(line).toContain('判定できない');
    expect(line).not.toContain('⚠');
    expect(line).not.toBe(describeManagerActivityForFlush('active'));
  });

  it('4状態すべてで空文字を返さない（Record<NonNullable<...>, true> を回す）', () => {
    const kinds = Object.keys(ALL_MANAGER_ACTIVITY_KINDS) as ManagerActivityKind[];
    // 先に対象が空でないことを確かめる: 空配列を回すループは何も検査せずに緑を返す。
    expect(kinds.length).toBeGreaterThan(0);
    for (const kind of kinds) {
      expect(describeManagerActivityForFlush(kind)).not.toBe('');
    }
  });
});

describe('describeReportDrift', () => {
  const NOW = new Date('2026-09-16T01:00:00.000Z');

  it('焼いた status といまの status が食い違えば ⚠ を出す（running に限定しない）', () => {
    const text = describeReportDrift({
      managerId: 'mgr-1',
      lastReportAt: '2026-09-16T00:00:00.000Z',
      lastReportStatus: 'running',
      status: 'stopped',
      now: NOW,
    });
    expect(text).toContain('⚠');
    expect(text).toContain('running');
    expect(text).toContain('stopped');
    expect(text).toContain('いま走っているターンの中身ではない');
  });

  it('waiting_human → done のような running を含まない組み合わせでも ⚠ を出す（4値の設計をそのまま踏襲）', () => {
    const text = describeReportDrift({
      managerId: 'mgr-1',
      lastReportAt: '2026-09-16T00:00:00.000Z',
      lastReportStatus: 'waiting_human',
      status: 'done',
      now: NOW,
    });
    expect(text).toContain('⚠');
    expect(text).toContain('waiting_human');
    expect(text).toContain('done');
  });

  it('一致していれば空文字（1文字も増えない）', () => {
    const text = describeReportDrift({
      managerId: 'mgr-1',
      lastReportAt: '2026-09-16T00:00:00.000Z',
      lastReportStatus: 'done',
      status: 'done',
      now: NOW,
    });
    expect(text).toBe('');
  });

  it('lastReportStatus が無い（この欄を持たない古い行）と空文字', () => {
    const text = describeReportDrift({
      managerId: 'mgr-1',
      lastReportAt: '2026-09-16T00:00:00.000Z',
      status: 'running',
      now: NOW,
    });
    expect(text).toBe('');
  });

  it('lastReportAt が無い（報告が一度も届いていない）と空文字', () => {
    const text = describeReportDrift({
      managerId: 'mgr-1',
      lastReportStatus: 'running',
      status: 'stopped',
      now: NOW,
    });
    expect(text).toBe('');
  });

  it('経過時間を「N分前」の形で言う', () => {
    const text = describeReportDrift({
      managerId: 'mgr-1',
      lastReportAt: '2026-09-16T00:55:00.000Z',
      lastReportStatus: 'running',
      status: 'done',
      now: NOW,
    });
    expect(text).toContain('5分前');
  });
});
