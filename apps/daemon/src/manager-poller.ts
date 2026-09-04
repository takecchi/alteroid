import type { ManagerPool } from '@alteroid/core';

/**
 * `ManagerPool` の2つの関心事を定期的に回す——`probeTurnEnds()`
 * （Issue #567）と `flushWithheldReports()`。
 *
 * **`packages/core/src/runner-protocol.ts` の `Registry#beat()`（10秒周期）に
 * 相乗りしない。** あそこは軽い `identity()` を投げるだけの場所で、コメントに
 * 「両方叩かないのは、10秒ごとに全台へ2往復を投げることになるからである」と
 * 書いてある。生ログは実測で最大 1.7MB あり、読みに行くコストは heartbeat とは
 * 桁違いに重い——別の緩いポーラーにする。
 *
 * 周期は分単位で足りる（`ManagerPool#probeTurnEnds` 自身の費用の門が10分の
 * 静止＋バックオフを持つので、ここを秒単位にしても大半は門で弾かれるだけである）。
 *
 * **この周期に `ManagerPool#flushWithheldReports()` も相乗りする**
 * （`probeTurnEnds()` の**後ろ**。中には入れない — あちらは費用の門を
 * 持つ別の関心事で、こちらは時間だけで判定する別物である）。理由は
 * `flushWithheldReports()` の doc のとおり——マネージャーが背景処理の
 * 完了待ちで畳んだ報告を握り潰したとき（`manager.ts` の `case 'report'`
 * の `event.awaitingBackground`）、次の本物の報告が来ればそれが自動で
 * 上書きするが、来なかった場合の逃げ道がここでしか作れない
 * （デーモン常駐のポーラーの外に、時間で必ず何かを起こす場所が無いため）。
 */
export const MANAGER_POLL_INTERVAL_MS = 60_000;

export interface ManagerPollerOptions {
  managers: ManagerPool;
  /** 主にテスト用。 */
  intervalMs?: number;
  /** 外から畳む（デーモンの終了時）。 */
  signal?: AbortSignal;
}

export interface ManagerPoller {
  /** いま取り直す（テスト用。本番はタイマーが自動で回す）。 */
  refresh(): Promise<void>;
  stop(): void;
}

/**
 * `usage-poller.ts` の `startUsagePolling` と同じ形——`setTimeout` チェーン・
 * 前の回が終わる前に次を始めない・`stop()` を持つ。
 *
 * **例外でプロセスを落とさない。** `ManagerPool#probeTurnEnds` 自身が1件の
 * 失敗でループを止めない設計だが（interface の doc）、ここでも `.catch()` で
 * 二重に握る——`probeTurnEnds` の契約が将来変わっても、このポーラーが原因で
 * デーモンごと落ちることはない。
 */
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
    // 重ねない。前の回がまだ生ログを読んでいる間は次を始めない。
    if (inFlight !== null) return inFlight;
    inFlight = options.managers
      .probeTurnEnds()
      .catch(() => undefined) // 例外でプロセスを落とさない。
      // **`probeTurnEnds()` の後ろに並べる。中には入れない**（上の doc）。
      // 前者が例外で終わっても後者は走る——別の関心事なので、片方の失敗が
      // もう片方を道連れにしない。
      .then(() => options.managers.flushWithheldReports().catch(() => undefined))
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
    // 観測が終了を引き止めないように。
    timer.unref?.();
  };

  // 起動直後に1回。**待たない**——デーモンの起動をこの周期に縛らない。
  void probe().then(() => schedule(interval));

  return {
    refresh: probe,
    stop,
  };
}
