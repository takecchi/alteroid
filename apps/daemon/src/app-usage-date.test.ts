import {
  createManagerPool,
  createMemoryStores,
  createRunnerRegistry,
  usageDate,
} from '@alteroid/core';
import type { CloneHost, Stores } from '@alteroid/core';
import { afterEach, describe, expect, it } from 'vitest';

import { createApp } from './app.js';

function fakeCloneHost(stores: Stores): CloneHost {
  return {
    postPersisted: async () => 'persisted',
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

function appWith(now?: () => Date): ReturnType<typeof createApp> {
  const stores = createMemoryStores();
  return createApp({
    clone: fakeCloneHost(stores),
    stores,
    token: 'test-token',
    shutdown: () => {},
    ...(now === undefined ? {} : { now }),
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

describe('GET /usage の today は、台帳の日と同じ関数・同じ TZ の値（Issue #2268）', () => {
  const originalTz = process.env['TZ'];
  afterEach(() => {
    if (originalTz === undefined) delete process.env['TZ'];
    else process.env['TZ'] = originalTz;
  });

  const instant = new Date('2026-09-30T00:30:00Z');
  const cases = [
    ['UTC', '2026-09-30'],
    ['Asia/Tokyo', '2026-09-30'],
    ['America/Los_Angeles', '2026-09-29'],
  ] as const;
  for (const [tz, expected] of cases) {
    it(`TZ=${tz} で、注入した時計 ${instant.toISOString()} の today は ${expected}`, async () => {
      process.env['TZ'] = tz;
      const app = appWith(() => instant);
      const res = await app.request('/usage');
      expect(res.status).toBe(200);
      const body = (await res.json()) as { today: string };
      expect(body.today).toBe(expected);
      expect(body.today).toBe(usageDate(instant));
    });
  }
});
