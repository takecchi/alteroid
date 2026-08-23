import { createHash } from 'node:crypto';

import { createRunnerHost, type RunnerHost } from '@alteroid/core';
import { describe, expect, it } from 'vitest';

import { createRunnerApp, Outbox } from './app.js';

/**
 * runner の `GET /events` に足した heartbeat（#272）が、実際に無音のあいだも
 * 書き込みを発生させることを確かめる。
 *
 * **`app.request()` は実 socket を持たないので、掃除（死んだ接続の切断）が
 * 実際に起きることまでは再現できない**（`apps/daemon/src/app.test.ts` の
 * `/chat` heartbeat 試験と同じ注釈）。掃除は Node の `outgoing` の
 * `close` / `error` を経由する経路で、そこは `@hono/node-server` が実 socket
 * を張ったときにしか動かない。**ここで見ているのは「無音のときに書き込みが
 * 発生するか」までである。**
 */
const TOKEN = 'daemon-only-token';
const TOKEN_SHA256 = createHash('sha256').update(TOKEN, 'utf8').digest('hex');

function bearer(): Record<string, string> {
  return { authorization: `Bearer ${TOKEN}`, accept: 'text/event-stream' };
}

/**
 * 期限を自分で持って読む。**待ちで落とさないためである。**
 *
 * `reader.read()` を無条件に await する形だと、来ないときは vitest の
 * テストタイムアウト（5000ms）で落ちる —— そのとき出るのは
 * `Test timed out in 5000ms` だけで、**「無音のときに書き込みが発生しなかった」
 * ではなく「待ち時間を超えた」しか言わない。** 実測（#272 の変異試験 M2:
 * runner の `startSseHeartbeat(...)` の呼び出しを無効化する変異）で、この歯は
 * まさにタイムアウトで落ちた。歯としては効いているが、**落ち方が測っている
 * 性質を指していない。**
 *
 * 期限を自分で持てば、期限までに読めたものを持って `expect` へ渡せる ——
 * 落ちるときは assertion で落ち、何が来ていたのかが出力に出る。
 */
async function readUntil(
  reader: ReadableStreamDefaultReader<Uint8Array>,
  needle: string,
  budgetMs: number,
): Promise<string> {
  const decoder = new TextDecoder();
  let seen = '';
  let timer: ReturnType<typeof setTimeout> | undefined;
  // **期限は1本で持つ**（読むたびに張り直すと、1回ごとの待ちになって合計が伸びる）。
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

function newHost(): RunnerHost {
  return createRunnerHost({
    runnerId: 'runner-events-heartbeat-test',
    workspacePath: '/workspace',
    emit: () => undefined,
  });
}

describe('runner の /events heartbeat', () => {
  /**
   * **この歯が単独で守るもの**: `outbox` へ何も push されないまま黙っていても、
   * `GET /events` は heartbeat のコメント行を書くこと。
   *
   * これが無いと、マネージャーが黙っている runner の `/events` は `hello` を
   * 書いた後1バイトも流れず、undici の既定 `bodyTimeout`（5分）でデーモン側の
   * 接続が切れる（#272 本体）。
   */
  it('outbox に何も push しなくても、無音のあいだに : hb が書かれる', async () => {
    const host = newHost();
    const app = createRunnerApp({
      host,
      outbox: new Outbox(),
      tokenSha256: TOKEN_SHA256,
      sseHeartbeatMs: 5,
    });

    const response = await app.request('/events', { headers: bearer() });
    const body = response.body;
    if (body === null) throw new Error('SSE の応答に本文が無い');

    const reader = body.getReader();
    // 間隔は 5ms なので 1000ms は200回ぶんの余裕がある。**来ないときは期限で
    // 読むのをやめ、assertion で落とす**（`readUntil` の JSDoc）。
    const seen = await readUntil(reader, ': hb', 1000);

    expect(seen).toContain(': hb');
    // 既存のフレーム（hello）を壊していないことも見ておく
    expect(seen).toContain('event: hello');

    await reader.cancel();
    await host.shutdown();
  });

  /**
   * **上の試験に歯が在ることの裏取り（陰性対照）。**
   *
   * 間隔を十分長くすれば、同じ読み方をしても heartbeat は来ない。これが無いと
   * 「常に書き込みが起きる」実装（例えば `hello` の直後に無条件で何か流す形）
   * でも上の試験が緑になってしまう。
   */
  it('間隔より短いあいだは heartbeat は流れない（上の試験が周期を見ている証拠）', async () => {
    const host = newHost();
    const app = createRunnerApp({
      host,
      outbox: new Outbox(),
      tokenSha256: TOKEN_SHA256,
      sseHeartbeatMs: 60_000,
    });

    const response = await app.request('/events', { headers: bearer() });
    const body = response.body;
    if (body === null) throw new Error('SSE の応答に本文が無い');

    const reader = body.getReader();
    // `hello` まで読んだら、その後100msぶん待って何も来ないことを見る。
    // ここも期限つきで読む（`hello` すら来ない壊れ方をしたときに、待ちではなく
    // assertion で落とすため）。
    const seen = await readUntil(reader, 'event: hello', 1000);
    expect(seen).toContain('event: hello');

    const next = await Promise.race([
      reader.read().then(({ value }) => new TextDecoder().decode(value)),
      new Promise<'まだ何も来ていない'>((resolve) =>
        setTimeout(() => resolve('まだ何も来ていない'), 100),
      ),
    ]);
    expect(next).toBe('まだ何も来ていない');

    await reader.cancel();
    await host.shutdown();
  });
});
