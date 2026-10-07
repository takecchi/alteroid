import { createManagerPool, createMemoryStores, createRunnerRegistry } from '@alteroid/core';
import type { CloneHost } from '@alteroid/core';
import { describe, expect, it } from 'vitest';

import { createApp } from './app.js';

const FAKE_SECRET = 'sk-ant-api03-FAKEFAKEFAKEFAKEFAKEFAKEFAKE';

describe('POST /approvals/answer の results[].error（#2509）', () => {
  it('answerApproval が例外で落ちても、2行目以降（偽の鍵）は応答に出ない', async () => {
    const stores = createMemoryStores();
    await stores.jobs.putApproval({
      id: 'ap-1',
      createdAt: '2026-09-02T00:00:00.000Z',
      question: '進めてよいか',
    });
    const clone: CloneHost = {
      postPersisted: async () => 'persisted',
      post: () => {},
      recycleSessionForToken: () => {},
      subscribe: () => () => {},
      async endConversation() {},
      async answerApproval() {
        throw new Error(`Failed query: update approvals set answer = $1\nparams: ${FAKE_SECRET}`);
      },
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
    const app = createApp({ clone, stores, token: 'test-token', shutdown: () => {} });

    const response = await app.request('/approvals/answer', {
      method: 'POST',
      headers: { 'content-type': 'application/json', authorization: 'Bearer test-token' },
      body: JSON.stringify({ answers: [{ id: 'ap-1', answer: 'よい' }] }),
    });

    expect(response.status).toBe(200);
    const text = await response.text();
    expect(text).not.toContain(FAKE_SECRET);
    expect(JSON.parse(text)).toMatchObject({
      results: [{ id: 'ap-1', ok: false, error: expect.stringContaining('Failed query') }],
    });
  });
});
