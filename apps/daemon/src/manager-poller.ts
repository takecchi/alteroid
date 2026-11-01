import { notePhase, reasonOf, writeStderrLine, type ManagerPool } from '@alteroid/core';

import { startPeriodicRun } from './periodic-runner.js';

// `Registry#beat()` に相乗りしない: 生ログは最大 1.7MB で読みに行くコストが heartbeat と桁違いに重いため。
export const MANAGER_POLL_INTERVAL_MS = 60_000;

export interface ManagerPollerOptions {
  managers: ManagerPool;
  intervalMs?: number;
  signal?: AbortSignal;
}

export interface ManagerPoller {
  refresh(): Promise<void>;
  stop(): void;
}

export function startManagerPolling(options: ManagerPollerOptions): ManagerPoller {
  const interval = options.intervalMs ?? MANAGER_POLL_INTERVAL_MS;

  // 段ごとの直前の失敗の理由（プロセスの中だけ）: 60 秒ごとに同じ失敗を書き積まないため。成功した段は消して、次に落ちたら書く。
  // 日誌へは書かない: 見回りの失敗で日誌を埋めないため。
  const lastFailure = new Map<string, string>();
  const noteFailure = (label: string, error: unknown) => {
    const reason = reasonOf(error);
    if (lastFailure.get(label) === reason) return;
    lastFailure.set(label, reason);
    writeStderrLine(
      `alteroidd: 見回りの段 ${label} が失敗しました（次の回も続けます）: ${reason}\n`,
    );
  };

  // 段ごとに印を打つ（#4485）: 見回りは印の無いまま 60 秒ごとに5段を回すので、どれかの段の同期の処理がループを止めても、
  // 止まった窓の「直前の印」が直前に通った別の出来事（runner の tool_use など）に見えていたため
  const step = (label: string, run: () => Promise<unknown> | undefined): Promise<void> => {
    notePhase(`poller:${label}`);
    let pending: Promise<unknown> | undefined;
    try {
      pending = run();
    } catch (error) {
      // 段の失敗で他の段を止めない
      noteFailure(label, error);
      return Promise.resolve();
    }
    return Promise.resolve(pending).then(
      () => {
        lastFailure.delete(label);
      },
      (error: unknown) => {
        noteFailure(label, error);
      },
    );
  };

  const probe = (): Promise<void> => {
    // `sweepRescueRefs()` は連鎖に繋がない: 削除は runner へ1本ずつ待つ（最大約1分）ので、繋ぐと他の関心事の次の周期が止まるため。
    void step('rescue-refs', () => options.managers.sweepRescueRefs?.());
    // `autoFoldUnderPressure()` も連鎖に繋がない: 各 runner へ資源を問い合わせる往復（最大 5 秒 × 台数）で遅れても、他の段の周期を止めないため。30 分の間引きは pool 側。
    void step('auto-fold', () => options.managers.autoFoldUnderPressure?.());
    return (
      step('turn-ends', () => options.managers.probeTurnEnds())
        // `settleStalledUsageWakes()` は `probeTurnEnds()` より後に置く: 読む `record.turnEndedAt` が同じ回に計算し直した値でないと古い助言で判定するため。
        .then(() => step('withheld-reports', () => options.managers.flushWithheldReports()))
        .then(() => step('usage-wakes', () => options.managers.settleStalledUsageWakes()))
        .then(() => step('denials', () => options.managers.renotifyStalledDenials()))
        .then(() => step('held-messages', () => options.managers.deliverHeldMessages?.()))
        .finally(() => {
          notePhase('poller:done');
        })
    );
  };

  // 重ねない・止める・次の予約は `startPeriodicRun` が持つ: 走っている間の `refresh` は同じ回を返す
  return startPeriodicRun({ intervalMs: interval, signal: options.signal, run: probe });
}
