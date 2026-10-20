import { notePhase, type ManagerPool } from '@alteroid/core';

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

  let inFlight: Promise<void> | null = null;
  let timer: ReturnType<typeof setTimeout> | undefined;
  let stopped = false;

  const stop = () => {
    stopped = true;
    if (timer !== undefined) {
      clearTimeout(timer);
      timer = undefined;
    }
  };
  options.signal?.addEventListener('abort', stop, { once: true });

  // 段ごとに印を打つ（#4485）: 見回りは印の無いまま 60 秒ごとに5段を回すので、どれかの段の同期の処理がループを止めても、
  // 止まった窓の「直前の印」が直前に通った別の出来事（runner の tool_use など）に見えていたため
  const step = (label: string, run: () => Promise<unknown> | undefined): Promise<void> => {
    notePhase(`poller:${label}`);
    let pending: Promise<unknown> | undefined;
    try {
      pending = run();
    } catch {
      // 段の失敗で他の段を止めない（今までの `.catch(() => undefined)` と同じ扱い）
      return Promise.resolve();
    }
    return Promise.resolve(pending)
      .catch(() => undefined)
      .then(() => undefined);
  };

  const probe = (): Promise<void> => {
    if (inFlight !== null) return inFlight;
    // `sweepRescueRefs()` は連鎖に繋がない: 削除は runner へ1本ずつ待つ（最大約1分）ので、繋ぐと他の関心事の次の周期が止まるため。
    void step('rescue-refs', () => options.managers.sweepRescueRefs?.());
    inFlight = step('turn-ends', () => options.managers.probeTurnEnds())
      // `settleStalledUsageWakes()` は `probeTurnEnds()` より後に置く: 読む `record.turnEndedAt` が同じ回に計算し直した値でないと古い助言で判定するため。
      .then(() => step('withheld-reports', () => options.managers.flushWithheldReports()))
      .then(() => step('usage-wakes', () => options.managers.settleStalledUsageWakes()))
      .then(() => step('denials', () => options.managers.renotifyStalledDenials()))
      .then(() => step('held-messages', () => options.managers.deliverHeldMessages?.()))
      .finally(() => {
        notePhase('poller:done');
        inFlight = null;
      });
    return inFlight;
  };

  const schedule = (delay: number) => {
    if (stopped) return;
    timer = setTimeout(() => {
      void probe().then(() => schedule(interval));
    }, delay);
    timer.unref?.();
  };

  void probe().then(() => schedule(interval));

  return {
    refresh: probe,
    stop,
  };
}
