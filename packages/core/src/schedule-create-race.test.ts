import { describe, expect, it } from 'vitest';

import type { Stores } from './store.js';
import { createMemoryStores } from './testing.js';
import { createCloneTools } from './tools.js';

const KIND = 'morning-check';
const CONCURRENT_AT = '2026-10-13T00:00:00.000Z';

/**
 * `editRequest` が「無い」と答えた直後に、ほか（人間の `POST /schedule`）が同じ名前の依頼を作り、
 * それがもう発火を引き受けている（`pendingRun`）状態を作る。
 */
function racingStores(): Stores {
  const stores = createMemoryStores();
  let raced = false;
  return {
    ...stores,
    schedules: {
      ...stores.schedules,
      list: stores.schedules.list.bind(stores.schedules),
      get: stores.schedules.get.bind(stores.schedules),
      put: stores.schedules.put.bind(stores.schedules),
      remove: stores.schedules.remove.bind(stores.schedules),
      removeIfPresent: stores.schedules.removeIfPresent.bind(stores.schedules),
      claimRun: stores.schedules.claimRun.bind(stores.schedules),
      completeRun: stores.schedules.completeRun.bind(stores.schedules),
      getPhase: stores.schedules.getPhase.bind(stores.schedules),
      putPhase: stores.schedules.putPhase.bind(stores.schedules),
      async editRequest(kind, changes, updatedAt, options) {
        const result = await stores.schedules.editRequest(kind, changes, updatedAt, options);
        if (result === null && !raced) {
          raced = true;
          await stores.schedules.put({
            kind,
            spec: { type: 'daily', at: '07:00' },
            request: '人間が作った本文',
            createdAt: CONCURRENT_AT,
            updatedAt: CONCURRENT_AT,
          });
          await stores.schedules.claimRun(kind, CONCURRENT_AT, CONCURRENT_AT, 'schedule');
        }
        return result;
      },
    },
  };
}

describe('クローンの schedule_create は、新しく作るときに「無いときだけ作る」で書く（#4610）', () => {
  it('読んでから書くまでに同じ名前が作られていたら、丸ごと置き換えず、発火の印を引き継いで置き換える', async () => {
    const stores = racingStores();
    const tools = createCloneTools({
      memoryCause: () => 'clone',
      conversationId: () => undefined,
      stores,
      emit: () => undefined,
    });
    const create = tools.find((entry) => entry.name === 'schedule_create');
    if (create === undefined) throw new Error('schedule_create が無い');

    await create.handler({ kind: KIND, request: 'クローンの本文', dailyAt: '09:00' } as never, {});

    const now = await stores.schedules.get(KIND);
    // 同じ kind は置き換える（道具の説明どおり）
    expect(now?.request).toBe('クローンの本文');
    // 先に作られた依頼の発火の印（引き受け中の回）を、丸ごと置き換えで消さない
    expect(now?.pendingRun?.at).toBe(CONCURRENT_AT);
    expect(now?.createdAt).toBe(CONCURRENT_AT);
  });

  it('対照: 無い名前は今までどおり新しく作る', async () => {
    const stores = createMemoryStores();
    const tools = createCloneTools({
      memoryCause: () => 'clone',
      conversationId: () => undefined,
      stores,
      emit: () => undefined,
    });
    const create = tools.find((entry) => entry.name === 'schedule_create');
    if (create === undefined) throw new Error('schedule_create が無い');

    await create.handler({ kind: KIND, request: 'クローンの本文', dailyAt: '09:00' } as never, {});

    expect((await stores.schedules.get(KIND))?.request).toBe('クローンの本文');
  });
});
