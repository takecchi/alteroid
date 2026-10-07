export interface TokenPoolWriteLock {
  // 握るのは読み直し→書き戻しの短い区間だけにする: probe や spread の間まで握ると、人間の PUT /tokens が最大60秒待たされるため
  run<T>(work: () => Promise<T>): Promise<T>;
}

// 本番では1つだけ作って両方へ渡す: 別々のインスタンスを渡すと直列化の意味が消えるため。
// 各サービス内の serial() は消さない: この鍵とは別の意味を持つため
export function createTokenPoolWriteLock(): TokenPoolWriteLock {
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
  };
}
