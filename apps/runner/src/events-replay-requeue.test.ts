import { createHash } from 'node:crypto';

import { createRunnerHost, type RunnerEvent, type RunnerHost } from '@alteroid/core';
import { SSEStreamingApi, type SSEMessage } from 'hono/streaming';
import { describe, expect, it, vi } from 'vitest';

import { createRunnerApp, Outbox } from './app.js';

const TOKEN = 'daemon-only-token';
const TOKEN_SHA256 = createHash('sha256').update(TOKEN, 'utf8').digest('hex');

function bearer(extra?: Record<string, string>): Record<string, string> {
  return { authorization: `Bearer ${TOKEN}`, accept: 'text/event-stream', ...extra };
}

function newHost(): RunnerHost {
  return createRunnerHost({
    runnerId: 'runner-replay-requeue-test',
    workspacePath: '/workspace',
    emit: () => undefined,
  });
}

async function readUntil(
  reader: ReadableStreamDefaultReader<Uint8Array>,
  needle: string | null,
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
    while (needle === null || !seen.includes(needle)) {
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

function count(haystack: string, needle: string): number {
  return haystack.split(needle).length - 1;
}

async function openReader(
  app: ReturnType<typeof createRunnerApp>,
  headers: Record<string, string>,
): Promise<ReadableStreamDefaultReader<Uint8Array>> {
  const response = await app.request('/events', { headers });
  const body = response.body;
  if (body === null) throw new Error('SSE の応答に本文が無い');
  return body.getReader();
}

describe('runner の /events: 控えから読み返した分を、書き切れずに畳んでも新しい連番で積み直さない（#4028）', () => {
  it('読み返しの書き込みが締め切りを超えて畳まれても、次の接続で同じ出来事は1回だけ届く', async () => {
    const host = newHost();
    const outbox = new Outbox();
    const first: RunnerEvent = { type: 'session', managerId: 'mgr-a', sessionId: 'sess-first' };
    const second: RunnerEvent = { type: 'session', managerId: 'mgr-a', sessionId: 'sess-second' };
    const sentinel: RunnerEvent = {
      type: 'session',
      managerId: 'mgr-a',
      sessionId: 'sess-sentinel',
    };
    outbox.push(first);
    const secondSeq = outbox.push(second);

    const realWriteSSE = SSEStreamingApi.prototype.writeSSE;
    const control: { hangId: string | null } = { hangId: null };
    const spy = vi.spyOn(SSEStreamingApi.prototype, 'writeSSE').mockImplementation(async function (
      this: SSEStreamingApi,
      message: SSEMessage,
    ) {
      if (message.event !== 'hello' && message.id === control.hangId) {
        return new Promise<void>(() => undefined);
      }
      return realWriteSSE.call(this, message);
    });

    try {
      const app = createRunnerApp({
        host,
        outbox,
        tokenSha256: TOKEN_SHA256,
        sseHeartbeatMs: 60_000,
        sseWriteDeadlineMs: 50,
      });

      // 1本目: 2件とも書けて控えに載る（デーモンには届かなかった想定）。
      const reader1 = await openReader(app, bearer());
      await readUntil(reader1, JSON.stringify(second), 1000);
      await reader1.cancel();
      await expect.poll(() => outbox.sentSince(0).length, { timeout: 1000 }).toBe(2);
      expect(outbox.pending).toBe(0);

      // 2本目: 0 から読み返し、2件目の書き込みが締め切りを超えて畳まれる。
      control.hangId = String(secondSeq);
      const reader2 = await openReader(app, bearer({ 'Last-Event-ID': '0' }));
      await readUntil(reader2, null, 2000);
      control.hangId = null;
      expect(outbox.pending).toBe(0);

      // 3本目: デーモンは1件目までを受け取っている。
      const reader3 = await openReader(app, bearer({ 'Last-Event-ID': String(secondSeq - 1) }));
      outbox.push(sentinel);
      const seen = await readUntil(reader3, JSON.stringify(sentinel), 1000);
      expect(seen).toContain(JSON.stringify(sentinel));
      expect(count(seen, JSON.stringify(second))).toBe(1);
      expect(seen).toContain(`id: ${String(secondSeq)}`);
      await reader3.cancel();
    } finally {
      spy.mockRestore();
      await host.shutdown();
    }
  });

  it('読み返しの書き込みで固まった購読者を置き換えても、新しい接続に同じ出来事は1回だけ流れる', async () => {
    const host = newHost();
    const outbox = new Outbox();
    const first: RunnerEvent = { type: 'session', managerId: 'mgr-b', sessionId: 'sess-first' };
    const second: RunnerEvent = { type: 'session', managerId: 'mgr-b', sessionId: 'sess-second' };
    const sentinel: RunnerEvent = {
      type: 'session',
      managerId: 'mgr-b',
      sessionId: 'sess-sentinel',
    };
    outbox.push(first);
    const secondSeq = outbox.push(second);

    const realWriteSSE = SSEStreamingApi.prototype.writeSSE;
    const control: { hangId: string | null; hanging: boolean } = { hangId: null, hanging: false };
    const spy = vi.spyOn(SSEStreamingApi.prototype, 'writeSSE').mockImplementation(async function (
      this: SSEStreamingApi,
      message: SSEMessage,
    ) {
      if (message.event !== 'hello' && message.id === control.hangId) {
        control.hanging = true;
        return new Promise<void>(() => undefined);
      }
      return realWriteSSE.call(this, message);
    });

    try {
      const app = createRunnerApp({
        host,
        outbox,
        tokenSha256: TOKEN_SHA256,
        sseHeartbeatMs: 60_000,
        sseWriteDeadlineMs: 60_000,
      });

      const reader1 = await openReader(app, bearer());
      await readUntil(reader1, JSON.stringify(second), 1000);
      await reader1.cancel();
      await expect.poll(() => outbox.sentSince(0).length, { timeout: 1000 }).toBe(2);

      // 2本目: 読み返しの2件目で固まる（締め切りは長いので畳まれない）。
      control.hangId = String(secondSeq);
      const reader2 = await openReader(app, bearer({ 'Last-Event-ID': '0' }));
      // 読みながら待つ: 読まないと1件目の書き込みが backpressure で詰まり、2件目へ進まないため。
      const draining2 = readUntil(reader2, null, 1500);
      await expect.poll(() => control.hanging, { timeout: 1000 }).toBe(true);
      control.hangId = null;

      // 3本目が2本目を置き換える。
      const reader3 = await openReader(app, bearer({ 'Last-Event-ID': String(secondSeq - 1) }));
      outbox.push(sentinel);
      const seen = await readUntil(reader3, JSON.stringify(sentinel), 1000);
      expect(seen).toContain(JSON.stringify(sentinel));
      expect(count(seen, JSON.stringify(second))).toBe(1);
      await reader3.cancel();
      await draining2;
      await reader2.cancel();
    } finally {
      spy.mockRestore();
      await host.shutdown();
    }
  });
});
