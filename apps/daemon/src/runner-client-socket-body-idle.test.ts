import { createServer, type Server, type ServerResponse } from 'node:http';
import { join } from 'node:path';

import { afterEach, describe, expect, it } from 'vitest';

import { makeTempDirSync } from '../../../vitest.tmpdir.js';
import { createHttpRunner } from './runner-client.js';

// `/health` には答え、`/transcript` は見出しと本文の一部だけを返して止まる runner（#4691）
let server: Server | undefined;
const stalled = new Set<ServerResponse>();
afterEach(async () => {
  for (const res of stalled) res.destroy();
  stalled.clear();
  await new Promise<void>((resolve) =>
    server === undefined ? resolve() : server.close(() => resolve()),
  );
  server = undefined;
});

async function stallingRunner(): Promise<string> {
  const socketPath = join(makeTempDirSync('alteroid-sock-idle-'), 'runner.sock');
  server = createServer((req, res) => {
    if (req.url === '/health') {
      res.writeHead(200, { 'content-type': 'application/json' });
      res.end(JSON.stringify({ runnerId: 'runner-stall' }));
      return;
    }
    if (req.url === '/managers/m-ok/transcript') {
      res.writeHead(200, { 'content-type': 'text/plain' });
      res.end('全部届く');
      return;
    }
    stalled.add(res);
    res.writeHead(200, { 'content-type': 'text/plain', 'content-length': '100' });
    res.write('abc');
  });
  await new Promise<void>((resolve) => server?.listen({ path: socketPath }, resolve));
  return `unix:${socketPath}`;
}

describe('Unix ソケット越しの応答の本文の無通信の期限（#4691）', () => {
  it('⭐ 見出しの後に本文が止まった runner からの transcript は、期限で打ち切って null を返す（止まったままにしない）', async () => {
    const runner = await createHttpRunner({
      baseUrl: await stallingRunner(),
      token: 'token',
      socketBodyIdleTimeoutMs: 200,
    });
    const started = Date.now();
    await expect(runner.transcript('m-stall')).resolves.toBeNull();
    expect(Date.now() - started).toBeLessThan(4_000);
  }, 10_000);

  it('本文が流れきる応答は、今までどおり全部読む', async () => {
    const runner = await createHttpRunner({
      baseUrl: await stallingRunner(),
      token: 'token',
      socketBodyIdleTimeoutMs: 200,
    });
    await expect(runner.transcript('m-ok')).resolves.toBe('全部届く');
  });
});
