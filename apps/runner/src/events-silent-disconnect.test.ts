import { createHash } from 'node:crypto';

import { createRunnerHost, type RunnerEvent, type RunnerHost } from '@alteroid/core';
import { SSEStreamingApi, type SSEMessage } from 'hono/streaming';
import { describe, expect, it, vi } from 'vitest';

import { createRunnerApp, Outbox } from './app.js';

/**
 * Issue #275: `await stream.writeSSE()` が**例外を投げずに正常返却**したのに、
 * 相手には届いていなかった1件（無音切断）が跡なく消える。
 *
 * `apps/runner/src/events-write-failure.test.ts`（#358）が測るのは
 * 「`writeSSE` が**投げた**とき」の手当てで、そちらは `writing` 変数経由で
 * 既に直っている。**ここが測るのはその裏側**——`writeSSE` が投げずに戻った
 * 場合は `writing = null` が即座に走り、`finally` の再投入（`if (writing !==
 * null) outbox.push(...)`）を素通りする。これは #358 の直し方そのものが
 * 意図的に踏んでいない窓であり、直したのは `Outbox.recordSent` /
 * `Outbox.sentSince`（SSE の `id` / `Last-Event-ID`）である。
 *
 * **測り方は #358 の歯（`events-write-failure.test.ts`）と対で読む。**
 * `writeSSE` は本物のまま実行させ（投げさせない）、書き終わった直後に
 * 読まずに `reader.cancel()` する——「runner から見れば成功したが、相手は
 * 1バイトも受け取っていない」状態を、送った側のバッファに残った未読の
 * bytes として作る。「戻った」で終わらせず、`Last-Event-ID` を持った
 * 2本目の接続がその出来事を実際に受け取れることまで確かめる。
 */
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

/** `events-write-failure.test.ts` と同じ形——期限で読み、来なければ空のまま返す。 */
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
    // **`event` 種別の書き込みが始まった瞬間に、相手側の reader を切る。**
    //
    // hono の `write()` は内部で例外を握り潰す（`catch {}`）ので、`writer.write`
    // がどう終わっても `writeSSE` 自体は投げない。**だから「相手が切れたのは
    // 書いている最中」を再現するには、writeSSE の中で切る必要がある** ——
    // 外側で `reader` を読まずに待つ形だと、hono の内部ストリームの
    // backpressure（既定 highWaterMark=1）に阻まれて `hello` の次の
    // チャンクが詰まったまま `writeSSE` 自体が戻らず、テストがデッドロック
    // する（実測）。ロジック本体（`app.ts`）は1行も変えていない——ここで
    // 動かしているのは「相手がいつ切れるか」というテスト側の時刻だけである。
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
      // **ここが要点——1バイトも読まずに切る。** 上のモックが、`event`
      // 種別の書き込みが始まった瞬間にこれを呼ぶ。`write()` は例外を出さない
      // ので runner 側からは「投げずに戻った」ようにしか見えない——これが
      // 「相手には届いていない無音切断」のこのテストでの表現である。
      cancelFirst = () => firstReader.cancel();

      // **`writeSSE` が実際に返り終えるまで待つ。** それより前段（`hello` の
      // 段階）で切ると、#358 の経路（`queue`/`writing` からの再投入）を
      // 測ることになり、ここで確かめたい「投げずに戻った後」の窓を踏まない。
      await expect.poll(() => wroteEvent, { timeout: 1000 }).toBe(true);

      // `finally` は走るが、`writing === null` なので outbox へは戻らない
      // ——直す前はここで本当に消えていた。
      await expect.poll(() => outbox.pending, { timeout: 1000 }).toBe(0);

      // 2本目: 直前に受け取れた最後の連番として `seq - 1`（＝1件も受け取れて
      // いない）を申告する。
      const second = await app.request('/events', {
        headers: bearer({ 'Last-Event-ID': String(seq - 1) }),
      });
      const secondBody = second.body;
      if (secondBody === null) throw new Error('SSE の応答に本文が無い');
      const secondReader = secondBody.getReader();

      const redelivered = await readUntil(secondReader, JSON.stringify(event), 1000);
      expect(redelivered).toContain(JSON.stringify(event));
      // **フレームの `id` にも連番が乗ること。** SSE のフレーム側だけで
      // 完結させる設計（`OutboxSeq` の doc）そのものを、配線の末端で確認する。
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

      // `Last-Event-ID` を付けない、素の再接続。
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

describe('Outbox.recordSent / sentSince（#275）', () => {
  it('sentSince は lastEventId より新しい分だけを古い順に返す', () => {
    const outbox = new Outbox();
    const e1: RunnerEvent = { type: 'session', managerId: 'a', sessionId: '1' };
    const e2: RunnerEvent = { type: 'session', managerId: 'a', sessionId: '2' };
    const e3: RunnerEvent = { type: 'session', managerId: 'a', sessionId: '3' };
    outbox.recordSent(e1, 10, '2026-01-01T00:00:00.000Z');
    outbox.recordSent(e2, 11, '2026-01-01T00:00:01.000Z');
    outbox.recordSent(e3, 12, '2026-01-01T00:00:02.000Z');

    expect(outbox.sentSince(10).map((i) => i.seq)).toEqual([11, 12]);
    expect(outbox.sentSince(12)).toEqual([]);
    expect(outbox.sentSince(0).map((i) => i.seq)).toEqual([10, 11, 12]);
  });

  /**
   * **上限（`Outbox.SENT_HISTORY_LIMIT`）を超えた分は古い順に捨てる。**
   *
   * 直す前の挙動（無条件に消える）より悪くはならない、という設計そのものの
   * 検査——上限に当たっても例外にはならず、単に古い方から読めなくなる。
   */
  it('SENT_HISTORY_LIMIT を超えた分は古い方から捨てる', () => {
    const outbox = new Outbox();
    const limit = Outbox.SENT_HISTORY_LIMIT;
    for (let i = 1; i <= limit + 5; i++) {
      const event: RunnerEvent = { type: 'session', managerId: 'a', sessionId: String(i) };
      outbox.recordSent(event, i, '2026-01-01T00:00:00.000Z');
    }
    // 直後（1〜5）は捨てられている——lastEventId=0 から見ても現れない。
    const all = outbox.sentSince(0);
    expect(all.length).toBe(limit);
    expect(all[0]?.seq).toBe(6);
    expect(all[all.length - 1]?.seq).toBe(limit + 5);
  });
});
