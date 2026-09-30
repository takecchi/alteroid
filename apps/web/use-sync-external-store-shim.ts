/**
 * `use-sync-external-store/shim` の差し替え先（`vite.config.ts` の `resolve.alias`）。
 *
 * shim（`use-sync-external-store@1.6.0`）の export は named の `useSyncExternalStore` ただ1つ
 * （`cjs/use-sync-external-store-shim.*.js` の `exports.useSyncExternalStore`。default は無い）。
 * React に `useSyncExternalStore` があれば shim はそれをそのまま返すので、React 19 では
 * 同じ関数になる。名前を合わせて React のものを再エクスポートするだけにする。
 */
export { useSyncExternalStore } from 'react';
