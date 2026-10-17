import { createHash } from 'node:crypto';

import { captureStderr, createRunnerHost, type RunnerEvent, type RunnerHost } from '@alteroid/core';
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
    runnerId: 'runner-write-failure-test',
    workspacePath: '/workspace',
    emit: () => undefined,
  });
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

describe('runner の /events: writeSSE が投げても出来事を失わない（#358）', () => {
  it('書きかけの1件は outbox へ戻り、次の接続で配り直される', async () => {
    const host = newHost();
    const outbox = new Outbox();
    const event: RunnerEvent = {
      type: 'session',
      managerId: 'mgr-write-fail',
      sessionId: 'sess-write-fail',
    };
    outbox.push(event);
    expect(outbox.pending).toBe(1);

    const realWriteSSE = SSEStreamingApi.prototype.writeSSE;
    let thrown = false;
    const spy = vi.spyOn(SSEStreamingApi.prototype, 'writeSSE').mockImplementation(async function (
      this: SSEStreamingApi,
      message: SSEMessage,
    ) {
      if (message.event !== 'hello' && !thrown) {
        thrown = true;
        throw new Error('boom: 相手が読まなくなった接続への書き込みが失敗した（模擬）');
      }
      return realWriteSSE.call(this, message);
    });

    try {
      const app = createRunnerApp({
        host,
        outbox,
        tokenSha256: TOKEN_SHA256,
        sseHeartbeatMs: 60_000,
      });

      const first = await app.request('/events', { headers: bearer() });
      const firstBody = first.body;
      if (firstBody === null) throw new Error('SSE の応答に本文が無い');
      const firstReader = firstBody.getReader();

      await expect.poll(() => thrown, { timeout: 1000 }).toBe(true);

      await expect.poll(() => outbox.pending, { timeout: 1000 }).toBe(1);

      const second = await app.request('/events', { headers: bearer() });
      const secondBody = second.body;
      if (secondBody === null) throw new Error('SSE の応答に本文が無い');
      const secondReader = secondBody.getReader();

      const redelivered = await readUntil(secondReader, JSON.stringify(event), 1000);
      expect(redelivered).toContain(JSON.stringify(event));
      await expect.poll(() => outbox.pending, { timeout: 1000 }).toBe(0);

      await secondReader.cancel();
      await firstReader.cancel();
    } finally {
      spy.mockRestore();
      await host.shutdown();
    }
  });

  // hono に抜くと `console.error` でスタックごと出て、跡の書き先（試験の準備）も通らないため、ほかの /events の跡と同じ1行で書く（#5011）
  it('⭐ 書き込みが投げたら、console.error ではなく跡の1行（理由つき）を書く', async () => {
    const host = newHost();
    const outbox = new Outbox();
    outbox.push({ type: 'session', managerId: 'mgr-write-fail-2', sessionId: 'sess-2' });

    let thrown = false;
    // 元の関数は spyOn の前に取る: 後で取ると差し替えた自分自身を呼び続けるため
    const realWriteSSE = SSEStreamingApi.prototype.writeSSE;
    const writeSpy = vi.spyOn(SSEStreamingApi.prototype, 'writeSSE');
    writeSpy.mockImplementation(async function (this: SSEStreamingApi, message: SSEMessage) {
      if (message.event !== 'hello' && !thrown) {
        thrown = true;
        throw new Error('boom: 相手が読まなくなった接続への書き込みが失敗した（模擬）');
      }
      return realWriteSSE.call(this, message);
    });
    const consoleSpy = vi.spyOn(console, 'error').mockImplementation(() => undefined);

    try {
      const app = createRunnerApp({
        host,
        outbox,
        tokenSha256: TOKEN_SHA256,
        sseHeartbeatMs: 60_000,
      });
      const lines = await captureStderr(async () => {
        const res = await app.request('/events', { headers: bearer() });
        const reader = res.body?.getReader();
        await expect.poll(() => thrown, { timeout: 1000 }).toBe(true);
        await expect.poll(() => outbox.pending, { timeout: 1000 }).toBe(1);
        await reader?.cancel();
      });

      expect(consoleSpy).not.toHaveBeenCalled();
      const text = lines.join('');
      expect(text).toContain(
        'alteroid-runner: /events への書き込みが失敗したため接続を畳みます（1 件を箱へ戻します）',
      );
      expect(text).toContain('boom: 相手が読まなくなった接続への書き込みが失敗した（模擬）');
    } finally {
      writeSpy.mockRestore();
      consoleSpy.mockRestore();
      await host.shutdown();
    }
  });
});
