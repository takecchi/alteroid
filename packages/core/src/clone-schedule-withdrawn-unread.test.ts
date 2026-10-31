import { describe, expect, it } from 'vitest';

import { createClone } from './clone.js';
import { fakeSdk, flushPendingMicrotasks } from './clone-test-harness.js';
import { createLocalRunner } from './runner-local.js';
import { createRunnerRegistry } from './runner-protocol.js';
import { createMemoryStores } from './testing.js';
import { createCloneTools } from './tools.js';

// 取り消した定期の依頼の未読の timer 行が受信箱に残っていると、依頼の本文が無いまま
// 「記憶にある目的に照らして必要なことをせよ」の素のターンとして走っていた。取り消した依頼の起動は走らせない。
describe('定期の依頼 — 取り消した依頼の未読の起動は走らせない', () => {
  const MIN = 60_000;
  const T0 = Date.parse('2026-08-11T00:00:00.000Z');
  const WEEK = 7 * 24 * 60 * MIN;
  const DUE = T0 + WEEK;
  const REQUEST = '週に1回、状態を見て進める';

  async function plan(stores: ReturnType<typeof createMemoryStores>, kind: string) {
    await stores.schedules.put({
      kind,
      spec: { type: 'every', minutes: 7 * 24 * 60 },
      request: REQUEST,
      createdAt: new Date(T0).toISOString(),
      updatedAt: new Date(T0).toISOString(),
    });
  }

  async function unreadTimer(stores: ReturnType<typeof createMemoryStores>, kind: string) {
    await stores.inbox.put(
      { type: 'timer', id: `unread-${kind}`, at: new Date(DUE).toISOString(), kind },
      new Date(DUE).toISOString(),
    );
  }

  // 人間の API（DELETE /schedule/:kind）と同じ外し方: クローンの道具 schedule_remove
  async function removeViaTool(stores: ReturnType<typeof createMemoryStores>, kind: string) {
    const tools = createCloneTools({
      stores,
      emit: () => undefined,
      memoryCause: () => 'clone',
      conversationId: () => 'conv-1',
      workConversationId: () => 'conv-1',
      dropQueuedInboxEvents: async () => 0,
    });
    const found = tools.find((entry) => entry.name === 'schedule_remove');
    if (!found) throw new Error('schedule_remove が無い');
    await found.handler({ kind } as never, { _meta: {} });
  }

  function wake(stores: ReturnType<typeof createMemoryStores>) {
    const sdk = fakeSdk(() => '進めた');
    createClone({
      stores,
      queryFn: sdk.fn,
      env: {},
      runners: createRunnerRegistry([
        createLocalRunner({ workspacePath: '/work', queryFn: fakeSdk().fn, env: {} }),
      ]),
    });
    return sdk;
  }

  it('取り消した依頼の未読の起動は、器を起こしてもモデルを呼ばず、受信箱からも消える', async () => {
    const stores = createMemoryStores();
    await plan(stores, 'weekly-check');
    await unreadTimer(stores, 'weekly-check');
    await removeViaTool(stores, 'weekly-check');
    expect(await stores.schedules.get('weekly-check')).toBeNull();

    const sdk = wake(stores);
    await flushPendingMicrotasks();
    await flushPendingMicrotasks();

    expect(sdk.calls.length).toBe(0);
    expect((await stores.inbox.pending()).count).toBe(0);
  });

  it('依頼の無い（もともと仕込まれていない）kind の未読の起動は、今までどおり判断のターンとして走る', async () => {
    const stores = createMemoryStores();
    await unreadTimer(stores, 'hand-planted');

    const sdk = wake(stores);
    await flushPendingMicrotasks();
    await flushPendingMicrotasks();

    expect(sdk.calls.length).toBe(1);
  });
});
