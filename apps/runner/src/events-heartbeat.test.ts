import { createHash } from 'node:crypto';

import { createRunnerHost, DEFAULT_SSE_HEARTBEAT_MS, type RunnerHost } from '@alteroid/core';
import { afterEach, describe, expect, it, vi } from 'vitest';

import { createRunnerApp, Outbox } from './app.js';
import { appDefaults } from './app-defaults.test-support.js';

const TOKEN = 'daemon-only-token';
const TOKEN_SHA256 = createHash('sha256').update(TOKEN, 'utf8').digest('hex');

function bearer(): Record<string, string> {
  return { authorization: `Bearer ${TOKEN}`, accept: 'text/event-stream' };
}

// 偽の時計で心拍の周期（`DEFAULT_SSE_HEARTBEAT_MS`）を進める。ストリームの読み書きは本物のまま（時計だけを偽にする）。
function fakeClock(): void {
  vi.useFakeTimers({ toFake: ['setInterval', 'clearInterval', 'setTimeout', 'clearTimeout'] });
}

afterEach(() => {
  vi.useRealTimers();
});

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

function newHost(): RunnerHost {
  return createRunnerHost({
    runnerId: 'runner-events-heartbeat-test',
    workspacePath: '/workspace',
    emit: () => undefined,
  });
}

describe('runner の /events heartbeat', () => {
  it('outbox に何も push しなくても、無音のあいだに : hb が書かれる', async () => {
    fakeClock();
    const host = newHost();
    const app = createRunnerApp({
      host,
      outbox: new Outbox(),
      tokenSha256: TOKEN_SHA256,
      ...appDefaults(),
    });

    const response = await app.request('/events', { headers: bearer() });
    const body = response.body;
    if (body === null) throw new Error('SSE の応答に本文が無い');

    const reader = body.getReader();
    const hello = await readUntil(reader, 'event: hello');
    expect(hello).toContain('event: hello');

    await vi.advanceTimersByTimeAsync(DEFAULT_SSE_HEARTBEAT_MS);
    const seen = await readUntil(reader, ': hb');
    expect(seen).toContain(': hb');

    await reader.cancel();
    await host.shutdown();
  });

  it('間隔より短いあいだは heartbeat は流れず、間隔ちょうどで流れる（上の試験が周期を見ている証拠）', async () => {
    fakeClock();
    const host = newHost();
    const app = createRunnerApp({
      host,
      outbox: new Outbox(),
      tokenSha256: TOKEN_SHA256,
      ...appDefaults(),
    });

    const response = await app.request('/events', { headers: bearer() });
    const body = response.body;
    if (body === null) throw new Error('SSE の応答に本文が無い');

    const reader = body.getReader();
    const seen = await readUntil(reader, 'event: hello');
    expect(seen).toContain('event: hello');

    let next: string | undefined;
    const pending = reader.read().then(({ value }) => {
      next = new TextDecoder().decode(value);
    });
    await vi.advanceTimersByTimeAsync(DEFAULT_SSE_HEARTBEAT_MS - 1);
    expect(next).toBeUndefined();
    await vi.advanceTimersByTimeAsync(1);
    await pending;
    expect(next).toContain(': hb');

    await reader.cancel();
    await host.shutdown();
  });
});
