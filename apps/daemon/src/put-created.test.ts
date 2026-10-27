import type { CloneHost, Stores } from '@alteroid/core';
import { createMemoryStores, memoryVersion } from '@alteroid/core';
import { beforeEach, describe, expect, it } from 'vitest';

import { createApp } from './app.js';

// 人間側の PUT も、クローンの道具（memory_write・practice_write）と同じく新規作成と置換を応答で言い分ける（#5379）。
// slug を打ち間違えた PUT が、既存の更新と同じ 200 に紛れないようにするため。

const JSON_HEADERS = { 'content-type': 'application/json' };

let stores: Stores;

function fakeClone(): CloneHost {
  return {
    post: () => 'conversation-1',
    subscribe: () => () => undefined,
    stop: () => Promise.resolve(),
    usageBlocked: false,
    managers: { list: () => Promise.resolve([]) },
  } as unknown as CloneHost;
}

async function put(path: string, body: unknown): Promise<Response> {
  return createApp({
    clone: fakeClone(),
    stores,
    token: 'test-token',
    shutdown: () => undefined,
  }).request(path, { method: 'PUT', headers: JSON_HEADERS, body: JSON.stringify(body) });
}

beforeEach(() => {
  stores = createMemoryStores();
});

describe('PUT /memory/:slug の created', () => {
  it('無い slug への PUT は created: true', async () => {
    const res = await put('/memory/typo-slug', { content: '本文\n' });
    expect(res.status).toBe(200);
    const body = (await res.json()) as { created?: boolean; version?: string };
    expect(body.created).toBe(true);
    expect(body.version).toBe(memoryVersion('本文\n'));
  });

  it('在る slug への PUT は created: false', async () => {
    await stores.persona.write('m1', '旧\n');
    const res = await put('/memory/m1', { content: '新\n' });
    expect(res.status).toBe(200);
    expect(((await res.json()) as { created?: boolean }).created).toBe(false);
  });

  it('ifMatch: null（無いときだけ作る）で作った回も created: true', async () => {
    const res = await put('/memory/fresh', { content: '本文\n', ifMatch: null });
    expect(res.status).toBe(200);
    expect(((await res.json()) as { created?: boolean }).created).toBe(true);
  });
});

describe('PUT /practices/:slug の created', () => {
  it('無い slug への PUT は created: true', async () => {
    const res = await put('/practices/typo-slug', { kind: 'k', title: '題', content: '本文' });
    expect(res.status).toBe(200);
    expect(((await res.json()) as { created?: boolean }).created).toBe(true);
  });

  it('在る slug への PUT は created: false', async () => {
    await stores.practices.write({ slug: 'p1', kind: 'k', title: '題', content: '旧' });
    const res = await put('/practices/p1', { kind: 'k', title: '新題', content: '新' });
    expect(res.status).toBe(200);
    expect(((await res.json()) as { created?: boolean }).created).toBe(false);
  });
});
