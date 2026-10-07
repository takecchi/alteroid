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
    runnerId: 'runner-hello-deadline-test',
    workspacePath: '/workspace',
    emit: () => undefined,
  });
}

function hangOnHello(): { spy: ReturnType<typeof vi.spyOn>; calls: string[] } {
  const calls: string[] = [];
  const spy = vi.spyOn(SSEStreamingApi.prototype, 'writeSSE').mockImplementation(async function (
    this: SSEStreamingApi,
    message: SSEMessage,
  ) {
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

describe('runner の /events: 最初の hello 書き込みも締め切りで塞ぐ', () => {
  it('hello が締め切りを過ぎたら stream.abort() で畳み、応答が終わる', async () => {
    const host = newHost();
    const outbox = new Outbox();

    const { spy, calls } = hangOnHello();
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
      expect(calls[0]).toBe('hello');

      const outcome = await readUntilClosed(reader, 2000);
      expect(outcome).toBe('closed');

      const logged = stderrSpy.mock.calls.map((args) => String(args[0])).join('');
      expect(logged).toContain('alteroid-runner:');
      expect(logged).toContain('hello');
      expect(logged).toContain('20ms');
      expect(logged).not.toContain('書きかけの1件を含め');
      expect(logged).toContain('（この接続が抱えていた 0 件を箱へ戻します）');

      await host.shutdown();
    } finally {
      spy.mockRestore();
      stderrSpy.mockRestore();
    }
  });

  it('hello 待ち中に抱えていた滞留も、畳んだとき outbox へ全部戻る（1件も落ちない）', async () => {
    const host = newHost();
    const outbox = new Outbox();
    const events: RunnerEvent[] = [
      { type: 'session', managerId: 'mgr-1', sessionId: 'sess-1' },
      { type: 'session', managerId: 'mgr-2', sessionId: 'sess-2' },
    ];
    for (const event of events) outbox.push(event);
    expect(outbox.pending).toBe(2);

    const { spy } = hangOnHello();
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

      const outcome = await readUntilClosed(reader, 2000);
      expect(outcome).toBe('closed');

      expect(outbox.pending).toBe(2);

      const logged = stderrSpy.mock.calls.map((args) => String(args[0])).join('');
      expect(logged).toContain('（この接続が抱えていた 2 件を箱へ戻します）');

      await host.shutdown();
    } finally {
      spy.mockRestore();
      stderrSpy.mockRestore();
    }
  });

  it('hello が締め切り内に返るときは畳まない（陰性対照）', async () => {
    const host = newHost();
    const outbox = new Outbox();
    const event: RunnerEvent = { type: 'session', managerId: 'mgr-a', sessionId: 'sess-a' };

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

    const hello = await readUntil(reader, 'event: hello', 1000);
    expect(hello).toContain('event: hello');

    outbox.push(event);
    const seen = await readUntil(reader, JSON.stringify(event), 1000);
    expect(seen).toContain(JSON.stringify(event));

    await reader.cancel();
    await host.shutdown();
  });
});
