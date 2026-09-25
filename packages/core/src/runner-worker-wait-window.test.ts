import { describe, expect, it } from 'vitest';

import { RunnerWorkerWaitWindow } from './runner-worker-wait-window.js';

/**
 * `runner-worker-wait-window.ts` の歯。**純粋なクラスなので I/O のモック無しで
 * 全分岐に通せる**（`runner-resume-state.test.ts` / `runner-turn-tally.test.ts`
 * と同じ作法。前例は PR #1565 / #1551 / #1523）。
 *
 * ここが固定するのは、切り出した3フィールドの**状態の器としての性質**
 * ——0→1 で窓を開く・1→0 で閉じ待ちを立てる・閉じ待ちの間に次の委譲が
 * 始まったら取り消す・ターンの集計を足し込む・閉じて中身を組み立てて空に
 * 戻す・`close()` は `#openTasks` を変えない、である。`RunnerSession` が
 * 「いつ呼ぶか・`#emit` するかどうか・`#turnTally` とどう受け渡すか」の判断は
 * 既存のブラックボックステスト（`runner-wakeup.test.ts` /
 * `runner-failure.test.ts` / `runner-resume-recreate-worker-count.test.ts` /
 * `runner-post-tool-use-failure.test.ts` /
 * `runner-post-tool-use-failure-resume.test.ts` /
 * `runner-resume-recovery.test.ts` 等）が引き続き持つ——ここでは扱わない。
 */

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
    // 窓が開いたことは foldTurn 経由でしか観測できない（このクラスに
    // 窓の中身そのものを覗く getter は無い——`RunnerSession` 側も持っていない）。
    const closed = win.foldTurn(turnOf());
    expect(closed).toBeNull(); // windowClosing が立っていないので閉じない
  });

  it('2件目の taskStarted は同じ窓の tasks を積み増す（開き直さない）', () => {
    const win = new RunnerWorkerWaitWindow();
    win.taskStarted('task-1');
    win.taskStarted('task-2');
    win.notified('task-1');
    win.notified('task-2'); // 1→0: 閉じ待ちが立つ
    const closed = win.close();
    expect(closed?.tasks).toBe(2);
    expect(closed?.openedAt).toBeDefined();
  });

  it('閉じ待ちの間に次の委譲が始まったら、閉じずに同じ区間として続ける', () => {
    const win = new RunnerWorkerWaitWindow();
    win.taskStarted('task-1');
    win.notified('task-1'); // 1→0: 閉じ待ちが立つ
    win.taskStarted('task-2'); // 閉じ待ちの間に次の委譲。取り消して同じ区間を継続
    // ここで foldTurn しても、windowClosing は取り消されているので閉じない。
    const closed = win.foldTurn(turnOf());
    expect(closed).toBeNull();
    // 窓は生きたまま——task-2 の完了通知でようやく閉じる。
    win.notified('task-2');
    const closedAfter = win.close();
    expect(closedAfter?.tasks).toBe(2); // task-1 と task-2 の両方を同じ窓で数えている
  });
});

describe('RunnerWorkerWaitWindow — notified（1→0 の遷移だけで閉じ待ちを立てる）', () => {
  it('対応する task_started を見ていない通知（had が false）では閉じ待ちを立てない', () => {
    const win = new RunnerWorkerWaitWindow();
    win.taskStarted('task-1');
    win.notified('unknown-task'); // 対応が無い。openTasks は空にならない
    const closed = win.foldTurn(turnOf());
    expect(closed).toBeNull(); // windowClosing は立っていない
  });

  it('taskId が undefined の通知では何もしない', () => {
    const win = new RunnerWorkerWaitWindow();
    win.taskStarted('task-1');
    win.notified(undefined);
    win.notified('task-1'); // 本物の1→0
    const closed = win.close();
    expect(closed?.settled).toBe(true);
  });

  it('複数開いている途中の通知では、まだ閉じ待ちにしない（1→0 のときだけ）', () => {
    const win = new RunnerWorkerWaitWindow();
    win.taskStarted('task-1');
    win.taskStarted('task-2');
    win.notified('task-1'); // 2→1。まだ閉じ待ちにしない
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
    win.notified('task-1'); // notifications はここでは数えない（RunnerSession 側の役目）
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
    win.taskStarted('task-1'); // 完了通知はまだ無い
    const closed = win.foldTurn(turnOf());
    expect(closed).toBeNull();
  });

  it('windowClosing が立っていれば、足し込んだ直後に閉じて中身を返す（settled: true）', () => {
    const win = new RunnerWorkerWaitWindow();
    win.taskStarted('task-1');
    win.notified('task-1'); // 1→0: 閉じ待ち
    const closed = win.foldTurn(turnOf());
    expect(closed).not.toBeNull();
    expect(closed?.settled).toBe(true);
    expect(closed?.turns).toBe(1); // 閉じる直前のこのターンも数えてから閉じる
    // 閉じた後は窓が空——次の foldTurn は null。
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
    win.notified('task-1'); // 1件だけ通知。task-2 はまだ開いたまま
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
    win.taskStarted('task-1'); // task-1 は完了通知を受けないまま残す
    const firstClose = win.close();
    expect(firstClose?.settled).toBe(false); // task-1 がまだ開いている

    // **close() を呼んでも openTasks は変わっていない** ——次の窓を開いても、
    // 残っている task-1 が settled を汚染し続けることで、変わっていないことを
    // 観測する（`clear()` を呼ぶまでこの汚染は消えない）。
    win.taskStarted('task-2');
    win.notified('task-2'); // task-2 だけ完了。task-1 は依然として残っている
    const secondClose = win.close();
    expect(secondClose?.settled).toBe(false); // task-1 の残骸のせいで settled にならない

    // clear() を呼んで初めて汚染が消える。
    win.clear();
    win.taskStarted('task-3');
    win.notified('task-3');
    expect(win.close()?.settled).toBe(true);
  });
});

describe('RunnerWorkerWaitWindow — clear（`close()` の後にだけ呼ぶ想定）', () => {
  it('openTasks を空にする', () => {
    const win = new RunnerWorkerWaitWindow();
    win.taskStarted('task-1'); // 完了通知を受けないまま残す
    win.close(); // 窓を閉じる（`close()` は openTasks を変えない——直上の歯）
    win.clear(); // ここでようやく task-1 の残骸が消える
    // clear 後は残骸が無いので、新しい窓は素直に settled: true になる。
    win.taskStarted('task-2');
    win.notified('task-2');
    expect(win.close()?.settled).toBe(true);
  });

  it('窓が無い状態で呼んでも安全（no-op）', () => {
    const win = new RunnerWorkerWaitWindow();
    expect(() => win.clear()).not.toThrow();
  });
});
