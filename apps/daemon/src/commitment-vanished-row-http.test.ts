import {
  createManagerPool,
  createMemoryStores,
  createRunnerRegistry,
  UnreadableCommitmentError,
} from '@alteroid/core';
import type { CloneHost, Commitment, Stores } from '@alteroid/core';
import { describe, expect, it } from 'vitest';

import { createApp } from './app.js';

// POST /commitments/:id/close と PATCH /commitments/:id は、書き込みが通らなかった回に行を読み直して理由を返す（#5072 の HTTP の口）。
// 読み直した行が無い・未了のまま・読めない、を「既に 不明な時刻 に片付いている」に潰さない。
// 状態コードは、同じ口の入口が同じ状態に返しているもの（無い → 404、読めない → 409）にそろえる

const ROW: Commitment = {
  id: 'c-1',
  at: '2026-10-19T00:00:00.000Z',
  origin: 'human',
  body: '元の本文',
};

type AfterWrite = 'vanished' | 'still-open' | 'unreadable';

// 1回目の get は行を返し、close / editBody は false を返し、書いた後の get は `after` の形で返す置き場
function racingStores(after: AfterWrite): Stores {
  const stores = createMemoryStores();
  const base = stores.commitments;
  let wrote = false;
  return {
    ...stores,
    commitments: {
      ...base,
      get: async (id) => {
        if (!wrote) return id === ROW.id ? ROW : null;
        if (after === 'vanished') return null;
        if (after === 'unreadable')
          throw new UnreadableCommitmentError(`${id} は読めない形で入っている`);
        return ROW;
      },
      close: async () => {
        wrote = true;
        return false;
      },
      editBody: async () => {
        wrote = true;
        return false;
      },
    },
  };
}

function setup(after: AfterWrite) {
  const stores = racingStores(after);
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
  return (method: string, path: string, body: unknown) =>
    app.request(path, {
      method,
      headers: { 'content-type': 'application/json', authorization: 'Bearer test-token' },
      body: JSON.stringify(body),
    });
}

async function errorOf(response: Response): Promise<string> {
  return ((await response.json()) as { error: string }).error;
}

describe('POST /commitments/:id/close: 閉じられなかった理由を、読み直した行の形どおりに返す', () => {
  it('⭐ 行が未了のまま残っていたら、「片付いている」と言わず、閉じられなかったと返す（409）', async () => {
    const response = await setup('still-open')('POST', '/commitments/c-1/close', {
      reason: '片付いた',
    });

    expect(response.status).toBe(409);
    const error = await errorOf(response);
    expect(error).not.toContain('片付いている');
    expect(error).toContain('閉じられなかった');
  });

  it('行が無くなっていたら、今までどおり 404', async () => {
    const response = await setup('vanished')('POST', '/commitments/c-1/close', {
      reason: '片付いた',
    });

    expect(response.status).toBe(404);
  });
});

describe('PATCH /commitments/:id: 直せなかった理由を、読み直した行の形どおりに返す', () => {
  it('⭐ 直す直前に行が無くなっていたら、入口と同じく 404 を返す', async () => {
    const response = await setup('vanished')('PATCH', '/commitments/c-1', { body: '直した' });

    expect(response.status).toBe(404);
    expect(await errorOf(response)).not.toContain('片付いている');
  });

  it('⭐ 直す直前に読めない形になっていたら、500 にせず、入口と同じく 409 を返す', async () => {
    const response = await setup('unreadable')('PATCH', '/commitments/c-1', { body: '直した' });

    expect(response.status).toBe(409);
    expect(await errorOf(response)).toContain('読めない');
  });

  it('⭐ 行が未了のまま残っていたら、「片付いている」と言わず、直せなかったと返す（409）', async () => {
    const response = await setup('still-open')('PATCH', '/commitments/c-1', { body: '直した' });

    expect(response.status).toBe(409);
    const error = await errorOf(response);
    expect(error).not.toContain('片付いている');
    expect(error).toContain('直せなかった');
  });
});
