import { RUNNER_KEEP_ALIVE_TIMEOUT_MS } from '@alteroid/core';
import { describe, expect, it } from 'vitest';

import { createRunnerHttpServer } from './index.js';

describe('runner の入口が作る HTTP サーバに keep-alive を掛ける（#4915）', () => {
  it('⭐ 入口のサーバは keepAliveTimeout が runner の値で、headersTimeout がそれより長い', () => {
    const server = createRunnerHttpServer(() => new Response('ok'));
    try {
      expect(server.keepAliveTimeout).toBe(RUNNER_KEEP_ALIVE_TIMEOUT_MS);
      expect(server.headersTimeout).toBeGreaterThan(server.keepAliveTimeout);
    } finally {
      server.close();
    }
  });
});
