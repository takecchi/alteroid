import { createHash } from 'node:crypto';

import { captureStderr, createRunnerHost, type RunnerEvent, type RunnerHost } from '@alteroid/core';
import { SSEStreamingApi, type SSEMessage } from 'hono/streaming';
import { afterEach, describe, expect, it, vi } from 'vitest';

import { createRunnerApp, Outbox, SSE_WRITE_DEADLINE_MS } from './app.js';
import { appDefaults } from './app-defaults.test-support.js';

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

// 偽の時計で締め切り（`SSE_WRITE_DEADLINE_MS`）を進める。ストリームの読み書きは本物のまま（時計だけを偽にする）。
function fakeClock(): void {
  vi.useFakeTimers({ toFake: ['setInterval', 'clearInterval', 'setTimeout', 'clearTimeout'] });
}

afterEach(() => {
  vi.useRealTimers();
});

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

// 来ないときは、テストのタイムアウトで落ちる（期限は偽の時計では張らない）。
async function readUntil(
  reader: ReadableStreamDefaultReader<Uint8Array>,
  needle: string,
): Promise<string> {
  const decoder = new TextDecoder();
  let seen = '';
  while (!seen.includes(needle)) {
    const next = await reader.read();
    if (next.done) break;
    seen += decoder.decode(next.value, { stream: true });
  }
  return seen;
}

// 終わったかどうかは旗で見る（偽の時計の下で期限を張らない）。
function watchClosed(reader: ReadableStreamDefaultReader<Uint8Array>): { closed: () => boolean } {
  let closed = false;
  void (async () => {
    for (;;) {
      const next = await reader.read();
      if (next.done) {
        closed = true;
        return;
      }
    }
  })();
  return { closed: () => closed };
}

describe('runner の /events: 最初の hello 書き込みも締め切りで塞ぐ', () => {
  it('hello が締め切りを過ぎたら stream.abort() で畳み、応答が終わる（手前では畳まない）', async () => {
    fakeClock();
    const host = newHost();
    const outbox = new Outbox();

    const { spy, calls } = hangOnHello();
    try {
      const lines = await captureStderr(async () => {
        const app = createRunnerApp({ host, outbox, tokenSha256: TOKEN_SHA256, ...appDefaults() });

        const response = await app.request('/events', { headers: bearer() });
        const body = response.body;
        if (body === null) throw new Error('SSE の応答に本文が無い');
        const watch = watchClosed(body.getReader());

        await vi.advanceTimersByTimeAsync(0);
        expect(calls).toHaveLength(1);
        expect(calls[0]).toBe('hello');

        await vi.advanceTimersByTimeAsync(SSE_WRITE_DEADLINE_MS - 1);
        expect(watch.closed()).toBe(false);
        await vi.advanceTimersByTimeAsync(1);
        expect(watch.closed()).toBe(true);
      });

      const logged = lines.join('');
      expect(logged).toContain('alteroid-runner:');
      expect(logged).toContain('hello');
      expect(logged).toContain(`${String(SSE_WRITE_DEADLINE_MS)}ms`);
      expect(logged).not.toContain('書きかけの1件を含め');
      expect(logged).toContain('（この接続が抱えていた 0 件を箱へ戻します）');

      await host.shutdown();
    } finally {
      spy.mockRestore();
    }
  });

  it('hello 待ち中に抱えていた滞留も、畳んだとき outbox へ全部戻る（1件も落ちない）', async () => {
    fakeClock();
    const host = newHost();
    const outbox = new Outbox();
    const events: RunnerEvent[] = [
      { type: 'session', managerId: 'mgr-1', sessionId: 'sess-1' },
      { type: 'session', managerId: 'mgr-2', sessionId: 'sess-2' },
    ];
    for (const event of events) outbox.push(event);
    expect(outbox.pending).toBe(2);

    const { spy } = hangOnHello();
    try {
      const lines = await captureStderr(async () => {
        const app = createRunnerApp({ host, outbox, tokenSha256: TOKEN_SHA256, ...appDefaults() });

        const response = await app.request('/events', { headers: bearer() });
        const body = response.body;
        if (body === null) throw new Error('SSE の応答に本文が無い');
        const watch = watchClosed(body.getReader());

        await vi.advanceTimersByTimeAsync(SSE_WRITE_DEADLINE_MS);
        expect(watch.closed()).toBe(true);
      });

      expect(outbox.pending).toBe(2);

      const logged = lines.join('');
      expect(logged).toContain('（この接続が抱えていた 2 件を箱へ戻します）');

      await host.shutdown();
    } finally {
      spy.mockRestore();
    }
  });

  it('hello が締め切り内に返るときは畳まない（陰性対照）', async () => {
    const host = newHost();
    const outbox = new Outbox();
    const event: RunnerEvent = { type: 'session', managerId: 'mgr-a', sessionId: 'sess-a' };

    const app = createRunnerApp({ host, outbox, tokenSha256: TOKEN_SHA256, ...appDefaults() });

    const response = await app.request('/events', { headers: bearer() });
    const body = response.body;
    if (body === null) throw new Error('SSE の応答に本文が無い');
    const reader = body.getReader();

    const hello = await readUntil(reader, 'event: hello');
    expect(hello).toContain('event: hello');

    outbox.push(event);
    const seen = await readUntil(reader, JSON.stringify(event));
    expect(seen).toContain(JSON.stringify(event));

    await reader.cancel();
    await host.shutdown();
  });
});
