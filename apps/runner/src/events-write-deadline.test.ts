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
    runnerId: 'runner-write-deadline-test',
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

async function readUntil(
  reader: ReadableStreamDefaultReader<Uint8Array>,
  needle: string,
  budgetMs: number,
): Promise<string> {
  const decoder = new TextDecoder();
  let seen = '';
  let timer: ReturnType<typeof setTimeout> | undefined;
  const expired = new Promise<'期限切れ'>((resolve) => {
    timer = setTimeout(() => resolve('期限切れ'), budgetMs);
    timer.unref?.();
  });
  try {
    while (!seen.includes(needle)) {
      const next = await Promise.race([reader.read(), expired]);
      if (next === '期限切れ') break;
      if (next.done) break;
      seen += decoder.decode(next.value, { stream: true });
    }
  } finally {
    if (timer !== undefined) clearTimeout(timer);
  }
  return seen;
}

// 単発の `reader.read()` にしない: `abort()` 直後の最初の `read()` は `hello` を返し、`done: true` になるのは次の `read()` なため。
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

describe('runner の /events: 締め切りを過ぎた書き込みは接続を畳む', () => {
  it('締め切りを過ぎたら stream.abort() で畳み、応答が終わる', async () => {
    const host = newHost();
    const outbox = new Outbox();
    const event: RunnerEvent = { type: 'session', managerId: 'mgr-stuck', sessionId: 'sess-stuck' };
    outbox.push(event);

    const { spy, calls } = hangOnRealEvents();
    const stderrSpy = vi.spyOn(process.stderr, 'write').mockImplementation(() => true);
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

      await expect.poll(() => calls.length, { timeout: 1000 }).toBe(1);

      const outcome = await readUntilClosed(reader, 2000);
      expect(outcome).toBe('closed');

      const logged = stderrSpy.mock.calls.map((args) => String(args[0])).join('');
      expect(logged).toContain('alteroid-runner:');
      expect(logged).toContain('20ms');

      await host.shutdown();
    } finally {
      spy.mockRestore();
      stderrSpy.mockRestore();
    }
  });

  it('畳んだとき、書きかけの1件と後続が全部 outbox へ戻る（1件も落ちない）', async () => {
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
    const stderrSpy = vi.spyOn(process.stderr, 'write').mockImplementation(() => true);
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

      await expect.poll(() => outbox.pending, { timeout: 1000 }).toBe(3);

      const outcome = await readUntilClosed(reader, 2000);
      expect(outcome).toBe('closed');

      expect(outbox.pending).toBe(3);

      await host.shutdown();
    } finally {
      spy.mockRestore();
      stderrSpy.mockRestore();
    }
  });

  it('締め切り内に返る書き込みでは畳まない（陰性対照）', async () => {
    const host = newHost();
    const outbox = new Outbox();
    const event1: RunnerEvent = { type: 'session', managerId: 'mgr-a', sessionId: 'sess-a' };
    const event2: RunnerEvent = { type: 'session', managerId: 'mgr-b', sessionId: 'sess-b' };
    outbox.push(event1);

    const app = createRunnerApp({
      host,
      outbox,
      tokenSha256: TOKEN_SHA256,
      sseHeartbeatMs: 60_000,
      sseWriteDeadlineMs: 2_000,
    });

    const response = await app.request('/events', { headers: bearer() });
    const body = response.body;
    if (body === null) throw new Error('SSE の応答に本文が無い');
    const reader = body.getReader();

    const first = await readUntil(reader, JSON.stringify(event1), 1000);
    expect(first).toContain(JSON.stringify(event1));

    outbox.push(event2);
    const second = await readUntil(reader, JSON.stringify(event2), 1000);
    expect(second).toContain(JSON.stringify(event2));

    await reader.cancel();
    await host.shutdown();
  });

  it('queue が空で待っているだけの接続は畳まれない（陰性対照）', async () => {
    const host = newHost();
    const outbox = new Outbox();

    const app = createRunnerApp({
      host,
      outbox,
      tokenSha256: TOKEN_SHA256,
      sseHeartbeatMs: 60_000,
      sseWriteDeadlineMs: 5,
    });

    const response = await app.request('/events', { headers: bearer() });
    const body = response.body;
    if (body === null) throw new Error('SSE の応答に本文が無い');
    const reader = body.getReader();

    const hello = await readUntil(reader, 'event: hello', 1000);
    expect(hello).toContain('event: hello');

    // ここで `reader.read()` を呼ばない: 期限切れの `read()` が孤立し、次の `readUntil` の `read()` がその後ろに並んで出来事を拾えなくなるため。
    await new Promise((resolve) => setTimeout(resolve, 200));

    const event: RunnerEvent = { type: 'session', managerId: 'mgr-late', sessionId: 'sess-late' };
    outbox.push(event);
    const seen = await readUntil(reader, JSON.stringify(event), 1000);
    expect(seen).toContain(JSON.stringify(event));

    await reader.cancel();
    await host.shutdown();
  });
});
