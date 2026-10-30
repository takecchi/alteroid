import { createHash } from 'node:crypto';

import { createRunnerHost, type RunnerEvent, type RunnerHost } from '@alteroid/core';
import { SSEStreamingApi, type SSEMessage } from 'hono/streaming';
import { afterEach, describe, expect, it, vi } from 'vitest';

import { createRunnerApp, Outbox } from './app.js';
import { appDefaults } from './app-defaults.test-support.js';
import { connectedSubscriber } from './outbox-subscribers.test-support.js';

const TOKEN = 'daemon-only-token';
const TOKEN_SHA256 = createHash('sha256').update(TOKEN, 'utf8').digest('hex');

function bearer(): Record<string, string> {
  return { authorization: `Bearer ${TOKEN}`, accept: 'text/event-stream' };
}

// 時刻（Date）だけを偽にする: SSE の締め切りなど他のタイマーは本物のまま
function setClock(iso: string): void {
  vi.useFakeTimers({ toFake: ['Date'] });
  vi.setSystemTime(new Date(iso));
}

afterEach(() => {
  vi.useRealTimers();
});

function newHost(): RunnerHost {
  return createRunnerHost({
    runnerId: 'runner-outbox-requeue-test',
    workspacePath: '/workspace',
    emit: () => undefined,
  });
}

// 守る事故: #630 (B)。差し戻しや引き渡しで queuedAt を「いま」に打ち直すと、oldestPendingAt が戻すたびに新しくなり、詰まりの古さを測る計器が嘘になる。
// #5692 で「差し戻し」自体が無くなった（出来事は列に残り、queuedAt は積んだときの1回だけ）ので、外から見える結果（積んだ時刻のまま答える）で縛る。
describe('Outbox: queuedAt は積んだときのまま（渡し先が変わっても、畳んでも。#630 (B)）', () => {
  it('積んだ出来事の oldestPendingAt は、後で時計が進み別の出来事が積まれても、積んだ時刻のまま', () => {
    setClock('2020-01-01T00:00:00.000Z');
    const outbox = new Outbox();
    outbox.push({ type: 'session', managerId: 'mgr-1', sessionId: 'sess-1' });
    setClock('2099-01-01T00:00:00.000Z');
    outbox.push({ type: 'session', managerId: 'mgr-1', sessionId: 'sess-2' });

    expect(outbox.oldestPendingAt).toBe('2020-01-01T00:00:00.000Z');
    expect(outbox.oldestPendingAt).not.toBe('2099-01-01T00:00:00.000Z');
  });

  it('push は「いま」の時刻を queuedAt にする——新規分は「いま」のまま', () => {
    setClock('2020-06-01T00:00:00.000Z');
    const outbox = new Outbox();
    const event: RunnerEvent = { type: 'session', managerId: 'mgr-2', sessionId: 'sess-2' };

    outbox.push(event);

    expect(outbox.oldestPendingAt).toBe('2020-06-01T00:00:00.000Z');
  });

  it('購読へ渡る queuedAt は、積んだときの値（渡すときの「いま」ではない）', () => {
    setClock('2020-01-01T00:00:00.000Z');
    const outbox = new Outbox();
    const event: RunnerEvent = { type: 'session', managerId: 'mgr-3', sessionId: 'sess-3' };
    outbox.push(event);
    setClock('2077-07-07T00:00:00.000Z');
    const received: { event: RunnerEvent; seq: number; queuedAt: string }[] = [];

    connectedSubscriber(outbox, (ev, seq, queuedAt) => received.push({ event: ev, seq, queuedAt }));

    expect(received).toHaveLength(1);
    expect(received[0]?.queuedAt).toBe('2020-01-01T00:00:00.000Z');
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
    setClock('2020-01-01T00:00:00.000Z');
    const outbox = new Outbox();
    const event: RunnerEvent = { type: 'session', managerId: 'mgr-stuck', sessionId: 'sess-stuck' };
    outbox.push(event);
    expect(outbox.oldestPendingAt).toBe('2020-01-01T00:00:00.000Z');

    setClock('2030-01-01T00:00:00.000Z');

    const { spy } = hangOnRealEvents();
    try {
      const app = createRunnerApp({
        host,
        outbox,
        tokenSha256: TOKEN_SHA256,
        sseHeartbeatMs: 60_000,
        sseWriteDeadlineMs: 20,
        ...appDefaults(),
      });

      const response = await app.request('/events', { headers: bearer() });
      const body = response.body;
      if (body === null) throw new Error('SSE の応答に本文が無い');
      const reader = body.getReader();

      const outcome = await readUntilClosed(reader, 2000);
      expect(outcome).toBe('closed');
      expect(outbox.pending).toBe(1);

      expect(outbox.oldestPendingAt).toBe('2020-01-01T00:00:00.000Z');
      expect(outbox.oldestPendingAt).not.toBe('2030-01-01T00:00:00.000Z');

      await reader.cancel();
      await host.shutdown();
    } finally {
      spy.mockRestore();
    }
  });
});
