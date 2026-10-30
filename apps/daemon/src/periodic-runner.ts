export interface PeriodicRun<T> {
  /** いま1回走らせる。走っている間は、その回を返す（重ねない）。 */
  refresh(): Promise<T>;
  stop(): void;
}

/**
 * 重ねない周期の繰り返しの骨組み（#5697）。起動時にすぐ1回走らせ、終わってから `intervalMs` 待って次を走らせる。
 * `run` は投げない（失敗は中で受けて結果に畳む）こと: 投げると次の回を予約しない。
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

  const schedule = (delay: number) => {
    if (stopped) return;
    timer = setTimeout(() => {
      void refresh().then(() => schedule(options.intervalMs));
    }, delay);
    timer.unref?.();
  };

  void refresh().then(() => schedule(options.intervalMs));

  return { refresh, stop };
}
