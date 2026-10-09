import { describe, expect, it } from 'vitest';

import {
  BACKGROUND_TASK_OWNER_LIMIT,
  RunnerSubagentStopState,
  SUBAGENT_BACKGROUND_WAIT_MS,
} from './runner-subagent-stop-state.js';

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
    expect(state.hasBackgroundTaskOwner('t0')).toBe(true);

    state.setBackgroundTaskOwner(`t${BACKGROUND_TASK_OWNER_LIMIT}`, 'agent-overflow');
    expect(state.hasBackgroundTaskOwner('t0')).toBe(false);
    expect(state.backgroundTaskOwner('t0')).toBeUndefined();
    expect(state.hasBackgroundTaskOwner('t1')).toBe(true);
    expect(state.backgroundTaskOwner(`t${BACKGROUND_TASK_OWNER_LIMIT}`)).toBe('agent-overflow');
  });

  it('command を渡すと backgroundTaskCommand で引ける。渡さなければ undefined', () => {
    const state = new RunnerSubagentStopState();
    expect(state.backgroundTaskCommand('t1')).toBeUndefined();

    state.setBackgroundTaskOwner('t1', 'agent-a', 'pnpm test');
    expect(state.backgroundTaskOwner('t1')).toBe('agent-a');
    expect(state.backgroundTaskCommand('t1')).toBe('pnpm test');

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
    expect(state.hasBackgroundTaskOwner('t0')).toBe(false);
    expect(state.backgroundTaskCommand('t0')).toBeUndefined();
    expect(state.backgroundTaskCommand(`t${BACKGROUND_TASK_OWNER_LIMIT}`)).toBe('cmd-overflow');
  });
});

describe('RunnerSubagentStopState — 1セッションに1回だけの診断フラグ', () => {
  it('ownerLookupFailureNoted は既定 false で、markOwnerLookupFailureNoted で true になり、以後 true のまま', () => {
    const state = new RunnerSubagentStopState();
    expect(state.ownerLookupFailureNoted).toBe(false);
    state.markOwnerLookupFailureNoted();
    expect(state.ownerLookupFailureNoted).toBe(true);
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

describe('RunnerSubagentStopState — 起こし直した回数の通算（観測専用。回数の上限は Issue #3008 で外した）', () => {
  it('起こし直す前の通算は 0', () => {
    const state = new RunnerSubagentStopState();
    expect(state.subagentWakeupTotal('agent-a')).toBe(0);
  });

  it('recordSubagentWakeup は通算を+1し、新しい通算値を返す', () => {
    const state = new RunnerSubagentStopState();
    expect(state.recordSubagentWakeup('agent-a')).toBe(1);
    expect(state.subagentWakeupTotal('agent-a')).toBe(1);
  });

  it('別の agentId は独立に数えられる', () => {
    const state = new RunnerSubagentStopState();
    state.recordSubagentWakeup('agent-a');
    state.recordSubagentWakeup('agent-b');
    state.recordSubagentWakeup('agent-a');
    expect(state.subagentWakeupTotal('agent-a')).toBe(2);
    expect(state.subagentWakeupTotal('agent-b')).toBe(1);
  });

  it('旧い通し上限（8）を超えても数えは止まらない・何も拒まない（上限は無い）', () => {
    const state = new RunnerSubagentStopState();
    for (let n = 1; n <= 50; n += 1) {
      expect(state.recordSubagentWakeup('agent-a')).toBe(n);
    }
    expect(state.subagentWakeupTotal('agent-a')).toBe(50);
  });
});

describe('SUBAGENT_BACKGROUND_WAIT_MS（背景処理の完了を待つ1回あたりの上限）', () => {
  it('30分である（#1554 の実例を待ち切れ、終わらない処理は時間で切れる。doc が根拠）', () => {
    expect(SUBAGENT_BACKGROUND_WAIT_MS).toBe(30 * 60_000);
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
