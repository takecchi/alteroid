import { describe, expect, it } from 'vitest';

import { createHttpRunner } from './runner-client.js';

const REQUEST = {
  remote: 'https://github.com/o/r.git',
  ref: 'refs/alteroid-rescue/m/root-1234abcd',
  commit: 'a'.repeat(40),
};

function clientWith(respond: (path: string, init: RequestInit | undefined) => Response) {
  return createHttpRunner({
    baseUrl: 'http://runner.test',
    token: 'tok',
    fetchFn: (async (input: string | URL | Request, init?: RequestInit) => {
      const path = new URL(typeof input === 'string' ? input : input.toString()).pathname;
      if (path === '/health') return Response.json({ runnerId: 'r', workspacePath: '/w' });
      return respond(path, init);
    }) as typeof fetch,
  });
}

describe('HttpRunner#deleteRescueRef', () => {
  it('所在を POST /rescue-refs/delete へ運び、runner の結果をそのまま返す', async () => {
    let seen: { path: string; body: unknown } | undefined;
    const client = await clientWith((path, init) => {
      seen = { path, body: JSON.parse(String(init?.body)) };
      return Response.json({ outcome: 'removed', alreadyGone: true });
    });
    expect(await client.deleteRescueRef?.(REQUEST)).toEqual({
      outcome: 'removed',
      alreadyGone: true,
    });
    expect(seen).toEqual({ path: '/rescue-refs/delete', body: REQUEST });
  });

  it('runner の分類（moved など）を保つ', async () => {
    const client = await clientWith(() => Response.json({ outcome: 'failed', kind: 'moved' }));
    expect(await client.deleteRescueRef?.(REQUEST)).toEqual({ outcome: 'failed', kind: 'moved' });
  });

  it('非2xx（古い runner の 404 など）・読めない応答は failed に倒す。消えたとは言わない', async () => {
    const notFound = await clientWith(() => new Response('nope', { status: 404 }));
    expect(await notFound.deleteRescueRef?.(REQUEST)).toEqual({ outcome: 'failed', kind: 'other' });
    const garbage = await clientWith(() => Response.json({ ok: true }));
    expect(await garbage.deleteRescueRef?.(REQUEST)).toEqual({ outcome: 'failed', kind: 'other' });
  });
});
