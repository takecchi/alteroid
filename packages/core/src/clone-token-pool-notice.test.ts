import { describe, it, expect } from 'vitest';
import { DAEMON_TOKEN_POOL_REOPENED_SOURCE } from './clone.js';
import type { InboxEvent, JournalEntry } from './schema.js';
import { createMemoryStores, humanMessage } from './testing.js';
import { setup, waitFor } from './clone-test-harness.js';
import type { FakeCall } from './clone-test-harness.js';

describe('🔴 実運用食い違い調査（2026-09-23）: token-pool の「戻った」通知の tokenId', () => {
  const spendLimitMessage = "You've hit your individual spend limit for this account.";

  function tokenPoolNotice(id: string, text: string): InboxEvent {
    return {
      type: 'external',
      id,
      at: new Date().toISOString(),
      source: DAEMON_TOKEN_POOL_REOPENED_SOURCE,
      payload: { text },
    };
  }

  it('陽性対照（反転済み。Issue #1051 続きの直しで反転——直す前は「古い方が渡る」が真だった）: 古いトークンの「戻った」通知が未処理のまま残っている間に別トークンの通知が届くと、実際にモデルへ渡る本文は新しい方である', async () => {
    // turn 0（notice-A の初回）だけ枠で失敗させ、turn 1 以降は成功させる。
    const s = setup(undefined, createMemoryStores(), {
      resultFor: (turnIndex) =>
        turnIndex < 1 ? { subtype: 'error_during_execution', text: spendLimitMessage } : undefined,
    });

    // alteroid-A が「戻った」——このターン（turn 0）は失敗し、`#deferred` へ
    // 保持される。
    s.clone.post(
      tokenPoolNotice(
        'notice-A',
        '認証トークンが通る状態に戻った（また通るようになった）: 「alteroid-A」（id tok-A）。枠で止まっていた仕事は、ここから再開できる。',
      ),
    );
    await waitFor(() => s.clone.usageBlocked, 'notice-A の初回処理が枠で失敗して保持される');
    await waitFor(
      () => s.calls[0]?.inputs.some((text) => text.includes('alteroid-A')) ?? false,
      'notice-A の本文が turn 0 でモデルへ渡る',
    );

    // alteroid-B が「戻った」——journal で見れば「いま戻ったのはこちら」に
    // なる、より新しい事実。`usageBlockAlwaysRearms` により無条件で再武装する。
    s.clone.post(
      tokenPoolNotice(
        'notice-B',
        '認証トークンが通る状態に戻った（また通るようになった）: 「alteroid-B」（id tok-B）。枠で止まっていた仕事は、ここから再開できる。',
      ),
    );

    await waitFor(
      () => (s.calls[0]?.inputs.length ?? 0) >= 2,
      'notice-A か notice-B、どちらかの再試行（turn 1）が投げられる',
    );

    const inputs = (s.calls[0] as FakeCall).inputs;
    // **turn 0 は必ず notice-A（それしか無いので自明。ここは足場の確認）。**
    expect(inputs[0]).toContain('alteroid-A');

    // 🔴→🟢 本題（Issue #1051 続きの直しで反転）。
    //
    // **直す前はここが逆だった**（`expect(inputs[1]).toContain('alteroid-A')`
    // ／ `expect(inputs[1]).not.toContain('alteroid-B')` —— turn 1（notice-B
    // の到着で誘発された、最初の再試行）に実際に渡る本文は、journal 上
    // 「新しい」はずの notice-B ではなく、先に保持されていた notice-A
    // （古い方）だった。**`findIndex` で「どこかに出てくるか」を見ると、
    // turn 0 の A が常に先頭に居るせいで自明に真になってしまう——だから
    // 「どのターンに何が載ったか」を turn 番号で直接見る、という点は直した
    // 後も変わらない。**
    //
    // **直した後はここが逆になる。** notice-A がまだ未処理（`#deferred` に
    // 居る）あいだに notice-B が届いた時点で、`#pendingTokenPoolNotice`
    // （`clone.ts`）が notice-A を外して畳み、notice-B を代表にする。⟹
    // 保持分（`#deferred`）が空になった状態で notice-B だけが解除され、
    // turn 1 は notice-B（新しい方）の本文で走る。
    //
    // 3点セット（AGENTS.md「テストを弱めずに直す」）:
    // 1. 変更した事実 — 上の2行の期待値を反転した（A→B）
    // 2. なぜ必要になったか — `#pendingTokenPoolNotice` の導入で、未処理の
    //    まま複数残っていた token-pool 通知が「常に最新の1件」に合流する
    //    ようになったため
    // 3. なぜ保証が弱くなっていないか — この束はいまも「turn 0 は
    //    notice-A・turn 1 の本文を直接 turn 番号で検査する」という同じ形の
    //    まま、期待する本文だけを直した（保証の形は変えていない。弱めても
    //    いない——むしろ「最新の内容が渡る」という、直す前は言えなかった
    //    主張を新たに固定している）
    expect(inputs[1]).toContain('alteroid-B');
    expect(inputs[1]).not.toContain('alteroid-A');

    await s.clone.stop();
  });
});

/**
 * token-pool の「戻った」通知は同時に未処理で1件まで（Issue #1051 続き。
 * `clone.ts` の `#pendingTokenPoolNotice` / `#foldPendingTokenPoolNotice` /
 * `#evictPendingTokenPoolRepresentative`）。
 *
 * 上の「実運用食い違い調査」の陽性対照が示した機序（`#pump` の FIFO が古い
 * token-pool 通知を先に配ってしまう）に対する直し本体の不変条件を、件数では
 * なく性質として固定する。
 *
 * - **不変条件**: 同時に未処理で残る token-pool の「戻った」は高々1件。実際に
 *   走るターンの本文はいちばん新しい方。合流させた古い方は日誌に残る（消えない）
 * - **陰性対照1**: 未処理の token-pool 通知が無い状態への単発の遷移では、
 *   必ずターンが1回起きて保持が解ける（合流する相手が無いので、これまでと
 *   1文字も変わらない経路であることの固定）
 * - **陰性対照2**: 1件目を処理し終えた（`#forget` された）後に届いた通知は、
 *   合流せず自分自身のターンを持つ——合流は「未処理の間」に限る
 * - **陰性対照3 / 器の入れ替え**: 合流で外された側は消えているが、生き残った
 *   代表は器の入れ替え（プロセスの再起動）を跨いでも失われず、かつ拾い直した
 *   後も合流が引き続き効く
 */
describe('クローン — token-pool の「戻った」通知は同時に未処理で1件まで（Issue #1051 続き）', () => {
  const spendLimitMessage = "You've hit your individual spend limit for this account.";

  function tokenPoolNotice(id: string, text: string): InboxEvent {
    return {
      type: 'external',
      id,
      at: new Date().toISOString(),
      source: DAEMON_TOKEN_POOL_REOPENED_SOURCE,
      payload: { text },
    };
  }

  it('不変条件: 未処理のまま token-pool 通知が3件連投されても、実際にモデルへ渡るのは常にいちばん新しい1件で、外した古い方は日誌に残ったまま器の未読は増えない', async () => {
    // 全ターンを枠で失敗させ続け、届くたびに「未処理のまま保持され続ける」
    // 状況を作る（`#usageBlocked` が一度も晴れない）。
    const s = setup(undefined, createMemoryStores(), {
      resultFor: () => ({ subtype: 'error_during_execution', text: spendLimitMessage }),
    });

    s.clone.post(tokenPoolNotice('n1', '認証トークンが通る状態に戻った: 「alteroid-tok-1」'));
    await waitFor(
      () => s.calls[0]?.inputs.some((text) => text.includes('alteroid-tok-1')) ?? false,
      'turn 0（n1）がモデルへ渡る',
    );

    // n2 が届いた時点で n1 はまだ未処理（`#deferred` に保持されたまま）——
    // 合流して n1 を外し、n2 を代表にする。
    s.clone.post(tokenPoolNotice('n2', '認証トークンが通る状態に戻った: 「alteroid-tok-2」'));
    await waitFor(
      () => (s.calls[0]?.inputs.length ?? 0) >= 2,
      'turn 1（n2 との合流で誘発された再試行）が走る',
    );
    expect((s.calls[0] as FakeCall).inputs[1]).toContain('alteroid-tok-2');
    expect((s.calls[0] as FakeCall).inputs[1]).not.toContain('alteroid-tok-1');

    // さらに n3 —— このときもまだ未処理なのは n2 だけ（1件までという不変条件）。
    s.clone.post(tokenPoolNotice('n3', '認証トークンが通る状態に戻った: 「alteroid-tok-3」'));
    await waitFor(
      () => (s.calls[0]?.inputs.length ?? 0) >= 3,
      'turn 2（n3 との合流で誘発された再試行）が走る',
    );
    const inputs = (s.calls[0] as FakeCall).inputs;
    expect(inputs[2]).toContain('alteroid-tok-3');
    expect(inputs[2]).not.toContain('alteroid-tok-1');
    expect(inputs[2]).not.toContain('alteroid-tok-2');

    // 🔑 器の未読は増え続けない——生き残っているのは n3（代表）の1行だけ。
    // n1 / n2 はどちらも合流の時点で `#forget` されている。
    await waitFor(async () => (await s.stores.inbox.pending()).count === 1, '器の未読は1件のまま');
    const pending = await s.stores.inbox.pending();
    expect(pending.count).toBe(1);

    // 🔑 消えない——外した n1 / n2 の全文は日誌（external_event）に残る。
    const bodies = await s.stores.journal.list({ types: ['external_event'] });
    const summaries = bodies
      .filter((row): row is Extract<JournalEntry, { type: 'external_event' }> => {
        return row.type === 'external_event';
      })
      .map((row) => row.summary);
    expect(summaries.some((summary) => summary.includes('alteroid-tok-1'))).toBe(true);
    expect(summaries.some((summary) => summary.includes('alteroid-tok-2'))).toBe(true);

    // 🔑 「畳んだ」ことそのものも exchange の行として残る（時間の窓ではなく
    // 「未処理のまま残っているか」だけで判定している、という文言まで含めて）。
    const exchanges = await s.stores.journal.list({ types: ['exchange'] });
    const foldNotes = exchanges.filter(
      (row): row is Extract<JournalEntry, { type: 'exchange' }> =>
        row.type === 'exchange' && row.text.includes('時間の窓ではなく'),
    );
    expect(foldNotes.length).toBe(2); // n1→n2 の合流1回、n2→n3 の合流1回

    await s.clone.stop();
  });

  it('陰性対照1: 未処理の token-pool 通知が無い状態への単発の遷移では、必ずターンが1回起きて保持が解ける（合流する相手が無いので何も変わらない経路）', async () => {
    const s = setup(undefined, createMemoryStores(), {
      resultFor: (turnIndex) =>
        turnIndex < 1 ? { subtype: 'error_during_execution', text: spendLimitMessage } : undefined,
    });

    s.clone.post(tokenPoolNotice('solo', '認証トークンが通る状態に戻った: 「alteroid-solo」'));
    await waitFor(() => s.clone.usageBlocked, 'turn 0 が枠で失敗して保持される');
    expect((s.calls[0] as FakeCall).inputs).toHaveLength(1);

    // 合流できる同種の相手が居ない状態で、別の起点（人間の発言）が再武装の
    // 契機になる——`usageBlockAlwaysRearms` が無条件で再武装する3種類のうち
    // token-pool 以外の1つを使うことで、「合流の判定そのものには触れていない」
    // 経路であることを確かめる。
    s.clone.post(humanMessage('起きてる？'));
    await waitFor(() => !s.clone.usageBlocked, '保持が解けて turn 1 が成功し、枠が晴れる');
    // turn 1 は保持されていた solo の再試行（成功）。**人間の発言自身も、
    // その後ろで自分のターンを持つ**（turn 2）——それはこの直しの前から在る
    // 挙動で、合流の判定（token-pool 由来の `external` にしか効かない）とは
    // 無関係である。ここで数えたいのは「solo は失われずちょうど1回で
    // 保持が解けた」ことなので、turn 1 だけを見る。
    await waitFor(
      () => (s.calls[0]?.inputs.length ?? 0) >= 3,
      '人間の発言自身のターン（turn 2）も走り切る',
    );
    expect((s.calls[0] as FakeCall).inputs).toHaveLength(3);
    expect((s.calls[0] as FakeCall).inputs[1]).toContain('alteroid-solo');

    await s.clone.stop();
  });

  it('陰性対照2: 1件目を処理し終えた後に届いた token-pool 通知は、合流せず自分自身のターンを持つ（合流は「未処理の間」に限る）', async () => {
    const s = setup(undefined, createMemoryStores());

    s.clone.post(tokenPoolNotice('done-A', '認証トークンが通る状態に戻った: 「alteroid-done-A」'));
    // **`waitForDone(s.events)` は使わない** —— `external`（`source: 'self'`
    // 相当の内部起点）のターンには紐づく会話が無く（`#conversationOf` が
    // `null` を返す）、`s.events` はどの会話も購読していないのでここでは
    // 一度も届かず、`waitForDone` が永久に解決しない（実測: 5秒でタイムアウト
    // した）。他のテストと同じく `s.calls[0].inputs` の件数で待つ。
    await waitFor(
      () => s.calls[0]?.inputs.some((text) => text.includes('alteroid-done-A')) ?? false,
      'done-A が turn 0 でモデルへ渡り、成功する',
    );
    expect((s.calls[0] as FakeCall).inputs).toHaveLength(1);

    // done-A は成功して `#forget` 済み——`#pendingTokenPoolNotice` はここで
    // 既に null に戻っている。done-B は合流の相手が居ないので自分のターンを持つ。
    s.clone.post(tokenPoolNotice('done-B', '認証トークンが通る状態に戻った: 「alteroid-done-B」'));
    await waitFor(() => (s.calls[0]?.inputs.length ?? 0) >= 2, 'done-B が自分自身のターンを持つ');
    expect((s.calls[0] as FakeCall).inputs[1]).toContain('alteroid-done-B');

    await s.clone.stop();
  });

  /**
   * ⚠️ **前提: 拾い直した token-pool 通知は `stale` としてターンを起こさずに
   * 消される（`inbox-staleness.ts` の `restoredInboxEventVerdict`。Issue
   * #783 段1、この直しより前から在る既存の設計）。** ⟹ この束のテストは
   * 「拾い直された通知が turn として配り直される」ことを確かめるものでは
   * ない——そうはならない。確かめるのは2点だけである。
   *
   * 1. **合図は失われない**——`stale` として消される回でも、全文は必ず
   *    日誌（`external_event`）に残る（この直しの前からの保証。壊していない
   *    ことの固定）
   * 2. **合流の索引（`#pendingTokenPoolNotice`）が器の実体と食い違ったまま
   *    残らない**——`stale` の消し込みは `#forget` を通らない別経路
   *    （`#removeStaleRedeliveryChunk`）なので、そちらにも同じ後始末を
   *    書いていないと、器からは既に消えた id を代表として指したままになり、
   *    拾い直し後にいちばん最初に届く新しい token-pool 通知が「代表が
   *    まだ未処理で残っている」という偽の前提で処理される（比較対象が
   *    見つからず `#evictPendingTokenPoolRepresentative` が `null` を返す
   *    だけなので、実害は「合流しそこねる」— 能力の欠落ではなく、単に
   *    合流できないだけ — に留まるが、それでも代表の差し替えは正しく
   *    起こるべきなのでここで固定する）
   */
  it('器の入れ替えを跨いでも合図は失われない。拾い直された token-pool 通知は（既存の設計どおり）stale としてターンを起こさずに消えるが、全文は日誌に残り、拾い直し後にいちばん最初に届く新しい通知は自分自身のターンを持つ', async () => {
    const stores = createMemoryStores();
    const alwaysFail = {
      resultFor: () => ({ subtype: 'error_during_execution', text: spendLimitMessage }),
    };

    const first = setup(undefined, stores, alwaysFail);
    first.clone.post(tokenPoolNotice('r-A', '認証トークンが通る状態に戻った: 「alteroid-r-A」'));
    await waitFor(
      () => first.calls[0]?.inputs.some((text) => text.includes('alteroid-r-A')) ?? false,
      '1つ目の器: turn 0（r-A）がモデルへ渡る',
    );

    // r-B が届いた時点で r-A はまだ未処理——合流して r-A を外し、r-B を代表にする。
    first.clone.post(tokenPoolNotice('r-B', '認証トークンが通る状態に戻った: 「alteroid-r-B」'));
    await waitFor(
      () => (first.calls[0]?.inputs.length ?? 0) >= 2,
      '1つ目の器: turn 1（r-B）がモデルへ渡り、また枠で失敗して保持される',
    );
    expect((first.calls[0] as FakeCall).inputs[1]).toContain('alteroid-r-B');
    // r-A は既に外されて `#forget` 済みのはず——器の未読は r-B の1件だけ。
    await waitFor(
      async () => (await stores.inbox.pending()).count === 1,
      '1つ目の器を閉じる前に、未読が r-B の1件だけになる',
    );

    await first.clone.stop();

    // 2つ目の器（同じ stores＝再起動相当）。拾い直した r-B は `stale` なので
    // ターンは起きない——`#restoreUnreadPass` が消す（`#removeStaleRedeliveryChunk`）。
    const second = setup(undefined, stores, alwaysFail);

    // 🔑 1点目: 合図は失われない——消される回でも全文は日誌に残る。
    await waitFor(async () => {
      const rows = await stores.journal.list({ types: ['external_event'] });
      return rows.some(
        (row) => row.type === 'external_event' && row.summary.includes('alteroid-r-B'),
      );
    }, 'r-B の全文が日誌（external_event）に残る');

    // 器の未読が0件になる（stale として消えたので、モデルへは1文字も渡らない
    // まま片付く）。
    await waitFor(async () => (await stores.inbox.pending()).count === 0, '器の未読が0件になる');
    // ここまでモデルは一度も呼ばれていない——`stale` はターンを起こさない。
    expect(second.calls).toHaveLength(0);

    // r-C が届く——拾い直しで代表が正しく片付いている（`#pendingTokenPoolNotice`
    // が null に戻っている）なら、合流する相手が居ないので r-C は自分自身の
    // 最初のターンを持つ。**もし後始末が漏れて代表が r-B を指したまま残って
    // いたら**、`#evictPendingTokenPoolRepresentative` は `#inbox` にも
    // `#deferred` にも r-B を見つけられず `null` を返すだけなので、それでも
    // r-C 自身は配られる——ここでは「配られること」ではなく「代表が正しく
    // r-C に差し替わること」（次の r-D との合流が効くこと）まで見届ける。
    second.clone.post(tokenPoolNotice('r-C', '認証トークンが通る状態に戻った: 「alteroid-r-C」'));
    await waitFor(
      () => second.calls[0]?.inputs.some((text) => text.includes('alteroid-r-C')) ?? false,
      '2つ目の器: r-C が turn 0 でモデルへ渡る',
    );
    await waitFor(() => second.clone.usageBlocked, '2つ目の器: turn 0 も枠で失敗して保持される');

    // r-C がまだ未処理のうちに r-D が届く——代表が正しく r-C に差し替わって
    // いれば合流して r-C を外し、r-D を代表にする。
    second.clone.post(tokenPoolNotice('r-D', '認証トークンが通る状態に戻った: 「alteroid-r-D」'));
    await waitFor(
      () => (second.calls[0]?.inputs.length ?? 0) >= 2,
      '2つ目の器: turn 1（r-D との合流で誘発された再試行）が走る',
    );
    const secondInputs = (second.calls[0] as FakeCall).inputs;
    expect(secondInputs[1]).toContain('alteroid-r-D');
    expect(secondInputs[1]).not.toContain('alteroid-r-C');

    await second.clone.stop();
  });
});

/**
 * 枠（利用上限）に当たったら、合図を捨てずに保持し、次の合図が来たときに
 * 試し直す（`clone.ts` の `#usageBlocked` / `#deferred`）。
 *
 * タイマーは持たない。「試す」の契機は常に**新しい合図の到着**である。`post()`
 * は解除の印を立てるだけで、保持していた合図を FIFO の順で受信箱へ戻すのは
 * `#pump` の先頭である（**そこへ寄せてあるのが競合を塞いでいる本体** —
 * 下の「終端を出した直後…」／「短絡した合図の後始末の直前に…」の2本が、
 * 寄せる前に何が失われていたかを名指しで踏む）。戻した先頭が枠でまた落ちれば
 * `#usageBlocked` が再び立ち、残りはまた保持される（`#pump` の枠チェック）。
 */
