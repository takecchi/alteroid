import type { ManagerPool } from '@alteroid/core';

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

  const probe = (): Promise<void> => {
    if (inFlight !== null) return inFlight;
    // `sweepRescueRefs()` は連鎖に繋がない: 削除は runner へ1本ずつ待つ（最大約1分）ので、繋ぐと他の関心事の次の周期が止まるため。
    void Promise.resolve(options.managers.sweepRescueRefs?.()).catch(() => undefined);
    inFlight = options.managers
      .probeTurnEnds()
      .catch(() => undefined)
      // `settleStalledUsageWakes()` は `probeTurnEnds()` より後に置く: 読む `record.turnEndedAt` が同じ回に計算し直した値でないと古い助言で判定するため。
      .then(() => options.managers.flushWithheldReports().catch(() => undefined))
      .then(() => options.managers.settleStalledUsageWakes().catch(() => undefined))
      .then(() => options.managers.renotifyStalledDenials().catch(() => undefined))
      .then(() => undefined)
      .finally(() => {
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
