import { useSyncExternalStore } from 'react';

function subscribe(onChange: () => void): () => void {
  document.addEventListener('visibilitychange', onChange);
  return () => document.removeEventListener('visibilitychange', onChange);
}

/**
 * このタブが見えているか（`document.visibilityState === 'visible'`）。
 * 裏に回ったあと戻ってきたとき（`visibilitychange`）に値が変わって、再描画される。
 */
export function usePageVisible(): boolean {
  return useSyncExternalStore(
    subscribe,
    () => document.visibilityState === 'visible',
    () => true,
  );
}
