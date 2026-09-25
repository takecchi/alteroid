import { describe, expect, it } from 'vitest';

import {
  CUT_OFF_WORKERS_LIMIT,
  PENDING_CUT_OFF_NOTIFICATIONS_LIMIT,
  RunnerCutOffWorkers,
} from './runner-cut-off-workers.js';

/**
 * `runner-cut-off-workers.ts` の歯。**純粋なクラスなので I/O のモック無しで
 * 全分岐に通せる**（`runner-subagent-stop-state.test.ts` / `clone-notices.test.ts`
 * と同じ作法。前例は PR #1359 / #1433）。
 *
 * ここが固定するのは、切り出した2フィールドの**状態の器としての性質**
 * ——記録・消費・FIFO の枝刈り・全件配達である。`RunnerSession` が「いつ
 * 呼ぶか・note を emit するかどうか・注記の文面」を決める判断は
 * `runner-subagent-stop.test.ts`（ブラックボックス）が引き続き持つ
 * ——ここでは扱わない。
 */

describe('RunnerCutOffWorkers — 打ち切りの記録と消費（consumeCutOff）', () => {
  it('記録していない agentId は consumeCutOff で false を返し、何も変わらない', () => {
    const state = new RunnerCutOffWorkers();
    expect(state.consumeCutOff('agent-1')).toBe(false);
  });

  it('recordCutOff で記録した agentId は consumeCutOff で true を返し、消費すると消える', () => {
    const state = new RunnerCutOffWorkers();
    state.recordCutOff('agent-1');
    expect(state.consumeCutOff('agent-1')).toBe(true);
    // 消費後は同じ agentId をもう一度 consume しても false（1回だけ）。
    expect(state.consumeCutOff('agent-1')).toBe(false);
  });

  it('別の agentId を記録しても、消費していない agentId には影響しない', () => {
    const state = new RunnerCutOffWorkers();
    state.recordCutOff('agent-1');
    state.recordCutOff('agent-2');
    expect(state.consumeCutOff('agent-2')).toBe(true);
    // agent-1 はまだ控えたまま。
    expect(state.consumeCutOff('agent-1')).toBe(true);
  });

  it(`上限（${CUT_OFF_WORKERS_LIMIT}件）を超えたら、いちばん古い記録から捨てる（FIFO）`, () => {
    // 別の対照用インスタンスで「上限ちょうどでは最初の1件がまだ残っている」ことを
    // 確かめる（`consumeCutOff` は消費（delete）を兼ねるので、本編と対照は
    // インスタンスを分ける——同じ器で先に consume すると挿入順の検証が崩れる）。
    const control = new RunnerCutOffWorkers();
    for (let n = 0; n < CUT_OFF_WORKERS_LIMIT; n += 1) {
      control.recordCutOff(`agent-${n}`);
    }
    expect(control.consumeCutOff('agent-0')).toBe(true);

    const state = new RunnerCutOffWorkers();
    for (let n = 0; n < CUT_OFF_WORKERS_LIMIT; n += 1) {
      state.recordCutOff(`agent-${n}`);
    }
    // 501件目を積むと、いちばん古い agent-0 が捨てられる。
    state.recordCutOff(`agent-${CUT_OFF_WORKERS_LIMIT}`);
    expect(state.consumeCutOff('agent-0')).toBe(false);
    // 2番目に古い agent-1 はまだ残っている。
    expect(state.consumeCutOff('agent-1')).toBe(true);
    // 新しく積んだものは引ける。
    expect(state.consumeCutOff(`agent-${CUT_OFF_WORKERS_LIMIT}`)).toBe(true);
  });

  it('recordCutOff は delete→add で挿入順を末尾へ動かす（既に在る鍵を書き直しても、上限に達するまで捨てられない）', () => {
    const state = new RunnerCutOffWorkers();
    state.recordCutOff('agent-0');
    for (let n = 1; n < CUT_OFF_WORKERS_LIMIT; n += 1) {
      state.recordCutOff(`agent-${n}`);
    }
    // ここで agent-0 を再度 record する——挿入順が末尾へ動くはず。
    state.recordCutOff('agent-0');
    // 上限ちょうどの状態でもう1件積むと、本来の「2番目に古い」agent-1 が
    // 先に捨てられる（agent-0 は書き直したので先頭ではなくなっている）。
    state.recordCutOff(`agent-${CUT_OFF_WORKERS_LIMIT}`);
    expect(state.consumeCutOff('agent-1')).toBe(false);
    expect(state.consumeCutOff('agent-0')).toBe(true);
  });
});

describe('RunnerCutOffWorkers — 未配達の打ち切り注記（recordPendingNotification / drainPendingNotifications）', () => {
  it('1件も控えていなければ drainPendingNotifications は空配列を返す', () => {
    const state = new RunnerCutOffWorkers();
    expect(state.drainPendingNotifications()).toEqual([]);
  });

  it('recordPendingNotification で控えた分が drainPendingNotifications で全件取れる', () => {
    const state = new RunnerCutOffWorkers();
    state.recordPendingNotification('agent-1');
    state.recordPendingNotification('agent-2');
    expect(state.drainPendingNotifications()).toEqual(['agent-1', 'agent-2']);
  });

  it('drain すると控えは空になる（同じ内容を2回取れない）', () => {
    const state = new RunnerCutOffWorkers();
    state.recordPendingNotification('agent-1');
    expect(state.drainPendingNotifications()).toEqual(['agent-1']);
    expect(state.drainPendingNotifications()).toEqual([]);
  });

  it('同じ agentId を重ねて記録しても1件のまま（Set なので重複しない）', () => {
    const state = new RunnerCutOffWorkers();
    state.recordPendingNotification('agent-1');
    state.recordPendingNotification('agent-1');
    expect(state.drainPendingNotifications()).toEqual(['agent-1']);
  });

  it(`上限（${PENDING_CUT_OFF_NOTIFICATIONS_LIMIT}件）を超えたら、いちばん古い記録から捨てる（FIFO）`, () => {
    const state = new RunnerCutOffWorkers();
    for (let n = 0; n < PENDING_CUT_OFF_NOTIFICATIONS_LIMIT; n += 1) {
      state.recordPendingNotification(`agent-${n}`);
    }
    state.recordPendingNotification(`agent-${PENDING_CUT_OFF_NOTIFICATIONS_LIMIT}`);

    const drained = state.drainPendingNotifications();
    // いちばん古い agent-0 は捨てられている。
    expect(drained).not.toContain('agent-0');
    // 2番目に古い agent-1 と、新しく積んだものは残っている。
    expect(drained).toContain('agent-1');
    expect(drained).toContain(`agent-${PENDING_CUT_OFF_NOTIFICATIONS_LIMIT}`);
    expect(drained).toHaveLength(PENDING_CUT_OFF_NOTIFICATIONS_LIMIT);
  });
});

describe('RunnerCutOffWorkers — recordCutOff と recordPendingNotification は独立している', () => {
  it('片方に記録しても、もう片方には現れない', () => {
    const state = new RunnerCutOffWorkers();
    state.recordCutOff('agent-1');
    expect(state.drainPendingNotifications()).toEqual([]);

    state.recordPendingNotification('agent-2');
    expect(state.consumeCutOff('agent-2')).toBe(false);
  });

  it('#onTaskNotification が行う「consumeCutOff → recordPendingNotification」の付け替えを組み合わせて再現できる', () => {
    const state = new RunnerCutOffWorkers();
    state.recordCutOff('agent-1');
    // task_notification 経由で判明した打ち切り: 消費して付け替える。
    expect(state.consumeCutOff('agent-1')).toBe(true);
    state.recordPendingNotification('agent-1');

    // 同期経路ではもう消費できない。
    expect(state.consumeCutOff('agent-1')).toBe(false);
    // だが未配達の注記としては残っている。
    expect(state.drainPendingNotifications()).toEqual(['agent-1']);
  });
});
