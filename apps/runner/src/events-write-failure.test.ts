import { createHash } from 'node:crypto';

import { createRunnerHost, type RunnerEvent, type RunnerHost } from '@alteroid/core';
import { SSEStreamingApi, type SSEMessage } from 'hono/streaming';
import { describe, expect, it, vi } from 'vitest';

import { createRunnerApp, Outbox } from './app.js';

/**
 * `apps/runner/src/app.ts` の `/events` ループが `bc9f6ba`（#358）で得た修理:
 *
 * ```ts
 * writing = item;
 * await stream.writeSSE({ event: item.event.type, data: JSON.stringify(item.event) });
 * // finally で消さない。投げたときは writing に残したまま抜け、
 * // 下の finally が箱へ戻す。
 * writing = null;
 * ```
 *
 * **この修理そのものに歯が無かった。** ここが測るのはただ1つ:
 * `stream.writeSSE(...)` が投げたとき、書きかけだった1件が
 * `outbox` へ戻ること（黙って失われないこと）。
 *
 * **測り方。** `hono/streaming` の `SSEStreamingApi.prototype.writeSSE` を
 * spy で差し替え、`event` 種別の書き込み（＝ `queue` から出た本物の出来事）を
 * ちょうど1回だけ投げさせる（`hello` は素通しする——`/events` が実際に
 * `writing = item` の後で投げたことを確かめたいので、それより前の書き込みまで
 * 巻き込まない）。ロジック本体（`app.ts`）は1行も変えない。
 *
 * **「戻った」で終わらせず、「配り直される」まで確かめる。** `outbox.pending`
 * だけを見ると、`Outbox.pending` は listener が付いている間も購読側の分を
 * 数える設計（#358 本体）なので、書きかけの1件は投げる前後で見かけ上
 * 動かない（`queue`／`writing` で数えていたものが `#queue` で数える側へ
 * 移るだけ）。**本当に消えていないことの証拠は、2本目の接続がその出来事を
 * 受け取れることである。**
 */
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

/** `readUntil`（`events-heartbeat.test.ts`）と同じ形——期限で読み、来なければ assertion で落とす。 */
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
    // **一度だけ投げる。** `hello` は通す——`writing = item` の後で投げたことを
    // 確かめたいので、それより前の書き込みは実装のまま動かす。2本目の接続で
    // 同じ出来事がまた `writeSSE` を通ったときは、今度は素通しして実際に
    // 「配り直された」ことまで読めるようにする。
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
        // heartbeat は無関係な書き込み経路（`stream.write` 直呼び）なので
        // 長くして雑音を減らす。
        sseHeartbeatMs: 60_000,
      });

      const first = await app.request('/events', { headers: bearer() });
      const firstBody = first.body;
      if (firstBody === null) throw new Error('SSE の応答に本文が無い');
      const firstReader = firstBody.getReader();

      // **まず、1本目が実際にこの1件（event）の書き込みを試み、投げたことを
      // 待つ。** `outbox.pending` は「`hello` の書き込みがまだ終わっていない
      // （＝ `queue` に1件溜まっているだけで `writing` は空）」状態でも
      // 「1本目が既に投げて `#queue` へ戻した」状態でも同じ1を返す
      // （`hello` に締め切りが付いた分、前者に余分なマイクロタスクが挟まる
      // ようになった——`thrown` を見ないと、2本目を開くタイミングが早すぎて
      // 「1本目ではなく2本目が最初の書き込みで投げる」という別の状況を
      // 作ってしまう）。
      await expect.poll(() => thrown, { timeout: 1000 }).toBe(true);

      // **`finally` が走り切って `outbox` へ戻すのを待つ。** カウンタは
      // 見かけ上動かない（doc 参照）ので「1のまま保たれている」ことだけを
      // ここでは見る——「消えていない」の本体は下の2本目の接続で見る。
      await expect.poll(() => outbox.pending, { timeout: 1000 }).toBe(1);

      const second = await app.request('/events', { headers: bearer() });
      const secondBody = second.body;
      if (secondBody === null) throw new Error('SSE の応答に本文が無い');
      const secondReader = secondBody.getReader();

      const redelivered = await readUntil(secondReader, JSON.stringify(event), 1000);
      expect(redelivered).toContain(JSON.stringify(event));
      // 配り直された以上、outbox 側の未送出はいずれ0に戻る。**書き込みが
      // 読めたことと `writing = null`（app.ts）の実行は別の非同期境界なので、
      // ここも poll で見る**（`readUntil` が拾うのは reader 側の到着であって、
      // 送り手側の後片付けが同じマイクロタスクで終わっている保証は無い）。
      await expect.poll(() => outbox.pending, { timeout: 1000 }).toBe(0);

      await secondReader.cancel();
      await firstReader.cancel();
    } finally {
      spy.mockRestore();
      await host.shutdown();
    }
  });
});
