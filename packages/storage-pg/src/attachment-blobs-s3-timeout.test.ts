import { createServer, type Server, type Socket } from 'node:net';

import { afterEach, describe, expect, it } from 'vitest';

import {
  S3AttachmentBlobStore,
  S3_CONNECT_TIMEOUT_MS,
  S3_IDLE_TIMEOUT_MS,
} from './attachment-blobs-s3.js';

// 繋がるが何も返さない S3（経路が半開きになった相手の代わり）
let server: Server | undefined;
const sockets = new Set<Socket>();
afterEach(async () => {
  for (const socket of sockets) socket.destroy();
  sockets.clear();
  await new Promise<void>((resolve) =>
    server === undefined ? resolve() : server.close(() => resolve()),
  );
  server = undefined;
});

async function silentS3(): Promise<string> {
  server = createServer((socket) => {
    sockets.add(socket);
    socket.on('error', () => undefined);
  });
  await new Promise<void>((resolve) => server?.listen(0, '127.0.0.1', resolve));
  const address = server.address();
  if (address === null || typeof address === 'string') throw new Error('番地が取れない');
  return `http://127.0.0.1:${String(address.port)}`;
}

function storeOf(endpoint: string, idleMs: number): S3AttachmentBlobStore {
  return new S3AttachmentBlobStore(
    {
      bucket: 'b',
      region: 'us-east-1',
      endpoint,
      forcePathStyle: true,
      accessKeyId: 'AKIDEXAMPLE',
      secretAccessKey: 'secret-example',
      prefix: '',
    },
    { timeouts: { connectMs: 1_000, idleMs } },
  );
}

describe('添付の S3 クライアントの期限（#4689）', () => {
  it('既定の期限は、接続 10 秒・無通信 60 秒', () => {
    expect(S3_CONNECT_TIMEOUT_MS).toBe(10_000);
    expect(S3_IDLE_TIMEOUT_MS).toBe(60_000);
  });

  it('⭐ 繋がるが何も返さない相手には、無通信の期限で打ち切って失敗を返す（止まったままにしない）', async () => {
    const store = storeOf(await silentS3(), 200);
    const started = Date.now();
    await expect(store.remove(['a'])).rejects.toBeDefined();
    expect(Date.now() - started).toBeLessThan(4_000);
  }, 10_000);
});

// 頭と本文の一部だけを返し、残りを返さない S3（本文を流している途中で経路が半開きになった相手の代わり）
async function stallingS3(): Promise<string> {
  server = createServer((socket) => {
    sockets.add(socket);
    socket.on('error', () => undefined);
    socket.once('data', () => {
      socket.write(
        'HTTP/1.1 200 OK\r\nContent-Type: application/octet-stream\r\nContent-Length: 100\r\n\r\nabc',
      );
    });
  });
  await new Promise<void>((resolve) => server?.listen(0, '127.0.0.1', resolve));
  const address = server.address();
  if (address === null || typeof address === 'string') throw new Error('番地が取れない');
  return `http://127.0.0.1:${String(address.port)}`;
}

describe('添付の S3 の本文の無通信の期限（#4689）', () => {
  // SDK は 6 秒以上の socketTimeout を 3 秒遅らせて登録し、その前に頭が届くと登録ごと取り消す。
  // だから試験も 6 秒以上で測る（短い期限では SDK の側だけで切れてしまい、穴を再現できない）
  it('⭐ 頭がすぐ届いて本文の途中で止まった相手にも、無通信の期限で打ち切って失敗を返す', async () => {
    const store = storeOf(await stallingS3(), 6_500);
    const body = await store.open('a');
    if (body === undefined) throw new Error('本文が無い');
    const started = Date.now();
    await expect(
      (async () => {
        for await (const chunk of body) void chunk;
      })(),
    ).rejects.toBeDefined();
    expect(Date.now() - started).toBeLessThan(12_000);
  }, 20_000);
});
