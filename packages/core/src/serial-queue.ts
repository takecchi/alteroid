export interface SerialQueue {
  // 前の処理が終わる（成功でも失敗でも）のを待ってから走る。呼び手へ返るのは自分の結果と自分の失敗だけ
  run<T>(work: () => Promise<T>): Promise<T>;
  // いま積まれている処理がすべて終わると解決する（失敗では拒否しない）。待っている間に積まれたものは待たない
  idle(): Promise<unknown>;
}

// 前の失敗で列が止まらないように、列の尾は常に解決する形で繋ぐ。
export function createSerialQueue(): SerialQueue {
  let tail: Promise<unknown> = Promise.resolve();
  return {
    run<T>(work: () => Promise<T>): Promise<T> {
      const next = tail.then(work, work);
      tail = next.then(
        () => undefined,
        () => undefined,
      );
      return next;
    },
    idle: () => tail,
  };
}
