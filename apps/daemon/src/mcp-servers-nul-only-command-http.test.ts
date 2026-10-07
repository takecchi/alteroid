import { createMemoryStores, type CloneHost, type Stores } from '@alteroid/core';
import { createFsStores } from '@alteroid/storage-fs';
import { describe, expect, it } from 'vitest';

import { makeTempDir } from '../../../vitest.tmpdir.js';

import { createApp } from './app.js';

function stubCloneHost(): CloneHost {
  return {
    postPersisted: async () => 'persisted',
    post: () => undefined,
    dropQueuedInboxEvents: async () => 0,
    subscribe: () => () => undefined,
    endConversation: async () => undefined,
    answerApproval: async () => undefined,
    managers: {} as CloneHost['managers'],
    usageBlocked: false,
    usageReleasePending: false,
    usageBlockedResetsAt: undefined,
    usageBlockedTokenId: undefined,
    recycleSessionForToken: () => undefined,
    stop: async () => undefined,
  };
}

describe.each([
  ['memory', async (): Promise<Stores> => createMemoryStores()],
  ['fs', async (): Promise<Stores> => createFsStores(await makeTempDir('alteroid-test-'))],
] as const)('PUT /mcp-servers の NUL だけの command（%s）', (_label, makeStores) => {
  it('入力の不備は 5xx ではなく 4xx で断る', async () => {
    const stores = await makeStores();
    const app = createApp({
      clone: stubCloneHost(),
      stores,
      token: 'test-token',
      shutdown: () => undefined,
    });
    const put = await app.request('/mcp-servers', {
      method: 'PUT',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ mcpServers: { srv: { command: '\u0000' } } }),
    });
    const text = await put.text();
    expect(put.status, `本文: ${text}`).toBeGreaterThanOrEqual(400);
    expect(put.status, `本文: ${text}`).toBeLessThan(500);
    expect(await stores.mcpServers.read(), '保存されていない').toBeNull();
  });
});

describe.each([
  ['memory', async (): Promise<Stores> => createMemoryStores()],
  ['fs', async (): Promise<Stores> => createFsStores(await makeTempDir('alteroid-test-'))],
] as const)('PUT /mcp-servers の NUL だけの url・command（%s）', (_label, makeStores) => {
  it.each([
    { label: 'http の url', config: { type: 'http', url: '\u0000' } },
    { label: 'sse の url', config: { type: 'sse', url: '\u0000' } },
    { label: 'stdio の command', config: { command: '\u0000' } },
  ])('$label が NUL だけなら 400 で、保存せず日誌も積まない', async ({ config }) => {
    const stores = await makeStores();
    const app = createApp({
      clone: stubCloneHost(),
      stores,
      token: 'test-token',
      shutdown: () => undefined,
    });
    const journalBefore = (await stores.journal.list()).length;
    const put = await app.request('/mcp-servers', {
      method: 'PUT',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ mcpServers: { srv: config } }),
    });
    const text = await put.text();
    expect(put.status, `本文: ${text}`).toBe(400);
    expect(text).not.toContain('\u0000');
    expect(await stores.mcpServers.read(), '保存されていない').toBeNull();
    expect((await stores.journal.list()).length, '日誌に何も積まない').toBe(journalBefore);
  });

  it('NUL を含んでも落とした後に残る command は、今までどおり落として保存できる', async () => {
    const stores = await makeStores();
    const app = createApp({
      clone: stubCloneHost(),
      stores,
      token: 'test-token',
      shutdown: () => undefined,
    });
    const put = await app.request('/mcp-servers', {
      method: 'PUT',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ mcpServers: { srv: { command: 'np\u0000x' } } }),
    });
    expect(put.status).toBe(200);
    expect((await stores.mcpServers.read())?.mcpServers.srv).toEqual({ command: 'npx' });
  });
});
