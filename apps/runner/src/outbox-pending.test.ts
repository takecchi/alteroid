import { createHash } from 'node:crypto';

import { createRunnerHost, type RunnerEvent, type RunnerHost } from '@alteroid/core';
import { SSEStreamingApi, type SSEMessage } from 'hono/streaming';
import { describe, expect, it, vi } from 'vitest';

import { createRunnerApp, Outbox } from './app.js';

/**
 * `bc9f6ba`（#358）の訂正そのものを測る歯。**この訂正にはまだ1本も歯が無かった**
 * （`git show --stat bc9f6ba` は `apps/runner/src/app.ts` のみで、テストファイルは
 * 1本も含まれていない）。
 *
 * 直す前の `Outbox.pending`（当時は `get pending() { return this.#queue.length; }`
 * の1行だけ）は、`push` が listener 付きのとき `#queue` に一切積まない
 * （`push` は listener が居ればそのまま渡して return する）ので、**「デーモンが
 * 繋がったまま読まなくなった」状況では常に 0 を返していた**（#323 の4時間、
 * この値はずっと 0 だった——`Outbox.pending` の doc に書いてある表そのもの）。
 *
 * ここで確かめるのは、その表の「デーモンが繋がったまま読まなくなった」行——
 * listener（`/events` の購読側）が付いたまま出来事が溜まったとき、
 * `outbox.pending` が 0 ではなく実際の件数を返すこと。
 *
 * **測り方。** `stream.writeSSE` を「相手が読まなくなった接続」そのものとして
 * 模す——`hello` だけ実装を素通しし、それ以外は**永久に解決しない Promise を
 * 返す**（無音の固着。`runner-client.ts` の `RUNNER_STREAM_SILENCE_TIMEOUT_MS`
 * の doc が言う「無音のまま固着した」状態と同じ形）。これで `/events` の
 * ハンドラは実際に「listener は付いたまま、`writeSSE` の途中で止まる」状態へ
 * 入る——モックで数だけ真似るのではなく、`app.ts` のループを本物のまま走らせて
 * その状態を作る。
 */
const TOKEN = 'daemon-only-token';
const TOKEN_SHA256 = createHash('sha256').update(TOKEN, 'utf8').digest('hex');

function bearer(): Record<string, string> {
  return { authorization: `Bearer ${TOKEN}`, accept: 'text/event-stream' };
}

function newHost(): RunnerHost {
  return createRunnerHost({
    runnerId: 'runner-outbox-pending-test',
    workspacePath: '/workspace',
    emit: () => undefined,
  });
}

/**
 * `SSEStreamingApi.prototype.writeSSE` を差し替える。`hello` は実装のまま
 * 通し、それ以外は**呼ばれたことだけ記録して永久に解決しない**——「相手が
 * 読まなくなった接続」を、実際に `await` が返らない形で再現する。
 */
function hangOnRealEvents(): { spy: ReturnType<typeof vi.spyOn>; calls: string[] } {
  const realWriteSSE = SSEStreamingApi.prototype.writeSSE;
  const calls: string[] = [];
  const spy = vi
    .spyOn(SSEStreamingApi.prototype, 'writeSSE')
    .mockImplementation(async function (this: SSEStreamingApi, message: SSEMessage) {
      if (message.event === 'hello') return realWriteSSE.call(this, message);
      calls.push(message.event ?? '');
      // 相手が読まなくなった接続——ここで永久に返らない。
      return new Promise<void>(() => undefined);
    });
  return { spy, calls };
}

describe('Outbox.pending: listener が付いたままでも溜まりが見える（#358）', () => {
  it('listener が付いたまま出来事が溜まったとき、pending が立つ（直す前はここで 0 を返していた）', async () => {
    const host = newHost();
    const outbox = new Outbox();
    const events: RunnerEvent[] = [
      { type: 'session', managerId: 'mgr-1', sessionId: 'sess-1' },
      { type: 'session', managerId: 'mgr-2', sessionId: 'sess-2' },
      { type: 'session', managerId: 'mgr-3', sessionId: 'sess-3' },
    ];
    for (const event of events) outbox.push(event);
    // まだ listener は居ないので、素直に3件と数えられる（ここは訂正の前後で
    // 変わらない側——比較対象として先に確かめておく）。
    expect(outbox.pending).toBe(3);

    const { spy } = hangOnRealEvents();
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

      // **ここが訂正そのものである。** `attach()` で3件とも `Outbox.#queue` から
      // ハンドラのローカル `queue` へ移り、うち1件が `writing`（書きかけ）へ
      // 進んで `writeSSE` の途中で止まる。listener は付いたままなので、直す前
      // なら `#queue.length` は 0 のまま——`pending` も 0 になっていた。
      await expect.poll(() => outbox.pending, { timeout: 1000 }).toBe(3);

      await reader.cancel();
      await host.shutdown();
    } finally {
      spy.mockRestore();
    }
  });

  /**
   * **この歯が単独で守るもの**: `writeSSE` の`await`が返らないあいだ、その
   * 1件（`writing`）も `pending` の数に入ること。
   *
   * 上の試験は3件まとめてで見ているが、こちらは**書きかけの1件だけ**を切り出す
   * ——`queue` に積まれた分がゼロの状態で `pending` を見ることで、
   * `writing` 自身が数えられていることを他の材料と混ぜずに確かめる。
   */
  it('writeSSE の途中で止まっている1件も数に入る', async () => {
    const host = newHost();
    const outbox = new Outbox();
    const event: RunnerEvent = { type: 'session', managerId: 'mgr-solo', sessionId: 'sess-solo' };
    outbox.push(event);

    const { spy, calls } = hangOnRealEvents();
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

      // `writeSSE` が実際にこの出来事で呼ばれ、そこで止まっていることを
      // 先に確かめる——止まっていなければ「入っている」の主張自体が空になる。
      await expect.poll(() => calls.length, { timeout: 1000 }).toBe(1);
      expect(calls).toEqual(['session']);

      // `queue` は空（1件しか push していない）。それでも `pending` は 0 では
      // ない——`writing` に居る1件がそのまま数えられているはずである。
      expect(outbox.pending).toBe(1);

      await reader.cancel();
      await host.shutdown();
    } finally {
      spy.mockRestore();
    }
  });
});
