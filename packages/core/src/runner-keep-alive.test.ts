import { createServer } from 'node:http';

import { describe, expect, it } from 'vitest';

import {
  RUNNER_CLIENT_KEEP_ALIVE_MS,
  RUNNER_KEEP_ALIVE_TIMEOUT_MS,
  applyRunnerKeepAlive,
} from './runner-keep-alive.js';

describe('runner の HTTP サーバの keep-alive（#4890）', () => {
  it('サーバの持ち時間は、クライアントの持ち時間（心拍10秒より長い）より長い', () => {
    expect(RUNNER_CLIENT_KEEP_ALIVE_MS).toBeGreaterThan(10_000);
    expect(RUNNER_KEEP_ALIVE_TIMEOUT_MS).toBeGreaterThan(RUNNER_CLIENT_KEEP_ALIVE_MS);
  });

  it('keepAliveTimeout を引き上げ、headersTimeout をそれより長くする（本物の node の http サーバ）', () => {
    const server = createServer();
    try {
      expect(server.keepAliveTimeout).toBeLessThan(RUNNER_KEEP_ALIVE_TIMEOUT_MS);
      applyRunnerKeepAlive(server);
      expect(server.keepAliveTimeout).toBe(RUNNER_KEEP_ALIVE_TIMEOUT_MS);
      expect(server.headersTimeout).toBeGreaterThan(server.keepAliveTimeout);
    } finally {
      server.close();
    }
  });

  it('すでに長い値は短くしない。headersTimeout の 0（無制限）はそのまま', () => {
    const server = { keepAliveTimeout: 120_000, headersTimeout: 0 };
    applyRunnerKeepAlive(server);
    expect(server).toEqual({ keepAliveTimeout: 120_000, headersTimeout: 0 });
  });
});
