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

  // 反転（#5176 の順序変更）: 以前は「日誌にも残さない」だった。重複は台帳の `reopen` の排他区間でしか確定しないので、
  // 日誌を先に書いた後に判明し、先の行を打ち消す行が足される（開き直していないことは変わらない）。
  it('同じ担当・同じ本文の未了の行が在れば 409 で、その id を言い、閉じたまま、日誌には打ち消しの行を足す', async () => {
    const { stores, call } = setup();
    const base = { at: AT, origin: 'manager', source: 'mgr-1', body: '同じ本文' } as const;
    await stores.commitments.open({ ...base, id: 'old' });
    await stores.commitments.close('old', CLOSED_AT, '片付けた', 'clone');
    await stores.commitments.open({ ...base, id: 'new' });

    const response = await call('POST', '/commitments/old/reopen', { reason: '戻す' });

    expect(response.status).toBe(409);
    expect(((await response.json()) as { error: string }).error).toContain('new');
    expect((await stores.commitments.get('old'))?.closedAt).toBe(CLOSED_AT);
    expect(JSON.stringify(await stores.journal.list({ types: ['decision'] }))).toContain(
      '直前の開き直しの行は効いていない（開き直していない）',
    );
  });

  it('日誌に書けないときは 500 で、開き直さず、閉じた記録は行に残る', async () => {
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
    const { call } = setup(stores);
    await openAndClose(stores);

    const response = await call('POST', '/commitments/c-1/reopen', { reason: '戻す' });

    expect(response.status).toBe(500);
    expect(((await response.json()) as { code: string }).code).toBe('journal_write_failed');
    const row = await stores.commitments.get('c-1');
    expect(row?.closedAt).toBe(CLOSED_AT);
    expect(row?.closedBy).toBe('daemon');
    expect(row?.closedReason).toBe('器が自動で閉じた');
  });

  // 以前は日誌の行が1本だけで `[CLOSED_AT]` を見ていた。#5272 で印（humanAction）の付いた行を開き直しの後へ分けたので、
  // 閉じた記録を持つ先の行は閉じているうちに、印の付いた後の行は開き直した後に書かれることを、行ごとに見る
  it('閉じた記録を残す先の行は台帳の行がまだ閉じているうちに、印の付いた行は開き直した後に書かれる', async () => {
    const base = createMemoryStores();
    const appended: { closedAt: string | undefined; marked: boolean; grounds: string }[] = [];
    const stores: Stores = {
      ...base,
      journal: {
        ...base.journal,
        append: async (entry) => {
          appended.push({
            closedAt: (await base.commitments.get('c-1'))?.closedAt,
            marked: entry.type === 'decision' && entry.humanAction !== undefined,
            grounds: entry.type === 'decision' ? entry.grounds : '',
          });
          return base.journal.append(entry);
        },
      },
    };
    const { call } = setup(stores);
    await openAndClose(stores);

    const response = await call('POST', '/commitments/c-1/reopen', { reason: '戻す' });

    expect(response.status).toBe(200);
    expect(appended.map(({ closedAt, marked }) => ({ closedAt, marked }))).toEqual([
      { closedAt: CLOSED_AT, marked: false },
      { closedAt: undefined, marked: true },
    ]);
    expect(appended[0]?.grounds).toContain(`closedAt=${CLOSED_AT}`);
  });

  it('印の付いた後の行が書けなくても、開き直しは効いているので 200 を返す', async () => {
    const base = createMemoryStores();
    let appends = 0;
    const stores: Stores = {
      ...base,
      journal: {
        ...base.journal,
        append: async (entry) => {
          appends += 1;
          if (appends > 1) throw new Error('journal down');
          return base.journal.append(entry);
        },
      },
    };
    const { call } = setup(stores);
    await openAndClose(stores);

    const response = await call('POST', '/commitments/c-1/reopen', { reason: '戻す' });

    expect(response.status).toBe(200);
    expect((await base.commitments.get('c-1'))?.closedAt).toBeUndefined();
  });

  it('先読みの後に別の手で開き直されたら、打ち消しの行を足して 409 を返す', async () => {
    const base = createMemoryStores();
    const stores: Stores = {
      ...base,
      commitments: {
        ...base.commitments,
        reopen: async (id) => {
          await base.commitments.reopen(id);
          return base.commitments.reopen(id);
        },
      },
    };
    const { call } = setup(stores);
    await openAndClose(stores);

    const response = await call('POST', '/commitments/c-1/reopen', { reason: '戻す' });

    expect(response.status).toBe(409);
    expect(((await response.json()) as { error: string }).error).toContain('閉じていない');
    expect(JSON.stringify(await base.journal.list({ types: ['decision'] }))).toContain(
      '直前の開き直しの行は効いていない（開き直していない）',
    );
  });

  it('先読みと開き直しの間に閉じ直されたら、実際に外した記録を補いの行へ残す', async () => {
    const base = createMemoryStores();
    const stores: Stores = {
      ...base,
      commitments: {
        ...base.commitments,
        reopen: async (id) => {
          await base.commitments.reopen(id);
          await base.commitments.close(id, '2026-10-19T02:00:00.000Z', '閉じ直した', 'human');
          return base.commitments.reopen(id);
        },
      },
    };
    const { call } = setup(stores);
    await openAndClose(stores);

    const response = await call('POST', '/commitments/c-1/reopen', { reason: '戻す' });

    expect(response.status).toBe(200);
    const journal = JSON.stringify(await base.journal.list({ types: ['decision'] }));
    expect(journal).toContain('closedAt=2026-10-19T02:00:00.000Z');
    expect(journal).toContain('closedReason=閉じ直した');
  });

  it('開き直した後に行が読めなくなっても 500 にせず、開き直しは効いていると言う', async () => {
    const base = createMemoryStores();
    // 先読み（日誌より前）は読め、開き直した後の読み直しだけが読めない
    let reopened = false;
    const stores: Stores = {
      ...base,
      commitments: {
        ...base.commitments,
        reopen: async (id) => {
          const result = await base.commitments.reopen(id);
          reopened = true;
          return result;
        },
        get: async (id) => {
          if (reopened) throw new UnreadableCommitmentError(`${id} は読めない形で入っている`);
          return base.commitments.get(id);
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
    await openAndClose(stores);

    const response = await call('POST', '/commitments/c-1/reopen', { reason: '戻す' });

    expect(response.status).toBe(409);
    expect(((await response.json()) as { error: string }).error).toContain('書き直さない');
  });
});
