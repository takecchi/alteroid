// SSE を張り直すまでの待ち: 1 秒から倍々で、30 秒で頭打ち。画面（SWR フック）と TUI が同じ値を読む。
// core の `REGISTRY_RETRY_*` は runner の名簿の再試行で、別の持ち主（値が今は同じでも連動させない）
export const SSE_RETRY_BASE_MS = 1_000;
export const SSE_RETRY_MAX_MS = 30_000;

// `attempt` は 0 始まりの、続けて失敗した回数
export function sseRetryDelay(attempt: number): number {
  return Math.min(SSE_RETRY_BASE_MS * 2 ** attempt, SSE_RETRY_MAX_MS);
}
