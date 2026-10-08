import {
  DEFAULT_ATTACHMENT_LIMITS,
  MemoryAttachmentStore,
  fetchManagerOutbox,
  sha256Hex,
} from '@alteroid/core';
import { describe, expect, it } from 'vitest';

import { createHttpRunner } from './runner-client.js';

/**
 * 出し箱の退避先を取りに行く口（Issue #4126 P2b）。`GET` / `DELETE /managers/:id/outbox/:fileId`。
 */

const FILE_ID = 'a'.repeat(32);

function clientWith(respond: (method: string, path: string) => Response | Promise<Response>) {
  const calls: { method: string; path: string }[] = [];
  const client = createHttpRunner({
    baseUrl: 'http://runner.test',
    token: 'tok',
    fetchFn: (async (input: string | URL | Request, init?: RequestInit) => {
      const path = new URL(typeof input === 'string' ? input : input.toString()).pathname;
      if (path === '/health') return Response.json({ runnerId: 'r', workspacePath: '/w' });
      const method = init?.method ?? 'GET';
      calls.push({ method, path });
      return respond(method, path);
    }) as typeof fetch,
  });
  return { client, calls };
}

async function readAll(body: AsyncIterable<Uint8Array>): Promise<string> {
  const chunks: Buffer[] = [];
  for await (const chunk of body) chunks.push(Buffer.from(chunk));
  return Buffer.concat(chunks).toString();
}

describe('HttpRunner#openOutboxFile / deleteOutboxFile', () => {
  it('GET /managers/:id/outbox/:fileId の本文をストリームで返し、content-length を size にする', async () => {
    const { client, calls } = clientWith(
      () =>
        new Response('成果物', {
          headers: { 'content-length': String(Buffer.byteLength('成果物')) },
        }),
    );
    const runner = await client;

    const content = await runner.openOutboxFile?.('mgr 1', FILE_ID);

    expect(calls).toEqual([{ method: 'GET', path: `/managers/mgr%201/outbox/${FILE_ID}` }]);
    expect(content?.size).toBe(Buffer.byteLength('成果物'));
    expect(await readAll(content!.body)).toBe('成果物');
  });

  it('404 は「無い」（undefined）で、500 や接続断は「取れなかった」として投げる', async () => {
    const missing = await clientWith(() => new Response('{}', { status: 404 })).client;
    expect(await missing.openOutboxFile?.('m', FILE_ID)).toBeUndefined();

    const broken = await clientWith(() => new Response('boom', { status: 500 })).client;
    await expect(broken.openOutboxFile?.('m', FILE_ID)).rejects.toThrow('500');
  });

  it('DELETE /managers/:id/outbox/:fileId を叩く。失敗は投げる（握るのは呼び手）', async () => {
    const ok = clientWith(() => new Response(null, { status: 204 }));
    await (await ok.client).deleteOutboxFile?.('m', FILE_ID);
    expect(ok.calls).toEqual([{ method: 'DELETE', path: `/managers/m/outbox/${FILE_ID}` }]);

    const bad = await clientWith(() => new Response('{}', { status: 400 })).client;
    await expect(bad.deleteOutboxFile?.('m', FILE_ID)).rejects.toThrow('400');
  });

  it('runner が申告より多く送り続けても、取り出しは途中で打ち切り、runner の繋ぎも畳む', async () => {
    let pulled = 0;
    let cancelled = false;
    const endless = new ReadableStream<Uint8Array>({
      pull(controller) {
        pulled += 1;
        controller.enqueue(new TextEncoder().encode('xxxx'));
      },
      cancel() {
        cancelled = true;
      },
    });
    const { client } = clientWith(
      () => new Response(endless, { headers: { 'content-length': '4' } }),
    );
    const runner = await client;
    const store = new MemoryAttachmentStore();

    const result = await fetchManagerOutbox({
      runner,
      runnerNamesOutbox: true,
      managerId: 'm',
      reportId: 'r1',
      files: [
        {
          fileId: FILE_ID,
          name: 'big.txt',
          mediaType: 'text/plain',
          size: 4,
          sha256: sha256Hex(new TextEncoder().encode('1234')),
        },
      ],
      rejectedFiles: [],
      store,
      limits: DEFAULT_ATTACHMENT_LIMITS,
    });

    expect(result.attachments).toEqual([]);
    expect(result.rejected[0]?.reason).toContain('途中で打ち切った');
    expect(pulled).toBeLessThan(20);
    await new Promise<void>((resolve) => setImmediate(resolve));
    expect(cancelled).toBe(true);
  });
});
