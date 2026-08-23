import { createHash } from 'node:crypto';

import { createRunnerHost, type RunnerEvent, type RunnerHost } from '@alteroid/core';
import * as core from '@alteroid/core';
import { describe, expect, it, vi } from 'vitest';

import { createRunnerApp, Outbox } from './app.js';

/**
 * `GET /events` の `finally`（#272）が守っている2つの約束を確かめる:
 *
 * 1. `stopHeartbeat()` が `detach()` より先に呼ばれること
 *    （`apps/runner/src/app.ts` のコメント「タイマーを先に止める」）。
 * 2. 流し切れなかった出来事が `queue` から `outbox` へ戻り、失われないこと
 *    （同じ `finally` の最後の行）。
 *
 * **どちらも `app.request()` の `reader.cancel()` で測れる。** hono の
 * `streamSSE` は `Response.body` にそのまま `SSEStreamingApi#responseReadable`
 * を渡しており（`hono/dist/helper/streaming/sse.js` の `streamSSE`）、その
 * `ReadableStream` の `cancel` アルゴリズムは `!this.closed` なら
 * `this.abort()` を呼ぶ（`hono/dist/utils/stream.js` の `StreamingApi`
 * コンストラクタ）。これは Node の `outgoing` の `close`/`error` を経由しない
 * ——**クライアント側からの明示的な cancel は、実 socket が無くても
 * `stream.onAbort(...)` まで届く。** `apps/daemon/src/app.test.ts` の
 * heartbeat 試験が断っている「`app.request()` では掃除を再現できない」は
 * *相手が黙って消える*ケース（TCP の再送タイムアウト経由の検知）の話で、
 * こちらの*明示的な cancel* とは経路が別である。
 */
const TOKEN = 'daemon-only-token';
const TOKEN_SHA256 = createHash('sha256').update(TOKEN, 'utf8').digest('hex');

function bearer(): Record<string, string> {
  return { authorization: `Bearer ${TOKEN}`, accept: 'text/event-stream' };
}

function newHost(): RunnerHost {
  return createRunnerHost({
    runnerId: 'runner-finally-order-test',
    workspacePath: '/workspace',
    emit: () => undefined,
  });
}

describe('runner の /events: finally の片付け順序と取りこぼし無し', () => {
  /**
   * **この歯が単独で守るもの**: `stopHeartbeat()` が `detach()` より先に
   * 呼ばれること。
   *
   * 逆順になると、`detach()` の後（=`outbox` から見て購読者が居なくなった後）
   * にもタイマーが数回残り、`stream.write()` を死んだ接続へ向けて撃ち続ける
   * 窓ができる（`write()` 自体は例外を出さないので、残っていても壊れて見え
   * ない——`sse-heartbeat.ts` の JSDoc「タイマーを先に止める」がまさにこの
   * 順序を理由に説明している）。
   *
   * **測り方**: `@alteroid/core` の `startSseHeartbeat` と `Outbox.prototype.attach`
   * を実装を保ったまま薄くラップし、それぞれが返す stop / detach 関数が
   * 呼ばれた順を記録する。ロジックそのものは1行も変えていない（本物の
   * `startSseHeartbeat` / `attach` を内部で呼ぶだけ）。
   */
  it('stopHeartbeat が detach より先に呼ばれる', async () => {
    const order: string[] = [];

    const realStart = core.startSseHeartbeat;
    const startSpy = vi
      .spyOn(core, 'startSseHeartbeat')
      .mockImplementation((stream, intervalMs, wake) => {
        const stop = realStart(stream, intervalMs, wake);
        return () => {
          order.push('stopHeartbeat');
          stop();
        };
      });

    const realAttach = Outbox.prototype.attach;
    const attachSpy = vi.spyOn(Outbox.prototype, 'attach').mockImplementation(function (
      this: Outbox,
      listener: (event: RunnerEvent) => void,
    ) {
      const detach = realAttach.call(this, listener);
      return () => {
        order.push('detach');
        detach();
      };
    });

    try {
      const host = newHost();
      const outbox = new Outbox();
      const app = createRunnerApp({
        host,
        outbox,
        tokenSha256: TOKEN_SHA256,
        sseHeartbeatMs: 5,
      });

      const response = await app.request('/events', { headers: bearer() });
      const body = response.body;
      if (body === null) throw new Error('SSE の応答に本文が無い');
      const reader = body.getReader();

      // 何も読まずに即座に切る——`stream.onAbort` を最短経路で踏ませる。
      await reader.cancel();
      // `finally` 節（非同期な `for` ループの外側）が走り切るのを待つ。
      await expect.poll(() => order.length >= 2, { timeout: 1000 }).toBe(true);

      expect(order).toEqual(['stopHeartbeat', 'detach']);
      await host.shutdown();
    } finally {
      startSpy.mockRestore();
      attachSpy.mockRestore();
    }
  });

  /**
   * **この歯が単独で守るもの**: 流し切れなかった出来事が `outbox` へ戻ること。
   *
   * `finally` の最後の行（`for (const event of queue) outbox.push(event);`）
   * が無いと、接続が切れた瞬間に読み側（`queue` にまだ残っていた分）の出来事
   * がそのまま失われる——次にデーモンが繋ぎ直しても、その分の出来事は二度と
   * 届かない（`Outbox` は「溜める量に上限を置かない」設計だが、それは
   * push されたものに限る話で、握ったまま消える分は守らない）。
   *
   * **測り方**: `outbox` へ2件 push してから `/events` を開く。`Outbox.attach`
   * は溜まっていた分を同期的に listener（=`/events` ハンドラの `queue`）へ
   * 流すので、ハンドラが `hello` すら書き終える前に2件とも `queue` の中へ
   * 移っている。その直後に読まずに `reader.cancel()` すれば、2件とも
   * `writeSSE` で流れる前に接続が切れる——`finally` が動けば `outbox.pending`
   * は2に戻り、動かなければ0のまま（＝出来事が消えたまま）になる。
   */
  it('流し切れなかった出来事は outbox へ戻る（消えない）', async () => {
    const host = newHost();
    const outbox = new Outbox();
    const event1: RunnerEvent = { type: 'session', managerId: 'mgr-1', sessionId: 'sess-1' };
    const event2: RunnerEvent = { type: 'session', managerId: 'mgr-2', sessionId: 'sess-2' };
    outbox.push(event1);
    outbox.push(event2);
    expect(outbox.pending).toBe(2);

    const app = createRunnerApp({
      host,
      outbox,
      tokenSha256: TOKEN_SHA256,
      sseHeartbeatMs: 5,
    });

    const response = await app.request('/events', { headers: bearer() });
    const body = response.body;
    if (body === null) throw new Error('SSE の応答に本文が無い');
    const reader = body.getReader();

    // `attach()` が同期的に `outbox` の内部キューを空にした直後、まだ何も
    // 流れていないうちに切る。
    expect(outbox.pending).toBe(0);
    await reader.cancel();

    await expect.poll(() => outbox.pending, { timeout: 1000 }).toBe(2);

    await host.shutdown();
  });
});
