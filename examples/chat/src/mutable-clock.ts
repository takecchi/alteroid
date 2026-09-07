import type { Clock } from "@mnemora/core";

/**
 * `now()` が返す時刻を差し替えられる `Clock` 実装(`decay` を `freshness` から分離して測るために足す)。
 *
 * **`Clock` 型は `@mnemora/core` から公開されている**——`packages/core/src/index.ts` が
 * `export * from "./interfaces/clock.js"` しており、`interfaces/clock.ts` の
 * `export interface Clock { now(): Date }` がそのまま外へ出ている(`systemClock`/`fixedClock`
 * も同様に公開)。⟹ 構造的に満たす別形を用意する必要は無く、`@mnemora/core` の `Clock` を
 * そのまま実装する。
 *
 * **これで何ができるか**: `packages/core/src/runtime.ts` は `Observation.recordedAt` と
 * `Memory.recordedAt`/`decayFloorAt` の計算に `clock.now()` を使う(`RuntimeDeps.clock`、
 * 既定は `systemClock`)。これを注入すれば、`observe()` の `occurredAt` に触れずに
 * `recordedAt` だけを過去へ振れる——`decay` の起点は `lastReinforcedAt ?? recordedAt` で
 * あり `occurredAt` を読まない(`packages/core/src/strategies/scoring.ts` の docstring)ため、
 * これで `freshness` を動かさずに `decay` だけを動かせる。
 *
 * ⚠ **`packages/postgres` の `outbox.available_at` はこの `Clock` を読まない**——
 * `packages/postgres/src/memory-store.ts` の `INSERT INTO outbox (...)` は Postgres の
 * SQL `now()` を直接使っており(アプリ側から渡した `Date` パラメータではない)、この
 * `Clock` を過去に設定しても `available_at` は常に実際の DB サーバ時刻のままになる
 * (コードを読んで確認した——実行して確かめた実測ではない。`time-term-arm.ts` の
 * `runOneProbe` の docstring 参照)。
 */
export interface MutableClock extends Clock {
  set(at: Date): void;
}

/** 既定の初期値は実時刻(`new Date()`)。 */
export function createMutableClock(initial: Date = new Date()): MutableClock {
  let current = initial;
  return {
    now(): Date {
      return current;
    },
    set(at: Date): void {
      current = at;
    },
  };
}
