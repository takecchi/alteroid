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
    runnerId: 'runner-silent-disconnect-test',
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

describe('runner の /events: 無音切断（writeSSE が投げずに戻る）で消えた1件を Last-Event-ID で配り直す（#275）', () => {
  it('1本目で「投げずに戻った」1件が、2本目の Last-Event-ID で配り直される', async () => {
    const host = newHost();
    const outbox = new Outbox();
    const event: RunnerEvent = {
      type: 'session',
      managerId: 'mgr-silent',
      sessionId: 'sess-silent',
    };
    const seq = outbox.push(event);
    expect(outbox.pending).toBe(1);

    const realWriteSSE = SSEStreamingApi.prototype.writeSSE;
    let wroteEvent = false;
    let cancelFirst: (() => Promise<void>) | null = null;
    let cancelled = false;
    // 外側で `reader` を読まずに待たず、`writeSSE` の中で切る: hono の backpressure で `hello` の次のチャンクが詰まり、`writeSSE` が戻らずデッドロックするため。
    const spy = vi.spyOn(SSEStreamingApi.prototype, 'writeSSE').mockImplementation(async function (
      this: SSEStreamingApi,
      message: SSEMessage,
    ) {
      if (message.event !== 'hello' && !cancelled) {
        cancelled = true;
        await cancelFirst?.();
      }
      const result = await realWriteSSE.call(this, message);
      if (message.event !== 'hello') wroteEvent = true;
      return result;
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
      cancelFirst = () => firstReader.cancel();

      await expect.poll(() => wroteEvent, { timeout: 1000 }).toBe(true);

      await expect.poll(() => outbox.pending, { timeout: 1000 }).toBe(0);

      const second = await app.request('/events', {
        headers: bearer({ 'Last-Event-ID': String(seq - 1) }),
      });
      const secondBody = second.body;
      if (secondBody === null) throw new Error('SSE の応答に本文が無い');
      const secondReader = secondBody.getReader();

      const redelivered = await readUntil(secondReader, JSON.stringify(event), 1000);
      expect(redelivered).toContain(JSON.stringify(event));
      expect(redelivered).toContain(`id: ${String(seq)}`);

      await secondReader.cancel();
    } finally {
      spy.mockRestore();
      await host.shutdown();
    }
  });

  it('Last-Event-ID を申告しない再接続では配り直さない（申告が復元の唯一の入口）', async () => {
    const host = newHost();
    const outbox = new Outbox();
    const event: RunnerEvent = {
      type: 'session',
      managerId: 'mgr-no-header',
      sessionId: 'sess-no-header',
    };
    outbox.push(event);

    const realWriteSSE = SSEStreamingApi.prototype.writeSSE;
    let wroteEvent = false;
    let cancelFirst: (() => Promise<void>) | null = null;
    let cancelled = false;
    const spy = vi.spyOn(SSEStreamingApi.prototype, 'writeSSE').mockImplementation(async function (
      this: SSEStreamingApi,
      message: SSEMessage,
    ) {
      if (message.event !== 'hello' && !cancelled) {
        cancelled = true;
        await cancelFirst?.();
      }
      const result = await realWriteSSE.call(this, message);
      if (message.event !== 'hello') wroteEvent = true;
      return result;
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
      cancelFirst = () => firstReader.cancel();
      await expect.poll(() => wroteEvent, { timeout: 1000 }).toBe(true);
      await expect.poll(() => outbox.pending, { timeout: 1000 }).toBe(0);

      const second = await app.request('/events', { headers: bearer() });
      const secondBody = second.body;
      if (secondBody === null) throw new Error('SSE の応答に本文が無い');
      const secondReader = secondBody.getReader();

      const seen = await readUntil(secondReader, JSON.stringify(event), 300);
      expect(seen).not.toContain(JSON.stringify(event));

      await secondReader.cancel();
    } finally {
      spy.mockRestore();
      await host.shutdown();
    }
  });
});

describe('runner の入れ替わり後の無音切断（#3036）', () => {
  it('前の runner の高い Last-Event-ID を申告されても、新しい runner（連番1から）の控えを1回ずつ配り直す', async () => {
    const host = newHost();
    const outbox = new Outbox();
    const lost: RunnerEvent = { type: 'session', managerId: 'mgr-swap', sessionId: 'sess-lost' };
    const seq = outbox.push(lost);
    expect(seq).toBe(1);

    const realWriteSSE = SSEStreamingApi.prototype.writeSSE;
    let wroteEvent = false;
    let cancelFirst: (() => Promise<void>) | null = null;
    let cancelled = false;
    const spy = vi.spyOn(SSEStreamingApi.prototype, 'writeSSE').mockImplementation(async function (
      this: SSEStreamingApi,
      message: SSEMessage,
    ) {
      if (message.event !== 'hello' && !cancelled) {
        cancelled = true;
        await cancelFirst?.();
      }
      const result = await realWriteSSE.call(this, message);
      if (message.event !== 'hello') wroteEvent = true;
      return result;
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
      cancelFirst = () => firstReader.cancel();
      await expect.poll(() => wroteEvent, { timeout: 1000 }).toBe(true);
      await expect.poll(() => outbox.pending, { timeout: 1000 }).toBe(0);

      const second = await app.request('/events', {
        headers: bearer({ 'Last-Event-ID': '50' }),
      });
      const secondBody = second.body;
      if (secondBody === null) throw new Error('SSE の応答に本文が無い');
      const secondReader = secondBody.getReader();

      const seen = await readUntil(secondReader, JSON.stringify(lost), 1000);
      expect(seen).toContain(JSON.stringify(lost));
      expect(seen.split(JSON.stringify(lost)).length - 1).toBe(1);
      await secondReader.cancel();
    } finally {
      spy.mockRestore();
      await host.shutdown();
    }
  });
});

describe('Outbox.recordSent / sentSince（#275）', () => {
  it('sentSince は lastEventId より新しい分だけを古い順に返す', () => {
    const outbox = new Outbox();
    const e1: RunnerEvent = { type: 'session', managerId: 'a', sessionId: '1' };
    const e2: RunnerEvent = { type: 'session', managerId: 'a', sessionId: '2' };
    const e3: RunnerEvent = { type: 'session', managerId: 'a', sessionId: '3' };
    const record = (event: RunnerEvent): number => {
      const seq = outbox.push(event);
      outbox.recordSent(event, seq, '2026-01-01T00:00:00.000Z');
      return seq;
    };
    const s1 = record(e1);
    const s2 = record(e2);
    const s3 = record(e3);

    expect(outbox.sentSince(s1).map((i) => i.seq)).toEqual([s2, s3]);
    expect(outbox.sentSince(s3)).toEqual([]);
    expect(outbox.sentSince(0).map((i) => i.seq)).toEqual([s1, s2, s3]);
  });

  it('同じ連番を2度記録しても控えには1件しか入らない。間に新しい連番があっても同じ（#3808）', () => {
    const outbox = new Outbox();
    const e1: RunnerEvent = { type: 'session', managerId: 'a', sessionId: '1' };
    const e2: RunnerEvent = { type: 'session', managerId: 'a', sessionId: '2' };
    const at = '2026-01-01T00:00:00.000Z';
    outbox.recordSent(e1, 1, at);
    outbox.recordSent(e2, 2, at);
    outbox.recordSent(e1, 1, at);
    outbox.recordSent(e2, 2, at);
    expect(outbox.sentSince(0).map((i) => i.seq)).toEqual([1, 2]);
  });

  it('読み返しの書き込みも無音で切れ続けても、3本目で同じ連番は1回だけ流れ、控えは増えない（#3808）', async () => {
    const host = newHost();
    const outbox = new Outbox();
    const event: RunnerEvent = { type: 'session', managerId: 'mgr-dup', sessionId: 'sess-dup' };
    const seq = outbox.push(event);

    const realWriteSSE = SSEStreamingApi.prototype.writeSSE;
    let eventWrites = 0;
    let cancelCurrent: (() => Promise<void>) | null = null;
    const spy = vi.spyOn(SSEStreamingApi.prototype, 'writeSSE').mockImplementation(async function (
      this: SSEStreamingApi,
      message: SSEMessage,
    ) {
      if (message.event !== 'hello' && cancelCurrent !== null) {
        const cancel = cancelCurrent;
        cancelCurrent = null;
        await cancel();
      }
      const result = await realWriteSSE.call(this, message);
      if (message.event !== 'hello') eventWrites++;
      return result;
    });

    try {
      const app = createRunnerApp({
        host,
        outbox,
        tokenSha256: TOKEN_SHA256,
        sseHeartbeatMs: 60_000,
      });

      const open = async (headers: Record<string, string>) => {
        const res = await app.request('/events', { headers });
        if (res.body === null) throw new Error('SSE の応答に本文が無い');
        return res.body.getReader();
      };

      const first = await open(bearer());
      cancelCurrent = () => first.cancel();
      await expect.poll(() => eventWrites, { timeout: 1000 }).toBe(1);
      await expect.poll(() => outbox.pending, { timeout: 1000 }).toBe(0);

      const second = await open(bearer({ 'Last-Event-ID': String(seq - 1) }));
      cancelCurrent = () => second.cancel();
      await expect.poll(() => eventWrites, { timeout: 1000 }).toBe(2);
      await new Promise<void>((resolve) => setImmediate(resolve));
      expect(outbox.sentSince(seq - 1).map((i) => i.seq)).toEqual([seq]);

      const third = await open(bearer({ 'Last-Event-ID': String(seq - 1) }));
      const seen = await readUntil(third, JSON.stringify(event), 1000);
      expect(seen.split(JSON.stringify(event)).length - 1).toBe(1);
      await new Promise<void>((resolve) => setImmediate(resolve));
      expect(outbox.sentSince(seq - 1).map((i) => i.seq)).toEqual([seq]);
      await third.cancel();
    } finally {
      spy.mockRestore();
      await host.shutdown();
    }
  });

  it('箱が振っていない連番の申告は、控えを全部返す。振った最大ちょうどは何も返さない（#3036）', () => {
    const outbox = new Outbox();
    const e1: RunnerEvent = { type: 'session', managerId: 'a', sessionId: '1' };
    const e2: RunnerEvent = { type: 'session', managerId: 'a', sessionId: '2' };
    const s1 = outbox.push(e1);
    outbox.recordSent(e1, s1, '2026-01-01T00:00:00.000Z');
    const s2 = outbox.push(e2);
    outbox.recordSent(e2, s2, '2026-01-01T00:00:01.000Z');

    expect(outbox.sentSince(50).map((i) => i.seq)).toEqual([s1, s2]);
    expect(outbox.sentSince(s2 + 1).map((i) => i.seq)).toEqual([s1, s2]);
    expect(outbox.sentSince(s2)).toEqual([]);
    expect(outbox.sentSince(s1).map((i) => i.seq)).toEqual([s2]);
  });

  it('SENT_HISTORY_LIMIT を超えた分は古い方から捨てる', () => {
    const outbox = new Outbox();
    const limit = Outbox.SENT_HISTORY_LIMIT;
    for (let i = 1; i <= limit + 5; i++) {
      const event: RunnerEvent = { type: 'session', managerId: 'a', sessionId: String(i) };
      outbox.recordSent(event, i, '2026-01-01T00:00:00.000Z');
    }
    const all = outbox.sentSince(0);
    expect(all.length).toBe(limit);
    expect(all[0]?.seq).toBe(6);
    expect(all[all.length - 1]?.seq).toBe(limit + 5);
  });
});
