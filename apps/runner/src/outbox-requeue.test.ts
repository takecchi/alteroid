import { createHash } from 'node:crypto';

import { createRunnerHost, type RunnerEvent, type RunnerHost } from '@alteroid/core';
import { SSEStreamingApi, type SSEMessage } from 'hono/streaming';
import { describe, expect, it, vi } from 'vitest';

import { createRunnerApp, Outbox } from './app.js';

/**
 * `Outbox.requeue`（元の `queuedAt` を保ったまま箱へ戻す口）を測る。
 *
 * **これは意味の変更である。** 直す前は、確実に配送できなかった分を
 * `outbox.push(event)` でそのまま戻していたので、`queuedAt` が
 * `this.#now()` で打ち直されていた——`/events` の `finally` も、`attach()` の
 * ドレイン（`new Date().toISOString()`）も同じ形だった。締め切り（(A)）を
 * 入れると接続を畳む頻度が上がるので、このままだと `oldestPendingAt` が
 * 「常に新しい」という嘘をつく計器になる（7時間待っている報告が、毎回さっき
 * 積まれたように見える）。
 *
 * **単体テストは「新しい時刻になっていないこと」ではなく「元の値と一致する
 * こと」で固定する**——`this.#now()` を意図的に「間違った現在時刻」に固定し、
 * `requeue` に渡した元の時刻とは異なる値を返すようにして、戻り値が
 * `this.#now()` の側ではなく渡した引数の側と一致することを確かめる。
 */
const TOKEN = 'daemon-only-token';
const TOKEN_SHA256 = createHash('sha256').update(TOKEN, 'utf8').digest('hex');

function bearer(): Record<string, string> {
  return { authorization: `Bearer ${TOKEN}`, accept: 'text/event-stream' };
}

function newHost(): RunnerHost {
  return createRunnerHost({
    runnerId: 'runner-outbox-requeue-test',
    workspacePath: '/workspace',
    emit: () => undefined,
  });
}

describe('Outbox.requeue: 元の queuedAt を保ったまま戻す', () => {
  /**
   * **単体レベル。** listener が付いていない（`#queue` へ積む側の分岐）状態で
   * `requeue` を呼ぶ。`now()` は意図的に「間違った現在時刻」を返すよう固定し、
   * `oldestPendingAt` が `now()` 側ではなく渡した `queuedAt` の側と一致することを
   * 確かめる。
   */
  it('listener が居ないとき、requeue した値の queuedAt が this.#now() ではなく渡した引数のまま', () => {
    const outbox = new Outbox(() => 'WRONG-NOW-2099-01-01T00:00:00.000Z');
    const event: RunnerEvent = { type: 'session', managerId: 'mgr-1', sessionId: 'sess-1' };

    outbox.requeue(event, 'ORIGINAL-2020-01-01T00:00:00.000Z');

    expect(outbox.oldestPendingAt).toBe('ORIGINAL-2020-01-01T00:00:00.000Z');
    expect(outbox.oldestPendingAt).not.toBe('WRONG-NOW-2099-01-01T00:00:00.000Z');
  });

  /**
   * **`push` は `requeue` への薄い委譲であること（新規分は「いま」のまま）。**
   * `requeue` を足しても、新規に積む場合の挙動（`queuedAt: this.#now()`）が
   * 後退していないことの裏取り。
   */
  it('push は requeue(event, this.#now()) に委譲する——新規分は「いま」のまま', () => {
    const outbox = new Outbox(() => 'NOW-2020-06-01T00:00:00.000Z');
    const event: RunnerEvent = { type: 'session', managerId: 'mgr-2', sessionId: 'sess-2' };

    outbox.push(event);

    expect(outbox.oldestPendingAt).toBe('NOW-2020-06-01T00:00:00.000Z');
  });

  /**
   * **配送経路（`attach` の第1引数）レベル。** listener が付いている状態で
   * `requeue` を呼ぶと、直接配送されるが、その `queuedAt` も「いま」ではなく
   * 渡した値のまま listener へ渡ること。
   */
  it('listener が居るとき、requeue で渡した queuedAt がそのまま listener の第3引数に渡る', () => {
    const outbox = new Outbox(() => 'WRONG-NOW');
    const event: RunnerEvent = { type: 'session', managerId: 'mgr-3', sessionId: 'sess-3' };
    const received: { event: RunnerEvent; seq: number; queuedAt: string }[] = [];
    outbox.attach((ev, seq, queuedAt) => received.push({ event: ev, seq, queuedAt }));

    outbox.requeue(event, 'ORIGINAL-TIME');

    expect(received).toHaveLength(1);
    expect(received[0]?.queuedAt).toBe('ORIGINAL-TIME');
  });
});

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

describe('/events の finally: 畳んで戻したときも元の queuedAt を保つ（(A)+(B) の結線）', () => {
  /**
   * **統合レベル。** (A) の締め切り超過で接続を畳んだとき、`finally` が
   * `outbox.push` ではなく `outbox.requeue` で戻すので、`oldestPendingAt` が
   * 畳んだ「いま」ではなく、元々積まれていた古い時刻を答え続けること。
   *
   * **時刻を進める**（`clock` を書き換える）ことで、「戻す操作をした時点の
   * `this.#now()`」と「元の `queuedAt`」を確実に異なる値にしてから確かめる。
   */
  it('畳んで戻した後も oldestPendingAt は元の古い時刻を答える', async () => {
    const host = newHost();
    let clock = 'OLD-2020-01-01T00:00:00.000Z';
    const outbox = new Outbox(() => clock);
    const event: RunnerEvent = { type: 'session', managerId: 'mgr-stuck', sessionId: 'sess-stuck' };
    outbox.push(event);
    expect(outbox.oldestPendingAt).toBe('OLD-2020-01-01T00:00:00.000Z');

    // 時間が進んだことにする——畳んで戻す操作がこの「いま」を使ってしまえば
    // 検出できるようにする。
    clock = 'NEW-2030-01-01T00:00:00.000Z';

    const { spy } = hangOnRealEvents();
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

      // 締め切りを過ぎて畳まれ、outbox へ戻るまで待つ。
      await expect.poll(() => outbox.pending, { timeout: 2000 }).toBe(1);

      // **ここが本題**——戻った後の oldestPendingAt が「いま」（2030年）では
      // なく、元の時刻（2020年）のままであること。
      expect(outbox.oldestPendingAt).toBe('OLD-2020-01-01T00:00:00.000Z');
      expect(outbox.oldestPendingAt).not.toBe('NEW-2030-01-01T00:00:00.000Z');

      await reader.cancel();
      await host.shutdown();
    } finally {
      spy.mockRestore();
    }
  });
});
