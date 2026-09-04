import { createHash } from 'node:crypto';

import { createRunnerHost, type RunnerEvent, type RunnerHost } from '@alteroid/core';
import { SSEStreamingApi, type SSEMessage } from 'hono/streaming';
import { describe, expect, it, vi } from 'vitest';

import { createRunnerApp, Outbox } from './app.js';

/**
 * `GET /events` の**最初の `hello` 書き込み**にも締め切りが掛かっていることを
 * 測る（PR #630 が本ループの1件（`stream.writeSSE(item...)`）に
 * `withDeadline(...)` を掛けた後も、その*前*に無条件で書かれる `hello` だけは
 * この経路を通っていなかった——本ループと同じ head-of-line blocking が入口に
 * 残っていた分の直し）。
 *
 * **前提**: `await stream.writeSSE(...)` は、相手が読まなくなった接続では
 * 原理上いつまでも返らない（`events-write-deadline.test.ts` の doc と同じ、
 * `hono@4.13.1` の `StreamingApi#write` の `catch {}`）。`hello` は本ループへ
 * 入る前の1回きりの書き込みなので、ここが詰まると heartbeat も本ループも
 * 一度も始まらない。
 *
 * **測り方は `events-write-deadline.test.ts` と同じ技法を流用する。** ただし
 * `hello` 自体を検証したいので、`hangOnRealEvents`（`hello` だけ実装へ通す）
 * ではなく、**`hello` を含めて全部hangさせる** `hangOnHello` を使う。
 */
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

/**
 * `SSEStreamingApi.prototype.writeSSE` を差し替える。**`hello` も含めて**
 * 呼ばれたことだけ記録して永久に解決しない（`events-write-deadline.test.ts` の
 * `hangOnRealEvents` と違い、`hello` を実装へ通さない——ここでは `hello` 自体の
 * 詰まりを再現したいので、これが要点である）。
 */
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

/** 期限つきで読む——来なければ空のまま返す（`events-heartbeat.test.ts` と同じ形）。 */
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

/**
 * 読み捨てながら、応答が終わる（`done: true`）まで読み進める
 * （`events-write-deadline.test.ts` の同名関数と同じ理由・同じ形）。
 */
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
  /**
   * **この歯が単独で守るもの**: `hello` の `writeSSE` が締め切りを過ぎても
   * 返らないとき、接続が実際に終わること。**直す前は、ここで `await` が
   * 永久に返らず `stream.onAbort` も heartbeat も一度も走らなかった**
   * （1文字壊しで確認済み——後述のコミット参照）。
   */
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

      // hello の書き込みが実際に始まっていることを先に確かめる。
      await expect.poll(() => calls.length, { timeout: 1000 }).toBe(1);
      expect(calls[0]).toBe('hello');

      // 締め切り（20ms）を過ぎたら `stream.abort()` が呼ばれ、応答が終わる。
      const outcome = await readUntilClosed(reader, 2000);
      expect(outcome).toBe('closed');

      // stderr に1行、何が起きたかを書く（黙って畳まない）。
      const logged = stderrSpy.mock.calls.map((args) => String(args[0])).join('');
      expect(logged).toContain('alteroid-runner:');
      expect(logged).toContain('hello');
      expect(logged).toContain('20ms');
      // **本ループの畳み文言（「書きかけの1件を含め」）をそのまま流用していない
      // ことも見る。** hello の時点では `writing` は必ず null で「書きかけの
      // 1件」という概念そのものが無いので、同じ文言を出したら意味が違う。
      expect(logged).not.toContain('書きかけの1件を含め');
      // この接続はまだ何も抱えていなかった（`queue` は空）——0件という
      // 実測をそのまま書く。
      expect(logged).toContain('（この接続が抱えていた 0 件を箱へ戻します）');

      await host.shutdown();
    } finally {
      spy.mockRestore();
      stderrSpy.mockRestore();
    }
  });

  /**
   * **この歯が単独で守るもの**: `hello` を待っている間に、`Last-Event-ID` も
   * 無い新規接続がそれでも `outbox.attach(...)` の同期フラッシュで `queue` へ
   * 既存の滞留を受け取っていた場合（＝再接続の直後にもう1件積まれていた等）、
   * `hello` の締め切り超過で畳んでも、その滞留が1件も欠けずに `outbox` へ
   * 戻ること。
   */
  it('hello 待ち中に抱えていた滞留も、畳んだとき outbox へ全部戻る（1件も落ちない）', async () => {
    const host = newHost();
    const outbox = new Outbox();
    const events: RunnerEvent[] = [
      { type: 'session', managerId: 'mgr-1', sessionId: 'sess-1' },
      { type: 'session', managerId: 'mgr-2', sessionId: 'sess-2' },
    ];
    // **リクエストの前に push する。** `outbox.attach(...)` は hello を書く
    // *前*に呼ばれ、その時点で既存の滞留（`#queue`）を同期的に `queue` へ
    // 流し込む——つまりこの2件は、hello の `writeSSE` が始まる前から
    // `queue` に乗っている。
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

      // 畳んだ後も2件とも outbox に残っている（1件も落ちていない）。
      expect(outbox.pending).toBe(2);

      const logged = stderrSpy.mock.calls.map((args) => String(args[0])).join('');
      expect(logged).toContain('（この接続が抱えていた 2 件を箱へ戻します）');

      await host.shutdown();
    } finally {
      spy.mockRestore();
      stderrSpy.mockRestore();
    }
  });

  /**
   * **陰性対照。** 締め切り内に返る `hello` では畳まない——これが無いと
   * 「常に畳む」実装でも上の2本が緑になってしまう。`hello` の後、本ループも
   * 正常に動くこと（heartbeat が起こり、後続の出来事も配送できること）まで
   * 確かめる。
   */
  it('hello が締め切り内に返るときは畳まない（陰性対照）', async () => {
    const host = newHost();
    const outbox = new Outbox();
    const event: RunnerEvent = { type: 'session', managerId: 'mgr-a', sessionId: 'sess-a' };

    const app = createRunnerApp({
      host,
      outbox,
      tokenSha256: TOKEN_SHA256,
      sseHeartbeatMs: 60_000,
      // 締め切りは短いが、実装は本物のまま（モックしない）——hello の実際の
      // 書き込みは一瞬で終わるので、この締め切りに引っかからないことを
      // 確かめる。
      sseWriteDeadlineMs: 2_000,
    });

    const response = await app.request('/events', { headers: bearer() });
    const body = response.body;
    if (body === null) throw new Error('SSE の応答に本文が無い');
    const reader = body.getReader();

    const hello = await readUntil(reader, 'event: hello', 1000);
    expect(hello).toContain('event: hello');

    // hello の後も接続は生きていて、本ループが出来事を配送できる。
    outbox.push(event);
    const seen = await readUntil(reader, JSON.stringify(event), 1000);
    expect(seen).toContain(JSON.stringify(event));

    await reader.cancel();
    await host.shutdown();
  });
});
