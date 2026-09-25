import { describe, expect, it } from 'vitest';

import {
  CUT_OFF_AGENT_TASKS_LIMIT,
  CUT_OFF_WORKERS_LIMIT,
  PENDING_BACKGROUND_TASK_OUTPUT_LIMIT,
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

/**
 * Issue #1554 で足した3本（`isCutOff` / `cutOffTasks` / 背景処理の出力の
 * 配達待ち）。`#cutOffWorkers` / `#pendingCutOffNotifications` とは寿命が
 * 違う——`consumeCutOff` / `drainPendingNotifications` に**消費されても**、
 * `isCutOff` はそのまま `true` を返し続ける（クラス doc「Issue #1554 で
 * 足した3本」）。
 */
describe('RunnerCutOffWorkers — isCutOff / cutOffTasks は消費されない（Issue #1554）', () => {
  it('recordCutOff した agentId は isCutOff で true。記録していなければ false', () => {
    const state = new RunnerCutOffWorkers();
    expect(state.isCutOff('agent-1')).toBe(false);
    state.recordCutOff('agent-1');
    expect(state.isCutOff('agent-1')).toBe(true);
  });

  it('consumeCutOff で消費した後も isCutOff は true のまま（別の記録なので消費されない）', () => {
    const state = new RunnerCutOffWorkers();
    state.recordCutOff('agent-1');
    expect(state.consumeCutOff('agent-1')).toBe(true);
    // #901 側の記録は消費されたが、#1554 側の記録は残っている。
    expect(state.isCutOff('agent-1')).toBe(true);
  });

  it('recordCutOff の tasks 引数を省略すると cutOffTasks は空配列', () => {
    const state = new RunnerCutOffWorkers();
    state.recordCutOff('agent-1');
    expect(state.cutOffTasks('agent-1')).toEqual([]);
    // 記録していない agentId も同じく空配列（区別しない）。
    expect(state.cutOffTasks('agent-2')).toEqual([]);
  });

  it('recordCutOff の tasks 引数がそのまま cutOffTasks で引ける', () => {
    const state = new RunnerCutOffWorkers();
    state.recordCutOff('agent-1', [{ id: 'bg-1', command: 'pnpm test' }, { id: 'bg-2' }]);
    expect(state.cutOffTasks('agent-1')).toEqual([
      { id: 'bg-1', command: 'pnpm test' },
      { id: 'bg-2' },
    ]);
  });

  it('同じ agentId を2回目 recordCutOff すると、直近の tasks で上書きされる（古い一覧は残らない）', () => {
    const state = new RunnerCutOffWorkers();
    state.recordCutOff('agent-1', [{ id: 'bg-1' }]);
    state.recordCutOff('agent-1', [{ id: 'bg-2' }]);
    expect(state.cutOffTasks('agent-1')).toEqual([{ id: 'bg-2' }]);
  });

  it(`isCutOff / cutOffTasks も上限（${CUT_OFF_AGENT_TASKS_LIMIT}件）を超えたら、いちばん古い記録から捨てる（FIFO）`, () => {
    const state = new RunnerCutOffWorkers();
    for (let n = 0; n < CUT_OFF_AGENT_TASKS_LIMIT; n += 1) {
      state.recordCutOff(`agent-${n}`, [{ id: `bg-${n}` }]);
    }
    expect(state.isCutOff('agent-0')).toBe(true);

    state.recordCutOff(`agent-${CUT_OFF_AGENT_TASKS_LIMIT}`, [
      { id: `bg-${CUT_OFF_AGENT_TASKS_LIMIT}` },
    ]);
    // いちばん古い agent-0 は捨てられている（isCutOff も cutOffTasks も）。
    expect(state.isCutOff('agent-0')).toBe(false);
    expect(state.cutOffTasks('agent-0')).toEqual([]);
    // 2番目に古い agent-1 はまだ残っている。
    expect(state.isCutOff('agent-1')).toBe(true);
    // 新しく積んだものは引ける。
    expect(state.isCutOff(`agent-${CUT_OFF_AGENT_TASKS_LIMIT}`)).toBe(true);
  });
});

describe('RunnerCutOffWorkers — 打ち切った作業者が残した背景処理の出力（recordPendingBackgroundTaskOutput / drainPendingBackgroundTaskOutputs。Issue #1554）', () => {
  it('1件も控えていなければ drainPendingBackgroundTaskOutputs は空配列を返す', () => {
    const state = new RunnerCutOffWorkers();
    expect(state.drainPendingBackgroundTaskOutputs()).toEqual([]);
  });

  it('recordPendingBackgroundTaskOutput で積んだ分が drainPendingBackgroundTaskOutputs で全件、積んだ順に取れる', () => {
    const state = new RunnerCutOffWorkers();
    state.recordPendingBackgroundTaskOutput({
      agentId: 'agent-1',
      taskId: 'bg-1',
      command: 'pnpm test',
      outputFile: '/tmp/out-1.txt',
    });
    state.recordPendingBackgroundTaskOutput({
      agentId: 'agent-1',
      taskId: 'bg-2',
      outputFile: null,
    });
    expect(state.drainPendingBackgroundTaskOutputs()).toEqual([
      { agentId: 'agent-1', taskId: 'bg-1', command: 'pnpm test', outputFile: '/tmp/out-1.txt' },
      { agentId: 'agent-1', taskId: 'bg-2', outputFile: null },
    ]);
  });

  it('drain すると控えは空になる（同じ内容を2回取れない）', () => {
    const state = new RunnerCutOffWorkers();
    state.recordPendingBackgroundTaskOutput({
      agentId: 'agent-1',
      taskId: 'bg-1',
      outputFile: '/tmp/out.txt',
    });
    expect(state.drainPendingBackgroundTaskOutputs()).toHaveLength(1);
    expect(state.drainPendingBackgroundTaskOutputs()).toEqual([]);
  });

  it('同じ agentId の複数件は、それぞれ別の要素として積まれる（重複排除しない。Set ではなく配列）', () => {
    const state = new RunnerCutOffWorkers();
    state.recordPendingBackgroundTaskOutput({
      agentId: 'agent-1',
      taskId: 'bg-1',
      outputFile: '/tmp/a.txt',
    });
    state.recordPendingBackgroundTaskOutput({
      agentId: 'agent-1',
      taskId: 'bg-2',
      outputFile: '/tmp/b.txt',
    });
    expect(state.drainPendingBackgroundTaskOutputs()).toHaveLength(2);
  });

  it(`上限（${PENDING_BACKGROUND_TASK_OUTPUT_LIMIT}件）を超えたら、いちばん古い記録から捨てる（FIFO）`, () => {
    const state = new RunnerCutOffWorkers();
    for (let n = 0; n < PENDING_BACKGROUND_TASK_OUTPUT_LIMIT; n += 1) {
      state.recordPendingBackgroundTaskOutput({
        agentId: 'agent-1',
        taskId: `bg-${n}`,
        outputFile: `/tmp/${n}.txt`,
      });
    }
    state.recordPendingBackgroundTaskOutput({
      agentId: 'agent-1',
      taskId: `bg-${PENDING_BACKGROUND_TASK_OUTPUT_LIMIT}`,
      outputFile: `/tmp/${PENDING_BACKGROUND_TASK_OUTPUT_LIMIT}.txt`,
    });

    const drained = state.drainPendingBackgroundTaskOutputs();
    expect(drained).toHaveLength(PENDING_BACKGROUND_TASK_OUTPUT_LIMIT);
    // いちばん古い bg-0 は捨てられている。
    expect(drained.some((item) => item.taskId === 'bg-0')).toBe(false);
    // 2番目に古い bg-1 と、新しく積んだものは残っている。
    expect(drained.some((item) => item.taskId === 'bg-1')).toBe(true);
    expect(
      drained.some((item) => item.taskId === `bg-${PENDING_BACKGROUND_TASK_OUTPUT_LIMIT}`),
    ).toBe(true);
  });
});
