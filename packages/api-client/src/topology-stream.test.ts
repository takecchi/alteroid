import { describe, expect, it } from 'vitest';

import { createAlteroidClient } from './index.js';

describe('topologyStream', () => {
  it('/topology/stream を叩き、snapshot と unavailable を event 名つきで返す。heartbeat は届かない', async () => {
    const urls: string[] = [];
    const body =
      ': heartbeat\n\n' +
      'event: snapshot\ndata: {"observedAt":"2026-10-04T00:00:00.000Z"}\n\n' +
      ': heartbeat\n\n' +
      'event: unavailable\ndata: {"error":"ECONNREFUSED"}\n\n';
    const client = createAlteroidClient({
      baseUrl: 'http://127.0.0.1:1',
      fetch: (request) => {
        urls.push(request.url);
        return Promise.resolve(new Response(body, { status: 200 }));
      },
    });

    const seen: { event: string; data: unknown }[] = [];
    for await (const message of client.topologyStream()) seen.push(message);

    expect(urls).toEqual(['http://127.0.0.1:1/topology/stream']);
    expect(seen).toEqual([
      { event: 'snapshot', data: { observedAt: '2026-10-04T00:00:00.000Z' } },
      { event: 'unavailable', data: { error: 'ECONNREFUSED' } },
    ]);
  });

  it('ok でない応答は投げる（黙って空のストリームにしない）', async () => {
    const client = createAlteroidClient({
      baseUrl: 'http://127.0.0.1:1',
      fetch: () => Promise.resolve(new Response('nope', { status: 503 })),
    });
    await expect(client.topologyStream().next()).rejects.toThrow('/topology/stream が 503');
  });
});
