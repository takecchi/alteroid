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
    runnerId: 'runner-stale-handoff-test',
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

describe('runner の /events: 古い購読者が抱えていた分を新しい購読者へ引き渡す（(C)）', () => {
  it('古い購読者が抱えていた分が、新しい購読者へ古い順に渡る', async () => {
    const host = newHost();
    const outbox = new Outbox();
    const event1: RunnerEvent = { type: 'session', managerId: 'mgr-1', sessionId: 'sess-1' };
    const event2: RunnerEvent = { type: 'session', managerId: 'mgr-2', sessionId: 'sess-2' };
    const event3: RunnerEvent = { type: 'session', managerId: 'mgr-3', sessionId: 'sess-3' };
    outbox.push(event1);
    outbox.push(event2);
    outbox.push(event3);

    const realWriteSSE = SSEStreamingApi.prototype.writeSSE;
    // `this` を変数へ代入しない: `@typescript-eslint/no-this-alias` に当たるため。
    const stuckStreams = new WeakSet<SSEStreamingApi>();
    let sawFirstNonHello = false;
    const spy = vi.spyOn(SSEStreamingApi.prototype, 'writeSSE').mockImplementation(async function (
      this: SSEStreamingApi,
      message: SSEMessage,
    ) {
      if (message.event === 'hello') return realWriteSSE.call(this, message);
      if (!sawFirstNonHello) {
        sawFirstNonHello = true;
        stuckStreams.add(this);
      }
      if (stuckStreams.has(this)) return new Promise<void>(() => undefined);
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

      const first = await app.request('/events', { headers: bearer() });
      const firstBody = first.body;
      if (firstBody === null) throw new Error('SSE の応答に本文が無い');
      const firstReader = firstBody.getReader();

      // `outbox.pending` だけで次へ進まない: `hello` の書き込み中でも合計は同じ3で、2本目が `stuckStreams` に登録されてしまうため。
      await expect.poll(() => sawFirstNonHello, { timeout: 1000 }).toBe(true);
      await expect.poll(() => outbox.pending, { timeout: 1000 }).toBe(3);

      const second = await app.request('/events', { headers: bearer() });
      const secondBody = second.body;
      if (secondBody === null) throw new Error('SSE の応答に本文が無い');
      const secondReader = secondBody.getReader();

      await expect.poll(() => outbox.pending, { timeout: 1000 }).toBe(3);

      const seen = await readUntil(secondReader, JSON.stringify(event3), 1000);
      expect(seen).toContain(JSON.stringify(event3));
      const idx1 = seen.indexOf(JSON.stringify(event1));
      const idx2 = seen.indexOf(JSON.stringify(event2));
      const idx3 = seen.indexOf(JSON.stringify(event3));
      expect(idx1).toBeGreaterThanOrEqual(0);
      expect(idx2).toBeGreaterThan(idx1);
      expect(idx3).toBeGreaterThan(idx2);

      await expect.poll(() => outbox.pending, { timeout: 1000 }).toBe(0);

      await secondReader.cancel();
      await firstReader.cancel();
      await host.shutdown();
    } finally {
      spy.mockRestore();
    }
  });

  it('引き渡した分は二重に戻らない（古い購読者が後で「成功」しても記録しない）', async () => {
    const host = newHost();
    const outbox = new Outbox();
    const event: RunnerEvent = { type: 'session', managerId: 'mgr-solo', sessionId: 'sess-solo' };
    outbox.push(event);

    const realWriteSSE = SSEStreamingApi.prototype.writeSSE;
    // `this` を変数へ代入しない: `@typescript-eslint/no-this-alias` に当たるため。
    const stuckStreams = new WeakSet<SSEStreamingApi>();
    let sawFirstNonHello = false;
    // 裸の `let` にせずプロパティで持つ: Promise executor からの代入で、TS が `releaseStuck?.()` の型を `never` に絞り込むため。
    const control: { release: (() => void) | null } = { release: null };
    const stuckPromise = new Promise<void>((resolve) => {
      control.release = resolve;
    });
    const spy = vi.spyOn(SSEStreamingApi.prototype, 'writeSSE').mockImplementation(async function (
      this: SSEStreamingApi,
      message: SSEMessage,
    ) {
      if (message.event === 'hello') return realWriteSSE.call(this, message);
      if (!sawFirstNonHello) {
        sawFirstNonHello = true;
        stuckStreams.add(this);
      }
      if (stuckStreams.has(this)) {
        await stuckPromise;
        return realWriteSSE.call(this, message);
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

      const first = await app.request('/events', { headers: bearer() });
      const firstBody = first.body;
      if (firstBody === null) throw new Error('SSE の応答に本文が無い');
      const firstReader = firstBody.getReader();

      await expect.poll(() => sawFirstNonHello, { timeout: 1000 }).toBe(true);
      await expect.poll(() => outbox.pending, { timeout: 1000 }).toBe(1);

      const second = await app.request('/events', { headers: bearer() });
      const secondBody = second.body;
      if (secondBody === null) throw new Error('SSE の応答に本文が無い');
      const secondReader = secondBody.getReader();

      const seen = await readUntil(secondReader, JSON.stringify(event), 1000);
      expect(seen).toContain(JSON.stringify(event));
      await expect.poll(() => outbox.pending, { timeout: 1000 }).toBe(0);

      control.release?.();

      // 1本目の応答を読む: 読まないと backpressure で実書き込みが完了せず、`superseded` の防御が効いているか区別できないため。
      void firstReader.read();
      void firstReader.read();

      await new Promise((resolve) => setTimeout(resolve, 200));
      expect(outbox.pending).toBe(0);

      // バイト読みより先に控えを見る: 読み側のタイミング次第で「読み切れなかった」と「記録されていない」を区別しづらくなるため。
      expect(outbox.sentSince(0)).toHaveLength(1);

      // `readUntil` で `hello` だけ見て打ち切らない: 直後に来るはずの2件目を読む前に終わるため。
      const third = await app.request('/events', {
        headers: bearer({ 'Last-Event-ID': '0' }),
      });
      const thirdBody = third.body;
      if (thirdBody === null) throw new Error('SSE の応答に本文が無い');
      const thirdReader = thirdBody.getReader();
      const decoder = new TextDecoder();
      let redelivered = '';
      const deadline = Date.now() + 500;
      for (;;) {
        const remaining = deadline - Date.now();
        if (remaining <= 0) break;
        const next = await Promise.race([
          thirdReader.read(),
          new Promise<'期限切れ'>((resolve) => setTimeout(() => resolve('期限切れ'), remaining)),
        ]);
        if (next === '期限切れ') break;
        if (next.done) break;
        redelivered += decoder.decode(next.value, { stream: true });
      }

      const needle = JSON.stringify(event);
      const firstIndex = redelivered.indexOf(needle);
      const occurrences = firstIndex === -1 ? 0 : redelivered.split(needle).length - 1;
      expect(occurrences).toBeLessThanOrEqual(1);

      await thirdReader.cancel();
      await secondReader.cancel();
      await firstReader.cancel();
      await host.shutdown();
    } finally {
      spy.mockRestore();
    }
  });
});
