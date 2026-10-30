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
    runnerId: 'runner-write-deadline-test',
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

// 単発の `reader.read()` にしない: `abort()` 直後の最初の `read()` は `hello` を返し、`done: true` になるのは次の `read()` なため。
// 終わったかどうかは呼び元が旗で見る（偽の時計の下で期限を張らない）。
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

describe('runner の /events: 締め切りを過ぎた書き込みは接続を畳む', () => {
  it('締め切りを過ぎたら stream.abort() で畳み、応答が終わる（締め切りの手前では畳まない）', async () => {
    fakeClock();
    const host = newHost();
    const outbox = new Outbox();
    const event: RunnerEvent = { type: 'session', managerId: 'mgr-stuck', sessionId: 'sess-stuck' };
    outbox.push(event);

    const { spy, calls } = hangOnRealEvents();
    try {
      const lines = await captureStderr(async () => {
        const app = createRunnerApp({ host, outbox, tokenSha256: TOKEN_SHA256, ...appDefaults() });

        const response = await app.request('/events', { headers: bearer() });
        const body = response.body;
        if (body === null) throw new Error('SSE の応答に本文が無い');
        const watch = watchClosed(body.getReader());

        await vi.advanceTimersByTimeAsync(0);
        expect(calls).toHaveLength(1);

        await vi.advanceTimersByTimeAsync(SSE_WRITE_DEADLINE_MS - 1);
        expect(watch.closed()).toBe(false);
        await vi.advanceTimersByTimeAsync(1);
        expect(watch.closed()).toBe(true);
      });

      const logged = lines.join('');
      expect(logged).toContain('alteroid-runner:');
      expect(logged).toContain(`${String(SSE_WRITE_DEADLINE_MS)}ms`);

      await host.shutdown();
    } finally {
      spy.mockRestore();
    }
  });

  it('畳んだとき、書きかけの1件と後続が全部 outbox へ戻る（1件も落ちない）', async () => {
    fakeClock();
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
      await captureStderr(async () => {
        const app = createRunnerApp({ host, outbox, tokenSha256: TOKEN_SHA256, ...appDefaults() });

        const response = await app.request('/events', { headers: bearer() });
        const body = response.body;
        if (body === null) throw new Error('SSE の応答に本文が無い');
        const watch = watchClosed(body.getReader());

        await vi.advanceTimersByTimeAsync(0);
        expect(outbox.pending).toBe(3);

        await vi.advanceTimersByTimeAsync(SSE_WRITE_DEADLINE_MS);
        expect(watch.closed()).toBe(true);

        expect(outbox.pending).toBe(3);
      });

      await host.shutdown();
    } finally {
      spy.mockRestore();
    }
  });

  it('締め切り内に返る書き込みでは畳まない（陰性対照）', async () => {
    const host = newHost();
    const outbox = new Outbox();
    const event1: RunnerEvent = { type: 'session', managerId: 'mgr-a', sessionId: 'sess-a' };
    const event2: RunnerEvent = { type: 'session', managerId: 'mgr-b', sessionId: 'sess-b' };
    outbox.push(event1);

    const app = createRunnerApp({ host, outbox, tokenSha256: TOKEN_SHA256, ...appDefaults() });

    const response = await app.request('/events', { headers: bearer() });
    const body = response.body;
    if (body === null) throw new Error('SSE の応答に本文が無い');
    const reader = body.getReader();

    const first = await readUntil(reader, JSON.stringify(event1));
    expect(first).toContain(JSON.stringify(event1));

    outbox.push(event2);
    const second = await readUntil(reader, JSON.stringify(event2));
    expect(second).toContain(JSON.stringify(event2));

    await reader.cancel();
    await host.shutdown();
  });

  it('queue が空で待っているだけの接続は、締め切りを過ぎても畳まれない（陰性対照）', async () => {
    fakeClock();
    const host = newHost();
    const outbox = new Outbox();

    const app = createRunnerApp({ host, outbox, tokenSha256: TOKEN_SHA256, ...appDefaults() });

    const response = await app.request('/events', { headers: bearer() });
    const body = response.body;
    if (body === null) throw new Error('SSE の応答に本文が無い');
    const reader = body.getReader();

    const hello = await readUntil(reader, 'event: hello');
    expect(hello).toContain('event: hello');

    // ここで `reader.read()` を呼ばない: 孤立した `read()` が、次の `readUntil` の `read()` の前に並んで出来事を拾えなくなるため。
    await vi.advanceTimersByTimeAsync(SSE_WRITE_DEADLINE_MS + 1);

    const event: RunnerEvent = { type: 'session', managerId: 'mgr-late', sessionId: 'sess-late' };
    outbox.push(event);
    const seen = await readUntil(reader, JSON.stringify(event));
    expect(seen).toContain(JSON.stringify(event));

    await reader.cancel();
    await host.shutdown();
  });
});
