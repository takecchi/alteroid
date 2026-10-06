import { createMemoryStores, createScheduler } from '@alteroid/core';
import type { CloneHost, Scheduler } from '@alteroid/core';
import { describe, expect, it } from 'vitest';

import { createApp } from './app.js';

/**
 * `POST /schedule` は `every` の分数に上限を課さず、`minutes: 1e15` を 200 で保存した（#3533）。保存された行は
 * スケジューラの次の予定を Invalid Date にし、`GET /schedule`（`scheduler.list()`）が 500 になる
 * （`toISOString()` が `RangeError: Invalid time value`）。同時に、スケジューラは1ms 周期で `timer` を
 * 積み続ける（core の `schedule-huge-every.test.ts`）。
 *
 * 人間の決定（2026-10-06）で、上限（1年 = 525600 分）を超える値は入口（`scheduleBody` の `scheduleSpecSchema`）で
 * 400 にする。
 */
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

const headers = { 'content-type': 'application/json', authorization: 'Bearer test-token' };

describe('POST /schedule の every の上限（1年 = 525600 分、#3533）', () => {
  async function post(minutes: number) {
    const stores = createMemoryStores();
    const scheduler: Scheduler = createScheduler({
      entries: [],
      post: () => undefined,
      schedules: stores.schedules,
    });
    const app = createApp({
      clone: stubCloneHost(),
      stores,
      token: 'test-token',
      shutdown: () => undefined,
      scheduler,
    });
    const res = await app.request('/schedule', {
      method: 'POST',
      headers,
      body: JSON.stringify({
        kind: 'huge',
        request: '確認する',
        spec: { type: 'every', minutes },
      }),
    });
    return { app, stores, res };
  }

  it.each([525_601, 1e15])(
    'minutes: %s は 400 で断り、何も保存せず、GET /schedule は 200',
    async (minutes) => {
      const { app, stores, res } = await post(minutes);
      expect(res.status).toBe(400);
      const body = (await res.json()) as { error: string };
      expect(body.error).toContain('spec.minutes');
      expect(body.error).toContain('525600');
      expect(body.error).toContain('cron');
      expect(body.error).toContain('単発');
      expect(body.error).not.toContain(String(minutes));
      expect((await stores.schedules.list()).entries).toEqual([]);
      expect((await app.request('/schedule', { headers })).status).toBe(200);
    },
  );

  it('minutes: 525600 は通り、GET /schedule に載る', async () => {
    const { app, res } = await post(525_600);
    expect(res.status).toBe(200);
    expect((await app.request('/schedule', { headers })).status).toBe(200);
  });
});
