import { createManagerPool, createMemoryStores, createRunnerRegistry } from '@alteroid/core';
import type { CloneHost, Stores } from '@alteroid/core';
import { describe, expect, it } from 'vitest';

import { createApp } from './app.js';

// PATCH /commitments/:id（#5242）。編集前の本文は日誌にしか残らないので、日誌を先に書くことを測る

const AT = '2026-10-19T00:00:00.000Z';
const CLOSED_AT = '2026-10-19T01:00:00.000Z';
const RETRACTED = '直前の本文編集の行は効いていない（本文は直していない）';

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
  const patch = (path: string, body: unknown) =>
    app.request(path, {
      method: 'PATCH',
      headers: { 'content-type': 'application/json', authorization: 'Bearer test-token' },
      body: JSON.stringify(body),
    });
  return { stores, patch };
}

async function openHuman(stores: Stores) {
  await stores.commitments.open({ id: 'c-1', at: AT, origin: 'human', body: '元の本文' });
}

async function decisions(stores: Stores): Promise<string> {
  return JSON.stringify(await stores.journal.list({ types: ['decision'] }));
}

describe('PATCH /commitments/:id は日誌を先に書く', () => {
  it('日誌に書けないときは 500 で、書き直さず、本文は元のまま', async () => {
    const base = createMemoryStores();
    const stores: Stores = {
      ...base,
      journal: {
        ...base.journal,
        append: async () => {
          throw new Error('journal down');
        },
      },
    };
    const { patch } = setup(stores);
    await openHuman(stores);

    const response = await patch('/commitments/c-1', { body: '直した本文' });

    expect(response.status).toBe(500);
    expect(((await response.json()) as { code: string }).code).toBe('journal_write_failed');
    const row = await stores.commitments.get('c-1');
    expect(row?.body).toBe('元の本文');
    expect(row?.editedAt).toBeUndefined();
  });

  it('書き直す瞬間には、編集前後の本文を持つ先の行が日誌に既に在る', async () => {
    const base = createMemoryStores();
    const seen: string[] = [];
    const stores: Stores = {
      ...base,
      commitments: {
        ...base.commitments,
        editBody: async (...args) => {
          seen.push(await decisions(base));
          return base.commitments.editBody(...args);
        },
      },
    };
    const { patch } = setup(stores);
    await openHuman(stores);

    const response = await patch('/commitments/c-1', { body: '直した本文' });

    expect(response.status).toBe(200);
    expect(seen).toHaveLength(1);
    expect(seen[0]).toContain('編集前「元の本文」→ 編集後「直した本文」');
  });

  it('日誌を書いた後に閉じられたら、打ち消しの行を足して 409 を返し、本文は元のまま', async () => {
    const base = createMemoryStores();
    const stores: Stores = {
      ...base,
      commitments: {
        ...base.commitments,
        editBody: async (...args) => {
          await base.commitments.close('c-1', CLOSED_AT, '割り込みで閉じた', 'human');
          return base.commitments.editBody(...args);
        },
      },
    };
    const { patch } = setup(stores);
    await openHuman(stores);

    const response = await patch('/commitments/c-1', { body: '直した本文' });

    expect(response.status).toBe(409);
    expect(((await response.json()) as { error: string }).error).toContain('割り込みで閉じた');
    expect((await base.commitments.get('c-1'))?.body).toBe('元の本文');
    expect(await decisions(base)).toContain(RETRACTED);
  });

  it('日誌を書いた後に版が変わったら、打ち消しの行を足して current つきの 409 を返す', async () => {
    const base = createMemoryStores();
    const stores: Stores = {
      ...base,
      commitments: {
        ...base.commitments,
        editBody: async (...args) => {
          await base.commitments.editBody('c-1', '別の書き手', '2026-10-19T00:30:00.000Z', 'human');
          return base.commitments.editBody(...args);
        },
      },
    };
    const { patch } = setup(stores);
    await openHuman(stores);

    const response = await patch('/commitments/c-1', { body: '直した本文', ifMatch: AT });

    expect(response.status).toBe(409);
    expect(((await response.json()) as { current: { body: string } }).current.body).toBe(
      '別の書き手',
    );
    expect((await base.commitments.get('c-1'))?.body).toBe('別の書き手');
    expect(await decisions(base)).toContain(RETRACTED);
  });

  it('読んだ版で ifMatch が既に合わないと分かる回は、日誌を書かずに 409', async () => {
    const { stores, patch } = setup();
    await openHuman(stores);

    const response = await patch('/commitments/c-1', {
      body: '直した本文',
      ifMatch: '2000-01-01T00:00:00.000Z',
    });

    expect(response.status).toBe(409);
    expect(await stores.journal.list({ types: ['decision'] })).toEqual([]);
  });
});
