import { notePhase, reasonOf, writeStderrLine, type ManagerPool } from '@alteroid/core';

import { startPeriodicRun } from './periodic-runner.js';

// `Registry#beat()` に相乗りしない: 生ログは最大 1.7MB で読みに行くコストが heartbeat と桁違いに重いため。
const MANAGER_POLL_INTERVAL_MS = 60_000;

interface PollStage {
  /** 印（`poller:<label>`）と stderr の段の名前 */
  readonly label: string;
  readonly run: () => Promise<unknown> | undefined;
}

interface ManagerPollerOptions {
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

  // 段ごとに印を打つ（#4485）: 見回りは印の無いまま 60 秒ごとに下の表の段を回すので、どれかの段の同期の処理がループを止めても、
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

  // 見回りの段の表。段の数・順・名前（= 印と stderr の名前）はここが持つ。失敗の握り方（止めない・間引く）と印の打ち方は全段で同じで、`step` が持つ。
  // 違うのは連鎖に繋ぐかだけで、表を 2 つに分けた: 繋がない段は周回の頭で全部起こして待たず、繋ぐ段は表の順に前の段が終わってから起こす。
  // 繋ぐ表を空にできない型（先頭 1 つ + 残り）にしたのは、先頭の段を同期で起こす（前に `Promise.resolve()` を挟んで 1 tick 遅らせない）ため。
  const detachedStages: readonly PollStage[] = [
    // 連鎖に繋がない: 削除は runner へ1本ずつ待つ（最大約1分）ので、繋ぐと他の関心事の次の周期が止まるため。
    { label: 'rescue-refs', run: () => options.managers.sweepRescueRefs() },
    // 連鎖に繋がない: 各 runner へ資源を問い合わせる往復（最大 5 秒 × 台数）で遅れても、他の段の周期を止めないため。30 分の間引きは pool 側。
    { label: 'auto-fold', run: () => options.managers.autoFoldUnderPressure() },
  ];
  const chainedStages: readonly [PollStage, ...PollStage[]] = [
    { label: 'turn-ends', run: () => options.managers.probeTurnEnds() },
    { label: 'withheld-reports', run: () => options.managers.flushWithheldReports() },
    // `probeTurnEnds()` より後に置く: 読む `record.turnEndedAt` が同じ回に計算し直した値でないと古い助言で判定するため。
    { label: 'usage-wakes', run: () => options.managers.settleStalledUsageWakes() },
    { label: 'denials', run: () => options.managers.renotifyStalledDenials() },
    { label: 'held-messages', run: () => options.managers.deliverHeldMessages() },
    // 報告由来の `done` で waiting のまま残した task を、猶予（30 分）を過ぎてから倒す。冪等で、台帳を数えるだけなので連鎖の末尾に置く
    { label: 'task-follow', run: () => options.managers.repairStrandedTasks() },
  ];

  const probe = (): Promise<void> => {
    for (const stage of detachedStages) {
      void step(stage.label, stage.run);
    }
    const [head, ...rest] = chainedStages;
    return rest
      .reduce(
        (previous, stage) => previous.then(() => step(stage.label, stage.run)),
        step(head.label, head.run),
      )
      .finally(() => {
        notePhase('poller:done');
      });
  };

  // 重ねない・止める・次の予約は `startPeriodicRun` が持つ: 走っている間の `refresh` は同じ回を返す
  return startPeriodicRun({ intervalMs: interval, signal: options.signal, run: probe });
}
