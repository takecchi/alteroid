import { createHash } from 'node:crypto';

import { createRunnerHost, type RunnerEvent, type RunnerHost } from '@alteroid/core';
import { SSEStreamingApi, type SSEMessage } from 'hono/streaming';
import { describe, expect, it, vi } from 'vitest';

import { createRunnerApp, Outbox } from './app.js';

/**
 * `GET /events` の先頭詰まり（head-of-line blocking）を塞ぐ締め切り
 * （`RunnerAppDeps.sseWriteDeadlineMs`）を測る。
 *
 * **前提**: `await stream.writeSSE(...)` は、相手が読まなくなった接続では
 * 原理上いつまでも返らない（`hono@4.13.1` の `StreamingApi#write` の
 * `catch {}`）。締め切りを切らずに待ち続けると、1件の詰まりが後続の配送を
 * 全部止める。
 *
 * **測り方は `outbox-pending.test.ts`（#358）と同じ技法を流用する。**
 * `SSEStreamingApi.prototype.writeSSE` を `vi.spyOn().mockImplementation()`
 * で差し替え、`hello` だけ本物へ通し、それ以外は「相手が読まなくなった接続」
 * そのものとして永久に解決しない `Promise` を返す。実サーバも実ソケットも
 * 使わず、`app.request()` で叩いてハンドラ本体は本物のまま走らせる。
 *
 * **アサーションが投げても後始末が走るよう、必ず `try/finally` で書く**
 * （`events-silent-disconnect.test.ts` の警告——外側で reader を読まずに
 * 待つ形は backpressure でデッドロックしうる。ここでは `reader.read()` を
 * 明示的に呼んで読み切るところまで確かめるので、その形は踏まない）。
 */
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

/**
 * `SSEStreamingApi.prototype.writeSSE` を差し替える。`hello` は実装のまま
 * 通し、それ以外は**呼ばれたことだけ記録して永久に解決しない**
 * （`outbox-pending.test.ts` の `hangOnRealEvents` と同じ形）。
 */
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
 * 読み捨てながら、応答が終わる（`done: true`）まで読み進める。
 *
 * **なぜ単発の `reader.read()` では駄目か。** `responseReadable` の既定
 * `highWaterMark` は1——`hello` フレームが先に1件分キューへ溜まっているので、
 * `abort()` 直後の最初の `read()` はまだ `hello` を返し、`done: true` になるのは
 * **次の** `read()` である。1回読んで `done` を主張すると、たまたま `hello` が
 * 先に来ただけで落ちる（または「畳まれた」を早合点する）。ここでは `done` に
 * 到達するまで読み切ることで、この段数に依存しない形にする。
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
      // 中身は見ない——ここは「終わったか」だけを見る歯である。
    }
  } finally {
    if (timer !== undefined) clearTimeout(timer);
  }
}

describe('runner の /events: 締め切りを過ぎた書き込みは接続を畳む', () => {
  /**
   * **この歯が単独で守るもの**: `writeSSE` が締め切りを過ぎても返らないとき、
   * 接続が実際に終わること（`reader.read()` が `done` を返すまで到達する）。
   */
  it('締め切りを過ぎたら stream.abort() で畳み、応答が終わる', async () => {
    const host = newHost();
    const outbox = new Outbox();
    const event: RunnerEvent = { type: 'session', managerId: 'mgr-stuck', sessionId: 'sess-stuck' };
    outbox.push(event);

    const { spy, calls } = hangOnRealEvents();
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

      // 書き込みが実際に始まっていることを先に確かめる（始まっていなければ
      // 「締め切りで畳んだ」の主張自体が空になる）。
      await expect.poll(() => calls.length, { timeout: 1000 }).toBe(1);

      // 締め切り（20ms）を過ぎたら `stream.abort()` が呼ばれ、応答が終わる
      // （読み切ると `done: true` に到達する。`readUntilClosed` の doc）。
      const outcome = await readUntilClosed(reader, 2000);
      expect(outcome).toBe('closed');

      // stderr に1行、何が起きたかを書く（黙って畳まない）。
      const logged = stderrSpy.mock.calls.map((args) => String(args[0])).join('');
      expect(logged).toContain('alteroid-runner:');
      expect(logged).toContain('20ms');

      await host.shutdown();
    } finally {
      spy.mockRestore();
      stderrSpy.mockRestore();
    }
  });

  /**
   * **この歯が単独で守るもの**: 畳んだとき、書きかけの1件と `queue` に
   * 残っていた後続が、1件も欠けずに `outbox` へ戻ること。**件数で固定する**
   * （「消えていない」を件数の一致で確かめる）。
   */
  it('畳んだとき、書きかけの1件と後続が全部 outbox へ戻る（1件も落ちない）', async () => {
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

      // 3件とも、この接続の「抱えている分」へ移っていることを先に見る
      // （1件が `writing`、残り2件が `queue`）。
      await expect.poll(() => outbox.pending, { timeout: 1000 }).toBe(3);

      // 締め切りを過ぎて畳まれ、応答が終わるまで待つ。
      const outcome = await readUntilClosed(reader, 2000);
      expect(outcome).toBe('closed');

      // 畳んだ後も3件とも outbox に残っている（1件も落ちていない）。
      expect(outbox.pending).toBe(3);

      await host.shutdown();
    } finally {
      spy.mockRestore();
      stderrSpy.mockRestore();
    }
  });

  /**
   * **陰性対照。** 締め切り内に返る書き込みでは畳まない——これが無いと
   * 「常に畳む」実装でも上の2本が緑になってしまう。書き込みが成功した後も
   * 接続が生きていて、次の出来事も配送できることまで確かめる。
   */
  it('締め切り内に返る書き込みでは畳まない（陰性対照）', async () => {
    const host = newHost();
    const outbox = new Outbox();
    const event1: RunnerEvent = { type: 'session', managerId: 'mgr-a', sessionId: 'sess-a' };
    const event2: RunnerEvent = { type: 'session', managerId: 'mgr-b', sessionId: 'sess-b' };
    outbox.push(event1);

    const app = createRunnerApp({
      host,
      outbox,
      tokenSha256: TOKEN_SHA256,
      sseHeartbeatMs: 60_000,
      // 締め切りは短いが、実装は本物のまま（モックしない）——実際の書き込みは
      // 一瞬で終わるので、この締め切りに引っかからないことを確かめる。
      sseWriteDeadlineMs: 2_000,
    });

    const response = await app.request('/events', { headers: bearer() });
    const body = response.body;
    if (body === null) throw new Error('SSE の応答に本文が無い');
    const reader = body.getReader();

    const first = await readUntil(reader, JSON.stringify(event1), 1000);
    expect(first).toContain(JSON.stringify(event1));

    // 畳まれていれば pending は0のままにはならない——引き続き配送できることを、
    // 2件目を実際に push して確かめる。
    outbox.push(event2);
    const second = await readUntil(reader, JSON.stringify(event2), 1000);
    expect(second).toContain(JSON.stringify(event2));

    await reader.cancel();
    await host.shutdown();
  });

  /**
   * **陰性対照。** `queue` が空で `wake` を待っているだけ（正常な待機）の
   * あいだは、締め切りが発火しないこと。締め切りは `writeSSE` を待っている
   * 最中にだけ効く——アイドル待機には掛かっていないことを、極端に短い
   * 締め切りでも接続が生き続けることで確かめる。
   */
  it('queue が空で待っているだけの接続は畳まれない（陰性対照）', async () => {
    const host = newHost();
    const outbox = new Outbox();

    const app = createRunnerApp({
      host,
      outbox,
      tokenSha256: TOKEN_SHA256,
      sseHeartbeatMs: 60_000,
      // 極端に短い締め切り。アイドル待機に効いていれば、これだけで即座に
      // 畳まれるはずである。
      sseWriteDeadlineMs: 5,
    });

    const response = await app.request('/events', { headers: bearer() });
    const body = response.body;
    if (body === null) throw new Error('SSE の応答に本文が無い');
    const reader = body.getReader();

    const hello = await readUntil(reader, 'event: hello', 1000);
    expect(hello).toContain('event: hello');

    // 締め切り（5ms）の何倍もの時間、何もせず待つ。**ここで `reader.read()` を
    // 呼ばない**——呼んで期限切れにすると、その `read()` 要求がリーダーに
    // 残ったまま孤立し（相手はまだ何も書いていないので解決しない）、次の
    // `readUntil` が発行する新しい `read()` がその後ろに並んでしまい、
    // 本当に来た出来事を拾えなくなる（1つのリーダーに複数の未解決 `read()`
    // を重ねない）。時間経過だけを見て、生死は次の一手（実際に出来事を
    // push して届くか）で確かめる。
    await new Promise((resolve) => setTimeout(resolve, 200));

    // 生きている証拠として、いまから push した出来事が届くことも見ておく。
    // **畳まれていたら、この出来事は誰にも配られず outbox へ戻るだけなので
    // 届かない**——このアサーションが陰性対照として効く理由そのものである。
    const event: RunnerEvent = { type: 'session', managerId: 'mgr-late', sessionId: 'sess-late' };
    outbox.push(event);
    const seen = await readUntil(reader, JSON.stringify(event), 1000);
    expect(seen).toContain(JSON.stringify(event));

    await reader.cancel();
    await host.shutdown();
  });
});
