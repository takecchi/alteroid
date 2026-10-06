import { useEffect, useRef, type RefObject } from 'react';

/**
 * いまの値を指す ref。非同期の応答が返った時点の「いまの入力」を、送った時点の値と比べるために使う
 * （応答を待つ間に打ち足した分を、成功のあとに消さない。issue #3515）。
 * クロージャは送った時点の値を握ったままなので、then の中ではこの ref を読む。
 */
export function useLatest<T>(value: T): RefObject<T> {
  const ref = useRef(value);
  useEffect(() => {
    ref.current = value;
  });
  return ref;
}
