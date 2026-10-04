import { describe, it, expect } from 'vitest';
import { ALWAYS_REDELIVER, createClone } from './clone.js';
import { createLocalRunner } from './runner-local.js';
import { createRunnerRegistry } from './runner-protocol.js';
import { createMemoryStores, humanMessage } from './testing.js';
import { fakeGatedSdk, fakeSdk, setup, waitFor, waitForDone } from './clone-test-harness.js';

/**
 * 稼働の地図（`GET /topology`）が読む2つの面。
 *
 * - `CloneHost.activeTurn` — クローンがいまターンを走らせているか。
 * - `exchange` の `managerId` — マネージャーとの往復がどのマネージャーの線を流れたか。
 *   **`text` には手を入れていない**（`[managerId]` の表示はそのまま）。
 */
describe('稼働の地図の材料（activeTurn と exchange.managerId）', () => {
  it('activeTurn は、ターンが走っているあいだは busy の材料を返し、終わると null', async () => {
    const stores = createMemoryStores();
    const { fn, calls, release } = fakeGatedSdk();
    const clone = createClone({
      redeliveryGate: ALWAYS_REDELIVER,
      stores,
      queryFn: fn,
      env: {},
      runners: createRunnerRegistry([
        createLocalRunner({ workspacePath: '/work', queryFn: fakeSdk().fn, env: {} }),
      ]),
    });
    expect(clone.activeTurn?.()).toBeNull();

    clone.post(humanMessage('やあ', 'conv-topology'));
    await waitFor(
      () => calls.some((call) => call.inputs.some((text) => text.includes('やあ'))),
      'ターンが始まる',
    );
    expect(clone.activeTurn?.()).toEqual({ conversationId: 'conv-topology', kind: 'normal' });

    release();
    await waitFor(() => clone.activeTurn?.() === null, 'ターンが終わる');
    await clone.stop();
  });

  it('マネージャーからの報告を受け取った行（inbound）に managerId が構造として載る。text は従来どおり', async () => {
    const s = setup();
    s.clone.post(humanMessage('やあ'));
    await waitForDone(s.events);

    s.clone.post({
      type: 'manager_message',
      id: 'evt-report',
      at: new Date().toISOString(),
      managerId: 'mgr-topology',
      kind: 'report',
      text: '直しました',
    });
    await waitFor(async () => {
      const rows = await s.stores.journal.list({ types: ['exchange'] });
      return rows.some((row) => row.type === 'exchange' && row.with === 'manager');
    }, '報告の受け取りが日誌に載る');

    const rows = await s.stores.journal.list({ types: ['exchange'] });
    const inbound = rows.find(
      (row) => row.type === 'exchange' && row.with === 'manager' && row.role === 'inbound',
    );
    if (inbound?.type !== 'exchange') throw new Error('報告の行が無い');
    expect(inbound.managerId).toBe('mgr-topology');
    // text の `[managerId/kind]` の表示は変えていない（機械が読む鍵は構造の側）。
    expect(inbound.text).toContain('[mgr-topology/report] 直しました');

    await s.clone.stop();
  });
});
