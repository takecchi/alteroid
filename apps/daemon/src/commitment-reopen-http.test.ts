import {
  createManagerPool,
  createMemoryStores,
  createRunnerRegistry,
  UnreadableCommitmentError,
} from '@alteroid/core';
import type { CloneHost, Stores } from '@alteroid/core';
import { describe, expect, it } from 'vitest';

import { createApp } from './app.js';

// POST /commitments/:id/reopen（#5176）。開き直す前の閉じた記録は行から消えるので、日誌へ逐語で残ることを測る

const AT = '2026-10-19T00:00:00.000Z';
const CLOSED_AT = '2026-10-19T01:00:00.000Z';

function setup(stores: Stores = createMemoryStores()) {
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
  const app = createApp({ clone, stores, token: 'test-token', shutdown: () => {} });
  const call = (method: string, path: string, body?: unknown) =>
    app.request(path, {
      method,
      headers: { 'content-type': 'application/json', authorization: 'Bearer test-token' },
      ...(body === undefined ? {} : { body: JSON.stringify(body) }),
    });
  return { stores, call };
}

async function openAndClose(stores: Stores) {
  await stores.commitments.open({
    id: 'c-1',
    at: AT,
    origin: 'manager',
    source: 'mgr-1',
    body: '元の本文',
    autoCloseWhenBack: { managerId: 'mgr-1' },
  });
  await stores.commitments.close('c-1', CLOSED_AT, '器が自動で閉じた', 'daemon');
}

describe('POST /commitments/:id/reopen', () => {
  it('閉じた行を未了へ戻して 200 で返し、閉じた記録を日誌へ逐語で残す', async () => {
    const { stores, call } = setup();
    await openAndClose(stores);

    const response = await call('POST', '/commitments/c-1/reopen', {
      reason: 'まだ終わっていない',
    });

    expect(response.status).toBe(200);
    const row = (await response.json()) as Record<string, unknown>;
    expect(row).toMatchObject({ id: 'c-1', at: AT, origin: 'manager', body: '元の本文' });
    expect(row.closedAt).toBeUndefined();
    expect(row.autoCloseWhenBack).toBeUndefined();
    expect((await stores.commitments.list()).entries.map((entry) => entry.id)).toEqual(['c-1']);

    const journal = JSON.stringify(await stores.journal.list({ types: ['decision'] }));
    expect(journal).toContain('まだ終わっていない');
    expect(journal).toContain('人間が直接 API から開き直した');
    expect(journal).toContain(`closedAt=${CLOSED_AT}`);
    expect(journal).toContain('closedBy=daemon');
    expect(journal).toContain('closedReason=器が自動で閉じた');
  });

  it('無い id は 404', async () => {
    const { call } = setup();
    const response = await call('POST', '/commitments/nope/reopen', { reason: '戻す' });
    expect(response.status).toBe(404);
  });

  it('同じ担当・同じ本文の未了の行が在れば 409 で、その id を言い、閉じたまま日誌にも残さない', async () => {
    const { stores, call } = setup();
    const base = { at: AT, origin: 'manager', source: 'mgr-1', body: '同じ本文' } as const;
    await stores.commitments.open({ ...base, id: 'old' });
    await stores.commitments.close('old', CLOSED_AT, '片付けた', 'clone');
    await stores.commitments.open({ ...base, id: 'new' });

    const response = await call('POST', '/commitments/old/reopen', { reason: '戻す' });

    expect(response.status).toBe(409);
    expect(((await response.json()) as { error: string }).error).toContain('new');
    expect((await stores.commitments.get('old'))?.closedAt).toBe(CLOSED_AT);
    expect(JSON.stringify(await stores.journal.list({ types: ['decision'] }))).not.toContain(
      '開き直した',
    );
  });

  it('開き直した後に行が読めなくなっても 500 にせず、開き直しは効いていると言う', async () => {
    const base = createMemoryStores();
    const stores: Stores = {
      ...base,
      commitments: {
        ...base.commitments,
        get: async (id) => {
          throw new UnreadableCommitmentError(`${id} は読めない形で入っている`);
        },
      },
    };
    const { call } = setup(stores);
    await openAndClose(stores);

    const response = await call('POST', '/commitments/c-1/reopen', { reason: '戻す' });

    expect(response.status).toBe(409);
    expect(((await response.json()) as { error: string }).error).toContain('開き直した');
  });

  it('未了の行は 409 で、日誌にも残さない', async () => {
    const { stores, call } = setup();
    await stores.commitments.open({ id: 'c-1', at: AT, origin: 'human', body: '本文' });

    const response = await call('POST', '/commitments/c-1/reopen', { reason: '戻す' });

    expect(response.status).toBe(409);
    expect(((await response.json()) as { error: string }).error).toContain('閉じていない');
    expect(JSON.stringify(await stores.journal.list({ types: ['decision'] }))).not.toContain(
      '開き直した',
    );
  });

  it.each([{}, { reason: '' }, { reason: '   ' }])(
    'reason が %j なら 400 で、開き直さない',
    async (body) => {
      const { stores, call } = setup();
      await openAndClose(stores);

      const response = await call('POST', '/commitments/c-1/reopen', body);

      expect(response.status).toBe(400);
      expect((await stores.commitments.get('c-1'))?.closedAt).toBe(CLOSED_AT);
    },
  );

  it('読めない行は 409 で、書き直さないと言う', async () => {
    const base = createMemoryStores();
    const stores: Stores = {
      ...base,
      commitments: {
        ...base.commitments,
        reopen: async (id) => {
          throw new UnreadableCommitmentError(`${id} は読めない形で入っている`);
        },
      },
    };
    const { call } = setup(stores);

    const response = await call('POST', '/commitments/c-1/reopen', { reason: '戻す' });

    expect(response.status).toBe(409);
    expect(((await response.json()) as { error: string }).error).toContain('書き直さない');
  });
});
