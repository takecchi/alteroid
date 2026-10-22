import { describe, expect, it } from 'vitest';

import { createHttpRunner } from './runner-client.js';

function clientWith(respond: (url: URL) => Response | Promise<Response>) {
  const urls: string[] = [];
  const client = createHttpRunner({
    baseUrl: 'http://runner.test',
    token: 'tok',
    fetchFn: (async (input: string | URL | Request) => {
      const url = new URL(typeof input === 'string' ? input : input.toString());
      if (url.pathname === '/health') return Response.json({ runnerId: 'r', workspacePath: '/w' });
      urls.push(`${url.pathname}${url.search}`);
      return respond(url);
    }) as typeof fetch,
  });
  return { client, urls };
}

describe('HttpRunner#transcriptTail（#5160）', () => {
  it('GET /managers/:id/transcript/tail?maxChars=N の本文を返す', async () => {
    const { client, urls } = clientWith(() => new Response('末尾の本文'));
    const runner = await client;

    expect(await runner.transcriptTail?.('mgr 1', 200_000)).toBe('末尾の本文');
    expect(urls).toEqual(['/managers/mgr%201/transcript/tail?maxChars=200000']);
  });

  it('404 は null、ほかの失敗（500・接続断）も transcript() と同じく null', async () => {
    const missing = await clientWith(() => new Response('{}', { status: 404 })).client;
    expect(await missing.transcriptTail?.('m', 10)).toBeNull();

    const broken = await clientWith(() => new Response('boom', { status: 500 })).client;
    expect(await broken.transcriptTail?.('m', 10)).toBeNull();

    const down = await clientWith(() => {
      throw new Error('接続断');
    }).client;
    expect(await down.transcriptTail?.('m', 10)).toBeNull();
    expect(await down.transcript('m')).toBeNull();
  });
});
