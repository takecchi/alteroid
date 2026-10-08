export const DEFAULT_SSE_HEARTBEAT_MS = 15_000;

// `\n\n` で終える: 空行が無いと次のフィールド行と1メッセージに混ざるため
export const HEARTBEAT_FRAME = ': hb\n\n';

// hono の型を import しない: core は hono に依存しない層のため
export interface SseHeartbeatStream {
  readonly aborted: boolean;
  readonly closed: boolean;
  write(input: string): Promise<unknown>;
}

export function startSseHeartbeat(
  stream: SseHeartbeatStream,
  intervalMs: number,
  wake: () => void,
  onBeat?: () => void,
): () => void {
  const timer = setInterval(() => {
    if (stream.aborted || stream.closed) {
      clearInterval(timer);
      wake();
      return;
    }
    // 分割して書かない: 進行中の writeSSE() の chunk の中へバイトが混ざりうるため
    // void だけで済ませない: 拾われない拒否は Node 15 以降でプロセスを落とし、1本の死んだ接続がデーモン全体を落とすため
    void stream.write(HEARTBEAT_FRAME).catch(() => {});
    onBeat?.();
  }, intervalMs);
  // unref() する: heartbeat はプロセスを生かしておく理由ではなく、ref したままだと停止時に event loop を空にできない理由が増えるため
  timer.unref?.();
  return () => clearInterval(timer);
}
