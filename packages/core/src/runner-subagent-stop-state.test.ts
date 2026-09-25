import { describe, expect, it } from 'vitest';

import {
  BACKGROUND_TASK_OWNER_LIMIT,
  RunnerSubagentStopState,
  SUBAGENT_WAKEUP_LIMIT_PER_AGENT,
  SUBAGENT_WAKEUP_LIMIT_PER_TASK,
} from './runner-subagent-stop-state.js';

/**
 * `runner-subagent-stop-state.ts` の歯。**純粋なクラスなので I/O のモック無しで
 * 全分岐に通せる**（`clone-notices.test.ts` と同じ作法。前例は PR #1359）。
 *
 * ここが固定するのは、切り出した8フィールドの**状態の器としての性質**——
 * 上限・FIFO の枝刈り・1回きりのフラグ・積算カウンタ——である。`RunnerSession`
 * が「いつ呼ぶか・emit するかどうか」を決める判断は
 * `runner-subagent-stop.test.ts` / `runner-stop.test.ts`（ブラックボックス）が
 * 引き続き持つ——ここでは扱わない。
 */

describe('RunnerSubagentStopState — 背景タスクの所有者表', () => {
  it('setBackgroundTaskOwner で控えた値を backgroundTaskOwner / hasBackgroundTaskOwner で引ける', () => {
    const state = new RunnerSubagentStopState();
    expect(state.hasBackgroundTaskOwner('t1')).toBe(false);
    expect(state.backgroundTaskOwner('t1')).toBeUndefined();

    state.setBackgroundTaskOwner('t1', 'agent-a');
    expect(state.hasBackgroundTaskOwner('t1')).toBe(true);
    expect(state.backgroundTaskOwner('t1')).toBe('agent-a');
  });

  it('マネージャー自身の分は空文字で控えられる（「引けなかった」と区別される）', () => {
    const state = new RunnerSubagentStopState();
    state.setBackgroundTaskOwner('t-manager', '');
    expect(state.hasBackgroundTaskOwner('t-manager')).toBe(true);
    expect(state.backgroundTaskOwner('t-manager')).toBe('');
  });

  it(`上限（${BACKGROUND_TASK_OWNER_LIMIT}件）を超えたら、いちばん古い所有者から捨てる（FIFO）`, () => {
    const state = new RunnerSubagentStopState();
    for (let n = 0; n < BACKGROUND_TASK_OWNER_LIMIT; n += 1) {
      state.setBackgroundTaskOwner(`t${n}`, `agent-${n}`);
    }
    // 上限ちょうどでは、まだ最初の1件が残っている（対照）。
    expect(state.hasBackgroundTaskOwner('t0')).toBe(true);

    // 501件目を積むと、いちばん古い t0 が捨てられる。
    state.setBackgroundTaskOwner(`t${BACKGROUND_TASK_OWNER_LIMIT}`, 'agent-overflow');
    expect(state.hasBackgroundTaskOwner('t0')).toBe(false);
    expect(state.backgroundTaskOwner('t0')).toBeUndefined();
    // 2番目に古い t1 はまだ残っている。
    expect(state.hasBackgroundTaskOwner('t1')).toBe(true);
    // 新しく積んだものは引ける。
    expect(state.backgroundTaskOwner(`t${BACKGROUND_TASK_OWNER_LIMIT}`)).toBe('agent-overflow');
  });

  /**
   * Issue #1554: `command`（3番目の任意引数）は所有者と同じ呼び出しで一緒に
   * 控える。読めなければ何も持たない——空文字と混ぜない（他の任意欄と同じ
   * 作法。`backgroundTaskCommand` の doc）。
   */
  it('command を渡すと backgroundTaskCommand で引ける。渡さなければ undefined', () => {
    const state = new RunnerSubagentStopState();
    expect(state.backgroundTaskCommand('t1')).toBeUndefined();

    state.setBackgroundTaskOwner('t1', 'agent-a', 'pnpm test');
    expect(state.backgroundTaskOwner('t1')).toBe('agent-a');
    expect(state.backgroundTaskCommand('t1')).toBe('pnpm test');

    // command を渡さなかった呼び出しでは、command は控えられない。
    state.setBackgroundTaskOwner('t2', 'agent-b');
    expect(state.backgroundTaskOwner('t2')).toBe('agent-b');
    expect(state.backgroundTaskCommand('t2')).toBeUndefined();
  });

  it('command は所有者と同じ枝刈り（FIFO）を受ける——所有者が捨てられれば command も一緒に消える', () => {
    const state = new RunnerSubagentStopState();
    for (let n = 0; n < BACKGROUND_TASK_OWNER_LIMIT; n += 1) {
      state.setBackgroundTaskOwner(`t${n}`, `agent-${n}`, `cmd-${n}`);
    }
    expect(state.backgroundTaskCommand('t0')).toBe('cmd-0');

    state.setBackgroundTaskOwner(
      `t${BACKGROUND_TASK_OWNER_LIMIT}`,
      'agent-overflow',
      'cmd-overflow',
    );
    // t0 は所有者ごと捨てられているので、command も引けない。
    expect(state.hasBackgroundTaskOwner('t0')).toBe(false);
    expect(state.backgroundTaskCommand('t0')).toBeUndefined();
    // 新しく積んだものは command も引ける。
    expect(state.backgroundTaskCommand(`t${BACKGROUND_TASK_OWNER_LIMIT}`)).toBe('cmd-overflow');
  });
});

describe('RunnerSubagentStopState — 1セッションに1回だけの診断フラグ', () => {
  it('ownerLookupFailureNoted は既定 false で、markOwnerLookupFailureNoted で true になり、以後 true のまま', () => {
    const state = new RunnerSubagentStopState();
    expect(state.ownerLookupFailureNoted).toBe(false);
    state.markOwnerLookupFailureNoted();
    expect(state.ownerLookupFailureNoted).toBe(true);
    // 2度目に立てても壊れない（呼び出し側の早期 return に依存しない）。
    state.markOwnerLookupFailureNoted();
    expect(state.ownerLookupFailureNoted).toBe(true);
  });

  it('settledOnlyNoted は既定 false で、markSettledOnlyNoted で true になる', () => {
    const state = new RunnerSubagentStopState();
    expect(state.settledOnlyNoted).toBe(false);
    state.markSettledOnlyNoted();
    expect(state.settledOnlyNoted).toBe(true);
  });

  it('stopIdleNoted は既定 false で、markStopIdleNoted で true になる', () => {
    const state = new RunnerSubagentStopState();
    expect(state.stopIdleNoted).toBe(false);
    state.markStopIdleNoted();
    expect(state.stopIdleNoted).toBe(true);
  });

  it('3本のフラグは互いに独立している（1本を立てても他は動かない）', () => {
    const state = new RunnerSubagentStopState();
    state.markSettledOnlyNoted();
    expect(state.ownerLookupFailureNoted).toBe(false);
    expect(state.stopIdleNoted).toBe(false);
    expect(state.settledOnlyNoted).toBe(true);
  });
});

describe('RunnerSubagentStopState — Stop の発火回数（観測専用の通算）', () => {
  it('incrementStopFirings は呼ぶたびに1ずつ進み、加算後の値を返す。stopFirings は現在値を返す', () => {
    const state = new RunnerSubagentStopState();
    expect(state.stopFirings).toBe(0);
    expect(state.incrementStopFirings()).toBe(1);
    expect(state.stopFirings).toBe(1);
    expect(state.incrementStopFirings()).toBe(2);
    expect(state.incrementStopFirings()).toBe(3);
    expect(state.stopFirings).toBe(3);
  });
});

describe('RunnerSubagentStopState — 起こし直しの予算（subagentWakeupCount / subagentWakeupTotal / recordSubagentWakeup）', () => {
  it('起こし直す前は per-task も per-agent も 0', () => {
    const state = new RunnerSubagentStopState();
    expect(state.subagentWakeupCount('agent-a', 'task-1')).toBe(0);
    expect(state.subagentWakeupTotal('agent-a')).toBe(0);
  });

  it('recordSubagentWakeup は通算を+1し、渡した全件の per-task カウントも+1する。新しい通算値を返す', () => {
    const state = new RunnerSubagentStopState();
    const newTotal = state.recordSubagentWakeup('agent-a', ['task-1', 'task-2']);
    expect(newTotal).toBe(1);
    expect(state.subagentWakeupTotal('agent-a')).toBe(1);
    expect(state.subagentWakeupCount('agent-a', 'task-1')).toBe(1);
    expect(state.subagentWakeupCount('agent-a', 'task-2')).toBe(1);
    // 渡していない背景処理は増えない。
    expect(state.subagentWakeupCount('agent-a', 'task-3')).toBe(0);
  });

  it('同じ背景処理を繰り返し渡すと per-task カウントが積み上がるが、通算は呼んだ回数ぶんだけ進む', () => {
    const state = new RunnerSubagentStopState();
    state.recordSubagentWakeup('agent-a', ['task-1']);
    state.recordSubagentWakeup('agent-a', ['task-1']);
    const total = state.recordSubagentWakeup('agent-a', ['task-1']);
    expect(total).toBe(3);
    expect(state.subagentWakeupCount('agent-a', 'task-1')).toBe(3);
  });

  it('別の agentId は独立に数えられる', () => {
    const state = new RunnerSubagentStopState();
    state.recordSubagentWakeup('agent-a', ['task-1']);
    state.recordSubagentWakeup('agent-b', ['task-1']);
    expect(state.subagentWakeupTotal('agent-a')).toBe(1);
    expect(state.subagentWakeupTotal('agent-b')).toBe(1);
    // 同じ taskId 文字列でも agentId が違えば鍵が違うので混ざらない。
    state.recordSubagentWakeup('agent-a', ['task-1']);
    expect(state.subagentWakeupCount('agent-a', 'task-1')).toBe(2);
    expect(state.subagentWakeupCount('agent-b', 'task-1')).toBe(1);
  });

  it(`per-task の枝刈りは FIFO である（${SUBAGENT_WAKEUP_LIMIT_PER_TASK} 件目以降も積める。上限そのものの判定は呼び出し側 = RunnerSession が持つ）`, () => {
    // ここは枝刈りの「器の性質」だけを固定する — 上限判定（起こし直すか
    // どうか）は RunnerSession#onSubagentStop の責務であり、この器は
    // 「上限に達しても値そのものは増え続ける」ことを保証するだけである。
    const state = new RunnerSubagentStopState();
    for (let n = 1; n <= SUBAGENT_WAKEUP_LIMIT_PER_TASK + 3; n += 1) {
      state.recordSubagentWakeup('agent-a', ['task-1']);
    }
    expect(state.subagentWakeupCount('agent-a', 'task-1')).toBe(SUBAGENT_WAKEUP_LIMIT_PER_TASK + 3);
  });

  it(`SUBAGENT_WAKEUP_LIMIT_PER_AGENT（${SUBAGENT_WAKEUP_LIMIT_PER_AGENT}）を超えても通算は増え続ける（上限判定自体は呼び出し側の責務）`, () => {
    const state = new RunnerSubagentStopState();
    for (let n = 1; n <= SUBAGENT_WAKEUP_LIMIT_PER_AGENT + 2; n += 1) {
      state.recordSubagentWakeup('agent-a', [`task-${n}`]);
    }
    expect(state.subagentWakeupTotal('agent-a')).toBe(SUBAGENT_WAKEUP_LIMIT_PER_AGENT + 2);
  });
});

describe('RunnerSubagentStopState — 上限到達 note の間引き（recordSubagentLimitReachedNote）', () => {
  it('1回目は count=1・shouldEscalate=true（1回目を黙らせない）', () => {
    const state = new RunnerSubagentStopState();
    const result = state.recordSubagentLimitReachedNote('agent-a');
    expect(result).toEqual({ count: 1, shouldEscalate: true });
  });

  it('2回目は shouldEscalate=false、3回目は true（1・3・9・27…の3倍ごと）', () => {
    const state = new RunnerSubagentStopState();
    expect(state.recordSubagentLimitReachedNote('agent-a')).toEqual({
      count: 1,
      shouldEscalate: true,
    });
    expect(state.recordSubagentLimitReachedNote('agent-a')).toEqual({
      count: 2,
      shouldEscalate: false,
    });
    expect(state.recordSubagentLimitReachedNote('agent-a')).toEqual({
      count: 3,
      shouldEscalate: true,
    });
    for (let n = 4; n <= 8; n += 1) {
      expect(state.recordSubagentLimitReachedNote('agent-a')).toEqual({
        count: n,
        shouldEscalate: false,
      });
    }
    expect(state.recordSubagentLimitReachedNote('agent-a')).toEqual({
      count: 9,
      shouldEscalate: true,
    });
  });

  it('別の agentId は独立に数えられる（片方が9回目でも、もう片方の1回目は escalate）', () => {
    const state = new RunnerSubagentStopState();
    for (let n = 1; n <= 8; n += 1) state.recordSubagentLimitReachedNote('agent-a');
    expect(state.recordSubagentLimitReachedNote('agent-a')).toEqual({
      count: 9,
      shouldEscalate: true,
    });
    expect(state.recordSubagentLimitReachedNote('agent-b')).toEqual({
      count: 1,
      shouldEscalate: true,
    });
  });
});
