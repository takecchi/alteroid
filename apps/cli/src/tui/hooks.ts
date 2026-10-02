/**
 * React とストアの橋。出所: takecchi/codiva（MIT）`src/ui/hooks.ts` の `useSessions`
 * （100ms にまとめた `useSyncExternalStore`）。
 */
import { useCallback, useRef, useState, useSyncExternalStore, type MutableRefObject } from 'react';

import type { Store } from './store.js';

/** 通知をまとめる窓。ストリームの細かい更新が来ても描画は 100ms に 1 回までにする。 */
export const COALESCE_MS = 100;

export function useCoalescedStore<S>(store: Store<S>, ms: number = COALESCE_MS): S {
  const subscribe = useCallback(
    (onChange: () => void) => {
      let timer: ReturnType<typeof setTimeout> | undefined;
      const unsubscribe = store.subscribe(() => {
        if (timer !== undefined) return;
        timer = setTimeout(() => {
          timer = undefined;
          onChange();
        }, ms);
      });
      return () => {
        // 保留中の通知も止める（アンマウント後に発火しないように）。
        if (timer !== undefined) clearTimeout(timer);
        timer = undefined;
        unsubscribe();
      };
    },
    [store, ms],
  );
  return useSyncExternalStore(subscribe, store.getSnapshot, store.getSnapshot);
}

/**
 * 値を state と ref の両方に持つ。更新は**同期的に** ref へ反映してから state を更新する
 * （ref は入力ハンドラの中でだけ読む。描画は返り値の state を使う）。
 * 1 画面 1 つの `useInput` へ続けて届くキー（貼り付け・IME の確定・長押し）は、描画を待たずに
 * 次が来る。state だけだと次のキーが古い値に適用されて文字が落ちる。
 */
export function useSyncedState<T>(
  initial: T,
): [T, (next: T | ((prev: T) => T)) => void, MutableRefObject<T>] {
  const [state, setState] = useState<T>(initial);
  const ref = useRef<T>(initial);
  const set = useCallback((next: T | ((prev: T) => T)) => {
    const value = typeof next === 'function' ? (next as (prev: T) => T)(ref.current) : next;
    if (Object.is(value, ref.current)) return;
    ref.current = value;
    setState(value);
  }, []);
  return [state, set, ref];
}
