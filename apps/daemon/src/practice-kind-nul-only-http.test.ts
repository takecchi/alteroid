import { createMemoryStores, type CloneHost, type Stores } from '@alteroid/core';
import { createFsStores } from '@alteroid/storage-fs';
import { describe, expect, it } from 'vitest';

import { makeTempDir } from '../../../vitest.tmpdir.js';

import { createApp } from './app.js';

function stubCloneHost(): CloneHost {
  return {
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

/**
 * `PUT /practices/:slug` の `kind` が NUL だけのとき。入口の `practiceKindSchema`（min(1)）は通り、
 * ストアが NUL を落とすと空の kind になって `practiceSchema` に弾かれる（ストアは投げる。契約どおり）。
 * その投げが HTTP で 400 にならず 500 になる。
 */
describe.each([
  ['memory', async (): Promise<Stores> => createMemoryStores()],
  ['fs', async (): Promise<Stores> => createFsStores(await makeTempDir('alteroid-test-'))],
] as const)('PUT /practices/:slug の NUL だけの kind（%s）', (_label, makeStores) => {
  it('入力の不備は 5xx ではなく 4xx で断る', async () => {
    const stores = await makeStores();
    const app = createApp({
      clone: stubCloneHost(),
      stores,
      token: 'test-token',
      shutdown: () => undefined,
    });
    const put = await app.request('/practices/nul-kind', {
      method: 'PUT',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ kind: '\u0000', title: '題', content: '本文' }),
    });
    const text = await put.text();
    expect(put.status, `本文: ${text}`).toBeGreaterThanOrEqual(400);
    expect(put.status, `本文: ${text}`).toBeLessThan(500);
  });
});
