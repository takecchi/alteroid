import { createManagerPool, createMemoryStores, createRunnerRegistry } from '@alteroid/core';
import type { CloneHost } from '@alteroid/core';
import { describe, expect, it } from 'vitest';

import { createApp } from './app.js';

function setup() {
  const stores = createMemoryStores();
  const clone: CloneHost = {
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
  return createApp({ clone, stores, token: 'test-token', shutdown: () => {} });
}

async function post(app: ReturnType<typeof setup>, path: string, body: unknown) {
  return app.request(path, {
    method: 'POST',
    headers: { 'content-type': 'application/json', authorization: 'Bearer test-token' },
    body: JSON.stringify(body),
  });
}

describe('一括削除の before の読み（存在しない日付・時差なしを断る）', () => {
  it.each([
    ['存在しない日付', '2026-02-31T00:00:00Z'],
    ['時差が無い', '2026-10-06T00:00:00'],
  ])('POST /inbox/remove は %s の before を 400 で断る', async (_label, before) => {
    const app = setup();
    const response = await post(app, '/inbox/remove', {
      types: ['manager_message'],
      before,
      reason: '古い合図の整理',
    });
    expect(response.status).toBe(400);
  });

  it.each([
    ['存在しない日付', '2026-02-31T00:00:00Z'],
    ['時差が無い', '2026-10-06T00:00:00'],
  ])('POST /archive/remove は %s の before を 400 で断る', async (_label, before) => {
    const app = setup();
    const response = await post(app, '/archive/remove', { before, reason: '古い退避の整理' });
    expect(response.status).toBe(400);
  });
});

describe('一括削除の before は時差つきの時刻だけ（#3390）', () => {
  const REFUSED = [
    '2026-10-06T00:00:00',
    '2026-10-06T00:00',
    '2026-10-06',
    '2026-10-06 00:00:00Z',
    '2026-10-06T00:00:00+0900',
    '2026-02-31T00:00:00+09:00',
    'foo 1',
  ];
  const ACCEPTED = ['2026-10-06T00:00:00Z', '2026-10-06T00:00Z', '2026-10-06T09:00:00.000+09:00'];

  it.each(REFUSED)('POST /inbox/remove は「%s」を、道具と同じ文言の 400 で断る', async (before) => {
    const app = setup();
    const response = await post(app, '/inbox/remove', {
      types: ['manager_message'],
      before,
      reason: '古い合図の整理',
      dryRun: false,
    });
    expect(response.status).toBe(400);
    const { error } = (await response.json()) as { error: string };
    expect(error).toContain(`before に渡された「${before}」は日時として読めない、または時差が無い`);
    expect(error).toContain('時差 Z か +09:00 を必ず書くこと');
    expect(error).toContain('1件も消していない');
  });

  it.each(REFUSED)(
    'POST /archive/remove は「%s」を、道具と同じ文言の 400 で断る',
    async (before) => {
      const app = setup();
      const response = await post(app, '/archive/remove', {
        before,
        reason: '古い退避の整理',
        dryRun: false,
      });
      expect(response.status).toBe(400);
      const { error } = (await response.json()) as { error: string };
      expect(error).toContain(
        `before に渡された「${before}」は日時として読めない、または時差が無い`,
      );
      expect(error).toContain('時差 Z か +09:00 を必ず書くこと');
      expect(error).toContain('1件も消していない');
    },
  );

  it.each(ACCEPTED)('POST /inbox/remove は時差つきの「%s」を通す（試算）', async (before) => {
    const app = setup();
    const response = await post(app, '/inbox/remove', {
      types: ['manager_message'],
      before,
      reason: '古い合図の整理',
    });
    expect(response.status).toBe(200);
  });

  it.each(ACCEPTED)('POST /archive/remove は時差つきの「%s」を通す（試算）', async (before) => {
    const app = setup();
    const response = await post(app, '/archive/remove', { before, reason: '古い退避の整理' });
    expect(response.status).toBe(200);
  });
});
