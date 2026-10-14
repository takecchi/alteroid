import type { SSEStreamingApi } from 'hono/streaming';

/**
 * SSE の書き出し（`writeSSE` / `write`）に期限を掛ける（#4671）。
 * 受け手が読まずに接続だけを保つと書き出しが返らず、送り待ちの溢れや資格切れの判定に届かないまま購読ごと居座るため。
 * 期限を過ぎたら `stream.abort()` で流れを畳み、書き出しの待ちは戻す（呼び手のループは `stream.aborted` を見て抜け、購読を外す）。
 * `abort()` を呼ぶ: 書きかけが残っている間は `close()` が解決せず、応答が終わらないため（runner の `/events` と同じ）。
 */
export function guardSseWrites(
  stream: SSEStreamingApi,
  deadlineMs: number,
  onExpired: (what: 'writeSSE' | 'write') => void,
): SSEStreamingApi {
  const guard = async <T>(what: 'writeSSE' | 'write', run: () => Promise<T>): Promise<void> => {
    let timer: ReturnType<typeof setTimeout> | undefined;
    const expired = new Promise<'expired'>((resolve) => {
      timer = setTimeout(() => resolve('expired'), deadlineMs);
      timer.unref?.();
    });
    const writing = run();
    // 期限で手放した書き出しが後から失敗しても、未処理の拒否にしない
    writing.catch(() => undefined);
    try {
      const outcome = await Promise.race([writing.then(() => 'written' as const), expired]);
      if (outcome === 'expired' && !stream.aborted) {
        onExpired(what);
        stream.abort();
      }
    } finally {
      if (timer !== undefined) clearTimeout(timer);
    }
  };
  return new Proxy(stream, {
    get(target, property) {
      if (property === 'writeSSE') {
        return (message: Parameters<SSEStreamingApi['writeSSE']>[0]) =>
          guard('writeSSE', () => target.writeSSE(message));
      }
      if (property === 'write') {
        return async (input: Parameters<SSEStreamingApi['write']>[0]) => {
          await guard('write', () => target.write(input));
          return target;
        };
      }
      const value: unknown = Reflect.get(target, property, target);
      return typeof value === 'function'
        ? (value as (...args: unknown[]) => unknown).bind(target)
        : value;
    },
  });
}
