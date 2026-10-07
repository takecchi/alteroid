import { createHash } from 'node:crypto';

import { createRunnerHost, type RunnerHost } from '@alteroid/core';
import { describe, expect, it } from 'vitest';

import { createRunnerApp, Outbox } from './app.js';

const TOKEN = 'daemon-only-token';
const TOKEN_SHA256 = createHash('sha256').update(TOKEN, 'utf8').digest('hex');

function bearer(): Record<string, string> {
  return { authorization: `Bearer ${TOKEN}`, accept: 'text/event-stream' };
}

// `reader.read()` を無条件に await しない: 来ないときにテストタイムアウトで落ち、何が来ていたのかが出力に出ないため。
async function readUntil(
  reader: ReadableStreamDefaultReader<Uint8Array>,
  needle: string,
  budgetMs: number,
): Promise<string> {
  const decoder = new TextDecoder();
  let seen = '';
  let timer: ReturnType<typeof setTimeout> | undefined;
  // 期限は1本で持つ: 読むたびに張り直すと、1回ごとの待ちになって合計が伸びるため。
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

function newHost(): RunnerHost {
  return createRunnerHost({
    runnerId: 'runner-events-heartbeat-test',
    workspacePath: '/workspace',
    emit: () => undefined,
  });
}

describe('runner の /events heartbeat', () => {
  it('outbox に何も push しなくても、無音のあいだに : hb が書かれる', async () => {
    const host = newHost();
    const app = createRunnerApp({
      host,
      outbox: new Outbox(),
      tokenSha256: TOKEN_SHA256,
      sseHeartbeatMs: 5,
    });

    const response = await app.request('/events', { headers: bearer() });
    const body = response.body;
    if (body === null) throw new Error('SSE の応答に本文が無い');

    const reader = body.getReader();
    const seen = await readUntil(reader, ': hb', 1000);

    expect(seen).toContain(': hb');
    expect(seen).toContain('event: hello');

    await reader.cancel();
    await host.shutdown();
  });

  it('間隔より短いあいだは heartbeat は流れない（上の試験が周期を見ている証拠）', async () => {
    const host = newHost();
    const app = createRunnerApp({
      host,
      outbox: new Outbox(),
      tokenSha256: TOKEN_SHA256,
      sseHeartbeatMs: 60_000,
    });

    const response = await app.request('/events', { headers: bearer() });
    const body = response.body;
    if (body === null) throw new Error('SSE の応答に本文が無い');

    const reader = body.getReader();
    const seen = await readUntil(reader, 'event: hello', 1000);
    expect(seen).toContain('event: hello');

    const next = await Promise.race([
      reader.read().then(({ value }) => new TextDecoder().decode(value)),
      new Promise<'まだ何も来ていない'>((resolve) =>
        setTimeout(() => resolve('まだ何も来ていない'), 100),
      ),
    ]);
    expect(next).toBe('まだ何も来ていない');

    await reader.cancel();
    await host.shutdown();
  });
});
