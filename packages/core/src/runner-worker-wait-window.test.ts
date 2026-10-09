import { describe, expect, it } from 'vitest';

import { RunnerWorkerWaitWindow } from './runner-worker-wait-window.js';

const turnOf = (overrides: Partial<Parameters<RunnerWorkerWaitWindow['foldTurn']>[0]> = {}) => ({
  inputsThisTurn: 0,
  notificationsThisTurn: 0,
  toolsThisTurn: 1,
  submitsThisTurn: 0,
  sourcesThisTurn: new Map<string, number>(),
  ...overrides,
});

describe('RunnerWorkerWaitWindow — taskStarted（0→1 で窓を開く）', () => {
  it('最初の taskStarted で窓を開き、tasks を1にする', () => {
    const win = new RunnerWorkerWaitWindow();
    win.taskStarted('task-1');
    const closed = win.foldTurn(turnOf());
    expect(closed).toBeNull();
  });

  it('2件目の taskStarted は同じ窓の tasks を積み増す（開き直さない）', () => {
    const win = new RunnerWorkerWaitWindow();
    win.taskStarted('task-1');
    win.taskStarted('task-2');
    win.notified('task-1');
    win.notified('task-2');
    const closed = win.close();
    expect(closed?.tasks).toBe(2);
    expect(closed?.openedAt).toBeDefined();
  });

  it('閉じ待ちの間に次の委譲が始まったら、閉じずに同じ区間として続ける', () => {
    const win = new RunnerWorkerWaitWindow();
    win.taskStarted('task-1');
    win.notified('task-1');
    win.taskStarted('task-2');
    const closed = win.foldTurn(turnOf());
    expect(closed).toBeNull();
    win.notified('task-2');
    const closedAfter = win.close();
    expect(closedAfter?.tasks).toBe(2);
  });
});

describe('RunnerWorkerWaitWindow — notified（1→0 の遷移だけで閉じ待ちを立てる）', () => {
  it('対応する task_started を見ていない通知（had が false）では閉じ待ちを立てない', () => {
    const win = new RunnerWorkerWaitWindow();
    win.taskStarted('task-1');
    win.notified('unknown-task');
    const closed = win.foldTurn(turnOf());
    expect(closed).toBeNull();
  });

  it('taskId が undefined の通知では何もしない', () => {
    const win = new RunnerWorkerWaitWindow();
    win.taskStarted('task-1');
    win.notified(undefined);
    win.notified('task-1');
    const closed = win.close();
    expect(closed?.settled).toBe(true);
  });

  it('複数開いている途中の通知では、まだ閉じ待ちにしない（1→0 のときだけ）', () => {
    const win = new RunnerWorkerWaitWindow();
    win.taskStarted('task-1');
    win.taskStarted('task-2');
    win.notified('task-1');
    const closed = win.foldTurn(turnOf());
    expect(closed).toBeNull();
  });
});

describe('RunnerWorkerWaitWindow — foldTurn（ターンの集計を足し込む）', () => {
  it('窓が無ければ何もせず null を返す（委譲の外で起きたターン）', () => {
    const win = new RunnerWorkerWaitWindow();
    expect(win.foldTurn(turnOf())).toBeNull();
  });

  it('契機は排他で1件だけ数える：入力が優先', () => {
    const win = new RunnerWorkerWaitWindow();
    win.taskStarted('task-1');
    win.notified('task-1');
    const closed = win.foldTurn(turnOf({ inputsThisTurn: 2, notificationsThisTurn: 1 }));
    expect(closed?.byCause).toEqual({ input: 1, notification: 0, continuation: 0 });
    expect(closed?.turns).toBe(1);
  });

  it('契機は排他で1件だけ数える：入力が無ければ通知', () => {
    const win = new RunnerWorkerWaitWindow();
    win.taskStarted('task-1');
    win.notified('task-1');
    const closed = win.foldTurn(turnOf({ notificationsThisTurn: 1 }));
    expect(closed?.byCause).toEqual({ input: 0, notification: 1, continuation: 0 });
  });

  it('契機は排他で1件だけ数える：どちらも無ければ continuation', () => {
    const win = new RunnerWorkerWaitWindow();
    win.taskStarted('task-1');
    win.notified('task-1');
    const closed = win.foldTurn(turnOf());
    expect(closed?.byCause).toEqual({ input: 0, notification: 0, continuation: 1 });
  });

  it('toolsThisTurn が0のターンを toolless に数える', () => {
    const win = new RunnerWorkerWaitWindow();
    win.taskStarted('task-1');
    win.notified('task-1');
    const closed = win.foldTurn(turnOf({ toolsThisTurn: 0 }));
    expect(closed?.toolless).toBe(1);
  });

  it('notifications / submits を積み増す（tasks 以下とは限らない）', () => {
    const win = new RunnerWorkerWaitWindow();
    win.taskStarted('task-1');
    win.notified('task-1');
    const closed = win.foldTurn(turnOf({ notificationsThisTurn: 3, submitsThisTurn: 2 }));
    expect(closed?.notifications).toBe(3);
    expect(closed?.submits).toBe(2);
  });

  it('sources は複数ターンにまたがって加算する', () => {
    const win = new RunnerWorkerWaitWindow();
    win.taskStarted('task-1');
    win.taskStarted('task-2');
    win.foldTurn(turnOf({ sourcesThisTurn: new Map([['cli', 1]]) }));
    win.notified('task-1');
    win.notified('task-2');
    const closed = win.foldTurn(
      turnOf({
        sourcesThisTurn: new Map([
          ['cli', 2],
          ['api', 1],
        ]),
      }),
    );
    expect(closed?.sources).toEqual({ cli: 3, api: 1 });
  });

  it('sources が1件も無ければフィールドごと省く', () => {
    const win = new RunnerWorkerWaitWindow();
    win.taskStarted('task-1');
    win.notified('task-1');
    const closed = win.foldTurn(turnOf());
    expect(closed).not.toHaveProperty('sources');
  });

  it('windowClosing が立っていなければ、足し込むだけで閉じない', () => {
    const win = new RunnerWorkerWaitWindow();
    win.taskStarted('task-1');
    const closed = win.foldTurn(turnOf());
    expect(closed).toBeNull();
  });

  it('windowClosing が立っていれば、足し込んだ直後に閉じて中身を返す（settled: true）', () => {
    const win = new RunnerWorkerWaitWindow();
    win.taskStarted('task-1');
    win.notified('task-1');
    const closed = win.foldTurn(turnOf());
    expect(closed).not.toBeNull();
    expect(closed?.settled).toBe(true);
    expect(closed?.turns).toBe(1);
    expect(win.foldTurn(turnOf())).toBeNull();
  });
});

describe('RunnerWorkerWaitWindow — close（組み立てて返し、空に戻す）', () => {
  it('窓が無ければ null を返す（`#finish` / `stop` / 引き継ぎのどこから呼んでも安全）', () => {
    const win = new RunnerWorkerWaitWindow();
    expect(win.close()).toBeNull();
  });

  it('全員から完了通知を受け切っていれば settled: true', () => {
    const win = new RunnerWorkerWaitWindow();
    win.taskStarted('task-1');
    win.notified('task-1');
    expect(win.close()?.settled).toBe(true);
  });

  it('受け切る前に閉じれば settled: false（`runner-wakeup.test.ts` と同じ形）', () => {
    const win = new RunnerWorkerWaitWindow();
    win.taskStarted('task-1');
    win.taskStarted('task-2');
    win.notified('task-1');
    expect(win.close()?.settled).toBe(false);
  });

  it('閉じた後は窓が空に戻る（二度目の close は null）', () => {
    const win = new RunnerWorkerWaitWindow();
    win.taskStarted('task-1');
    win.notified('task-1');
    expect(win.close()).not.toBeNull();
    expect(win.close()).toBeNull();
  });

  it('close() は #openTasks を1バイトも変えない（順序の約束の前提）', () => {
    const win = new RunnerWorkerWaitWindow();
    win.taskStarted('task-1');
    const firstClose = win.close();
    expect(firstClose?.settled).toBe(false);

    win.taskStarted('task-2');
    win.notified('task-2');
    const secondClose = win.close();
    expect(secondClose?.settled).toBe(false);

    win.clear();
    win.taskStarted('task-3');
    win.notified('task-3');
    expect(win.close()?.settled).toBe(true);
  });
});

describe('RunnerWorkerWaitWindow — clear（`close()` の後にだけ呼ぶ想定）', () => {
  it('openTasks を空にする', () => {
    const win = new RunnerWorkerWaitWindow();
    win.taskStarted('task-1');
    win.close();
    win.clear();
    win.taskStarted('task-2');
    win.notified('task-2');
    expect(win.close()?.settled).toBe(true);
  });

  it('窓が無い状態で呼んでも安全（no-op）', () => {
    const win = new RunnerWorkerWaitWindow();
    expect(() => win.clear()).not.toThrow();
  });
});
