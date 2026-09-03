import { createHash } from 'node:crypto';

import { createRunnerHost, type RunnerEvent, type RunnerHost } from '@alteroid/core';
import { SSEStreamingApi, type SSEMessage } from 'hono/streaming';
import { describe, expect, it, vi } from 'vitest';

import { createRunnerApp, Outbox } from './app.js';

/**
 * `Outbox.attach` の第3引数（`drain`）——新しい購読者が古い購読者を黙って
 * 置き換える瞬間に、古い購読者が抱えている分（`queue` + 書きかけの1件）を
 * 同期的に新しい購読者へ引き渡すこと（この改修の (C)）を測る。
 *
 * **窓が開く筋。** 相手（デーモン）が TCP の FIN を返さないまま、新しい接続を
 * 張ってくる場合など。`attach()` はいまも「既に購読者が居ても黙って
 * `#listener` / `#probe` を置き換える」ので、これが無いと古いハンドラの
 * `queue` と書きかけの1件は配られもせず `outbox.pending` からも消える
 * （静かに消える——`Outbox.attach` の doc）。**この窓は狭い**——それでも
 * 塞ぐ理由は、開いたときに消えるのが箱の中身そのもの（報告・確認・生ログの
 * 引き渡し）だからである。
 *
 * **測り方**: 古い接続の `writeSSE` を「呼ばれたことだけ記録して永久に解決
 * しない」形にモックし（`outbox-pending.test.ts` と同じ技法）、その状態で
 * 2本目の接続（`app.request('/events', ...)`）を張る。1本目は本物の
 * ソケットを使わないので、この2本目の接続は「1本目が FIN を返していないのに
 * 新しい接続が張られた」状態をそのまま再現する。
 */
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

describe('runner の /events: 古い購読者が抱えていた分を新しい購読者へ引き渡す（(C)）', () => {
  /**
   * **この歯が単独で守るもの**: 新しい購読者が付いたとき、古い購読者が
   * 抱えていた分（書きかけの1件＋queueの後続）が箱を経由して新しい購読者へ
   * 渡り、**古い順に**受け取れること。
   */
  it('古い購読者が抱えていた分が、新しい購読者へ古い順に渡る', async () => {
    const host = newHost();
    const outbox = new Outbox();
    const event1: RunnerEvent = { type: 'session', managerId: 'mgr-1', sessionId: 'sess-1' };
    const event2: RunnerEvent = { type: 'session', managerId: 'mgr-2', sessionId: 'sess-2' };
    const event3: RunnerEvent = { type: 'session', managerId: 'mgr-3', sessionId: 'sess-3' };
    outbox.push(event1);
    outbox.push(event2);
    outbox.push(event3);

    // 1本目だけを「読まなくなった接続」にする——非 hello の書き込みの
    // *1本目に触れたストリーム*だけを永久に止め、他（2本目）は本物のまま
    // 通す。ストリームの同一性で見分ける（`this` がどちらの `writeSSE`
    // 呼び出しかを区別する）ので、`app.request()` を呼ぶ順序にだけ依存し、
    // タイミングには依存しない。
    const realWriteSSE = SSEStreamingApi.prototype.writeSSE;
    // **`this` を変数へ代入しない**（`WeakSet` の要素として使うだけ）——
    // `@typescript-eslint/no-this-alias` に当たらない形。
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
      // 締め切りは長め（この試験の中では発火させない——(A) と混ぜない）。
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

      // 1本目が「書きかけの1件（event1）＋ queue に event2, event3」を
      // 抱えていることを、outbox 側の合算（#probe 経由）で確かめる。
      await expect.poll(() => outbox.pending, { timeout: 1000 }).toBe(3);

      // 2本目を張る——1本目が FIN を返していないのに新しい接続が張られる
      // 窓そのもの。
      const second = await app.request('/events', { headers: bearer() });
      const secondBody = second.body;
      if (secondBody === null) throw new Error('SSE の応答に本文が無い');
      const secondReader = secondBody.getReader();

      // 引き渡した後も、合算 (`outbox.pending`) は3のまま——消えていない。
      await expect.poll(() => outbox.pending, { timeout: 1000 }).toBe(3);

      // 2本目が3件とも受け取り、しかも古い順（event1 → event2 → event3）
      // であること。
      const seen = await readUntil(secondReader, JSON.stringify(event3), 1000);
      expect(seen).toContain(JSON.stringify(event3));
      const idx1 = seen.indexOf(JSON.stringify(event1));
      const idx2 = seen.indexOf(JSON.stringify(event2));
      const idx3 = seen.indexOf(JSON.stringify(event3));
      expect(idx1).toBeGreaterThanOrEqual(0);
      expect(idx2).toBeGreaterThan(idx1);
      expect(idx3).toBeGreaterThan(idx2);

      // 引き渡した3件とも配送済みなので、いずれ0に戻る。
      await expect.poll(() => outbox.pending, { timeout: 1000 }).toBe(0);

      await secondReader.cancel();
      await firstReader.cancel();
      await host.shutdown();
    } finally {
      spy.mockRestore();
    }
  });

  /**
   * **この歯が単独で守るもの**: 引き渡した分が二重に配られないこと。
   *
   * 古い購読者は `writeSSE` の途中で止まっているので自分の `finally` を
   * 実行できない——**が、その書き込みが後になって「成功」として返ってきた
   * 場合**（相手の接続が実は生きていた／`stream.abort()` で強制的に解放
   * された等）でも、古い購読者はもう `recordSent` や差し戻しを行わない
   * こと（`superseded` フラグの doc）。これが無いと、同じ出来事が
   * `Outbox` の控え（`#sent`）に二重に記録され、`Last-Event-ID` で読み直す
   * 3本目の接続に同じ出来事が2回届く経路になる。
   *
   * **測り方**: 1本目の書き込みを「あとで手動で解決できる」形にしておく。
   * 2本目が引き渡しを受けて配送し終えたあとで、1本目の書き込みを解決させ、
   * 1本目が二重に何もしない（控えが増えない・`pending` が増えない）ことを
   * 確かめる。
   */
  it('引き渡した分は二重に戻らない（古い購読者が後で「成功」しても記録しない）', async () => {
    const host = newHost();
    const outbox = new Outbox();
    const event: RunnerEvent = { type: 'session', managerId: 'mgr-solo', sessionId: 'sess-solo' };
    outbox.push(event);

    const realWriteSSE = SSEStreamingApi.prototype.writeSSE;
    // **`this` を変数へ代入しない**（`WeakSet` の要素として使うだけ）——
    // `@typescript-eslint/no-this-alias` に当たらない形。
    const stuckStreams = new WeakSet<SSEStreamingApi>();
    let sawFirstNonHello = false;
    let releaseStuck: (() => void) | null = null;
    const stuckPromise = new Promise<void>((resolve) => {
      releaseStuck = resolve;
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
        // 「まだ返らない」を模しつつ、後で手動で解決できるようにしておく
        // （`stream.abort()` を待たず、テスト側で明示的に「実は成功していた」
        // を再現するため）。
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

      await expect.poll(() => outbox.pending, { timeout: 1000 }).toBe(1);

      const second = await app.request('/events', { headers: bearer() });
      const secondBody = second.body;
      if (secondBody === null) throw new Error('SSE の応答に本文が無い');
      const secondReader = secondBody.getReader();

      // 2本目が受け取って配送し切るまで待つ。
      const seen = await readUntil(secondReader, JSON.stringify(event), 1000);
      expect(seen).toContain(JSON.stringify(event));
      await expect.poll(() => outbox.pending, { timeout: 1000 }).toBe(0);

      // ここで初めて、1本目の書き込みを「実は成功していた」ことにする。
      releaseStuck?.();

      // **1本目の応答を実際に読む。** `firstReader` を一度も読まないままだと、
      // 誰も消費していない `responseReadable` の backpressure（既定
      // `highWaterMark=1`）に阻まれて、解放した実書き込み（`realWriteSSE`）
      // 自体が完了しない——`superseded` の防御が効いているのか、単に書き込みが
      // 終わっていないだけなのかが区別できなくなる（実測: 読まずに待つと、
      // このテストは `superseded` の分岐を丸ごと外しても緑のままだった）。
      // 読むことで、1本目のループが実際に再開まで進めることを保証する。
      void firstReader.read();
      void firstReader.read();

      // 少し待って、1本目の再開が何か（`recordSent` や `requeue`）をしても
      // `pending` が動かないこと、そして `Last-Event-ID` で読み直しても
      // 二重に届かないことを確かめる。
      await new Promise((resolve) => setTimeout(resolve, 200));
      expect(outbox.pending).toBe(0);

      // **本題そのもの——`Outbox` の控え（`#sent`）に、同じ出来事が2件目として
      // 記録されていないこと。** ここが直接の検査対象である
      // （`Outbox.recordSent` / `Outbox.sentSince` の doc）。バイト読みより
      // 先にこちらで固定する——読み側（3本目の接続）のタイミング次第で
      // 「読み切れなかった」と「記録されていない」が区別しづらくなるため。
      expect(outbox.sentSince(0)).toHaveLength(1);

      // **裏取り。** 3本目が `Last-Event-ID: 0` で読み直しても、同じ出来事が
      // 2回現れないこと。**`readUntil` で `hello` だけを見て早期に打ち切ると、
      // その直後に来るはずの2件目を読む前に終わってしまう**——ここでは
      // 固定の時間だけ読み切ってから数える（早期終了しない）。
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
