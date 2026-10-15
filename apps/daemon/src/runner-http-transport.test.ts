import { createServer, type Server } from 'node:http';
import type { AddressInfo } from 'node:net';
import { performance } from 'node:perf_hooks';

import { afterEach, describe, expect, it, vi } from 'vitest';

import { RunnerHttpTransport } from './runner-http-transport.js';

let server: Server | undefined;
let transport: RunnerHttpTransport | undefined;

afterEach(async () => {
  transport?.close();
  transport = undefined;
  server?.closeAllConnections();
  await new Promise<void>((resolve) => (server ? server.close(() => resolve()) : resolve()));
  server = undefined;
});

/** 本物の http サーバ。`hangHealth` のときは応答を返さない。繋がった本数を数える。 */
async function startServer(
  options: { hangHealth?: boolean } = {},
): Promise<{ url: string; connections: () => number }> {
  let connections = 0;
  server = createServer((_req, res) => {
    if (options.hangHealth === true) return;
    res.end('ok');
  });
  server.on('connection', () => {
    connections += 1;
  });
  await new Promise<void>((resolve) => server?.listen(0, resolve));
  // 名前で繋ぐ: IP リテラルだと名前解決（`dns.lookup`）が走らず、段の観測が試せない
  return {
    url: `http://localhost:${String((server?.address() as AddressInfo).port)}`,
    connections: () => connections,
  };
}

describe('runner への HTTP の接続の使い回し（#4890）', () => {
  it('⭐ 同じ runner への2回の確認が、同じ接続を使う（接続は1本で、2回目は名前解決も接続もやり直さない）', async () => {
    const { url, connections } = await startServer();
    transport = new RunnerHttpTransport();

    const first = await transport.send(`${url}/health`);
    expect(await first.text()).toBe('ok');
    expect(connections()).toBe(1);
    // 本番の確認は10秒空く。ここは、本文を読み終えた直後はまだ接続が池へ戻っていない（戻る前に次を投げると別の接続になる）ので、1周だけ譲る（時間の待ちではない）
    await new Promise((resolve) => setImmediate(resolve));

    const secondStartedAt = performance.now();
    const second = await transport.send(`${url}/health`);
    expect(await second.text()).toBe('ok');
    expect(connections()).toBe(1);

    // 2回目は名前解決が始まっていない（使い回した）。ヘッダは届いている
    expect(transport.stagesSince(secondStartedAt)).toEqual({
      lookup: { kind: 'none' },
      headersReceived: true,
    });
  });

  it('新しい接続を張った回は、名前解決が済んだ ms・接続・応答のヘッダを返す', async () => {
    const { url } = await startServer();
    transport = new RunnerHttpTransport();

    const startedAt = performance.now();
    await (await transport.send(`${url}/health`)).text();

    const stages = transport.stagesSince(startedAt);
    expect(stages.lookup).toMatchObject({ kind: 'resolved' });
    expect(stages.connected).toBe(true);
    expect(stages.headersReceived).toBe(true);
  });

  it('応答が返らない回は、名前解決が済み・接続が張れ・ヘッダが届いていない、と返す', async () => {
    const { url, connections } = await startServer({ hangHealth: true });
    transport = new RunnerHttpTransport();
    const controller = new AbortController();

    const startedAt = performance.now();
    const hung = transport
      .send(`${url}/health`, { signal: controller.signal })
      .then(() => 'answered')
      .catch(() => 'aborted');
    // サーバが接続を受けるまで待つ（実時間の待ちではなく、条件が成るまでの再試行）
    await vi.waitFor(() => {
      expect(connections()).toBe(1);
    });

    const stages = transport.stagesSince(startedAt);
    expect(stages.lookup).toMatchObject({ kind: 'resolved' });
    expect(stages.connected).toBe(true);
    expect(stages.headersReceived).toBe(false);

    controller.abort();
    expect(await hung).toBe('aborted');
  });

  it('名前解決が失敗した回は、その段を「失敗」と返し、接続は張れていない', async () => {
    transport = new RunnerHttpTransport();
    const startedAt = performance.now();
    // `.invalid` は予約された TLD で、必ず引けない
    await expect(transport.send('http://runner-4890.invalid/health')).rejects.toBeInstanceOf(
      TypeError,
    );

    const stages = transport.stagesSince(startedAt);
    expect(stages.lookup).toMatchObject({ kind: 'failed' });
    expect(stages.connected).toBe(false);
    expect(stages.headersReceived).toBe(false);
  });

  it('要求を一度も投げていない確認の時刻では、段を埋めない（接続の使い回しか前か区別できない欄は不明）', () => {
    transport = new RunnerHttpTransport();
    expect(transport.stagesSince(performance.now())).toEqual({ lookup: { kind: 'none' } });
  });
});
