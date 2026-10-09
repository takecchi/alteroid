import { describe, expect, it } from 'vitest';

import {
  describeManagerFoldCandidate,
  isManagerFoldCandidate,
  MANAGER_FOLD_CANDIDATE_IDLE_THRESHOLD_MS,
  type ManagerFoldCandidateInput,
} from './manager-fold-candidate.js';


const NOW = new Date('2026-09-24T12:00:00.000Z');

// 条件3は意図的に `true` を渡す: `false` のままだと常に候補が出ず、条件を1つずつ外す変異試験が「候補が出る」ケースを作れない。
function baseInput(overrides: Partial<ManagerFoldCandidateInput> = {}): ManagerFoldCandidateInput {
  return {
    status: 'done',
    hasAwaitingBackgroundSignal: false,
    awaitingBackgroundSignalVersionConfirmed: true,
    activityKind: 'active',
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

  it.each(['running', 'waiting_human', 'failed', 'lost', 'stopped'] as const)(
    'status が %s なら候補にしない（条件1）',
    (status) => {
      const input = baseInput({ status });
      expect(isManagerFoldCandidate(input, NOW)).toBe(false);
      expect(describeManagerFoldCandidate(input, NOW)).toBeNull();
    },
  );

  it('背景処理待ちの印が立っていれば候補にしない（条件2）', () => {
    const input = baseInput({ hasAwaitingBackgroundSignal: true });
    expect(isManagerFoldCandidate(input, NOW)).toBe(false);
    expect(describeManagerFoldCandidate(input, NOW)).toBeNull();
  });

  it('条件3が偽なら、他の条件をすべて満たしていても候補にしない', () => {
    const input = baseInput({ awaitingBackgroundSignalVersionConfirmed: false });
    expect(isManagerFoldCandidate(input, NOW)).toBe(false);
    expect(describeManagerFoldCandidate(input, NOW)).toBeNull();
  });

  it.each(['unknown', 'stalled-turn-end', 'stalled-tool-use', 'tool-running'] as const)(
    '状態の判定が %s なら候補にしない（条件4。unknown を「手が空いている」へ倒さない）',
    (activityKind) => {
      const input = baseInput({ activityKind });
      expect(isManagerFoldCandidate(input, NOW)).toBe(false);
      expect(describeManagerFoldCandidate(input, NOW)).toBeNull();
    },
  );

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

  it('器が名乗っていない形（条件3が false）では、他の条件が何であれ候補は1件も出ない', () => {
    const unconfirmedInput: ManagerFoldCandidateInput = {
      status: 'done',
      hasAwaitingBackgroundSignal: false,
      awaitingBackgroundSignalVersionConfirmed: false,
      activityKind: 'active',
      lastTurnEndedAt: '2000-01-01T00:00:00.000Z',
    };
    expect(isManagerFoldCandidate(unconfirmedInput, NOW)).toBe(false);
    expect(describeManagerFoldCandidate(unconfirmedInput, NOW)).toBeNull();
  });
});
