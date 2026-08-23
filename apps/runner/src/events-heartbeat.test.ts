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
    const decoder = new TextDecoder();
    let seen = '';
    while (!seen.includes(': hb')) {
      const { value, done } = await reader.read();
      if (done) break;
      seen += decoder.decode(value, { stream: true });
    }

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
    const decoder = new TextDecoder();
    let seen = '';
    // `hello` まで読んだら、その後100msぶん待って何も来ないことを見る
    while (!seen.includes('event: hello')) {
      const { value, done } = await reader.read();
      if (done) break;
      seen += decoder.decode(value, { stream: true });
    }

    const next = await Promise.race([
      reader.read().then(({ value }) => decoder.decode(value)),
      new Promise<'まだ何も来ていない'>((resolve) =>
        setTimeout(() => resolve('まだ何も来ていない'), 100),
      ),
    ]);
    expect(next).toBe('まだ何も来ていない');

    await reader.cancel();
    await host.shutdown();
  });
});
