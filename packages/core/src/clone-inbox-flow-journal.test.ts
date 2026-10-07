import { describe, it, expect } from 'vitest';
import { ALWAYS_REDELIVER, commitmentFor, createClone } from './clone.js';
import { createLocalRunner } from './runner-local.js';
import { createRunnerRegistry } from './runner-protocol.js';
import type { Commitment } from './schema.js';
import { captureStderr, createMemoryStores, humanMessage } from './testing.js';
import { fakeGatedSdk, fakeSdk, setup, waitFor, waitForDone } from './clone-test-harness.js';

describe('inbox_flow（受信箱の到着・配達・消し込み・滞留を日誌へ残す。Issue #783 段0）', () => {
  it('人間の発言を1件処理すると、その窓の arrived / delivered に human_message が型別で載る', async () => {
    const s = setup(() => 'わかった');
    s.clone.post(humanMessage('やあ'));
    await waitForDone(s.events);

    const rows = await s.stores.journal.list({ types: ['inbox_flow'] });
    expect(rows).toHaveLength(1);
    const row = rows[0];
    if (row?.type !== 'inbox_flow') throw new Error('inbox_flow が日誌に無い');
    expect(row.arrived).toEqual({ total: 1, byType: [{ type: 'human_message', count: 1 }] });
    expect(row.delivered).toEqual({ total: 1, byType: [{ type: 'human_message', count: 1 }] });
    expect(row.settled).toEqual({ total: 0, byType: [] });
    expect(typeof row.windowStartedAt).toBe('string');

    await s.clone.stop();
  });

  it('2件目の窓には、1件目の消し込みが型別で載る（`settled` が1窓遅れて現れることの固定）', async () => {
    const s = setup(() => 'わかった');
    s.clone.post(humanMessage('1件目'));
    await waitForDone(s.events);
    s.clone.post(humanMessage('2件目'));
    await waitFor(
      async () => (await s.stores.journal.list({ types: ['inbox_flow'] })).length >= 2,
      '2本目の inbox_flow 行',
    );

    // order: 'asc' を明示する: JournalStore.list() の既定は desc で、既定のままだと窓の順序が逆になるため
    const rows = await s.stores.journal.list({ types: ['inbox_flow'], order: 'asc' });
    expect(rows).toHaveLength(2);
    const [first, second] = rows;
    if (first?.type !== 'inbox_flow' || second?.type !== 'inbox_flow') {
      throw new Error('inbox_flow が日誌に無い');
    }

    expect(first.arrived.total).toBe(1);
    expect(first.settled).toEqual({ total: 0, byType: [] });

    expect(second.arrived).toEqual({ total: 1, byType: [{ type: 'human_message', count: 1 }] });
    expect(second.delivered).toEqual({ total: 1, byType: [{ type: 'human_message', count: 1 }] });
    expect(second.settled).toEqual({ total: 1, byType: [{ type: 'human_message', count: 1 }] });

    await s.clone.stop();
  });

  it('拾い直しの配達があると delivered が arrived を上回る（Issue #1049。器を跨いだ拾い直しは、この窓には arrived していない）', async () => {
    const stores = createMemoryStores();
    const leftover = humanMessage('前の器の置き土産');
    await stores.inbox.put(leftover, '2026-09-01T00:00:00.000Z');

    const s = setup(() => 'わかった', stores);
    await waitForDone(s.events);

    const rows = await s.stores.journal.list({ types: ['inbox_flow'] });
    expect(rows.length).toBeGreaterThanOrEqual(1);
    const row = rows[0];
    if (row?.type !== 'inbox_flow') throw new Error('inbox_flow が日誌に無い');

    expect(row.delivered).toEqual({ total: 1, byType: [{ type: 'human_message', count: 1 }] });
    expect(row.arrived).toEqual({ total: 0, byType: [] });
    expect(row.delivered.total).toBeGreaterThan(row.arrived.total);

    await s.clone.stop();
  });

  it('`InboxStore.pending()` が読めない窓は書かず、カウンタも失わない（次の窓へ持ち越す）', async () => {
    const stores = createMemoryStores();
    const originalPending = stores.inbox.pending.bind(stores.inbox);
    let fail = true;
    stores.inbox.pending = async () => {
      if (fail) throw new Error('inbox.pending が壊れている');
      return originalPending();
    };

    const lines = await captureStderr(async () => {
      const s = setup(() => 'わかった', stores);
      s.clone.post(humanMessage('1件目'));
      await waitForDone(s.events);

      expect(await s.stores.journal.list({ types: ['inbox_flow'] })).toEqual([]);

      fail = false;
      s.clone.post(humanMessage('2件目'));
      await waitFor(
        async () => (await s.stores.journal.list({ types: ['inbox_flow'] })).length >= 1,
        'inbox_flow 行',
      );

      const rows = await s.stores.journal.list({ types: ['inbox_flow'] });
      expect(rows).toHaveLength(1);
      const row = rows[0];
      if (row?.type !== 'inbox_flow') throw new Error('inbox_flow が日誌に無い');
      expect(row.arrived).toEqual({ total: 2, byType: [{ type: 'human_message', count: 2 }] });
      expect(row.delivered).toEqual({ total: 2, byType: [{ type: 'human_message', count: 2 }] });

      await s.clone.stop();
    });
    expect(lines.some((line) => line.includes('受信箱の流量（inbox_flow）'))).toBe(true);
  });
});

describe('inbox_flow.retained（メモリ上の索引の残数。Issue #1264）', () => {
  it('1つ目の窓には、処理中の合図自身が retained.unread=1 として載る（#forget はターンの後（`#pump` の finally）でしか呼ばれないため）', async () => {
    const s = setup(() => 'わかった');
    s.clone.post(humanMessage('やあ'));
    await waitForDone(s.events);

    const rows = await s.stores.journal.list({ types: ['inbox_flow'] });
    expect(rows).toHaveLength(1);
    const row = rows[0];
    if (row?.type !== 'inbox_flow') throw new Error('inbox_flow が日誌に無い');
    expect(row.retained).toEqual({
      unread: 1,
      redelivered: 0,
      redeliveredClosed: 0,
      pendingCollapse: 0,
    });

    await s.clone.stop();
  });

  it('2つ目の窓では、1件目の消し込みが効いて retained.unread が1のまま増えない（`this.#unread.delete(event.id);` が `#forget` の中で効いていることの固定）', async () => {
    const s = setup(() => 'わかった');
    s.clone.post(humanMessage('1件目'));
    await waitForDone(s.events);
    s.clone.post(humanMessage('2件目'));
    await waitFor(
      async () => (await s.stores.journal.list({ types: ['inbox_flow'] })).length >= 2,
      '2本目の inbox_flow 行',
    );

    const rows = await s.stores.journal.list({ types: ['inbox_flow'], order: 'asc' });
    expect(rows).toHaveLength(2);
    const [first, second] = rows;
    if (first?.type !== 'inbox_flow' || second?.type !== 'inbox_flow') {
      throw new Error('inbox_flow が日誌に無い');
    }

    expect(first.retained).toEqual({
      unread: 1,
      redelivered: 0,
      redeliveredClosed: 0,
      pendingCollapse: 0,
    });
    expect(second.retained).toEqual({
      unread: 1,
      redelivered: 0,
      redeliveredClosed: 0,
      pendingCollapse: 0,
    });

    await s.clone.stop();
  });

  it('2つ目の窓では、1件目の消し込みが効いて retained.pendingCollapse が1のまま増えない（`#dropPendingCollapse` が `#forget` の中で効いていることの固定。畳み込みの索引は manager_message でしか増えない）', async () => {
    // waitForDone は使えない: manager_message の会話 id は null で、setup() が購読している 'conv-1' に何も流れないため
    const s = setup(() => 'わかった');
    s.clone.post({
      type: 'manager_message',
      id: 'evt-mgr-1',
      at: new Date().toISOString(),
      managerId: 'mgr-1',
      kind: 'report',
      text: '1件目の本文（畳まれない別本文にする）',
    });
    await waitFor(
      async () => (await s.stores.journal.list({ types: ['inbox_flow'] })).length >= 1,
      '1本目の inbox_flow 行',
    );
    s.clone.post({
      type: 'manager_message',
      id: 'evt-mgr-2',
      at: new Date().toISOString(),
      managerId: 'mgr-2',
      kind: 'report',
      text: '2件目の本文（1件目と違う managerId・本文なので畳まれない）',
    });
    await waitFor(
      async () => (await s.stores.journal.list({ types: ['inbox_flow'] })).length >= 2,
      '2本目の inbox_flow 行',
    );

    const rows = await s.stores.journal.list({ types: ['inbox_flow'], order: 'asc' });
    expect(rows).toHaveLength(2);
    const [first, second] = rows;
    if (first?.type !== 'inbox_flow' || second?.type !== 'inbox_flow') {
      throw new Error('inbox_flow が日誌に無い');
    }

    expect(first.retained).toEqual({
      unread: 1,
      redelivered: 0,
      redeliveredClosed: 0,
      pendingCollapse: 1,
    });
    expect(second.retained).toEqual({
      unread: 1,
      redelivered: 0,
      redeliveredClosed: 0,
      pendingCollapse: 1,
    });

    await s.clone.stop();
  });

  it('拾い直した合図は retained.redelivered / retained.redeliveredClosed に一時的に載り、消し込みが効いた後の窓では0に戻る（`this.#redelivered.delete(event.id);` / `this.#redeliveredClosed.delete(event.id);` が `#forget` の中で効いていることの固定）', async () => {
    const stores = createMemoryStores();

    const live = humanMessage('生きている拾い直し', 'conv-live');
    const closed = humanMessage('片付いた拾い直し', 'conv-closed');
    await stores.inbox.put(live, '2026-09-01T00:00:00.000Z');
    await stores.inbox.put(closed, '2026-09-01T00:00:01.000Z');
    await stores.commitments.open(commitmentFor(closed) as Commitment);
    expect(
      await stores.commitments.close(
        closed.id,
        '2026-09-01T00:05:00.000Z',
        'もう対応済み',
        'clone',
      ),
    ).toBe(true);

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

    await waitFor(
      () => calls.some((call) => call.inputs.some((text) => text.includes('生きている拾い直し'))),
      'live のターンが始まる',
    );

    release();

    await waitFor(
      async () => (await stores.journal.list({ types: ['inbox_flow'] })).length >= 1,
      '1本目の inbox_flow 行',
    );
    const firstRows = await stores.journal.list({ types: ['inbox_flow'] });
    expect(firstRows).toHaveLength(1);
    const first = firstRows[0];
    if (first?.type !== 'inbox_flow') throw new Error('inbox_flow が日誌に無い');
    expect(first.retained).toEqual({
      unread: 2,
      redelivered: 2,
      redeliveredClosed: 1,
      pendingCollapse: 0,
    });

    clone.post(humanMessage('3件目（窓3をトリガー）', 'conv-third'));

    await waitFor(
      async () => (await stores.journal.list({ types: ['inbox_flow'], order: 'asc' })).length >= 2,
      '2本目の inbox_flow 行',
    );
    const secondRows = await stores.journal.list({ types: ['inbox_flow'], order: 'asc' });
    expect(secondRows).toHaveLength(2);
    const second = secondRows[1];
    if (second?.type !== 'inbox_flow') throw new Error('inbox_flow が日誌に無い');
    expect(second.retained).toEqual({
      unread: 1,
      redelivered: 0,
      redeliveredClosed: 0,
      pendingCollapse: 0,
    });

    await clone.stop();
  });
});
