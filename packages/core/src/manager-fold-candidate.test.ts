import { describe, expect, it } from 'vitest';

import {
  describeManagerFoldCandidate,
  isManagerFoldCandidate,
  MANAGER_FOLD_CANDIDATE_IDLE_THRESHOLD_MS,
  type ManagerFoldCandidateInput,
} from './manager-fold-candidate.js';

/**
 * Issue #1394 段⑤ の歯。**畳む操作は作っていない** ——ここで測るのは
 * 「畳む候補」の判定と表示だけである（`manager_stop` はどこからも呼ばない）。
 *
 * **条件3（`awaitingBackgroundSignalVersionConfirmed`）は、いまの
 * `tools.ts` 側の配線では常に `false` を渡される**（材料が無いため。
 * `manager-fold-candidate.ts` の doc）。この純関数自体は `true` を渡されても
 * 正しく動く形で書いてあるので、ここでは意図的に `true` を渡して条件1・2・
 * 4・5の判定を単体で測る——さもないと、どの入力を与えても常に `false` にしか
 * ならず、条件を1つずつ外す変異試験が「候補が出る」ケースを1つも作れない
 * （変異試験の生存の4分類3「テストの構造が観測不能」と同じ形になる）。
 * 呼び出し元（`tools.ts`）が実際に `false` を固定で渡していることは
 * `tools.test.ts` 側の統合の歯が確かめる。
 */

const NOW = new Date('2026-09-24T12:00:00.000Z');

/** 全条件を満たす基準入力（条件3も `true` にした、単体測定専用の形）。 */
function baseInput(overrides: Partial<ManagerFoldCandidateInput> = {}): ManagerFoldCandidateInput {
  return {
    status: 'done',
    hasAwaitingBackgroundSignal: false,
    awaitingBackgroundSignalVersionConfirmed: true,
    activityKind: 'active',
    // ちょうど7時間前——閾値（6時間）を上回る。
    lastTurnEndedAt: '2026-09-24T05:00:00.000Z',
    ...overrides,
  };
}

describe('isManagerFoldCandidate / describeManagerFoldCandidate', () => {
  it('全条件を満たせば候補になる（陽性対照）', () => {
    const input = baseInput();
    expect(isManagerFoldCandidate(input, NOW)).toBe(true);
    const line = describeManagerFoldCandidate(input, NOW);
    expect(line).not.toBeNull();
    expect(line).toContain('畳む候補');
    expect(line).toContain('7時間');
    // **候補であって畳んだのではないことを、文言そのものに書く。**
    expect(line).toContain('いまは表示だけで、畳む操作はしない');
  });

  it('閾値ちょうど（6時間）は候補になる（境界は以上）', () => {
    const input = baseInput({
      lastTurnEndedAt: new Date(
        NOW.getTime() - MANAGER_FOLD_CANDIDATE_IDLE_THRESHOLD_MS,
      ).toISOString(),
    });
    expect(isManagerFoldCandidate(input, NOW)).toBe(true);
  });

  it('閾値の1ミリ秒手前は候補にならない', () => {
    const input = baseInput({
      lastTurnEndedAt: new Date(
        NOW.getTime() - MANAGER_FOLD_CANDIDATE_IDLE_THRESHOLD_MS + 1,
      ).toISOString(),
    });
    expect(isManagerFoldCandidate(input, NOW)).toBe(false);
    expect(describeManagerFoldCandidate(input, NOW)).toBeNull();
  });

  // ------------------------------------------------------------------
  // 条件1: status が done であること
  // ------------------------------------------------------------------
  it.each(['running', 'waiting_human', 'failed', 'lost', 'stopped'] as const)(
    'status が %s なら候補にしない（条件1）',
    (status) => {
      const input = baseInput({ status });
      expect(isManagerFoldCandidate(input, NOW)).toBe(false);
      expect(describeManagerFoldCandidate(input, NOW)).toBeNull();
    },
  );

  // ------------------------------------------------------------------
  // 条件2: 背景処理待ちの印が立っていないこと
  // ------------------------------------------------------------------
  it('背景処理待ちの印が立っていれば候補にしない（条件2）', () => {
    const input = baseInput({ hasAwaitingBackgroundSignal: true });
    expect(isManagerFoldCandidate(input, NOW)).toBe(false);
    expect(describeManagerFoldCandidate(input, NOW)).toBeNull();
  });

  // ------------------------------------------------------------------
  // 条件3: 器がその印を送る版であると確かめられること（材料が無い）
  // ------------------------------------------------------------------
  it('条件3が偽なら、他の条件をすべて満たしていても候補にしない', () => {
    const input = baseInput({ awaitingBackgroundSignalVersionConfirmed: false });
    expect(isManagerFoldCandidate(input, NOW)).toBe(false);
    expect(describeManagerFoldCandidate(input, NOW)).toBeNull();
  });

  // ------------------------------------------------------------------
  // 条件4: classifyManagerActivity が 'active' であること
  // ------------------------------------------------------------------
  it.each(['unknown', 'stalled-turn-end', 'stalled-tool-use'] as const)(
    '状態の判定が %s なら候補にしない（条件4。unknown を「手が空いている」へ倒さない）',
    (activityKind) => {
      const input = baseInput({ activityKind });
      expect(isManagerFoldCandidate(input, NOW)).toBe(false);
      expect(describeManagerFoldCandidate(input, NOW)).toBeNull();
    },
  );

  // ------------------------------------------------------------------
  // 条件5: 最後のターン終了から6時間以上経っていること
  // ------------------------------------------------------------------
  it('lastTurnEndedAt が無ければ候補にしない（「取れない」を「空いた」へ倒さない）', () => {
    const input = baseInput({ lastTurnEndedAt: undefined });
    expect(isManagerFoldCandidate(input, NOW)).toBe(false);
    expect(describeManagerFoldCandidate(input, NOW)).toBeNull();
  });

  it('lastTurnEndedAt が壊れた文字列（Date.parse できない）なら候補にしない', () => {
    const input = baseInput({ lastTurnEndedAt: 'not-a-timestamp' });
    expect(isManagerFoldCandidate(input, NOW)).toBe(false);
    expect(describeManagerFoldCandidate(input, NOW)).toBeNull();
  });

  it('まだ6時間経っていなければ候補にしない', () => {
    const input = baseInput({ lastTurnEndedAt: '2026-09-24T11:00:00.000Z' });
    expect(isManagerFoldCandidate(input, NOW)).toBe(false);
    expect(describeManagerFoldCandidate(input, NOW)).toBeNull();
  });

  // ------------------------------------------------------------------
  // 本番の配線（tools.ts）を模した回帰——条件3が常に false のとき
  // ------------------------------------------------------------------
  it('本番と同じ形（条件3が常に false）では、他の条件が何であれ候補は1件も出ない', () => {
    const productionLikeInput: ManagerFoldCandidateInput = {
      status: 'done',
      hasAwaitingBackgroundSignal: false,
      awaitingBackgroundSignalVersionConfirmed: false,
      activityKind: 'active',
      lastTurnEndedAt: '2000-01-01T00:00:00.000Z',
    };
    expect(isManagerFoldCandidate(productionLikeInput, NOW)).toBe(false);
    expect(describeManagerFoldCandidate(productionLikeInput, NOW)).toBeNull();
  });
});
