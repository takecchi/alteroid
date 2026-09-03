import { describe, expect, it } from 'vitest';

import {
  classifyManagerActivity,
  describeManagerActivityForFlush,
  type ManagerActivityInput,
  type ManagerActivityKind,
} from './manager-activity.js';

/**
 * `classifyManagerActivity` / `describeManagerActivityForFlush`（台帳
 * `028ee442` の指摘への直し）の歯。
 *
 * **ここで測るのは判定そのもの。** `tools.ts` の `describeTurnEnd` /
 * `describeToolUseStall` が同じ判定から**字面を1バイトも変えずに**描いて
 * いることは `tools.test.ts` / `manager-turn-end.test.ts` /
 * `manager-tool-stall.test.ts` の既存の歯が引き続き測る——ここでは重複しない。
 * `flushWithheldReports()` との結線（`ManagerPool` 経由の統合）は
 * `manager-flush-activity.test.ts` が持つ。
 */

/** `toolUseStallPending` の最小の1件。 */
function pending(id = 'toolu_1'): ManagerActivityInput['toolUseStallPending'] {
  return [{ id, name: 'AskUserQuestion' }];
}

/**
 * ⚠️⚠️ 網羅の歯の一覧そのもの（これが本命）。**`Record<NonNullable<
 * ManagerActivityKind>, true>` で縛る**——`ManagerActivityKind` に値が
 * 増えてここを足し忘れるとコンパイルエラーで止まる（AGENTS.md「型で
 * 塞いだ分岐にも実行時の歯を足す」と対になる、コンパイル時の網羅性の歯）。
 *
 * **モジュール scope へ置く。** `classifyManagerActivity` の網羅（下の
 * describe）と `describeManagerActivityForFlush` が「4状態とも非空文字を
 * 返す」（もう1つ下の describe）の**両方**がこの同じ一覧を回す——一覧を
 * 2つ持つと、状態が増えたときに片方だけ更新されて静かにずれる。
 */
const ALL_MANAGER_ACTIVITY_KINDS = {
  'stalled-turn-end': true,
  'stalled-tool-use': true,
  active: true,
  unknown: true,
} satisfies Record<NonNullable<ManagerActivityKind>, true>;

describe('classifyManagerActivity — 4状態の網羅（依頼者の守る線: 「無い」の種類を潰さない）', () => {
  it('4状態すべてがこの一覧に載っている（Object.keys で数え上げる歯）', () => {
    expect(Object.keys(ALL_MANAGER_ACTIVITY_KINDS).sort()).toEqual(
      ['active', 'stalled-tool-use', 'stalled-turn-end', 'unknown'].sort(),
    );
  });

  describe('判定できない（unknown）', () => {
    it('turnEndReason も toolUseStallPending も無ければ unknown', () => {
      expect(classifyManagerActivity({ waitingCount: 0 })).toBe('unknown');
    });

    it('waiting が非空でも、観測そのものが無ければ unknown のまま（active へ倒さない）', () => {
      // ⚠️ 依頼者の守る線: 「判定できない」を「進んでいる」へ倒さないこと。
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

  it('unknown は「判定できない」と分かる文字を出す。⚠ は付けない（症状の断定ではないため字面で区別する）', () => {
    const line = describeManagerActivityForFlush('unknown');
    expect(line).toContain('判定できない');
    expect(line).not.toContain('⚠');
    // **active とは字面で区別できる**——依頼者が「進んでいるので待つ」と
    // 「観測が無いので分からない」を読み違えないため。
    expect(line).not.toBe(describeManagerActivityForFlush('active'));
  });

  /**
   * ⚠️⚠️ これが本命——静かな失敗を作らないための歯。
   *
   * 「flush の文面に判定の行が無い」が2つの意味を持つ形（(a) `'active'`
   * だったので言うことが無い／(b) 結線が壊れて1行も足されなかった）を
   * 作らないため、**4状態すべてで空文字を返さないこと**を、状態の一覧
   * （`ALL_MANAGER_ACTIVITY_KINDS`。`classifyManagerActivity` の網羅と
   * 同じ一覧）を回して測る。**先に「対象が空でないこと」を確かめる**
   * （依頼者の守る線——空配列を回すループは何も検査せずに緑を返す）。
   */
  it('4状態すべてで空文字を返さない（Record<NonNullable<...>, true> を回す）', () => {
    const kinds = Object.keys(ALL_MANAGER_ACTIVITY_KINDS) as ManagerActivityKind[];
    expect(kinds.length).toBeGreaterThan(0);
    for (const kind of kinds) {
      expect(describeManagerActivityForFlush(kind)).not.toBe('');
    }
  });
});
