import { useEffect, useRef, type RefObject } from 'react';

/**
 * いまの値を指す ref。保存・送信の `.then` の中は「送った時点」の値しか見えないので、
 * 成功時に「いまの欄の値が送った値と同じか」を比べるために使う（保存中の追記を黙って消さない）。
 */
export function useLatest<T>(value: T): RefObject<T> {
  const ref = useRef(value);
  useEffect(() => {
    ref.current = value;
  });
  return ref;
}
