import { useEffect, useRef, type RefObject } from 'react';

// then の中ではクロージャの値でなくこの ref を読む: クロージャは送った時点の値を握ったままのため
export function useLatest<T>(value: T): RefObject<T> {
  const ref = useRef(value);
  useEffect(() => {
    ref.current = value;
  });
  return ref;
}
