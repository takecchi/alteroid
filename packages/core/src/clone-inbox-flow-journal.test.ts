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
    // **この窓ではまだ乗らない**（上のクラス docstring「`settled` は同じ窓には
    // 乗らないことがある」）。
    expect(row.settled).toEqual({ total: 0, byType: [] });
    expect(typeof row.windowStartedAt).toBe('string');

    await s.clone.stop();
  });

  it('2件目の窓には、1件目の消し込みが型別で載る（`settled` が1窓遅れて現れることの固定）', async () => {
    const s = setup(() => 'わかった');
    s.clone.post(humanMessage('1件目'));
    await waitForDone(s.events);
    // 2件目は1件目が終わってから届くので、まとめ読み（`#mergedHumanBatch`）に
    // 束ねられず、独立したもう1回の pump 反復＝もう1つの窓になる。
    s.clone.post(humanMessage('2件目'));
    await waitFor(
      async () => (await s.stores.journal.list({ types: ['inbox_flow'] })).length >= 2,
      '2本目の inbox_flow 行',
    );

    // **`order: 'asc'` を明示する。** `JournalStore.list()` の既定は `desc`
    // （新しい順）なので、既定のまま `[first, second]` と受けると**窓の順序が
    // 逆になる**——「1件目の窓」と信じた行が実際には2件目の窓になり、`settled`
    // が1窓ずれて現れることの固定がそのまま裏返る（この取り違えを実際に踏んだ）。
    const rows = await s.stores.journal.list({ types: ['inbox_flow'], order: 'asc' });
    expect(rows).toHaveLength(2);
    const [first, second] = rows;
    if (first?.type !== 'inbox_flow' || second?.type !== 'inbox_flow') {
      throw new Error('inbox_flow が日誌に無い');
    }

    // 1件目の窓: 到着・配達はあるが、まだ消し込みは乗らない。
    expect(first.arrived.total).toBe(1);
    expect(first.settled).toEqual({ total: 0, byType: [] });

    // **2件目の窓が、1件目を型別で消し込み済みとして持ち越す。** 同時に
    // 2件目自身の到着・配達も同じ行に型別で載る——「到着→消し込みの後に
    // 窓を書くと、arrived と settled の両方に型別で載る」を、時系列で
    // 満たす形（同時に起きるとは限らないので、2窓に分けて固定する）。
    expect(second.arrived).toEqual({ total: 1, byType: [{ type: 'human_message', count: 1 }] });
    expect(second.delivered).toEqual({ total: 1, byType: [{ type: 'human_message', count: 1 }] });
    expect(second.settled).toEqual({ total: 1, byType: [{ type: 'human_message', count: 1 }] });

    // **カウンタは持ち越されない**（窓を書いた直後に次の窓が空から始まる）。
    // 2件目の窓の `arrived.total` が1件目ぶんまで足された「2」にはならない
    // ——上のアサーションそのものがこれを固定している（累積なら2になるはず）。

    await s.clone.stop();
  });

  it('拾い直しの配達があると delivered が arrived を上回る（Issue #1049。器を跨いだ拾い直しは、この窓には arrived していない）', async () => {
    const stores = createMemoryStores();
    // 前の器が残した「未読のまま」の合図を、post() を経由せずに直接ストアへ
    // 置く——`#remember`（＝ arrived を数える唯一の場所）を通っていないので、
    // 新しく起こすクローンの窓ではこの1件は1度も arrived していない。
    const leftover = humanMessage('前の器の置き土産');
    await stores.inbox.put(leftover, '2026-09-01T00:00:00.000Z');

    const s = setup(() => 'わかった', stores);
    // `#restoreUnread`（起動直後の拾い直し）がこの1件を配る。ターンが1本
    // 走って初めて `case 'turn_ended'` が inbox_flow を書くので、その完了を待つ。
    await waitForDone(s.events);

    const rows = await s.stores.journal.list({ types: ['inbox_flow'] });
    expect(rows.length).toBeGreaterThanOrEqual(1);
    const row = rows[0];
    if (row?.type !== 'inbox_flow') throw new Error('inbox_flow が日誌に無い');

    // **配達はされている**（`#restoreUnread` が `#inbox.push` した）。
    expect(row.delivered).toEqual({ total: 1, byType: [{ type: 'human_message', count: 1 }] });
    // **だがこの窓には arrived していない**——受理（`#remember`）は前の器の
    // 出来事で、いまの器はそれを見ていない。
    expect(row.arrived).toEqual({ total: 0, byType: [] });
    // ⟹ delivered(1) > arrived(0)。2つが別物を数えていることの数での固定。
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

      // この窓は pending() が壊れているので書かれない。
      expect(await s.stores.journal.list({ types: ['inbox_flow'] })).toEqual([]);

      // 直ってから2件目を処理すると、1件目ぶんのカウンタが持ち越されて
      // 一緒に出る（データを失っていない）。
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
      // 1件目・2件目の両方ぶんの到着・配達が、持ち越されて1行にまとまって出る。
      expect(row.arrived).toEqual({ total: 2, byType: [{ type: 'human_message', count: 2 }] });
      expect(row.delivered).toEqual({ total: 2, byType: [{ type: 'human_message', count: 2 }] });

      await s.clone.stop();
    });
    expect(lines.some((line) => line.includes('受信箱の流量（inbox_flow）'))).toBe(true);
  });
});

/**
 * `inbox_flow.retained`（メモリ上の4つの索引の残数。Issue #1264、案1a）。
 *
 * `#forget` が行う後始末のうち、`#unread` / `#redelivered` /
 * `#redeliveredClosed` の3つの `Map` からの削除は、直したことの証拠が無い
 * まま `main` に在った（Issue #1264 の「なぜ測れないのか」）——読み手が
 * 「配り直しの断り文を組む3箇所だけ」で、削除を止めても出力が1文字も
 * 変わらないので歯が書けなかった。この `describe` はその出口
 * （`inbox_flow.retained`）を歯にする。
 *
 * **`#redelivered` / `#redeliveredClosed` は放っておけば最初から空である。**
 * 空の `Map` に対して「消し込み後に0であること」だけを書いても、`#forget`
 * の削除を殺して緑のままになる（歯が1本も増えない）——必ず「消し込みの
 * 前には入っている」ことを同じテストの中で固定する。
 */
describe('inbox_flow.retained（メモリ上の索引の残数。Issue #1264）', () => {
  it('1つ目の窓には、処理中の合図自身が retained.unread=1 として載る（#forget はターンの後（`#pump` の finally）でしか呼ばれないため）', async () => {
    const s = setup(() => 'わかった');
    s.clone.post(humanMessage('やあ'));
    await waitForDone(s.events);

    const rows = await s.stores.journal.list({ types: ['inbox_flow'] });
    expect(rows).toHaveLength(1);
    const row = rows[0];
    if (row?.type !== 'inbox_flow') throw new Error('inbox_flow が日誌に無い');
    // 他の3つの索引はこのシナリオでは一度も使われない
    // （`#redelivered` / `#redeliveredClosed` は起動時の拾い直しの経路でしか
    // 増えず、`#pendingCollapse` は `manager_message` / デーモン自身の
    // `external` でしか増えない——`inboxCollapseKey` の doc）。
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
    // 🔴 ここが1つ目の窓の固定と同じ「1」でなければ、1件目の `#unread` の
    // 項目が `#forget` で消えていない——`this.#unread.delete(event.id);` を
    // 殺すとここが「2」になる。
    expect(second.retained).toEqual({
      unread: 1,
      redelivered: 0,
      redeliveredClosed: 0,
      pendingCollapse: 0,
    });

    await s.clone.stop();
  });

  it('2つ目の窓では、1件目の消し込みが効いて retained.pendingCollapse が1のまま増えない（`#dropPendingCollapse` が `#forget` の中で効いていることの固定。畳み込みの索引は manager_message でしか増えない）', async () => {
    // **`waitForDone` は使えない。** `manager_message` の会話 id は常に
    // `null`（`#conversationOf` の doc）＝内部ターン扱いで、`setup()` が
    // 購読している `'conv-1'` には何も流れない。窓の書き込みは日誌を
    // 直接ポーリングして待つ。
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

    // 1件目自身が `#foldIntoPendingCollapse` の代表として索引に載る
    // （`existing === undefined` の分岐。畳まれるのは2件目以降の同文だけ）。
    expect(first.retained).toEqual({
      unread: 1,
      redelivered: 0,
      redeliveredClosed: 0,
      pendingCollapse: 1,
    });
    // 🔴 1件目の代表が `#forget` で片付いていれば、2件目自身の代表1件だけが
    // 載って「1」のまま——`#dropPendingCollapse` を殺すと「2」になる
    // （片付いた代表の「影」が残り続ける。`#pendingCollapse` の doc
    // 「鍵が落ちるとき」）。
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

    // **`live`**: 前の器が残した未読で、台帳は開いていない（＝閉じてもいない）
    // ——`#restoreUnreadPass` は `#redelivered` にだけ載せ、通常どおりターンを
    // 走らせる。**`closed`**: 前の器が残した未読で、台帳は既に閉じている
    // ——`#restoreUnreadPass` は `#redelivered` と `#redeliveredClosed` の
    // 両方に載せ、ターンを起こさずに畳む（`#foldClosedRedelivery` +
    // `#settleInboxEvent(event, false)` が `#forget` を呼ぶ）。
    const live = humanMessage('生きている拾い直し', 'conv-live');
    const closed = humanMessage('片付いた拾い直し', 'conv-closed');
    // `claimPending()`（testing.ts のインメモリ実装）は `at` の昇順で返す
    // ——`live` を先に配らせるため、`closed` より早い時刻にしておく。
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

    // `live` のターンが実際に始まる（入力が SDK まで届く）まで待つ。この
    // 時点で `#restoreUnreadPass` は最後まで走っている——`live` のターンが
    // 止まっているあいだ、`closed` は待ち行列に残ったまま dequeue されない
    // （受信箱のループは直列。`#pump` の同時実行モデル）。
    await waitFor(
      () => calls.some((call) => call.inputs.some((text) => text.includes('生きている拾い直し'))),
      'live のターンが始まる',
    );

    release();

    // `live` の `turn_ended` が窓を書く。この時点では `closed` はまだ
    // dequeue されていない（`live` の後始末 `#forget` は `#pump` の
    // `finally`——窓を書いた後）ので、`closed` の索引はまだ載ったままである。
    await waitFor(
      async () => (await stores.journal.list({ types: ['inbox_flow'] })).length >= 1,
      '1本目の inbox_flow 行',
    );
    const firstRows = await stores.journal.list({ types: ['inbox_flow'] });
    expect(firstRows).toHaveLength(1);
    const first = firstRows[0];
    if (first?.type !== 'inbox_flow') throw new Error('inbox_flow が日誌に無い');
    expect(first.retained).toEqual({
      // live 自身（処理中）＋ closed（まだ #forget していない）。
      unread: 2,
      // live・closed のどちらも `#restoreUnreadPass` が拾い直した。
      redelivered: 2,
      // closed だけが台帳の閉じた行を持つ。
      redeliveredClosed: 1,
      pendingCollapse: 0,
    });

    // **`closed` は `live` の直後に FIFO で dequeue され、ターンを起こさずに
    // 畳まれて `#forget` される**（`#pump` の直列処理。`closed` はゲート付き
    // SDK を一度も呼ばないので、この後始末はゲートと無関係に進む）。3件目の
    // 合図は `closed` より後に積まれるので、`closed` の後始末が終わるまで
    // dequeue されない——FIFO がそのまま同期点になる。
    clone.post(humanMessage('3件目（窓3をトリガー）', 'conv-third'));

    await waitFor(
      async () => (await stores.journal.list({ types: ['inbox_flow'], order: 'asc' })).length >= 2,
      '2本目の inbox_flow 行',
    );
    const secondRows = await stores.journal.list({ types: ['inbox_flow'], order: 'asc' });
    expect(secondRows).toHaveLength(2);
    const second = secondRows[1];
    if (second?.type !== 'inbox_flow') throw new Error('inbox_flow が日誌に無い');
    // 🔴 live・closed のどちらも `#forget` で片付いていれば、3件目自身の
    // `unread` だけが残り「1」——`this.#redelivered.delete(event.id);` /
    // `this.#redeliveredClosed.delete(event.id);` のどちらかを殺すと、
    // 対応する欄が「0」に戻らない。
    expect(second.retained).toEqual({
      unread: 1,
      redelivered: 0,
      redeliveredClosed: 0,
      pendingCollapse: 0,
    });

    await clone.stop();
  });
});

/**
 * 🔴 実運用の食い違い調査（2026-09-23、マネージャーからの委譲。Issue #1051 続き）。
 *
 * ## 観測されていた症状
 *
 * 本番の日誌（`token_rotation`）では特定の時間帯、「recovered（turn_success）:
 * alteroid03」と「exhausted: 候補の最速回復は alteroid09」が3.5秒周期で交互に
 * 記録されていた。ところが**そのあいだにクローンが実際に受け取った「戻った」
 * 通知の本文は「alteroid09」を名乗っていた**——journal 側の最新の recovered が
 * 03 なのに、クローンへ渡った文面は 09 だった、という食い違い。
 *
 * ## この束が確かめる機序
 *
 * `apps/daemon/src/index.ts`（`reopenedTokenOf` → `settleTokenOutcome` →
 * `wake()` → `CloneWakeGate.decide` → `clone.post(...)`）を読む限り、1回の
 * `settleTokenOutcome` 呼び出しの中では tokenId が入れ替わる余地はない
 * （daemon 側の対照は `apps/daemon/src/index.test.ts` が別途固定する——この
 * ファイルからは `apps/daemon` を import できない。依存は core → daemon の
 * 一方向であり、ここに daemon 側の配線の対照を置くこと自体が向きを逆にする）。
 *
 * **入れ替わりうるのはクローン側 —— `#pump` の FIFO 再武装である**
 * （`clone.ts` の `#deferred` / `#pump` 先頭 / `usageBlockAlwaysRearms`）。
 * クローンが枠で止まっている間に届いた「戻った」通知は、たとえ
 * `usageBlockAlwaysRearms` が真でも**即座には処理されない**——`post()` は
 * `#releaseRequested = true` を立てるだけで、実際に投げ直すのは `#pump` の
 * 先頭であり、そこは**保持している合図を FIFO の先頭から**戻す
 * （`#deferred.splice(0)` → `unshift([...held, event])`）。⟹ 新しく届いた
 * 通知（journal 上「最新」）よりも**先に保持されていた古い通知の本文**が先に
 * モデルへ渡り、しかもそのリトライがそのとき通れば「成功したターン」として
 * 残る——古い本文がそのまま「いま起きたこと」として扱われる形である。
 *
 * **下のテストは、その機序をこの層で再現する陽性対照である。** この束は
 * 直す前の commit（`#pendingTokenPoolNotice` を導入する前）でこの機序が
 * 実在することを固定し、直した後は次の describe（`token-pool の「戻った」
 * 通知は同時に未処理で1件まで`）の不変条件テストへ主役を譲る——直した後の
 * この束の意味は「turn 1 の本文が変わった」という差分そのものになる。
 */
