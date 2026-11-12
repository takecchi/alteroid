import { describe, it, expect } from 'vitest';
import {
  DAEMON_TOKEN_POOL_REOPENED_SOURCE,
  createClone,
  retainedSizesForTesting,
} from './clone.js';
import type { RetainedSizes } from './clone.js';
import { EXCHANGE_KIND_THINNING_PREFIX } from './exchange-kind.js';
import { createLocalRunner } from './runner-local.js';
import { createRunnerRegistry } from './runner-protocol.js';
import type { InboxEvent } from './schema.js';
import { createMemoryStores, humanMessage } from './testing.js';
import {
  fakeGatedSdk,
  fakeSdk,
  setup,
  waitFor,
  waitForDone,
  withoutQueueNotice,
} from './clone-test-harness.js';

// 受信箱の内側の保持分（`#unread`・`#redelivered`・`#pendingCollapse`）の後始末漏れを、日誌を経由せず `retainedSizesForTesting` で直接見る。
// ターンの中の値は fakeSdk の reply の中で取り、全部片付いた後の値は `stop()`（読み切ってから畳む）の後に取る: 壁時計で待たず、漏れは「0にならない」で赤くなる。
const NONE: RetainedSizes = { unread: 0, redelivered: 0, pendingCollapse: 0 };

describe('受信箱の内側の保持分の後始末（Issue #1264。日誌を経由しない観測口）', () => {
  it('人間の発言を1件処理すると、処理中は未読が1（合図自身）で、片付いた後は0に戻る', async () => {
    const seen: RetainedSizes[] = [];
    const holder: { s?: ReturnType<typeof setup> } = {};
    const s = setup(() => {
      if (holder.s !== undefined) seen.push(retainedSizesForTesting(holder.s.clone));
      return 'わかった';
    });
    holder.s = s;
    s.clone.post(humanMessage('やあ'));
    await waitForDone(s.events);
    await s.clone.stop();

    // stop() の蒸留のターンは数えない（先頭の1件だけ見る）
    expect(seen.slice(0, 1)).toEqual([{ unread: 1, redelivered: 0, pendingCollapse: 0 }]);
    expect(retainedSizesForTesting(s.clone)).toEqual(NONE);
  });

  it('2件目の処理中も未読は1のまま増えない（`#forget` の `#unread.delete` が効いていることの固定）', async () => {
    const seen: RetainedSizes[] = [];
    const holder: { s?: ReturnType<typeof setup> } = {};
    const s = setup(() => {
      if (holder.s !== undefined) seen.push(retainedSizesForTesting(holder.s.clone));
      return 'わかった';
    });
    holder.s = s;
    s.clone.post(humanMessage('1件目'));
    await waitForDone(s.events);
    s.clone.post(humanMessage('2件目'));
    await waitFor(() => seen.length >= 2, '2件目のターンが始まる');
    await s.clone.stop();

    // stop() の蒸留のターンは数えない（先頭の2件だけ見る）
    expect(seen.slice(0, 2)).toEqual([
      { unread: 1, redelivered: 0, pendingCollapse: 0 },
      { unread: 1, redelivered: 0, pendingCollapse: 0 },
    ]);
    expect(retainedSizesForTesting(s.clone)).toEqual(NONE);
  });

  it('畳み込みの索引は、代表がターンへ取り出された時点で落ち、増えたままにならない（`#pump` の取り出しで `#dropPendingCollapse` が効いていることの固定。索引は manager_message でしか増えない）', async () => {
    const seen: RetainedSizes[] = [];
    const holder: { s?: ReturnType<typeof setup> } = {};
    const s = setup(() => {
      if (holder.s !== undefined) seen.push(retainedSizesForTesting(holder.s.clone));
      return 'わかった';
    });
    holder.s = s;
    // waitForDone は使えない: manager_message の会話 id は null で、setup() が購読している 'conv-1' に何も流れないため
    s.clone.post({
      type: 'manager_message',
      id: 'evt-mgr-1',
      at: new Date().toISOString(),
      managerId: 'mgr-1',
      kind: 'report',
      text: '1件目の本文（畳まれない別本文にする）',
    });
    await waitFor(() => seen.length >= 1, '1件目のターンが始まる');
    s.clone.post({
      type: 'manager_message',
      id: 'evt-mgr-2',
      at: new Date().toISOString(),
      managerId: 'mgr-2',
      kind: 'report',
      text: '2件目の本文（1件目と違う managerId・本文なので畳まれない）',
    });
    await waitFor(() => seen.length >= 2, '2件目のターンが始まる');
    await s.clone.stop();

    // 取り出された代表の索引は落ちている（読まれている最中の代表に同文を畳まない）ので、ターンの中では0
    expect(seen.slice(0, 2)).toEqual([
      { unread: 1, redelivered: 0, pendingCollapse: 0 },
      { unread: 1, redelivered: 0, pendingCollapse: 0 },
    ]);
    expect(retainedSizesForTesting(s.clone)).toEqual(NONE);
  });

  it('拾い直した合図は redelivered に載り、消し込みが済むと0に戻る（`#forget` の `#redelivered.delete` が効いていることの固定）', async () => {
    const stores = createMemoryStores();
    const live = humanMessage('生きている拾い直し', 'conv-live');
    await stores.inbox.put(live, '2026-09-01T00:00:00.000Z');

    const { fn, calls, release } = fakeGatedSdk();
    const clone = createClone({
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
    expect(retainedSizesForTesting(clone)).toEqual({
      unread: 1,
      redelivered: 1,
      pendingCollapse: 0,
    });

    release();
    clone.post(humanMessage('3件目（窓をトリガー）', 'conv-third'));
    await clone.stop();

    expect(retainedSizesForTesting(clone)).toEqual(NONE);
  });

  it('拾い直した合図を待ち行列から消すと、その合図の3つの索引が外れる（`dropQueuedInboxEvents` の中の3行の固定）', async () => {
    const stores = createMemoryStores();

    const live = humanMessage('生きている拾い直し', 'conv-live');
    const queued = humanMessage('待ち行列で消される拾い直し', 'conv-queued');
    await stores.inbox.put(live, '2026-09-01T00:00:00.000Z');
    await stores.inbox.put(queued, '2026-09-01T00:00:01.000Z');

    const { fn, calls, release } = fakeGatedSdk();
    const clone = createClone({
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
    expect(retainedSizesForTesting(clone)).toEqual({
      unread: 2,
      redelivered: 2,
      pendingCollapse: 0,
    });

    expect(await clone.dropQueuedInboxEvents([queued.id])).toBe(1);

    // 消した分だけが外れ、処理中の live は残る
    expect(retainedSizesForTesting(clone)).toEqual({
      unread: 1,
      redelivered: 1,
      pendingCollapse: 0,
    });

    release();
    await clone.stop();

    expect(retainedSizesForTesting(clone)).toEqual(NONE);
  });

  it('待ち行列にある報告（畳み込みの代表）を消すと、その索引も外れる（`dropQueuedInboxEvents` の `#dropPendingCollapse` の固定。拾い直しでない合図の側）', async () => {
    const { fn, calls, release } = fakeGatedSdk();
    const clone = createClone({
      stores: createMemoryStores(),
      queryFn: fn,
      env: {},
      runners: createRunnerRegistry([
        createLocalRunner({ workspacePath: '/work', queryFn: fakeSdk().fn, env: {} }),
      ]),
    });

    clone.post(humanMessage('処理中の合図', 'conv-live'));
    await waitFor(
      () => calls.some((call) => call.inputs.some((text) => text.includes('処理中の合図'))),
      'live のターンが始まる',
    );
    clone.post({
      type: 'manager_message',
      id: 'evt-mgr-queued',
      at: new Date().toISOString(),
      managerId: 'mgr-1',
      kind: 'report',
      text: '待ち行列で消される報告',
    });
    expect(retainedSizesForTesting(clone)).toEqual({
      unread: 2,
      redelivered: 0,
      pendingCollapse: 1,
    });

    expect(await clone.dropQueuedInboxEvents(['evt-mgr-queued'])).toBe(1);
    expect(retainedSizesForTesting(clone)).toEqual({
      unread: 1,
      redelivered: 0,
      pendingCollapse: 0,
    });

    release();
    await clone.stop();

    expect(retainedSizesForTesting(clone)).toEqual(NONE);
  });

  it('stale の拾い直しを一括で消すと、その合図の索引が外れる（`#removeStaleRedeliveryChunk` の `#unread` / `#redelivered` の固定）', async () => {
    const stores = createMemoryStores();

    const stale: InboxEvent = {
      type: 'external',
      id: 'evt-stale-tokenpool',
      at: '2026-09-01T00:00:00.000Z',
      source: DAEMON_TOKEN_POOL_REOPENED_SOURCE,
    };
    const live = humanMessage('stale の後ろの生きている拾い直し', 'conv-live');
    await stores.inbox.put(stale, '2026-09-01T00:00:00.000Z');
    await stores.inbox.put(live, '2026-09-01T00:00:01.000Z');

    const { fn, calls, release } = fakeGatedSdk();
    const clone = createClone({
      stores,
      queryFn: fn,
      env: {},
      runners: createRunnerRegistry([
        createLocalRunner({ workspacePath: '/work', queryFn: fakeSdk().fn, env: {} }),
      ]),
    });

    await waitFor(
      () =>
        calls.some((call) =>
          call.inputs.some((text) => text.includes('stale の後ろの生きている拾い直し')),
        ),
      'live のターンが始まる',
    );
    await waitFor(async () => (await stores.inbox.pending()).count === 1, 'stale が器から消える');

    // stale の分は外れ、処理中の live だけが残る
    expect(retainedSizesForTesting(clone)).toEqual({
      unread: 1,
      redelivered: 1,
      pendingCollapse: 0,
    });

    release();
    await clone.stop();

    expect(retainedSizesForTesting(clone)).toEqual(NONE);
  });

  it('拾い直している最中に消された合図は、配らずに畳んだうえで3つの索引も外す（`#restoreUnreadPass` の `#droppedWhileRestoring` 分岐の3行の固定）', async () => {
    const stores = createMemoryStores();

    const target = humanMessage('拾い直しの最中に消される', 'conv-dropped');
    await stores.inbox.put(target, '2026-09-01T00:00:00.000Z');

    // 消し込みは Task の起票（拾い直しの途中で呼ばれる `tasks.add`）の中で差し込む: 時間で近似せず、#restoringUnread が立っている窓で必ず墓標が残るため
    const holder: { clone?: ReturnType<typeof createClone> } = {};
    let droppedDuringRestore: number | undefined;
    const originalAdd = stores.tasks.add.bind(stores.tasks);
    stores.tasks.add = async (entry, placement) => {
      if (entry.id === target.id && droppedDuringRestore === undefined) {
        if (holder.clone === undefined) throw new Error('clone がまだ無い');
        droppedDuringRestore = await holder.clone.dropQueuedInboxEvents([target.id]);
      }
      return originalAdd(entry, placement);
    };

    const sdk = fakeSdk();
    const clone = createClone({
      stores,
      queryFn: sdk.fn,
      env: {},
      runners: createRunnerRegistry([
        createLocalRunner({ workspacePath: '/work', queryFn: fakeSdk().fn, env: {} }),
      ]),
    });
    holder.clone = clone;

    await waitFor(
      async () =>
        (await stores.journal.list({ types: ['exchange'] })).some(
          (entry) =>
            entry.type === 'exchange' &&
            entry.text.startsWith(
              `${EXCHANGE_KIND_THINNING_PREFIX}拾い直している最中に器から消された合図なので`,
            ),
        ),
      '拾い直しの最中に消された合図を畳んだ跡',
    );
    expect(droppedDuringRestore).toBe(0);

    // 畳んだ合図の索引は、後続の合図を待たずに外れている
    expect(retainedSizesForTesting(clone)).toEqual(NONE);

    clone.post(humanMessage('後から届く合図（窓をトリガー）', 'conv-after'));
    await clone.stop();

    expect(retainedSizesForTesting(clone)).toEqual(NONE);
    // 待ち行列の節は落としてから見る（#5469 P6c）: 起こし直しの時点で台帳と同じ id の Task が積まれており（P5）、その題は待ち行列の先頭に出る。ここで見たいのは「消された合図が配られていない」こと
    expect(
      sdk.calls.some((call) =>
        call.inputs.some((text) => withoutQueueNotice(text).includes('拾い直しの最中に消される')),
      ),
    ).toBe(false);
  });
});
