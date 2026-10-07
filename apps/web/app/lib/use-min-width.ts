// CSS の order-* で入れ替えず JS で見る: 見た目の順だけ変えると、キーボードと読み上げの順が食い違うため
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
  return useSyncExternalStore(
    subscribe,
    () => window.matchMedia(query).matches,
    () => false,
  );
}
