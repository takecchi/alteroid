import { describe, expect, it } from 'vitest';

import { SSE_RETRY_BASE_MS, SSE_RETRY_MAX_MS, sseRetryDelay } from './sse-retry.js';

describe('sseRetryDelay（指数バックオフ）', () => {
  it('1 秒から倍々で、30 秒で頭打ち', () => {
    expect([0, 1, 2, 3, 4, 5, 6, 10].map((n) => sseRetryDelay(n))).toEqual([
      1000, 2000, 4000, 8000, 16000, 30000, 30000, 30000,
    ]);
  });

  it('値は 1 秒と 30 秒', () => {
    expect(SSE_RETRY_BASE_MS).toBe(1_000);
    expect(SSE_RETRY_MAX_MS).toBe(30_000);
  });
});
