import { describe, expect, it } from 'vitest';

import { shouldEscalateDenial } from './denial-escalation.js';
import { RunnerSubagentStopState } from './runner-subagent-stop-state.js';

// 拒否（manager.ts）と作業者の上限到達（runner-subagent-stop-state.ts）は同じ規則で間引く（#5819）
describe('知らせを間引く規則（1件目、そのあとは3倍ごと）', () => {
  const escalatedUpTo = (limit: number, decide: (count: number) => boolean): number[] =>
    Array.from({ length: limit }, (_, index) => index + 1).filter(decide);

  it('1・3・9・27・81 件目だけ知らせる', () => {
    expect(escalatedUpTo(100, shouldEscalateDenial)).toEqual([1, 3, 9, 27, 81]);
  });

  it('0 件以下では知らせない', () => {
    expect(shouldEscalateDenial(0)).toBe(false);
    expect(shouldEscalateDenial(-1)).toBe(false);
  });

  it('作業者の上限到達の知らせも、同じ回で上がる', () => {
    const state = new RunnerSubagentStopState();
    const escalated = escalatedUpTo(
      100,
      () => state.recordSubagentLimitReachedNote('agent-1').shouldEscalate,
    );
    expect(escalated).toEqual(escalatedUpTo(100, shouldEscalateDenial));
  });
});
