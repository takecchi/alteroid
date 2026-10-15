import { createServer, type Server } from 'node:http';
import type { AddressInfo } from 'node:net';
import { performance } from 'node:perf_hooks';

import { afterEach, describe, expect, it } from 'vitest';

import { createHttpRunner } from './runner-client.js';

let server: Server | undefined;

afterEach(async () => {
  server?.closeAllConnections();
  await new Promise<void>((resolve) => (server ? server.close(() => resolve()) : resolve()));
  server = undefined;
});

describe('HttpRunner は TCP の runner へ接続を使い回して繋ぐ（#4915）', () => {
  it('⭐ fetchFn を渡さない HttpRunner の確認を重ねても、サーバが受ける接続は1本', async () => {
    let connections = 0;
    server = createServer((_req, res) => {
      res.setHeader('content-type', 'application/json');
      res.end(JSON.stringify({ runnerId: 'runner-keepalive', workspacePath: '/w' }));
    });
    server.on('connection', () => {
      connections += 1;
    });
    await new Promise<void>((resolve) => server?.listen(0, '127.0.0.1', resolve));
    const port = (server.address() as AddressInfo).port;

    // `createHttpRunner` の名乗り（1回目）で接続が張られる
    const runner = await createHttpRunner({
      baseUrl: `http://127.0.0.1:${String(port)}`,
      token: 't',
    });
    try {
      expect(connections).toBe(1);
      for (let i = 0; i < 2; i += 1) {
        // 本文を読み終えてから接続が池へ戻るまでの1拍を譲る（時間の待ちではない）
        await new Promise((resolve) => setImmediate(resolve));
        const startedAt = performance.now();
        expect((await runner.identity?.())?.runnerId).toBe('runner-keepalive');
        expect(connections).toBe(1);
        // RunnerHttpTransport を通った印: 段（応答のヘッダが届いた）を取れるのは transport だけ。
        // Node 同梱の fetch も接続を使い回すので、接続の本数だけでは配線を縛れない
        expect(runner.stagesSince?.(startedAt)).toMatchObject({ headersReceived: true });
      }
    } finally {
      await runner.close();
    }
  });
});
