import { createHash } from 'node:crypto';

import { createRunnerHost, type RunnerEvent, type RunnerHost } from '@alteroid/core';
import { SSEStreamingApi, type SSEMessage } from 'hono/streaming';
import { describe, expect, it, vi } from 'vitest';

import { createRunnerApp, Outbox } from './app.js';

const TOKEN = 'daemon-only-token';
const TOKEN_SHA256 = createHash('sha256').update(TOKEN, 'utf8').digest('hex');

function bearer(): Record<string, string> {
  return { authorization: `Bearer ${TOKEN}`, accept: 'text/event-stream' };
}

function newHost(): RunnerHost {
  return createRunnerHost({
    runnerId: 'runner-outbox-pending-test',
    workspacePath: '/workspace',
    emit: () => undefined,
  });
}

function hangOnRealEvents(): { spy: ReturnType<typeof vi.spyOn>; calls: string[] } {
  const realWriteSSE = SSEStreamingApi.prototype.writeSSE;
  const calls: string[] = [];
  const spy = vi.spyOn(SSEStreamingApi.prototype, 'writeSSE').mockImplementation(async function (
    this: SSEStreamingApi,
    message: SSEMessage,
  ) {
    if (message.event === 'hello') return realWriteSSE.call(this, message);
    calls.push(message.event ?? '');
    return new Promise<void>(() => undefined);
  });
  return { spy, calls };
}

describe('Outbox.pending: listener が付いたままでも溜まりが見える（#358）', () => {
  it('listener が付いたまま出来事が溜まったとき、pending が立つ（直す前はここで 0 を返していた）', async () => {
    const host = newHost();
    const outbox = new Outbox();
    const events: RunnerEvent[] = [
      { type: 'session', managerId: 'mgr-1', sessionId: 'sess-1' },
      { type: 'session', managerId: 'mgr-2', sessionId: 'sess-2' },
      { type: 'session', managerId: 'mgr-3', sessionId: 'sess-3' },
    ];
    for (const event of events) outbox.push(event);
    expect(outbox.pending).toBe(3);

    const { spy } = hangOnRealEvents();
    try {
      const app = createRunnerApp({
        host,
        outbox,
        tokenSha256: TOKEN_SHA256,
        sseHeartbeatMs: 60_000,
      });

      const response = await app.request('/events', { headers: bearer() });
      const body = response.body;
      if (body === null) throw new Error('SSE の応答に本文が無い');
      const reader = body.getReader();

      await expect.poll(() => outbox.pending, { timeout: 1000 }).toBe(3);

      await reader.cancel();
      await host.shutdown();
    } finally {
      spy.mockRestore();
    }
  });

  it('writeSSE の途中で止まっている1件も数に入る', async () => {
    const host = newHost();
    const outbox = new Outbox();
    const event: RunnerEvent = { type: 'session', managerId: 'mgr-solo', sessionId: 'sess-solo' };
    outbox.push(event);

    const { spy, calls } = hangOnRealEvents();
    try {
      const app = createRunnerApp({
        host,
        outbox,
        tokenSha256: TOKEN_SHA256,
        sseHeartbeatMs: 60_000,
      });

      const response = await app.request('/events', { headers: bearer() });
      const body = response.body;
      if (body === null) throw new Error('SSE の応答に本文が無い');
      const reader = body.getReader();

      await expect.poll(() => calls.length, { timeout: 1000 }).toBe(1);
      expect(calls).toEqual(['session']);

      expect(outbox.pending).toBe(1);

      await reader.cancel();
      await host.shutdown();
    } finally {
      spy.mockRestore();
    }
  });
});
