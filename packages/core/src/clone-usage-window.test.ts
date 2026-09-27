import { describe, it, expect } from 'vitest';
import { ALWAYS_REDELIVER, DAEMON_TOKEN_POOL_REOPENED_SOURCE, createClone } from './clone.js';
import type { CloneHost } from './host.js';
import { createLocalRunner } from './runner-local.js';
import { createRunnerRegistry } from './runner-protocol.js';
import type { ChatStreamEvent, InboxEvent } from './schema.js';
import type { Stores } from './store.js';
import { createMemoryStores, humanMessage } from './testing.js';
import {
  fakeSdk,
  setup,
  createEventSink,
  wireEvents,
  waitFor,
  waitForDone,
  isTerminal,
  waitForTerminal,
} from './clone-test-harness.js';
import type { FakeCall } from './clone-test-harness.js';

/**
 * **`usageBlocked`（Issue #783）**: クローンがいま枠（利用上限）で止まっているかを
 * 読む読み取り専用の窓（`CloneHost.usageBlocked`）。
 *
 * `apps/daemon/src/index.ts` の `wake()` はここを見て、「認証トークンが通る状態に
 * 戻った」の合図をクローンへ配るか畳むかを決める（`CloneWakeGate`）。実装は
 * `#usageBlocked !== null` を読むだけの薄い窓なので、既存の「枠に当たったら保持
 * する」歯と同じ入り口（支出上限のエラー文言）を借りて確かめる。
 */
describe('usageBlocked（クローンがいま枠で止まっているかを読む窓。Issue #783）', () => {
  const spendLimitMessage = "You've hit your individual spend limit for this account.";

  it('枠に当たっていない間は false', () => {
    const s = setup();
    expect(s.clone.usageBlocked).toBe(false);
  });

  it('枠に当たって保持している間は true になり、解除されたら false へ戻る', async () => {
    // 歯2（すぐ上のブロック）と同じ形の可変フラグ——枠を「合図で明示的に開ける
    // まで開かない」ようにする。
    let releaseGateOpen = false;
    const { fn } = fakeSdk(undefined, {
      resultFor: () =>
        releaseGateOpen
          ? undefined
          : { subtype: 'error_during_execution', text: spendLimitMessage },
    });
    const clone = createClone({
      redeliveryGate: ALWAYS_REDELIVER,
      stores: createMemoryStores(),
      queryFn: fn,
      env: {},
      runners: createRunnerRegistry([
        createLocalRunner({ workspacePath: '/work', queryFn: fakeSdk().fn, env: {} }),
      ]),
    });
    const { events } = wireEvents(clone, 'conv-1');

    expect(clone.usageBlocked).toBe(false);

    clone.post(humanMessage('やあ'));
    await waitForTerminal(events);
    await waitFor(() => clone.usageBlocked, '枠に当たって保持される');
    expect(clone.usageBlocked).toBe(true);

    // 枠を開けて、続きの合図（トリガー）を送る——保持していた分が配り直されて
    // 成功する。`#usageBlocked` は成功したターンの `finally`（`#pump`）で降ろされる。
    releaseGateOpen = true;
    clone.post(humanMessage('トリガー', 'conv-2'));
    await waitFor(() => !clone.usageBlocked, '枠が解除される');
    expect(clone.usageBlocked).toBe(false);

    await clone.stop();
  });
});

/**
 * **`usageBlockedResetsAt` / `usageBlockedTokenId`（Issue #1223 再発）**:
 * 止まりの回復予定時刻と、いまのセッションの鍵の id を読む窓
 * （`CloneHost.usageBlockedResetsAt` / `usageBlockedTokenId`）。
 *
 * これらは `wake()` / `redeliveryGate` が `staleObservedRecoveryForBlockedKey`
 * へ渡す材料そのもの——`post()` の抑止（上の「Issue #1223 再発」describe）が
 * 間接的に確かめているが、ここでは窓そのものを直に固定する。
 */
describe('usageBlockedResetsAt / usageBlockedTokenId（止まりの resetsAt といまの鍵。Issue #1223 再発）', () => {
  it('枠に当たっていなければ両方 undefined', () => {
    const s = setup();
    expect(s.clone.usageBlockedResetsAt).toBeUndefined();
    expect(s.clone.usageBlockedTokenId).toBeUndefined();
  });

  it('resetsAt 付きの枠に当たると usageBlockedResetsAt にその値が出る', async () => {
    const resetsAt = Date.now() + 60 * 60 * 1000;
    const { fn } = fakeSdk(undefined, {
      resultSubtype: 'error_during_execution',
      resultText: '（結果なし。rate_limit_event だけが上限の理由を運ぶ）',
      rateLimitEventAt: () => ({ status: 'rejected', rateLimitType: 'five_hour', resetsAt }),
    });
    const clone = createClone({
      redeliveryGate: ALWAYS_REDELIVER,
      stores: createMemoryStores(),
      queryFn: fn,
      env: {},
      runners: createRunnerRegistry([
        createLocalRunner({ workspacePath: '/work', queryFn: fakeSdk().fn, env: {} }),
      ]),
    });
    wireEvents(clone, 'conv-1');

    clone.post(humanMessage('やあ'));
    await waitFor(() => clone.usageBlocked, '枠に当たって保持される');
    expect(clone.usageBlockedResetsAt).toBe(resetsAt);

    await clone.stop();
  });

  it('resetsAt を持たない枠の通知なら usageBlockedResetsAt は undefined（取れないことを0で埋めない）', async () => {
    const spendLimitMessage = "You've hit your individual spend limit for this account.";
    const { fn } = fakeSdk(undefined, {
      resultSubtype: 'error_during_execution',
      resultText: spendLimitMessage,
    });
    const clone = createClone({
      redeliveryGate: ALWAYS_REDELIVER,
      stores: createMemoryStores(),
      queryFn: fn,
      env: {},
      runners: createRunnerRegistry([
        createLocalRunner({ workspacePath: '/work', queryFn: fakeSdk().fn, env: {} }),
      ]),
    });
    wireEvents(clone, 'conv-1');

    clone.post(humanMessage('やあ'));
    await waitFor(() => clone.usageBlocked, '枠に当たって保持される');
    expect(clone.usageBlockedResetsAt).toBeUndefined();

    await clone.stop();
  });

  it('tokenIdentity を渡した器では、枠に当たっていなくても usageBlockedTokenId が読める（セッションが起きた瞬間の身元）', async () => {
    const { fn } = fakeSdk();
    const clone = createClone({
      redeliveryGate: ALWAYS_REDELIVER,
      stores: createMemoryStores(),
      queryFn: fn,
      env: {},
      tokenIdentity: () => ({ tokenId: 'tok-a', generation: 1 }),
      runners: createRunnerRegistry([
        createLocalRunner({ workspacePath: '/work', queryFn: fakeSdk().fn, env: {} }),
      ]),
    });
    const { events } = wireEvents(clone, 'conv-1');

    clone.post(humanMessage('やあ'));
    await waitForDone(events);
    expect(clone.usageBlockedTokenId).toBe('tok-a');
    // 枠には1度も当たっていない。
    expect(clone.usageBlocked).toBe(false);

    await clone.stop();
  });

  it('tokenIdentity を渡していない器（プールを使わない既定の構成）では usageBlockedTokenId は undefined', () => {
    const s = setup();
    expect(s.clone.usageBlockedTokenId).toBeUndefined();
  });
});

/**
 * **`usageReleasePending`（Issue #1051）**: 枠の解除を試す印
 * （`#releaseRequested`）が、まだ使われずに立っているかを読む窓
 * （`CloneHost.usageReleasePending`）。
 *
 * ## これが何を支えているか
 *
 * `apps/daemon/src/index.ts` の門（`worthDeliveringNow`）は、**この印が立って
 * いる間は「通る状態に戻った」の合図を配らない。** その判断が成り立つ根拠は
 * 1つだけである —— **合図の効果は `post()` の中のこの印を立てることだけで、
 * 既に立っているならもう一度立てても状態は1文字も動かない。**
 *
 * ⟹ **ここで測るのはその根拠そのものである。** 門の側の歯（`index.test.ts`）は
 * 引数の真偽表しか見られないので、**引数が現実と結びついていることは、ここで
 * しか固定できない。**
 */
/**
 * 「認証トークンが通る状態に戻った」の合図を1件作る（`apps/daemon/src/index.ts` の
 * `wake()` が出すものと同じ型・同じ `source`）。
 *
 * **本文は呼び手が変えられるようにしてある。** 同一本文にすると受信箱の
 * 畳み込み（Issue #954 / `inboxCollapseKey`）まで一緒に効いてしまい、測りたい
 * `#releaseRequested` の話と混ざる——**別の本文でも印の挙動は同じ**であることを
 * 見るほうが、測っているものが1つに絞れる。
 */
function tokenPoolReopened(text: string): InboxEvent {
  return {
    type: 'external',
    id: `evt-${text}`,
    at: '2026-09-16T01:39:52.172Z',
    source: DAEMON_TOKEN_POOL_REOPENED_SOURCE,
    payload: { text },
  };
}

describe('usageReleasePending（再開の印がまだ使われずに立っているか。Issue #1051）', () => {
  const spendLimitMessage = "You've hit your individual spend limit for this account.";

  it('枠に当たっていない間は false（印を立てる条件そのものが無い）', () => {
    const s = setup();
    expect(s.clone.usageReleasePending).toBe(false);
  });

  it('🔴 枠で止まっている間、1件目の合図で印が立ち、2件目は何も動かさない', async () => {
    // **枠は開けない。** ここで測るのは印の立ち方だけで、解除までは追わない。
    const releaseGateOpen = false;
    const { fn } = fakeSdk(undefined, {
      resultFor: () =>
        releaseGateOpen
          ? undefined
          : { subtype: 'error_during_execution', text: spendLimitMessage },
    });
    const clone = createClone({
      redeliveryGate: ALWAYS_REDELIVER,
      stores: createMemoryStores(),
      queryFn: fn,
      env: {},
      runners: createRunnerRegistry([
        createLocalRunner({ workspacePath: '/work', queryFn: fakeSdk().fn, env: {} }),
      ]),
    });
    const { events } = wireEvents(clone, 'conv-1');

    clone.post(humanMessage('やあ'));
    await waitForTerminal(events);
    await waitFor(() => clone.usageBlocked, '枠に当たって保持される');

    // **止まった直後、印はまだ立っていない。** ここが「配る意味が在る」窓である。
    expect(clone.usageReleasePending).toBe(false);

    // 1件目の「通る状態に戻った」の合図。
    clone.post(tokenPoolReopened('1件目'));
    expect(clone.usageReleasePending).toBe(true);

    // **2件目以降は、立っている印をもう一度立てるだけである。** ＝ 門がここを
    // 畳んでも、クローンの状態は1文字も違わない（Issue #1051 の根拠）。
    const before = { blocked: clone.usageBlocked, pending: clone.usageReleasePending };
    clone.post(tokenPoolReopened('2件目'));
    clone.post(tokenPoolReopened('3件目'));
    expect({ blocked: clone.usageBlocked, pending: clone.usageReleasePending }).toEqual(before);

    await clone.stop();
  });

  it('🔴 印は再試行で消費される ⟹ 次の回復はまた配られる（起こし損ねを作らない）', async () => {
    // **枠は開けない。** ここで測るのは印の立ち方だけで、解除までは追わない。
    const releaseGateOpen = false;
    const { fn } = fakeSdk(undefined, {
      resultFor: () =>
        releaseGateOpen
          ? undefined
          : { subtype: 'error_during_execution', text: spendLimitMessage },
    });
    const clone = createClone({
      redeliveryGate: ALWAYS_REDELIVER,
      stores: createMemoryStores(),
      queryFn: fn,
      env: {},
      runners: createRunnerRegistry([
        createLocalRunner({ workspacePath: '/work', queryFn: fakeSdk().fn, env: {} }),
      ]),
    });
    const { events } = wireEvents(clone, 'conv-1');

    clone.post(humanMessage('やあ'));
    await waitForTerminal(events);
    await waitFor(() => clone.usageBlocked, '枠に当たって保持される');

    clone.post(tokenPoolReopened('1件目'));
    expect(clone.usageReleasePending).toBe(true);

    // **印は `#pump` の先頭で必ず消費される**（「印だけ立って誰も見ない」が
    // 起きない理由は `clone.ts` の解除ブロックの doc に在る）。
    await waitFor(() => !clone.usageReleasePending, '再開の印が消費される');

    // ⟹ **門の条件（`blocked && !releasePending`）は、次の回復をまた通す。**
    // 畳んだぶんは「遅れ」ではなく「重複」だった、ということがここで閉じる。
    expect(clone.usageReleasePending).toBe(false);

    await clone.stop();
  });
});

/**
 * 症状B（人間の報告）: 「利用上限に当たった状態で話しかけると、枠が回復した
 * 後も、待たされていた発言への返信が届かない」を直接確かめる。
 *
 * 上のブロック（FIFO の配り直し）が確かめているのは「保持と再投入がクローンの
 * 内部で動くか」であって、「人間の側から見えるか」ではない。既存のその
 * ブロックは `setup()` の張りっぱなしの購読（ファイル冒頭 `clone.subscribe`）を
 * 使っており、`apps/daemon/src/app.ts` の `POST /chat`（:772-811）が
 * `done` / `error` を見た時点で `unsubscribe()` する現物の振る舞いを再現して
 * いない。ここではその振る舞いを持つ聞き手を自分で用意する。
 *
 * **人間の要望はリアルタイム性ではない**（「あとで良いのでちゃんと返信して
 * ほしい」が本旨。マネージャーからの追加指示）。SSE を張りっぱなしにする形が
 * 正解ではないので、ここで測るのは「その場で観測できるか」と「後から見つけら
 * れる形（日誌）で残るか」という別々の2つの事実であり、どちらかが正しい・
 * 間違っているという話ではない。
 */
describe('クローン — 枠が回復した後の返信は、人間の側から観測できるか（症状B）', () => {
  const spendLimitMessage = "You've hit your individual spend limit for this account.";

  /**
   * `setup()` は張りっぱなしの購読を1本持つ（ファイル冒頭）。ここではそれを
   * 使わず、購読者を自分で選べる素の clone を組み立てる。
   */
  function setupBareClone(sdkOptions: Parameters<typeof fakeSdk>[1] = {}): {
    clone: CloneHost;
    stores: Stores;
    calls: FakeCall[];
  } {
    const stores = createMemoryStores();
    const { fn, calls } = fakeSdk(undefined, sdkOptions);
    const clone = createClone({
      redeliveryGate: ALWAYS_REDELIVER,
      stores,
      queryFn: fn,
      env: {},
      runners: createRunnerRegistry([
        createLocalRunner({ workspacePath: '/work', queryFn: fakeSdk().fn, env: {} }),
      ]),
    });
    return { clone, stores, calls };
  }

  /**
   * `apps/daemon/src/app.ts` の `POST /chat` と同じ振る舞いの聞き手
   * （:772 で subscribe、:774/:808 で `done`/`error` を終端と見て、
   * :811 の `finally` で unsubscribe する）。**張りっぱなしにしないことが
   * 要点** — 実物の SSE 購読はここで終わる。
   */
  function subscribeLikeChatEndpoint(clone: CloneHost, conversationId: string): ChatStreamEvent[] {
    // **終端で購読を外すのがこの聞き手の本体である**（実物の SSE と同じ）。だから
    // `wireEvents`（張りっぱなし）へは寄せられない —— 寄せると測っている当のものが
    // 消える。観測の部品（`createEventSink`）だけを共有して、外し方は自分で持つ。
    const { events, push } = createEventSink();
    const unsubscribe = clone.subscribe(conversationId, (event) => {
      push(event);
      if (event.type === 'done' || event.type === 'error') unsubscribe();
    });
    return events;
  }

  it('(a) 元の接続（done/error で外れる、実物の SSE と同じ聞き手）には、保持していた合図の再試行が成功しても届かない', async () => {
    const { clone, stores, calls } = setupBareClone({
      resultFor: (turnIndex) =>
        turnIndex === 0
          ? { subtype: 'error_during_execution', text: spendLimitMessage }
          : undefined,
    });

    // 1本目: 枠に当たる。app.ts の POST /chat と同じ聞き手を張ってから post する
    // （app.ts も :772 の subscribe を :787 の post より先に行う）。
    const firstConnection = subscribeLikeChatEndpoint(clone, 'conv-1');
    clone.post(humanMessage('一件目'));
    await waitForTerminal(firstConnection);
    expect(firstConnection.filter(isTerminal).map((event) => event.type)).toEqual(['error']);
    // ここで購読は既に外れている（`subscribeLikeChatEndpoint` が error を見て
    // 自分で unsubscribe した）。

    await waitFor(async () => {
      const pending = await stores.inbox.claimPending();
      return pending.length === 1;
    }, '1本目が未読のまま保持される');

    // 枠が回復した後の「試す契機」は、人間が chat を開いていなくても来る
    // （自律 tick・マネージャーからの報告・外部イベントなど、`post()` を呼ぶ
    // ものなら何でもよい）。
    // **⚠️ Issue #1240 続き以降は、`post()` の解除チェックが合図の種類を見る
    // ことがある**（`usageBlockAlwaysRearms` の doc）——ただしそれは
    // `#usageBlocked.resetsAt` が分かっているときだけで、ここで使う
    // `spendLimitMessage` は文言だけの通知（`classifyUsageNotice` 経由）なので
    // `resetsAt` を持たない。`resetsAt` が無ければ合図の種類に関わらず今までどおり
    // 再武装する（`usageBlockAlwaysRearms` の doc「それ以外は post() が
    // resetsAt を見る」）ので、この歯が使う `timer` 合図でも解除は起きる。
    // ここでは conv-1 に紐付かない `timer` 合図を使い、「1本目の接続がまだ
    // 生きている」という都合の良い前提を置かないことを明示する。
    clone.post({
      type: 'timer',
      id: 'evt-trigger',
      at: new Date().toISOString(),
      kind: 'self_initiative_tick',
    });

    // 保持していた1本目の再試行が実際に SDK へ投げられるまで待つ
    // （calls[0] の入力数が2件目に増える＝再試行が起きた証拠）。
    await waitFor(async () => (calls[0]?.inputs.length ?? 0) >= 2, '1本目の再試行が実行される');
    // 再試行そのものが成功したこと（done で終わる）も別途確かめる（副読）。
    //
    // **「失敗の記録ではない outbound」では足りない。** 枠で保持していることを
    // 人間へ返す1行（`#reportFailure`）も同じ `with: 'human'` / `outbound` /
    // `conv-1` で載るので、否定形の条件だと再試行を待たずに満たされてしまう。
    // 偽の SDK の返信は常に `わかった` なので**その本文を数える** — 1本目でも
    // assistant の本文は流れて日誌に載る（`clone.ts` の journal 書き込みは
    // result の成否より前）ので、**2件目が出た＝再試行の返信が載った**である。
    //
    // ---- 追記（SDK のエラーを応答として扱うのをやめた改修） ----
    // 上の「1本目でも assistant の本文が**そのまま**日誌に載る」は、もう成り立た
    // ない。失敗したターンの本文には印が付く（`clone.ts` の `result` の分岐。
    // 無印で残すと、日誌が digest を通って翌日の日報の材料になるときに
    // 「クローンがそう言った」として効いてしまう）。
    //
    // **これは保証を弱める変更ではない。** 印が付くことで、素の `わかった` は
    // **再試行の返信ただ1件だけ**になる — 直す前の `>= 2` は「1本目の分と合わせて
    // 2件」という数え方だったので、1本目の本文が混ざる余地があった。いまは
    // 1件でも「再試行の返信が載った」を一意に指す。**そのうえで、1本目の本文に
    // 印が付いていることも同じ待ちの中で確かめる**（片方だけを見ると、印を
    // 付ける実装が消えても緑のままになる）。
    await waitFor(async () => {
      const exchanges = await stores.journal.list({ types: ['exchange'] });
      const outbound = exchanges.filter(
        (entry) =>
          entry.type === 'exchange' &&
          entry.with === 'human' &&
          entry.role === 'outbound' &&
          entry.conversationId === 'conv-1',
      );
      const retried = outbound.filter(
        (entry) => entry.type === 'exchange' && entry.text === 'わかった',
      );
      const marked = outbound.filter(
        (entry) =>
          entry.type === 'exchange' &&
          entry.text.startsWith('（このターンは失敗して終わった') &&
          entry.text.includes('わかった'),
      );
      return retried.length === 1 && marked.length === 1;
    }, '再試行が成功した記録が日誌に残る（1本目の本文には失敗の印が付く）');

    // 症状B(a): 元の接続には、この再試行の成功（text/done）が一切届いていない
    // — 購読は1本目自身の error で既に外れている。**これは「あるべき」を示す
    // アサーションではない**（マネージャーの指示どおり、SSE を張りっぱなしに
    // する形は正解ではないため）。観測された事実として記録する。
    // 1本目自身の queued/thinking/text/usage_limited/error のあとは何も増えて
    // いないこと＝再試行の分（2周目の queued 以降）が一切届いていないこと。
    expect(firstConnection.some((event) => event.type === 'done')).toBe(false);
    expect(firstConnection.filter(isTerminal)).toHaveLength(1);
    expect(firstConnection.filter((event) => event.type === 'usage_limited')).toHaveLength(1);

    await clone.stop();
  });

  it('(b) 保持していた合図の再試行が成功すると、日誌には with:human / role:outbound / 同じ conversationId の記録が残る', async () => {
    const { clone, stores } = setupBareClone({
      resultFor: (turnIndex) =>
        turnIndex === 0
          ? { subtype: 'error_during_execution', text: spendLimitMessage }
          : undefined,
    });

    const isMatchingOutboundExchange = (
      entry: Awaited<ReturnType<Stores['journal']['list']>>[number],
    ): entry is Extract<
      Awaited<ReturnType<Stores['journal']['list']>>[number],
      { type: 'exchange' }
    > =>
      entry.type === 'exchange' &&
      entry.with === 'human' &&
      entry.role === 'outbound' &&
      entry.conversationId === 'conv-1';

    const matchingOutbound = async () =>
      (await stores.journal.list({ types: ['exchange'] })).filter(isMatchingOutboundExchange);

    const firstConnection = subscribeLikeChatEndpoint(clone, 'conv-1');
    clone.post(humanMessage('一件目'));
    await waitForTerminal(firstConnection);

    const before = await matchingOutbound();

    clone.post({
      type: 'timer',
      id: 'evt-trigger',
      at: new Date().toISOString(),
      kind: 'self_initiative_tick',
    });

    // 症状B(b): 再試行が成功すると、日誌には新しい outbound の記録が増える
    // （`#emit` の購読者の有無とは無関係に、`#journal`（`packages/core/src/clone.ts`）
    // の journal 書き込みは常に走る）。**これは実際にありうる真の観測**であって、(a) と対になる
    // 別の事実である。
    //
    // **⚠️ 「件数が増えた」では足りない（#1220 の観測点ずれ）。** `#reportFailure`
    // は `#emit(error)` を最初に行い（`waitForTerminal` はここで解決する）、
    // 人間向けの本文（`humanText`）を組み立てて `#journal` へ書くのは**その後**
    // ——`#usageBlocked` を読んでから書くこの1行が、まだ完了していない窓が
    // 実在する。壁時計のポーリングだった頃は、この窓を待つあいだに実時間が
    // 経ち、黙って埋まっていた。**出来事の到着を同期でつかむ形（`waitForEvents`
    // 系）に直したことで、この窓が露出した**——`timer` を投げた直後、まだ
    // 「一件目」自身の held 通知（`いま利用上限に当たっているので……`。文言は
    // `#reportFailure` の `humanText` 分岐、`#usageBlocked !== null` 側）が
    // 書き終わっていない状態で `matchingOutbound()` を引くと、**件数の増分**は
    // その held 通知1件だけで満たされてしまい、再試行そのものの成功
    // （`わかった`）はまだ1件も書かれていない。実測（2026-09-19）:
    // `before` が1件・`timer` 投稿直後に「件数が増えた」を満たした時点の新顔が
    // `いま利用上限に当たっているので、この発言にはまだ返せない。……` だった
    // （this のブランチが検出する前の一時状態）。
    //
    // **直し方は「待つ対象そのものを観測する」のままにする**（#1220 の路線）——
    // 「件数が増えた」という**間接**の代理指標ではなく、**この歯が本当に
    // 見たいもの**（再試行の返信そのもの、`text === 'わかった'`）を直接 待つ。
    await waitFor(
      async () =>
        (await matchingOutbound()).some(
          (entry) =>
            entry.text === 'わかった' && !before.some((existing) => existing.id === entry.id),
        ),
      '保持していた1本目の再試行の返信（わかった）が日誌に残る',
    );

    const after = await matchingOutbound();
    const newest = after.find(
      (entry) => entry.text === 'わかった' && !before.some((existing) => existing.id === entry.id),
    );
    expect(newest).toBeDefined();
    // **増えた1件が再試行の返信そのものであること**まで見る（否定形だと、枠で
    // 保持していることを人間へ返す1行でも通ってしまう）。偽の SDK の返信は
    // 常に `わかった` である。
    expect(newest?.text).toBe('わかった');
    expect(newest?.text.startsWith('人間との対話ターンが失敗した')).toBe(false);

    await clone.stop();
  });

  /**
   * 人間へ返す1行を、**枠のときとそれ以外で言い分けているか**。
   *
   * 人間の要望は「あとで良いのでちゃんと返信してほしい」である。だから会話に
   * 残る1行は「待てば返る」と「もう返らない」を区別していなければならない —
   * どちらも「失敗した」で済ませると、人間は待つべきかもう一度送るべきかを
   * 会話から決められない（送り直すと、保持されている分と重複する）。
   *
   * **`#reportFailure` の分岐（`#usageBlocked === null`）に歯を当てるのが目的**
   * なので、枠の場合と枠でない場合を1本の中で対にして見る（別々の it にすると、
   * 片方だけが緑のまま「常に同じ文言を返す」実装を通してしまう）。
   */
  it('人間へ返す1行は、枠で保持しているときだけ「あとで試し直す」と言う', async () => {
    /**
     * 会話に残った、クローンからの1行（assistant の本文 `わかった` は除く）。
     *
     * **除外は `includes` で行う**（元は `!== 'わかった'` だった）。失敗した
     * ターンの本文には印が付くので（`clone.ts` の `result` の分岐）、完全一致で
     * 除くと `（このターンは失敗して終わった…）\nわかった` が「クローンからの
     * 1行」に混ざり、**このヘルパが数える対象が2件になって条件が永久に満たされ
     * なくなる**。ここで見たいのは `#reportFailure` が人間へ返す1行だけである。
     */
    const noticesFor = async (stores: Stores) =>
      (await stores.journal.list({ types: ['exchange'] }))
        .filter(
          (entry) =>
            entry.type === 'exchange' &&
            entry.with === 'human' &&
            entry.role === 'outbound' &&
            entry.conversationId === 'conv-1' &&
            !entry.text.includes('わかった'),
        )
        .map((entry) => (entry.type === 'exchange' ? entry.text : ''));

    // 枠に当たった場合。
    const limited = setupBareClone({
      resultFor: () => ({ subtype: 'error_during_execution', text: spendLimitMessage }),
    });
    limited.clone.post(humanMessage('一件目'));
    await waitFor(async () => (await noticesFor(limited.stores)).length === 1, '枠の1行が残る');
    const limitedNotice = (await noticesFor(limited.stores))[0] ?? '';
    expect(limitedNotice).toContain('利用上限');
    expect(limitedNotice).toContain('試し直');
    // 生の文言（英語）は人間へ返す1行には載せない。
    expect(limitedNotice).not.toContain(spendLimitMessage);
    await limited.clone.stop();

    // 枠ではない失敗の場合。**待てば返るとは言わない。**
    const broken = setupBareClone({
      resultFor: () => ({ subtype: 'error_during_execution', text: '内部で何かが壊れた' }),
    });
    broken.clone.post(humanMessage('一件目'));
    await waitFor(
      async () => (await noticesFor(broken.stores)).length === 1,
      '枠でない失敗の1行が残る',
    );
    const brokenNotice = (await noticesFor(broken.stores))[0] ?? '';
    expect(brokenNotice).toContain('返せなかった');
    expect(brokenNotice).not.toContain('試し直');
    expect(brokenNotice).not.toContain('内部で何かが壊れた');
    await broken.clone.stop();
  });
});
