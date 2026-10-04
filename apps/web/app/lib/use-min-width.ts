/**
 * 画面幅が `minWidthPx` 以上か。`matchMedia` を見る（回転や分割表示で幅が変わっても追いつく）。
 *
 * CSS の `xl:` だけで並びを変えず JS で見るのは、**幅で DOM の順そのものを変えたい**ときのため
 * （見た目の順だけ `order-*` で入れ替えると、キーボードと読み上げの順が見た目と食い違う）。
 * 値は `apps/web/app/test-support.tsx` の `setViewportWidth` で動かせる。
 */
import { useCallback, useSyncExternalStore } from 'react';

export function useMinWidth(minWidthPx: number): boolean {
  const query = `(min-width: ${minWidthPx}px)`;
  const subscribe = useCallback(
    (onChange: () => void) => {
      const list = window.matchMedia(query);
      list.addEventListener('change', onChange);
      return () => list.removeEventListener('change', onChange);
    },
    [query],
  );
  // SPA（`ssr: false`）なのでサーバ側の値は使われない。狭い側（縦積み）を既定にしておく。
  return useSyncExternalStore(
    subscribe,
    () => window.matchMedia(query).matches,
    () => false,
  );
}
