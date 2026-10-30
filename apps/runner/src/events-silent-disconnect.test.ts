import { createHash } from 'node:crypto';

import { captureStderr, createRunnerHost, type RunnerEvent, type RunnerHost } from '@alteroid/core';
import { SSEStreamingApi, type SSEMessage } from 'hono/streaming';
import { describe, expect, it, vi } from 'vitest';

import { createRunnerApp, Outbox } from './app.js';
import { writeAll } from './outbox-subscribers.test-support.js';

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

// #5692: 控えは「書き終えた分」として列に残る。試験専用の口（recordSent・sentSince）は無く、本番と同じ `subscribe` で書き終え（writeAll）、
// 繋ぎ直し（`lastEventId` つきの subscribe = HTTP の Last-Event-ID と同じ入口）で何が流れてくるかを見る。
describe('Outbox の控え（書き終えた分）と Last-Event-ID の繋ぎ直し（#275）', () => {
  it('Last-Event-ID より新しい分だけが古い順に流れる', () => {
    const outbox = new Outbox();
    const e1: RunnerEvent = { type: 'session', managerId: 'a', sessionId: '1' };
    const e2: RunnerEvent = { type: 'session', managerId: 'a', sessionId: '2' };
    const e3: RunnerEvent = { type: 'session', managerId: 'a', sessionId: '3' };
    const s1 = outbox.push(e1);
    const s2 = outbox.push(e2);
    const s3 = outbox.push(e3);
    writeAll(outbox);

    expect(writeAll(outbox, { lastEventId: s1 })).toEqual([s2, s3]);
    expect(writeAll(outbox, { lastEventId: s3 })).toEqual([]);
    expect(writeAll(outbox, { lastEventId: 0 })).toEqual([s1, s2, s3]);
  });

  it('同じ連番を2度記録しても控えには1件しか入らない。間に新しい連番があっても同じ（#3808）', () => {
    const outbox = new Outbox();
    const e1: RunnerEvent = { type: 'session', managerId: 'a', sessionId: '1' };
    const e2: RunnerEvent = { type: 'session', managerId: 'a', sessionId: '2' };
    outbox.push(e1);
    outbox.push(e2);
    writeAll(outbox);
    // 読み返して同じ連番をもう一度書き終えても、控えは増えない
    writeAll(outbox, { lastEventId: 0 });
    writeAll(outbox, { lastEventId: 0 });
    expect(writeAll(outbox, { lastEventId: 0 })).toEqual([1, 2]);
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
      expect(writeAll(outbox, { lastEventId: seq - 1 })).toEqual([seq]);

      const third = await open(bearer({ 'Last-Event-ID': String(seq - 1) }));
      const seen = await readUntil(third, JSON.stringify(event), 1000);
      expect(seen.split(JSON.stringify(event)).length - 1).toBe(1);
      await new Promise<void>((resolve) => setImmediate(resolve));
      await third.cancel();
      await expect.poll(() => outbox.subscribed, { timeout: 1000 }).toBe(false);
      expect(writeAll(outbox, { lastEventId: seq - 1 })).toEqual([seq]);
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
    const s2 = outbox.push(e2);
    writeAll(outbox);

    expect(writeAll(outbox, { lastEventId: 50 })).toEqual([s1, s2]);
    expect(writeAll(outbox, { lastEventId: s2 + 1 })).toEqual([s1, s2]);
    expect(writeAll(outbox, { lastEventId: s2 })).toEqual([]);
    expect(writeAll(outbox, { lastEventId: s1 })).toEqual([s2]);
  });

  it('SENT_HISTORY_LIMIT を超えた分は古い方から捨てる', () => {
    const outbox = new Outbox();
    const limit = Outbox.SENT_HISTORY_LIMIT;
    for (let i = 1; i <= limit + 5; i++) {
      const event: RunnerEvent = { type: 'session', managerId: 'a', sessionId: String(i) };
      outbox.push(event);
    }
    writeAll(outbox);
    const all = writeAll(outbox, { lastEventId: 0 });
    expect(all.length).toBe(limit);
    expect(all[0]).toBe(6);
    expect(all[all.length - 1]).toBe(limit + 5);
  });
});

describe('Outbox の送信済みの控えは字数でも締める（#4669）', () => {
  const mirrorOf = (i: number): RunnerEvent =>
    ({ type: 'session', managerId: 'a', sessionId: String(i) }) as RunnerEvent;

  it('⭐ 書き出した字数の合計が上限を超えたら、古い分から落とす（件数の上限より手前でも）', () => {
    const outbox = new Outbox();
    for (let seq = 1; seq <= 20; seq += 1) outbox.push(mirrorOf(seq));
    writeAll(outbox, { chars: () => 1_000_000 });
    const kept = writeAll(outbox, { lastEventId: 0 });
    expect(kept).toEqual([5, 6, 7, 8, 9, 10, 11, 12, 13, 14, 15, 16, 17, 18, 19, 20]);
  });

  it('上限を1件で超える出来事でも、直近の1件は残す', () => {
    const outbox = new Outbox();
    outbox.push(mirrorOf(1));
    outbox.push(mirrorOf(2));
    writeAll(outbox, { chars: (seq) => (seq === 1 ? 10 : Outbox.SENT_HISTORY_MAX_CHARS + 1) });
    expect(writeAll(outbox, { lastEventId: 0 })).toEqual([2]);
  });

  it('字数を渡さなければ、出来事を直列化した字数で数える', () => {
    const outbox = new Outbox();
    const big = {
      type: 'session',
      managerId: 'a',
      sessionId: 'x'.repeat(9_000_000),
    } as RunnerEvent;
    outbox.push(mirrorOf(1));
    outbox.push(big);
    outbox.push(big);
    writeAll(outbox);
    expect(writeAll(outbox, { lastEventId: 0 })).toEqual([3]);
  });

  it('字数で落とした分より前を繋ぎ直しで求められたら、送り直せないことを標準エラーに残す。落としていない範囲では黙る', async () => {
    const outbox = new Outbox();
    for (let seq = 1; seq <= 20; seq += 1) outbox.push(mirrorOf(seq));
    writeAll(outbox, { chars: () => 1_000_000 });
    const dropped = await captureStderr(() => {
      expect(writeAll(outbox, { lastEventId: 2 })[0]).toBe(5);
    });
    expect(dropped.join('')).toContain('控えの字数の上限で落としてあり、送り直せない');
    const silent = await captureStderr(() => {
      writeAll(outbox, { lastEventId: 10 });
    });
    expect(silent).toEqual([]);
  });
});

describe('/events へ書いた出来事の控えは、書き出した本文の字数で締まる（#4669）', () => {
  it('⭐ 100万字級の出来事を20件流すと、控えは字数の上限に収まる分だけ残る', async () => {
    const host = newHost();
    const outbox = new Outbox();
    const big = (i: number): RunnerEvent =>
      ({
        type: 'session',
        managerId: 'mgr-big',
        sessionId: `${String(i)}${'x'.repeat(1_000_000)}`,
      }) as RunnerEvent;
    for (let i = 1; i <= 20; i += 1) outbox.push(big(i));
    try {
      const app = createRunnerApp({
        host,
        outbox,
        tokenSha256: TOKEN_SHA256,
        sseHeartbeatMs: 60_000,
      });
      const response = await app.request('/events', { headers: bearer() });
      const body = response.body;
      if (body === null) throw new Error('SSE の応答に本文が無い');
      const reader = body.getReader();
      // 20件目まで読み切る（書き出した分が控えに積まれる）
      const decoder = new TextDecoder();
      let seen = '';
      while (!seen.includes('id: 20')) {
        const next = await reader.read();
        if (next.done) break;
        seen += decoder.decode(next.value, { stream: true });
        seen = seen.slice(-64);
      }
      await reader.cancel();
      await expect.poll(() => outbox.subscribed, { timeout: 1000 }).toBe(false);
      const kept = writeAll(outbox, { lastEventId: 0 });
      expect(kept.length).toBeLessThanOrEqual(16);
      expect(kept.at(-1)).toBe(20);
    } finally {
      await host.shutdown();
    }
  });
});
