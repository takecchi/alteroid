import {
  createManagerPool,
  createMemoryStores,
  createRunnerRegistry,
  fakeCloneHost,
} from '@alteroid/core';
import { describe, expect, it } from 'vitest';

import { createApp } from './app.js';

function setup() {
  const stores = createMemoryStores();
  const clone = fakeCloneHost({
    managers: createManagerPool({ stores, post: () => {}, runners: createRunnerRegistry() }),
  });
  return { stores, app: createApp({ clone, stores, token: 'test-token', shutdown: () => {} }) };
}

function post(app: ReturnType<typeof setup>['app'], expression: string) {
  return app.request('/schedule', {
    method: 'POST',
    headers: { 'content-type': 'application/json', authorization: 'Bearer test-token' },
    body: JSON.stringify({
      kind: 'five-only',
      request: '確認する',
      spec: { type: 'cron', expression },
    }),
  });
}

describe('POST /schedule の cron は5欄だけ', () => {
  it.each(['*/5 * * * * *', '0 0 10 * * 1', '0 10 * * 1 *', '0 0 10 * * 1 2030'])(
    '6欄・7欄の「%s」は 400 で断り、何も仕込まない',
    async (expression) => {
      const { stores, app } = setup();
      const response = await post(app, expression);
      expect(response.status).toBe(400);
      expect(await stores.schedules.list()).toEqual({ entries: [], unreadable: [] });
    },
  );

  it('5欄は仕込む', async () => {
    const { stores, app } = setup();
    expect((await post(app, '0 10 * * 1')).status).toBe(200);
    expect((await stores.schedules.list()).entries).toMatchObject([
      { spec: { type: 'cron', expression: '0 10 * * 1' } },
    ]);
  });
});
