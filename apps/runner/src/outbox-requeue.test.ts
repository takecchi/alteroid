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
    runnerId: 'runner-outbox-requeue-test',
    workspacePath: '/workspace',
    emit: () => undefined,
  });
}

describe('Outbox.requeue: 元の queuedAt を保ったまま戻す', () => {
  it('listener が居ないとき、requeue した値の queuedAt が this.#now() ではなく渡した引数のまま', () => {
    const outbox = new Outbox(() => 'WRONG-NOW-2099-01-01T00:00:00.000Z');
    const event: RunnerEvent = { type: 'session', managerId: 'mgr-1', sessionId: 'sess-1' };

    outbox.requeue(event, 'ORIGINAL-2020-01-01T00:00:00.000Z');

    expect(outbox.oldestPendingAt).toBe('ORIGINAL-2020-01-01T00:00:00.000Z');
    expect(outbox.oldestPendingAt).not.toBe('WRONG-NOW-2099-01-01T00:00:00.000Z');
  });

  it('push は requeue(event, this.#now()) に委譲する——新規分は「いま」のまま', () => {
    const outbox = new Outbox(() => 'NOW-2020-06-01T00:00:00.000Z');
    const event: RunnerEvent = { type: 'session', managerId: 'mgr-2', sessionId: 'sess-2' };

    outbox.push(event);

    expect(outbox.oldestPendingAt).toBe('NOW-2020-06-01T00:00:00.000Z');
  });

  it('listener が居るとき、requeue で渡した queuedAt がそのまま listener の第3引数に渡る', () => {
    const outbox = new Outbox(() => 'WRONG-NOW');
    const event: RunnerEvent = { type: 'session', managerId: 'mgr-3', sessionId: 'sess-3' };
    const received: { event: RunnerEvent; seq: number; queuedAt: string }[] = [];
    outbox.attach((ev, seq, queuedAt) => received.push({ event: ev, seq, queuedAt }));

    outbox.requeue(event, 'ORIGINAL-TIME');

    expect(received).toHaveLength(1);
    expect(received[0]?.queuedAt).toBe('ORIGINAL-TIME');
  });
});

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

// `outbox.pending` の poll で待たない: 書きかけの1件も合算して締め切りの前後で `1` のままで、発火前に満たされるため。応答が閉じるまで読む。
async function readUntilClosed(
  reader: ReadableStreamDefaultReader<Uint8Array>,
  budgetMs: number,
): Promise<'closed' | 'timeout'> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  const expired = new Promise<'timeout'>((resolve) => {
    timer = setTimeout(() => resolve('timeout'), budgetMs);
    timer.unref?.();
  });
  try {
    for (;;) {
      const next = await Promise.race([reader.read(), expired]);
      if (next === 'timeout') return 'timeout';
      if (next.done) return 'closed';
    }
  } finally {
    if (timer !== undefined) clearTimeout(timer);
  }
}

describe('/events の finally: 畳んで戻したときも元の queuedAt を保つ（(A)+(B) の結線）', () => {
  it('畳んで戻した後も oldestPendingAt は元の古い時刻を答える', async () => {
    const host = newHost();
    let clock = 'OLD-2020-01-01T00:00:00.000Z';
    const outbox = new Outbox(() => clock);
    const event: RunnerEvent = { type: 'session', managerId: 'mgr-stuck', sessionId: 'sess-stuck' };
    outbox.push(event);
    expect(outbox.oldestPendingAt).toBe('OLD-2020-01-01T00:00:00.000Z');

    clock = 'NEW-2030-01-01T00:00:00.000Z';

    const { spy } = hangOnRealEvents();
    try {
      const app = createRunnerApp({
        host,
        outbox,
        tokenSha256: TOKEN_SHA256,
        sseHeartbeatMs: 60_000,
        sseWriteDeadlineMs: 20,
      });

      const response = await app.request('/events', { headers: bearer() });
      const body = response.body;
      if (body === null) throw new Error('SSE の応答に本文が無い');
      const reader = body.getReader();

      const outcome = await readUntilClosed(reader, 2000);
      expect(outcome).toBe('closed');
      expect(outbox.pending).toBe(1);

      expect(outbox.oldestPendingAt).toBe('OLD-2020-01-01T00:00:00.000Z');
      expect(outbox.oldestPendingAt).not.toBe('NEW-2030-01-01T00:00:00.000Z');

      await reader.cancel();
      await host.shutdown();
    } finally {
      spy.mockRestore();
    }
  });
});
