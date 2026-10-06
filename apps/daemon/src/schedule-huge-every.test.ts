import { createMemoryStores, createScheduler } from '@alteroid/core';
import type { CloneHost, Scheduler } from '@alteroid/core';
import { describe, expect, it } from 'vitest';

import { createApp } from './app.js';

/**
 * `POST /schedule` は `every` の分数に上限を課さず、`minutes: 1e15` を 200 で保存する。保存された行は
 * スケジューラの次の予定を Invalid Date にし、`GET /schedule`（`scheduler.list()`）が 500 になる
 * （`toISOString()` が `RangeError: Invalid time value`）。同時に、スケジューラは1ms 周期で `timer` を
 * 積み続ける（core の `schedule-huge-every.test.ts`）。
 *
 * 直し方は2通りありうる（入口で断る／スケジューラが範囲外を扱う）ので、ここは「保存を受けたなら
 * 一覧が読める」「読めなくなる値は最初から断る」のどちらでも緑になる形で書く。
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

describe('POST /schedule の every が巨大でも、定期ジョブの一覧は読める', () => {
  it('minutes: 1e15 を仕込んだ後の GET /schedule が 500 にならない（断るなら 4xx で何も保存しない）', async () => {
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
    scheduler.start();
    try {
      const created = await app.request('/schedule', {
        method: 'POST',
        headers,
        body: JSON.stringify({
          kind: 'huge',
          request: '確認する',
          spec: { type: 'every', minutes: 1e15 },
        }),
      });

      if (created.status >= 400 && created.status < 500) {
        expect((await stores.schedules.list()).entries).toEqual([]);
      } else {
        expect(created.status).toBe(200);
      }
      const listed = await app.request('/schedule', { headers });
      expect(listed.status).toBe(200);
    } finally {
      scheduler.stop();
    }
  });
});
