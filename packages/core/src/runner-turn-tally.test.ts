import { describe, expect, it } from 'vitest';

import { RunnerTurnTally } from './runner-turn-tally.js';
import type { SdkFailure } from './sdk-failure.js';

/**
 * `runner-turn-tally.ts` の歯。**純粋なクラスなので I/O のモック無しで全分岐に
 * 通せる**（`runner-subagent-stop-state.test.ts` と同じ作法。前例は PR #1433）。
 *
 * ここが固定するのは、切り出した10フィールドの**状態の器としての性質**——
 * 積む・数える・「読み出して畳む」操作が畳む範囲の違い（`takeAtResult` /
 * `takeSaid` / `discardOpenedWorkersAndRejections`）——である。`RunnerSession`
 * が「いつ呼ぶか・emit するかどうか」を決める判断は `runner-failure.test.ts` /
 * `runner-wakeup.test.ts` / `runner-unreported.test.ts` /
 * `runner-resume-recreate-worker-count.test.ts`（ブラックボックス）が引き続き
 * 持つ——ここでは扱わない。
 */

const failureOf = (code: string): SdkFailure => ({ code, via: 'result_is_error', text: '' });

describe('RunnerTurnTally — 喋った本文と拒否の印（takeAtResult / takeSaid の畳む範囲の違い）', () => {
  it('hasSaid は積んだ本文が無ければ false、積めば true', () => {
    const tally = new RunnerTurnTally();
    expect(tally.hasSaid).toBe(false);
    tally.recordSaid('こんにちは', 'uuid-1');
    expect(tally.hasSaid).toBe(true);
  });

  it('takeAtResult は said・rejected を含む12フィールド全部を読み出して畳む（以後は初期状態に戻る）', () => {
    const tally = new RunnerTurnTally();
    tally.recordSaid('本文1', 'uuid-1');
    tally.recordSaid('本文2', 'uuid-2');
    tally.setRejected(failureOf('rate_limit'));
    tally.incrementInputsSinceResult();
    tally.incrementInputsSinceResult();
    tally.incrementNotificationsSinceResult();
    tally.incrementToolsSinceResult();
    tally.incrementSubmitsSinceResult();
    tally.recordSubmitSource('cli');
    tally.recordSubmitSource('cli');
    tally.addOpenedWorker('task-1');
    tally.addOpenedWorker('task-2');
    tally.pushWorkerRejection('billing_error');
    tally.recordFailedWorkerNotification('task-1', true);
    tally.recordFailedWorkerNotification('task-2', false);

    const taken = tally.takeAtResult();
    expect(taken.said).toEqual(['本文1', '本文2']);
    expect(taken.rejected).toEqual(failureOf('rate_limit'));
    expect(taken.inputsThisTurn).toBe(2);
    expect(taken.notificationsThisTurn).toBe(1);
    expect(taken.toolsThisTurn).toBe(1);
    expect(taken.submitsThisTurn).toBe(1);
    expect(taken.sourcesThisTurn.get('cli')).toBe(2);
    expect(taken.openedWorkersThisTurn).toBe(2);
    expect(taken.workerRejectionsThisTurn).toEqual(['billing_error']);
    expect(taken.failedWorkerNotificationsThisTurn).toBe(2);
    expect(taken.failedWorkerNotificationsNamingLimitThisTurn).toBe(1);

    // **畳んだ後は初期状態に戻る。** 二度目の takeAtResult は全部ゼロ／空を返す
    // ——`turn_ended` を跨いで前のターンの値が漏れないことを保証する形。
    const second = tally.takeAtResult();
    expect(second.said).toEqual([]);
    expect(second.rejected).toBeNull();
    expect(second.inputsThisTurn).toBe(0);
    expect(second.notificationsThisTurn).toBe(0);
    expect(second.toolsThisTurn).toBe(0);
    expect(second.submitsThisTurn).toBe(0);
    expect(second.sourcesThisTurn.size).toBe(0);
    expect(second.openedWorkersThisTurn).toBe(0);
    expect(second.workerRejectionsThisTurn).toEqual([]);
    expect(second.failedWorkerNotificationsThisTurn).toBe(0);
    expect(second.failedWorkerNotificationsNamingLimitThisTurn).toBe(0);
    expect(tally.hasSaid).toBe(false);
  });

  it('addOpenedWorker は同じ taskId を2度数えない', () => {
    const tally = new RunnerTurnTally();
    tally.addOpenedWorker('task-1');
    tally.addOpenedWorker('task-1');
    tally.addOpenedWorker('task-2');
    const taken = tally.takeAtResult();
    expect(taken.openedWorkersThisTurn).toBe(2);
  });

  it('recordFailedWorkerNotification は limitNamed が false の回を枠を名乗った件数に数えない', () => {
    const tally = new RunnerTurnTally();
    tally.recordFailedWorkerNotification('task-1', false);
    tally.recordFailedWorkerNotification('task-2', false);
    tally.recordFailedWorkerNotification('task-3', true);
    const taken = tally.takeAtResult();
    expect(taken.failedWorkerNotificationsThisTurn).toBe(3);
    expect(taken.failedWorkerNotificationsNamingLimitThisTurn).toBe(1);
  });

  it('🔴 #1569: 同じ taskId の failed 通知は何度届いても1体と数え、1回でも枠を名乗れば枠を名乗った側に数える', () => {
    const tally = new RunnerTurnTally();
    tally.recordFailedWorkerNotification('task-1', false);
    tally.recordFailedWorkerNotification('task-1', true);
    tally.recordFailedWorkerNotification('task-1', false);
    const taken = tally.takeAtResult();
    expect(taken.failedWorkerNotificationsThisTurn).toBe(1);
    expect(taken.failedWorkerNotificationsNamingLimitThisTurn).toBe(1);
  });

  it('#1569: taskId を持たない failed 通知は重複を除けないので1件ずつ数える', () => {
    const tally = new RunnerTurnTally();
    tally.recordFailedWorkerNotification(undefined, false);
    tally.recordFailedWorkerNotification(undefined, false);
    expect(tally.takeAtResult().failedWorkerNotificationsThisTurn).toBe(2);
  });

  it('takeSaid は said/reportId の2本だけを読み出して畳み、rejected と残り10本には触れない', () => {
    const tally = new RunnerTurnTally();
    tally.recordSaid('未報告の本文', 'uuid-said');
    tally.setRejected(failureOf('rate_limit'));
    tally.incrementInputsSinceResult();
    tally.incrementNotificationsSinceResult();
    tally.incrementToolsSinceResult();
    tally.incrementSubmitsSinceResult();
    tally.recordSubmitSource('cli');
    tally.addOpenedWorker('task-1');
    tally.pushWorkerRejection('billing_error');
    tally.recordFailedWorkerNotification('task-1', true);

    const { said, reportId } = tally.takeSaid();
    expect(said).toEqual(['未報告の本文']);
    expect(reportId).toBe('uuid-said');
    // **`said`/`saidUuid` は畳まれる。** 2度目は空。
    expect(tally.hasSaid).toBe(false);

    // **残り10本（rejected を含む）は takeSaid では触れない。**
    // takeAtResult で読み出して初めて畳まれていることを確認する。
    const taken = tally.takeAtResult();
    expect(taken.rejected).toEqual(failureOf('rate_limit'));
    expect(taken.inputsThisTurn).toBe(1);
    expect(taken.notificationsThisTurn).toBe(1);
    expect(taken.toolsThisTurn).toBe(1);
    expect(taken.submitsThisTurn).toBe(1);
    expect(taken.sourcesThisTurn.get('cli')).toBe(1);
    expect(taken.openedWorkersThisTurn).toBe(1);
    expect(taken.workerRejectionsThisTurn).toEqual(['billing_error']);
    expect(taken.failedWorkerNotificationsThisTurn).toBe(1);
    expect(taken.failedWorkerNotificationsNamingLimitThisTurn).toBe(1);
  });

  it('said が空のまま takeSaid を呼ぶと、reportId も undefined のまま返る（呼び出し側は hasSaid で先に見る想定）', () => {
    const tally = new RunnerTurnTally();
    const { said, reportId } = tally.takeSaid();
    expect(said).toEqual([]);
    expect(reportId).toBeUndefined();
  });

  it('discardOpenedWorkersAndRejections は openedWorkersThisTurn / workerRejectionsThisTurn / failedWorkerNotifications系2欄の3本だけを読み出さずに捨て、残り9本には触れない', () => {
    const tally = new RunnerTurnTally();
    tally.recordSaid('本文', 'uuid-x');
    tally.setRejected(failureOf('rate_limit'));
    tally.incrementInputsSinceResult();
    tally.incrementNotificationsSinceResult();
    tally.incrementToolsSinceResult();
    tally.incrementSubmitsSinceResult();
    tally.recordSubmitSource('cli');
    tally.addOpenedWorker('task-1');
    tally.pushWorkerRejection('billing_error');
    tally.recordFailedWorkerNotification('task-1', true);

    tally.discardOpenedWorkersAndRejections();

    // 捨てた3本は空に戻っている。
    const taken = tally.takeAtResult();
    expect(taken.openedWorkersThisTurn).toBe(0);
    expect(taken.workerRejectionsThisTurn).toEqual([]);
    expect(taken.failedWorkerNotificationsThisTurn).toBe(0);
    expect(taken.failedWorkerNotificationsNamingLimitThisTurn).toBe(0);

    // **残り9本は影響を受けない。** said/saidUuid/rejected/inputs/notifications/
    // tools/submits/sources は discardOpenedWorkersAndRejections を呼ぶ前の
    // 値のまま、takeAtResult で読み出せる。
    expect(taken.said).toEqual(['本文']);
    expect(taken.rejected).toEqual(failureOf('rate_limit'));
    expect(taken.inputsThisTurn).toBe(1);
    expect(taken.notificationsThisTurn).toBe(1);
    expect(taken.toolsThisTurn).toBe(1);
    expect(taken.submitsThisTurn).toBe(1);
    expect(taken.sourcesThisTurn.get('cli')).toBe(1);
  });

  it('recordSaid は uuid が undefined でも積める（result 到来前の assistant メッセージが uuid を持たない場合の型を許す）', () => {
    const tally = new RunnerTurnTally();
    tally.recordSaid('本文', undefined);
    const { said, reportId } = tally.takeSaid();
    expect(said).toEqual(['本文']);
    expect(reportId).toBeUndefined();
  });

  it('recordSubmitSource は同じ source を件数で畳む', () => {
    const tally = new RunnerTurnTally();
    tally.recordSubmitSource('cli');
    tally.recordSubmitSource('cli');
    tally.recordSubmitSource('web');
    const taken = tally.takeAtResult();
    expect(taken.sourcesThisTurn.get('cli')).toBe(2);
    expect(taken.sourcesThisTurn.get('web')).toBe(1);
    // **取れない軸に0の行を作らない。** 呼んでいない source は鍵ごと無い。
    expect(taken.sourcesThisTurn.has('unknown')).toBe(false);
  });

  it('pushWorkerRejection は複数件を順序どおり積める', () => {
    const tally = new RunnerTurnTally();
    tally.pushWorkerRejection('rate_limit');
    tally.pushWorkerRejection('billing_error');
    const taken = tally.takeAtResult();
    expect(taken.workerRejectionsThisTurn).toEqual(['rate_limit', 'billing_error']);
  });
});
