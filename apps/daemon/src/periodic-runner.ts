import { reasonOf, writeStderrLine } from '@alteroid/core';

export interface PeriodicRun<T> {
  /** いま1回走らせる。走っている間は、その回を返す（重ねない）。 */
  refresh(): Promise<T>;
  stop(): void;
}

/**
 * 重ねない周期の繰り返しの骨組み（#5697）。起動時にすぐ1回走らせ、終わってから `intervalMs` 待って次を走らせる。
 * 失敗は `run` の中で受けて結果に畳むのが原則。投げても、骨組みが受けて stderr に1行残し、次の回を予約する（止まった後は予約しない）。
 * `refresh()` を直接呼んだ呼び手には、投げた失敗がそのまま拒否で返る。
 * 骨組みを1つに置く: 定期処理ごとに手で書くと、止め方・重ねない判定・`unref` が片方だけ変わるため。
 */
export function startPeriodicRun<T>(options: {
  readonly intervalMs: number;
  readonly signal?: AbortSignal | undefined;
  readonly run: () => Promise<T>;
}): PeriodicRun<T> {
  let inFlight: Promise<T> | null = null;
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

  const refresh = (): Promise<T> => {
    if (inFlight !== null) return inFlight;
    inFlight = options.run().finally(() => {
      inFlight = null;
    });
    return inFlight;
  };

  // 骨組みが起こす回だけ失敗を受ける（`refresh` を直接呼んだ呼び手には拒否のまま返す）。受けないと、受けられない拒否で daemon が落ち、次の回も予約されない。
  const runThenSchedule = () =>
    refresh()
      .catch((error: unknown) => {
        writeStderrLine(
          `alteroidd: 定期処理の回が失敗しました（次の回は予約します）: ${reasonOf(error)}\n`,
        );
      })
      .then(() => schedule(options.intervalMs));

  const schedule = (delay: number) => {
    if (stopped) return;
    timer = setTimeout(() => {
      void runThenSchedule();
    }, delay);
    timer.unref?.();
  };

  void runThenSchedule();

  return { refresh, stop };
}
