import { describe, expect, it } from 'vitest';

import { createHttpRunner } from './runner-client.js';

// 鍵の付け替えのための畳みの印（keepPeers）を、DELETE のクエリで運ぶ（#4734）
describe('HttpRunner.stop の keepPeers（#4734）', () => {
  async function runnerRecording(urls: string[]) {
    const fetchFn = (async (input: string | URL | Request, init?: RequestInit) => {
      const url = typeof input === 'string' ? input : input.toString();
      if (url.endsWith('/health')) {
        return new Response(JSON.stringify({ runnerId: 'runner-a' }), {
          headers: { 'content-type': 'application/json' },
        });
      }
      urls.push(`${init?.method ?? 'GET'} ${new URL(url).pathname}${new URL(url).search}`);
      return new Response(JSON.stringify({ ok: true }), {
        headers: { 'content-type': 'application/json' },
      });
    }) as typeof fetch;
    return createHttpRunner({ baseUrl: 'http://runner.test', token: 'token', fetchFn });
  }

  it('⭐ keepPeers なら ?keepPeers=1 を付けて DELETE する', async () => {
    const urls: string[] = [];
    const runner = await runnerRecording(urls);
    await runner.stop('mgr-1', { keepPeers: true });
    expect(urls).toEqual(['DELETE /managers/mgr-1?keepPeers=1']);
  });

  it('印が無ければ今どおりクエリを付けない', async () => {
    const urls: string[] = [];
    const runner = await runnerRecording(urls);
    await runner.stop('mgr-1');
    expect(urls).toEqual(['DELETE /managers/mgr-1']);
  });
});
