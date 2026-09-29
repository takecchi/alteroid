import { createManagerPool, createMemoryStores, createRunnerRegistry } from '@alteroid/core';
import type { CloneHost, Stores } from '@alteroid/core';
import { describe, expect, it } from 'vitest';

import { createApp } from './app.js';

/**
 * `GET /usage` の `from` / `to` が、暦の上に実在しない日を 400 で断る（Issue #2156）。
 *
 * **`app.test.ts` には置かない。** 測っているのは `usageDateSchema`（core）の判定が `GET /usage`
 * の問いの検査にそのまま効くことで、ほかのルートの応答とは観点が違う。
 *
 * 直す前は、`usageDateSchema` が形（`YYYY-MM-DD`）だけを見ていて、`2026-02-30` も通した。
 * 集計は日付を文字列の大小で比べるだけなので、例外にならず、黙って「その文字列までの範囲」と
 * して絞っていた。
 */
function fakeCloneHost(stores: Stores): CloneHost {
  return {
    post: () => {},
    recycleSessionForToken: () => {},
    subscribe: () => () => {},
    async endConversation() {},
    async answerApproval() {},
    async dropQueuedInboxEvents() {
      return 0;
    },
    managers: createManagerPool({ stores, post: () => {}, runners: createRunnerRegistry() }),
    usageBlocked: false,
    usageReleasePending: false,
    usageBlockedResetsAt: undefined,
    usageBlockedTokenId: undefined,
    async stop() {},
  };
}

function appWith(): ReturnType<typeof createApp> {
  const stores = createMemoryStores();
  return createApp({
    clone: fakeCloneHost(stores),
    stores,
    token: 'test-token',
    shutdown: () => {},
  });
}

describe('GET /usage の from / to は、実在しない日を 400 で断る（Issue #2156）', () => {
  const unreal = ['2026-02-30', '2026-13-01', '2026-00-00', '2026-04-31', '2025-02-29'] as const;
  for (const date of unreal) {
    it(`from=${date} は 400`, async () => {
      const app = appWith();
      expect((await app.request(`/usage?from=${date}`)).status).toBe(400);
    });
    it(`to=${date} は 400`, async () => {
      const app = appWith();
      expect((await app.request(`/usage?to=${date}`)).status).toBe(400);
    });
  }

  it('形の合わない値も、いまどおり 400', async () => {
    const app = appWith();
    expect((await app.request('/usage?from=2026-8-1')).status).toBe(400);
    expect((await app.request('/usage?to=yesterday')).status).toBe(400);
  });

  it('実在する日（閏年の 2/29 を含む）は通す', async () => {
    const app = appWith();
    expect((await app.request('/usage?from=2024-02-29&to=2026-08-31')).status).toBe(200);
    expect((await app.request('/usage?from=2026-12-31')).status).toBe(200);
  });
});
