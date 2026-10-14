/** CLI の control channel への求め（`interrupt` など）が期限内に答えなかった（#4664）。答えが後から来たかどうかは分からない。 */
export class ControlRequestTimeoutError extends Error {
  readonly timeoutMs: number;

  constructor(what: string, timeoutMs: number) {
    super(`${what} が ${String(timeoutMs)}ms 以内に返らなかった`);
    this.name = 'ControlRequestTimeoutError';
    this.timeoutMs = timeoutMs;
  }
}

/** 人間の「止める」操作が `interrupt` の答えを待つ期限（#4664）。同じ control channel の `getContextUsage`（`CONTEXT_USAGE_READ_TIMEOUT_MS`）に揃える。 */
export const CLONE_INTERRUPT_TIMEOUT_MS = 10_000;

/**
 * control channel への求めの答えを `ms` まで待つ。過ぎたら {@link ControlRequestTimeoutError} を投げる。
 * 打ち切った後に返ってきた答えと失敗は捨てる（未処理の拒否にしない）。
 */
export async function controlRequestWithin<T>(
  answer: Promise<T>,
  ms: number,
  what: string,
): Promise<T> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  const expired = new Promise<never>((_, reject) => {
    timer = setTimeout(() => {
      reject(new ControlRequestTimeoutError(what, ms));
    }, ms);
  });
  answer.catch(() => undefined);
  try {
    return await Promise.race([answer, expired]);
  } finally {
    clearTimeout(timer);
  }
}
