import { describe, it, expect } from 'vitest';
import { ALWAYS_REDELIVER, DAEMON_TOKEN_POOL_REOPENED_SOURCE, createClone } from './clone.js';
import { EXCHANGE_KIND_FAILURE_PREFIX } from './exchange-kind.js';
import { countsAsUndistilledActivity } from './distill-gap.js';
import { humanExchanges } from './conversation.js';
import { createLocalRunner } from './runner-local.js';
import { createRunnerRegistry } from './runner-protocol.js';
import type { InboxEvent, JournalEntry } from './schema.js';
import type { Stores } from './store.js';
import { createMemoryStores, humanMessage } from './testing.js';
import { fakeSdk, setup, wireEvents, waitFor, waitForTerminal } from './clone-test-harness.js';
import type { FakeCall, Setup } from './clone-test-harness.js';

describe('クローン — 枠に当たり続けたセッションは畳んで作り直す（Issue #1240）', () => {
  const spendLimitMessage = "You've hit your individual spend limit for this account.";

  /**
   * 1本 90,000 文字。**閾値（200,000）に対して選んだ大きさ**——2本
   * （起点＋再試行1回。180,000文字）では届かず、3本（起点＋再試行2回。
   * 270,000文字）で確実に超える。実際に積まれるのはこれに断り書き（`redelivery`
   * 等）が足された分なのでもっと大きいが、逆方向の余裕（2本で届いてしまう）
   * は無い——断り書きぶんは無視できるほど小さい。
   */
  const BIG_BODY = 'x'.repeat(90_000);

  /** 「枠の解除を試す」旨の日誌の行数（＝解除を試した回数そのもの）。 */
  async function releaseAttemptCount(stores: Stores): Promise<number> {
    const rows = (await stores.journal.list({ types: ['exchange'] })) as { text: string }[];
    return rows.filter((entry) => entry.text.includes('枠の解除を試す')).length;
  }

  async function waitForReleaseAttempts(stores: Stores, expected: number): Promise<void> {
    await waitFor(
      async () => (await releaseAttemptCount(stores)) === expected,
      `解除の試行が${String(expected)}回になる`,
    );
  }

  /** 発意 tick を1本作る。中身は無く、届いたこと自体が再試行を誘発する。 */
  function tick(id: string): InboxEvent {
    return { type: 'self_initiative', id, at: new Date().toISOString(), reason: 'テスト用tick' };
  }

  /**
   * 「`BIG_BODY` の発言 → 枠に当たる（1本ぶん）→ tick → 再試行して枠に当たる
   * （2本ぶん。まだ閾値未満）」まで進める共通の下ごしらえ。**3本目
   * （閾値超え）は呼び出し側が明示的に足す**——「2本では畳まない」ことを
   * 確かめる歯と共有するための切り方である。
   */
  async function driveToTwoAccumulations(stores: Stores, s: Setup): Promise<void> {
    s.clone.post(humanMessage(BIG_BODY));
    await waitFor(() => s.clone.usageBlocked, '1回目で枠に当たって保持される');

    s.clone.post(tick('evt-si-1'));
    await waitForReleaseAttempts(stores, 1);
    await waitFor(() => s.clone.usageBlocked, '再試行1回目もまた枠に当たる');
  }

  it('2本ぶん（180,000文字。閾値未満）までは畳まない。resume 素材は残る', async () => {
    const stores = createMemoryStores();
    const s = setup(undefined, stores, {
      resultSubtype: 'error_during_execution',
      resultText: spendLimitMessage,
    });

    // **⭐ ここが直す前は赤くならない対照——閾値未満では畳まれない。**
    await driveToTwoAccumulations(stores, s);
    expect(await stores.sessions.getCloneSessionId()).not.toBeNull();

    await s.clone.stop();
  });

  it('3本ぶん（270,000文字。閾値超え）で、resume 素材を捨てて次は新しいセッションで走る', async () => {
    const stores = createMemoryStores();
    const s = setup(undefined, stores, {
      resultSubtype: 'error_during_execution',
      resultText: spendLimitMessage,
    });

    await driveToTwoAccumulations(stores, s);

    // 3本目（270,000文字 ⟹ 閾値 200,000 を超える）。
    s.clone.post(tick('evt-si-2'));
    await waitForReleaseAttempts(stores, 2);

    // **⭐ ここが本体。** 積算が閾値を超えた時点で、次の境界のために resume
    // 素材が捨てられている（畳んだ後ではなく、印と同時——`#noteContextWindowFold`
    // と同じ形）。
    await waitFor(
      async () => (await stores.sessions.getCloneSessionId()) === null,
      '積算が閾値を超え、resume 素材が捨てられる',
    );

    // 次のターンは新しいセッションで走る（`calls.length` が増える）。
    await new Promise((resolve) => setTimeout(resolve, 80));
    s.clone.post(tick('evt-si-3'));
    await waitFor(() => s.calls.length > 1, '新しいセッションが開くこと');
    await s.clone.stop();

    expect(s.calls.length).toBeGreaterThan(1);
  });

  /**
   * **成功したら積算は0へ戻る**（`#usageBlockedAccumulatedChars` の doc）。
   *
   * ## この歯が居ないと何が起きるか（変異試験で確かめた。段4 に生出力を残す）
   *
   * `turn_ended` の成功枝で積算を戻す1行を消す変異を手で当てたところ、
   * **他の365本は1本も落ちなかった**（この歯を足す前は366本中0本がここを
   * 守っていた）。理由は単純で、既存の回帰テストはどれも「枠に当たり続ける
   * だけ」か「最初から成功し続ける」かのどちらかで、**「一度成功してから
   * また枠に当たる」を跨ぐテストが1本も無かった**——このリポジトリの流儀
   * （AGENTS.md「Issue の『確かめていないこと』は…仕事の指定である」）に
   * ならい、見つかった穴をここで埋める。
   */
  it('成功すると積算は0へ戻る——前の枠当たりの分を次の枠当たりへ持ち越さない', async () => {
    const stores = createMemoryStores();
    // **回数ではなく可変フラグで駆動する**（歯2「中身を持つ合図…」と同じ形）。
    // `resultFor` は本セッションのターンだけでなく `sideQuery`（蒸留）からも
    // 呼ばれうる（`fakeSdk` は文字列プロンプトでは常に `turnIndex=0` で呼ぶ）
    // ので、通し番号で「何本目か」を数えると側道の呼び出しに数字がずれる。
    // フラグなら、成功させたい1回の直前だけ立てて直後に降ろせるので、side
    // query が紛れ込んでも影響しない。
    let succeedNow = false;
    const s = setup(undefined, stores, {
      resultFor: () =>
        succeedNow
          ? { subtype: 'success', text: 'わかった' }
          : { subtype: 'error_during_execution', text: spendLimitMessage },
    });

    // 1本目の枠当たり: 180,000文字ぶん積む（まだ閾値未満）。
    await driveToTwoAccumulations(stores, s);
    const inputsSoFar = (s.calls[0] as FakeCall).inputs.length;

    // 解除させる（保持していた1本目の発言＝`BIG_BODY` が再試行され、
    // `succeedNow` が真なのでそれは成功する。**再試行の中身がどう転んでも
    // 構わない**——`succeedNow` が真のあいだは何が来ても成功するので、
    // 「1度でも成功が挟まったら積算が0へ戻るか」だけを測れる作りである。
    succeedNow = true;
    s.clone.post(tick('evt-si-2'));
    await waitFor(() => !s.clone.usageBlocked, '解除された発言が成功し、枠が解ける');
    // 成功の帰結（`#usageBlocked === null`）が届いた直後は、まだ同じ受信箱の
    // 反復のうちに残った合図（tick 自身の内部ターンなど）が処理され続けて
    // いることがある。**次の枠当たりを起こす前に、静まるまで少し待つ**
    // ——でないと、いま数えたいのとは別の要因で `s.calls[0].inputs` が
    // 動き続け、次の測定の基準がぶれる。
    await new Promise((resolve) => setTimeout(resolve, 80));
    succeedNow = false;
    expect(await stores.sessions.getCloneSessionId()).not.toBeNull();

    // 2本目の枠当たり: 新しい `BIG_BODY`（90,000文字）だけを持つ発言を送る。
    // **リセットされていれば、これ単独（約90,000文字）はまだ閾値
    // 200,000未満のはず。** 直す前の変異（成功でリセットしない）なら、
    // 1本目の 180,000文字余り（＋解除の途中で積まれた分）にこれが上乗せ
    // され、**この1本の失敗の時点で**閾値を超えて畳まれてしまう
    // （畳みの判定は `#noteUsageNotice` の中、そのターンの失敗の瞬間に
    // 行われる——`#noteUnproductiveUsageBlockFold` の doc）。
    s.clone.post(humanMessage(BIG_BODY));
    await waitFor(() => s.clone.usageBlocked, '2本目の枠当たり: 新しい発言だけで枠に当たる');

    // **⭐ ここが本体。** リセットされていれば、この1本（約90,000文字）だけ
    // では畳まれていない（resume 素材が残っている）。
    await new Promise((resolve) => setTimeout(resolve, 80));
    expect(await stores.sessions.getCloneSessionId()).not.toBeNull();
    // 参考: 実際に新しい入力が積まれたことも確かめる（測定が空振りでない証拠）。
    expect((s.calls[0] as FakeCall).inputs.length).toBeGreaterThan(inputsSoFar);

    await s.clone.stop();
  });

  it('畳んだ理由を「枠」だと人間へ言う（文脈窓だとは言わない。記録は消えたと言わない）', async () => {
    const stores = createMemoryStores();
    const s = setup(undefined, stores, {
      resultSubtype: 'error_during_execution',
      resultText: spendLimitMessage,
    });

    await driveToTwoAccumulations(stores, s);
    s.clone.post(tick('evt-si-2'));
    await waitForReleaseAttempts(stores, 2);
    await waitFor(
      async () => (await stores.sessions.getCloneSessionId()) === null,
      '積算が閾値を超え、resume 素材が捨てられる',
    );

    const rows = (await stores.journal.list({ types: ['exchange'], with: ['human'] })) as {
      role: string;
      text: string;
    }[];
    // **`#reportFailure` が書く1行だけを採る**（`with: 'human'` の outbound には
    // ターン失敗前に出ていた本文の控えも載るので、それと混同しない——
    // 「文脈窓で落ちたら…」の `lastToHuman` と同じ絞り方）。
    // **`journal.list()` は新しい順（降順）で返す** —— 直前の走査で確かめた
    // （最初に受理した発言の inbound 行が配列の最後に出る）。⟹ 最新の
    // 1件は `[0]` である。
    const outbound = rows.filter(
      (row) => row.role === 'outbound' && row.text.startsWith('いま利用上限に当たっているので'),
    );
    const last = outbound[0];
    await s.clone.stop();

    expect(last?.text).toContain('次の発言から新しく開き直す');
    // **原因は枠であって長さではない——文脈窓の断り書きを流用しない。**
    expect(last?.text).toContain('枠（利用上限）');
    // **⛔ 消えていないものを消えたことにしない**（`CONTEXT_WINDOW_FOLD_NOTICE`
    // と同じ約束）。
    expect(last?.text).toContain('消えていない');
    expect(last?.text).not.toContain('失われ');
  });
});

/**
 * 変更B: 回復予定時刻（`#usageBlocked.resetsAt`）より前は再武装しない。
 * ただし常に再武装する3種類（`human_message` / `human_answer` /
 * `manager_message` / `external` かつ `source: 'token-pool'`）は据え置く
 * （`usageBlockAlwaysRearms` の doc。Issue #1240 続き）。
 *
 * **`resetsAt` を持たせる経路は `rate_limit_event` だけである**
 * （`rejectedRateLimitNotice` の doc）。`resultText` を上限の文言に一致させない
 * ことで、`result` 側の `classifyUsageNotice` が二重に `#usageBlocked` を
 * 上書きしない形にしてある（既存の「rate_limit_event の status: rejected でも
 * 枠が閉じたと判定する」と同じ作法）。
 */
describe('クローン — 枠の回復予定時刻（resetsAt）より前は再武装しない（Issue #1240 続き）', () => {
  /** 過去の時刻。届いた瞬間から見て「もう過ぎている」resetsAt。 */
  const PAST_RESETS_AT_MS = 1_700_000_000_000;
  /** 十分先の時刻。テストの実行時間ぶんでは絶対に追いつかない resetsAt。 */
  const FUTURE_RESETS_AT_MS = () => Date.now() + 60 * 60 * 1000;

  function setupRateLimited(resetsAt: number): Setup {
    return setup(undefined, createMemoryStores(), {
      // **`result` 側の文言を上限のプレフィックスに当てない。** rate_limit_event
      // 経路だけが resetsAt を運ぶことを確かめたいので、result 側の
      // classifyUsageNotice が resetsAt を持たない notice で #usageBlocked を
      // 上書きしないようにする。
      resultSubtype: 'error_during_execution',
      resultText: '（結果なし。rate_limit_event だけが上限の理由を運ぶ）',
      rateLimitEventAt: () => ({ status: 'rejected', rateLimitType: 'five_hour', resetsAt }),
    });
  }

  async function releaseAttemptCount(s: Setup): Promise<number> {
    const exchanges = (await s.stores.journal.list({ types: ['exchange'] })) as { text: string }[];
    return exchanges.filter((entry) => entry.text.includes('枠の解除を試す')).length;
  }

  function tick(id: string): InboxEvent {
    return { type: 'self_initiative', id, at: new Date().toISOString(), reason: 'テスト用tick' };
  }

  /**
   * 中身の無い内部の合図を、複数回・連続して届けるための口。**`self_initiative`
   * ではなく `external`（トークンプール以外の任意の source）を使う** ——
   * `self_initiative` はどれも「同じ tick」として `isSameTick` に畳まれる
   * （type しか見ない）ので、前の1本がまだ待ち行列に残っているうちに次を
   * post すると、次が畳み込みで消えてしまう（`post()` の isTick 畳み込み）。
   * `external` は source が違えば `inboxCollapseKey` が `undefined` を返し
   * （`isDaemonSelfNotice` に当たらない限り畳まない）、`isTick` の対象にも
   * ならないので、この畳み込みを心配せずに複数本を連続で送れる。
   */
  function internalSignal(id: string): InboxEvent {
    return { type: 'external', id, at: new Date().toISOString(), source: `test-internal-${id}` };
  }

  it('resetsAt より前に届いた self_initiative は再武装しない', async () => {
    const s = setupRateLimited(FUTURE_RESETS_AT_MS());
    s.clone.post(humanMessage('一件目'));
    await waitFor(() => s.clone.usageBlocked, '枠に当たって保持される');

    const inputsBefore = (s.calls[0] as FakeCall).inputs.length;
    s.clone.post(tick('evt-si-1'));

    // **起きないことを確かめる歯なので、起きるまで待てない。** 少し待って
    // 「増えていない」ことを見る——`usageReleasePending` が真になっていない
    // ことと、実際にモデルへ渡った入力が増えていないことの両方を見る。
    await new Promise((resolve) => setTimeout(resolve, 80));
    expect(s.clone.usageReleasePending).toBe(false);
    expect(await releaseAttemptCount(s)).toBe(0);
    expect((s.calls[0] as FakeCall).inputs.length).toBe(inputsBefore);

    await s.clone.stop();
  });

  it('resetsAt より後（もう過ぎている）なら self_initiative でも再武装する', async () => {
    const s = setupRateLimited(PAST_RESETS_AT_MS);
    s.clone.post(humanMessage('一件目'));
    await waitFor(() => s.clone.usageBlocked, '枠に当たって保持される');

    s.clone.post(tick('evt-si-1'));
    await waitFor(async () => (await releaseAttemptCount(s)) === 1, '解除の試行が1回になる');

    await s.clone.stop();
  });

  it('resetsAt が分からない（文言だけの通知）なら、従来どおり self_initiative でも再武装する', async () => {
    // 後方互換: rate_limit_event を使わず、文言だけで検知させる
    // （`classifyUsageNotice` 経路。resetsAt を持たない）。
    const spendLimitMessage = "You've hit your individual spend limit for this account.";
    const s = setup(undefined, createMemoryStores(), {
      resultSubtype: 'error_during_execution',
      resultText: spendLimitMessage,
    });
    s.clone.post(humanMessage('一件目'));
    await waitFor(() => s.clone.usageBlocked, '枠に当たって保持される');

    s.clone.post(tick('evt-si-1'));
    await waitFor(async () => (await releaseAttemptCount(s)) === 1, '解除の試行が1回になる');

    await s.clone.stop();
  });

  it('token-pool の復帰通知（external）は resetsAt より前でも常に再武装する', async () => {
    const s = setupRateLimited(FUTURE_RESETS_AT_MS());
    s.clone.post(humanMessage('一件目'));
    await waitFor(() => s.clone.usageBlocked, '枠に当たって保持される');

    s.clone.post({
      type: 'external',
      id: 'evt-tokenpool-1',
      at: new Date().toISOString(),
      source: DAEMON_TOKEN_POOL_REOPENED_SOURCE,
    });
    await waitFor(async () => (await releaseAttemptCount(s)) === 1, '解除の試行が1回になる');

    await s.clone.stop();
  });

  /**
   * **⚠️ Issue #1223 再発: token-pool の3つ目の例外にも例外が在る。**
   *
   * `usageBlockAlwaysRearms` は token-pool の通知を無条件に再武装させるが、
   * その根拠は「プールの構成が変わると resetsAt の予定は無意味になる」
   * （`usageBlockAlwaysRearms` の doc）。**同じ鍵の観測ベースの回復
   * （`observedRecovery: true`）が、いま止まっている同じ鍵を指しているだけ
   * なら、プールは1文字も変わっていない**——`post()` の中の
   * `staleObservedRecoveryNoticeEvent` がこの1点だけを見て外す
   * （`tokenPoolReopenedPayload` の構造化した payload を読む。文言は見ない）。
   */
  describe('⚠️ Issue #1223 再発: 同じ鍵の観測ベース回復は resetsAt 前なら再武装しない', () => {
    /**
     * `setupRateLimited` に `tokenIdentity` を足したもの。**「止まったときの
     * 鍵」を確かめるにはセッションの身元が要る**——`setup` はこれを受けない
     * ので（`cloneWithIdentity` の doc と同じ理由）直に組む。
     */
    function setupRateLimitedWithIdentity(
      resetsAt: number,
      identity: () => { tokenId: string; generation: number } | undefined,
    ): Setup {
      const stores = createMemoryStores();
      const { fn, calls } = fakeSdk(undefined, {
        resultSubtype: 'error_during_execution',
        resultText: '（結果なし。rate_limit_event だけが上限の理由を運ぶ）',
        rateLimitEventAt: () => ({ status: 'rejected', rateLimitType: 'five_hour', resetsAt }),
      });
      const clone = createClone({
        redeliveryGate: ALWAYS_REDELIVER,
        stores,
        queryFn: fn,
        env: {},
        tokenIdentity: identity,
        runners: createRunnerRegistry([
          createLocalRunner({ workspacePath: '/work', queryFn: fakeSdk().fn, env: {} }),
        ]),
      });
      const { events, waitForEvents } = wireEvents(clone, 'conv-1');
      return { clone, stores, calls, events, waitForEvents };
    }

    /** token-pool の構造化した復帰通知（`wake()` が組む形。Issue #1223 再発）。 */
    function reopenedNotice(tokenId: string, observedRecovery: boolean): InboxEvent {
      return {
        type: 'external',
        id: `evt-tokenpool-${tokenId}-${String(observedRecovery)}`,
        at: new Date().toISOString(),
        source: DAEMON_TOKEN_POOL_REOPENED_SOURCE,
        payload: { text: 'ダミー本文', tokenId, observedRecovery },
      };
    }

    it('同じ鍵・観測ベースの回復は再武装しない（抑止へ回る）', async () => {
      const s = setupRateLimitedWithIdentity(FUTURE_RESETS_AT_MS(), () => ({
        tokenId: 'tok-a',
        generation: 1,
      }));
      s.clone.post(humanMessage('一件目'));
      await waitFor(() => s.clone.usageBlocked, '枠に当たって保持される');

      s.clone.post(reopenedNotice('tok-a', true));
      // **起きないことを確かめる歯なので、起きるまで待てない。**
      await new Promise((resolve) => setTimeout(resolve, 80));
      expect(s.clone.usageReleasePending).toBe(false);
      expect(await releaseAttemptCount(s)).toBe(0);

      await s.clone.stop();
    });

    it('違う鍵を指していれば、観測ベースでも常に再武装する', async () => {
      const s = setupRateLimitedWithIdentity(FUTURE_RESETS_AT_MS(), () => ({
        tokenId: 'tok-a',
        generation: 1,
      }));
      s.clone.post(humanMessage('一件目'));
      await waitFor(() => s.clone.usageBlocked, '枠に当たって保持される');

      s.clone.post(reopenedNotice('tok-b', true));
      await waitFor(async () => (await releaseAttemptCount(s)) === 1, '解除の試行が1回になる');

      await s.clone.stop();
    });

    it('観測ベースでない（「回した」「冷却が明けた」相当）なら、同じ鍵でも常に再武装する', async () => {
      const s = setupRateLimitedWithIdentity(FUTURE_RESETS_AT_MS(), () => ({
        tokenId: 'tok-a',
        generation: 1,
      }));
      s.clone.post(humanMessage('一件目'));
      await waitFor(() => s.clone.usageBlocked, '枠に当たって保持される');

      s.clone.post(reopenedNotice('tok-a', false));
      await waitFor(async () => (await releaseAttemptCount(s)) === 1, '解除の試行が1回になる');

      await s.clone.stop();
    });

    it('いまの鍵の身元が分からない（tokenIdentity 未設定）なら、判定できないので常に再武装する', async () => {
      const s = setupRateLimitedWithIdentity(FUTURE_RESETS_AT_MS(), () => undefined);
      s.clone.post(humanMessage('一件目'));
      await waitFor(() => s.clone.usageBlocked, '枠に当たって保持される');

      s.clone.post(reopenedNotice('tok-a', true));
      await waitFor(async () => (await releaseAttemptCount(s)) === 1, '解除の試行が1回になる');

      await s.clone.stop();
    });
  });

  it('人間の発言は resetsAt より前でも常に再武装する', async () => {
    const s = setupRateLimited(FUTURE_RESETS_AT_MS());
    s.clone.post(humanMessage('一件目'));
    await waitFor(() => s.clone.usageBlocked, '枠に当たって保持される');

    s.clone.post(humanMessage('二件目'));
    await waitFor(async () => (await releaseAttemptCount(s)) === 1, '解除の試行が1回になる');

    await s.clone.stop();
  });

  /**
   * **🔴 2026-09-24 の実運用: 枠で落ちたマネージャーの報告のたびに、クローンも
   * 1ターン回して 429 を踏んでいた**（「内部の失敗記録を畳んだ: 867 件」）。
   * 機構が合成した失敗の知らせ（`synthesized: true`）は枠が開いた証拠に
   * ならないので、回復予定時刻より前なら再武装しない。
   */
  function managerNotice(id: string, synthesized: boolean): InboxEvent {
    return {
      type: 'manager_message',
      id,
      at: new Date().toISOString(),
      managerId: 'mgr-limit',
      kind: 'report',
      text: '（このターンは応答を返さずに終わった: success/429 / result_is_error）',
      ...(synthesized ? { synthesized: true as const } : {}),
    };
  }

  it('🔴 機構が合成したマネージャーの失敗の知らせは、resetsAt より前なら再武装しない', async () => {
    const s = setupRateLimited(FUTURE_RESETS_AT_MS());
    s.clone.post(humanMessage('一件目'));
    await waitFor(() => s.clone.usageBlocked, '枠に当たって保持される');

    const inputsBefore = (s.calls[0] as FakeCall).inputs.length;
    s.clone.post(managerNotice('evt-mgr-synth-1', true));
    // **消えていない**（保持へ回った）ことを待ってから「試していない」を見る。
    await waitFor(async () => {
      const pending = await s.stores.inbox.claimPending();
      return pending.some((p) => p.event.id === 'evt-mgr-synth-1');
    }, '合成された知らせが未読のまま保持される');

    expect(s.clone.usageReleasePending).toBe(false);
    expect(await releaseAttemptCount(s)).toBe(0);
    expect((s.calls[0] as FakeCall).inputs.length).toBe(inputsBefore);

    await s.clone.stop();
  });

  it('マネージャー本人の報告（synthesized なし）は、resetsAt より前でも従来どおり再武装する', async () => {
    const s = setupRateLimited(FUTURE_RESETS_AT_MS());
    s.clone.post(humanMessage('一件目'));
    await waitFor(() => s.clone.usageBlocked, '枠に当たって保持される');

    s.clone.post(managerNotice('evt-mgr-own-1', false));
    await waitFor(async () => (await releaseAttemptCount(s)) === 1, '解除の試行が1回になる');

    await s.clone.stop();
  });

  it('機構が合成した知らせでも、resetsAt が過ぎていれば再武装する', async () => {
    const s = setupRateLimited(PAST_RESETS_AT_MS);
    s.clone.post(humanMessage('一件目'));
    await waitFor(() => s.clone.usageBlocked, '枠に当たって保持される');

    s.clone.post(managerNotice('evt-mgr-synth-past', true));
    await waitFor(async () => (await releaseAttemptCount(s)) === 1, '解除の試行が1回になる');

    await s.clone.stop();
  });

  /**
   * **🔴 文言だけの枠でも回復予定時刻を持つ**（`withNoticeTextResetsAt`）。
   * 本番の枠は `rate_limit_event` を伴わず文言だけで届く回があり、直す前は
   * `resetsAt` が常に「不明」＝どの合図でも試していた。
   */
  function resetsAtText(at: number): { text: string; expected: number } {
    // 2時間先の「分の頭」を UTC の 12 時間表記で書く（窓＝既定の5時間の内側）。
    const target = at - (at % 60_000) + 2 * 60 * 60 * 1000;
    const date = new Date(target);
    const hour24 = date.getUTCHours();
    const hour12 = hour24 % 12 === 0 ? 12 : hour24 % 12;
    const minute = String(date.getUTCMinutes()).padStart(2, '0');
    const meridiem = hour24 < 12 ? 'am' : 'pm';
    return {
      text:
        "You've hit your org's monthly spend limit · ask your admin to raise it at " +
        `claude.ai/admin-settings/usage · your session limit resets ${String(hour12)}:${minute}${meridiem} (UTC)`,
      expected: target,
    };
  }

  it('🔴 文言だけの枠でも、文言の時刻を回復予定時刻として持ち、それより前は内部の合図で再武装しない', async () => {
    const { text, expected } = resetsAtText(Date.now());
    const s = setup(undefined, createMemoryStores(), {
      resultSubtype: 'error_during_execution',
      resultText: text,
    });
    s.clone.post(humanMessage('一件目'));
    await waitFor(() => s.clone.usageBlocked, '枠に当たって保持される');

    expect(s.clone.usageBlockedResetsAt).toBe(expected);

    s.clone.post(tick('evt-si-text-1'));
    await new Promise((resolve) => setTimeout(resolve, 80));
    expect(s.clone.usageReleasePending).toBe(false);
    expect(await releaseAttemptCount(s)).toBe(0);

    await s.clone.stop();
  });

  it('抑止した回数は捨てず、実際に解除を試した1行へ畳んで出て0へ戻る', async () => {
    const s = setupRateLimited(FUTURE_RESETS_AT_MS());
    s.clone.post(humanMessage('一件目'));
    await waitFor(() => s.clone.usageBlocked, '枠に当たって保持される');

    // 抑止される内部の合図を2回届ける。**器へ未読として残ったことを見て
    // 次へ進む**（壁時計の sleep ではなく、実際に保持へ回ったことを待つ）。
    s.clone.post(internalSignal('evt-si-1'));
    await waitFor(async () => {
      const pending = await s.stores.inbox.claimPending();
      return pending.some((p) => p.event.id === 'evt-si-1');
    }, 'evt-si-1 が未読のまま保持される');
    s.clone.post(internalSignal('evt-si-2'));
    await waitFor(async () => {
      const pending = await s.stores.inbox.claimPending();
      return pending.some((p) => p.event.id === 'evt-si-2');
    }, 'evt-si-2 が未読のまま保持される');
    expect(s.clone.usageReleasePending).toBe(false);
    expect(await releaseAttemptCount(s)).toBe(0);

    // 常に再武装する人間の発言で、実際に解除を試す。
    s.clone.post(humanMessage('二件目'));
    await waitFor(async () => (await releaseAttemptCount(s)) === 1, '解除の試行が1回になる');

    const exchanges = (await s.stores.journal.list({ types: ['exchange'] })) as { text: string }[];
    const releaseLine = exchanges.find((entry) => entry.text.includes('枠の解除を試す'));
    expect(releaseLine?.text).toContain('再武装を抑止: 2 回');

    // **0へ戻る**——同じ資格でもう一度抑止される self_initiative を送っても、
    // 次に出る「解除を試す」行の抑止件数は前回の2を引きずらない（1のまま）。
    await waitFor(() => s.clone.usageBlocked, '二件目の再試行がまた枠に当たる');
    s.clone.post(internalSignal('evt-si-3'));
    await waitFor(async () => {
      const pending = await s.stores.inbox.claimPending();
      return pending.some((p) => p.event.id === 'evt-si-3');
    }, 'evt-si-3 が未読のまま保持される');
    s.clone.post(humanMessage('三件目'));
    await waitFor(async () => (await releaseAttemptCount(s)) === 2, '解除の試行が2回になる');

    const exchangesAfter = (await s.stores.journal.list({ types: ['exchange'] })) as {
      text: string;
    }[];
    const releaseLines = exchangesAfter.filter((entry) => entry.text.includes('枠の解除を試す'));
    expect(releaseLines).toHaveLength(2);
    // `journal.list()` は降順（新しい順）を返す（ファイル冒頭近くの同じ注記）
    // ⟹ `[0]` が2回目（三件目で起きた解除。抑止は evt-si-3 の1件だけ）、
    // `[1]` が1回目（二件目で起きた解除。抑止は evt-si-1 / evt-si-2 の2件）。
    expect(releaseLines[0]?.text).toContain('再武装を抑止: 1 回');
    expect(releaseLines[0]?.text).not.toContain('再武装を抑止: 2 回');
    expect(releaseLines[1]?.text).toContain('再武装を抑止: 2 回');

    await s.clone.stop();
  });
});

/**
 * **`Clone#post()` を実際に通した検証（Issue #1298）。**
 *
 * `inboxCollapseKey`（`inbox-backlog.ts`）の `external` 分岐は、
 * `isDaemonSelfNotice` が真の合図（token-pool の復帰通知など）を `source` +
 * `payload` の丸ごと `JSON.stringify` で鍵にしていた。`describeReopenedTokenNotice`
 * （`apps/daemon/src/index.ts`）は畳んだ件数を本文（`payload.text`）へ焼き
 * 込むので、**同じトークン・同じ `how`（同じ出来事）でも畳んだ件数が違うだけで
 * `payload` が別物になり、鍵も別になっていた**——`Clone#post()` は2件とも新しい
 * 行として受信箱へ積んでいた（1件も畳まれない）。
 *
 * **⚠️ 最初の1本目（「陽性対照（直す前）」）はこの状態を実際に `Clone#post()` へ
 * 通して固定していた**（コミット `4dffdb0`。`event.identity` を足す前）。
 * `inbox-backlog.test.ts` の「external + source: token-pool: payload が違えば
 * 別の鍵（陰性対照）」が鍵関数だけを単体で確かめているのに対し、こちらは
 * 受信箱に実際に何行残るかまで見ていた。
 *
 * **⟹ 直した（このコミット）。** `event.identity`（{@link InboxEvent} の
 * `external` 分岐）という opt-in の欄を鍵の優先入力にし、`wake()`
 * （`apps/daemon/src/index.ts`）が `deliveredIdentity(reopened)` をそこへ渡す
 * ようにした。**この歯はテストを消さず、期待値を反転させる形で更新した**
 * （AGENTS.md「テストを弱めずに直す」の反転の条件）——
 *
 * 1. **変更した事実**: 「陽性対照（直す前）」は「`identity` を渡さない場合
 *    （後方互換）」として残し、期待値（2行のまま積まれる）はそのまま維持した
 *    ——`identity` を渡さない送信元（webhook・`runner-registry`）の挙動は
 *    1文字も変えていないので、ここは反転していない。
 * 2. **なぜ必要になったか**: 上の doc のとおり、`payload` 丸ごとを鍵にすると
 *    畳んだ件数の違いだけで同じ出来事が別々に積まれ、受信箱の滞留の主因に
 *    なっていた（#1298 本文・#783 の実測）。
 * 3. **なぜ保証が弱くなっていないか**: 新しく足した「`identity` を渡せば
 *    畳まれる」は既存のアサーションを1つも緩めておらず、**むしろ増やしている**
 *    ——畳んだ後も受信箱に合図が1件残ること・畳んだこと自体の跡（見分けを
 *    含む）が消えずに日誌へ残ること・別のトークン／別の `how` は依然として
 *    畳まれないこと（下の「陰性対照」）を新たに固定した。
 */
describe('クローン — token-pool の復帰通知: 畳んだ件数だけが違う2通の扱い（Issue #1298）', () => {
  const FUTURE_RESETS_AT_MS = () => Date.now() + 60 * 60 * 1000;

  function setupRateLimited(resetsAt: number): Setup {
    return setup(undefined, createMemoryStores(), {
      resultSubtype: 'error_during_execution',
      resultText: '（結果なし。rate_limit_event だけが上限の理由を運ぶ）',
      rateLimitEventAt: () => ({ status: 'rejected', rateLimitType: 'five_hour', resetsAt }),
    });
  }

  /** 隣の describe（Issue #1240 続き）と同じ形（このファイルでの慣習）。 */
  async function releaseAttemptCount(s: Setup): Promise<number> {
    const exchanges = (await s.stores.journal.list({ types: ['exchange'] })) as { text: string }[];
    return exchanges.filter((entry) => entry.text.includes('枠の解除を試す')).length;
  }

  /**
   * `describeReopenedTokenNotice`（`apps/daemon/src/index.ts`）が実際に返す
   * 本文の形をそのまま真似る——base に、`folded > 0` のときだけ件数の前置きが
   * 付く。**同じトークン・同じ `how` なら `tokenId` / `how` は固定**にして
   * ある——ここで動かすのは `folded` だけであり、それが「同じ出来事」の
   * 条件である。**`identity` は省略可能**（渡さなければ #1298 の直る前と
   * 同じ形——`apps/daemon/src/index.ts` の `deliveredIdentity` が実際に返す
   * 形を模した固定文字列を渡せば、直った後の形になる）。
   */
  function tokenPoolReopenedNotice(
    id: string,
    folded: number,
    options?: { readonly tokenId?: string; readonly how?: string; readonly identity?: string },
  ): InboxEvent {
    const tokenId = options?.tokenId ?? 'tok-a';
    const how = options?.how ?? 'また通るようになった';
    const base =
      `認証トークンが通る状態に戻った（${how}）: ` +
      `「本命」（id ${tokenId}）。枠で止まっていた仕事は、ここから再開できる。`;
    const text =
      folded <= 0
        ? base
        : `${base}（この間に同じ合図が ${String(folded + 1)} 件届き、1件にまとめた）`;
    return {
      type: 'external',
      id,
      at: new Date().toISOString(),
      source: DAEMON_TOKEN_POOL_REOPENED_SOURCE,
      payload: { text },
      ...(options?.identity !== undefined ? { identity: options.identity } : {}),
    };
  }

  it('陽性対照（直す前）: identity を渡さなければ、folded だけが違う2通は別の行のまま（後方互換）', async () => {
    const s = setupRateLimited(FUTURE_RESETS_AT_MS());
    s.clone.post(humanMessage('一件目'));
    await waitFor(() => s.clone.usageBlocked, '枠に当たって保持される');

    s.clone.post(tokenPoolReopenedNotice('evt-reopen-1', 4));
    await waitFor(
      async () => (await s.stores.inbox.peekPending()).some((p) => p.event.id === 'evt-reopen-1'),
      '1件目（folded=4）が受信箱に積まれる',
    );

    s.clone.post(tokenPoolReopenedNotice('evt-reopen-2', 7));
    await waitFor(
      async () => (await s.stores.inbox.peekPending()).some((p) => p.event.id === 'evt-reopen-2'),
      '2件目（folded=7）が受信箱に積まれる',
    );

    // `identity` を渡していない送信元（webhook・`runner-registry` など）は
    // #1298 の直しの影響を受けない——同じトークン・同じ `how` でも `folded`
    // が違えば `payload.text` が別物になり、`inboxCollapseKey` が別の鍵を
    // 返す ⟹ 2件とも受信箱に残る。
    const pending = await s.stores.inbox.peekPending();
    const reopenRows = pending.filter(
      (p) => p.event.id === 'evt-reopen-1' || p.event.id === 'evt-reopen-2',
    );
    expect(reopenRows).toHaveLength(2);

    await s.clone.stop();
  });

  it('直った後: identity が同じなら、folded だけが違う2通は1行に畳まれる。合図は消えず、クローンは再開できる', async () => {
    const s = setupRateLimited(FUTURE_RESETS_AT_MS());
    s.clone.post(humanMessage('一件目'));
    await waitFor(() => s.clone.usageBlocked, '枠に当たって保持される');

    const identity = '5:tok-aまた通るようになった';
    s.clone.post(tokenPoolReopenedNotice('evt-reopen-1', 4, { identity }));
    await waitFor(
      async () => (await s.stores.inbox.peekPending()).some((p) => p.event.id === 'evt-reopen-1'),
      '1件目（folded=4）が受信箱に積まれる（代表）',
    );

    s.clone.post(tokenPoolReopenedNotice('evt-reopen-2', 7, { identity }));
    // 2件目は行としては積まれない（畳まれる）。「積まれない」ことは待てない
    // ので、日誌に畳んだ跡が付くのを待つ（`#foldIntoPendingCollapse` の
    // `row-folded` 分岐）。
    await waitFor(async () => {
      const exchanges = (await s.stores.journal.list({ types: ['exchange'] })) as {
        text: string;
      }[];
      return exchanges.some((entry) => entry.text.includes('受信箱の行は増やさずに'));
    }, '2件目が行を増やさずに畳まれた跡が日誌に付く');

    // **受信箱には1行しか残らない**（#1298 が直る前は2行残っていた——上の
    // 「陽性対照（直す前）」と対になる）。
    const pending = await s.stores.inbox.peekPending();
    const reopenRows = pending.filter(
      (p) => p.event.id === 'evt-reopen-1' || p.event.id === 'evt-reopen-2',
    );
    expect(reopenRows).toHaveLength(1);
    expect(reopenRows[0]?.event.id).toBe('evt-reopen-1');

    // **畳んだこと自体は跡に残る（合図は消えていない）。** `#foldIntoPendingCollapse`
    // の `row-folded` 分岐の doc が言うとおり、2件目の生の本文そのものは
    // ここでは日誌へ書かれない——それは「束ね読み」（#841）が実際のターンの
    // 中で書く役目であり、ここで書くと同じ本文が二重に載る（doc の逐語）。
    // ここで確かめるのは、**畳んだという事実と、畳んだ合図の見分け
    // （`inboxEventShape`）が跡として残ること**——「静かに消えた」との違いが
    // ここで見える。
    const exchanges = (await s.stores.journal.list({ types: ['exchange'] })) as { text: string }[];
    const foldLines = exchanges.filter((entry) => entry.text.includes('受信箱の行は増やさずに'));
    expect(foldLines).toHaveLength(1);
    expect(foldLines[0]?.text).toContain('external source.chars=10 payload=yes');
    expect(foldLines[0]?.text).toContain('本文と届いた時刻はこのあと束ね読み');

    // **クローンは再開できる**——token-pool の通知は常に再武装する
    // （`usageBlockAlwaysRearms`）ので、畳まれた2件目のぶんも含めて実際に
    // 解除の試行（ターン）が走る。`resetsAt` はまだ先なので、この試行はまた
    // 枠に当たって終わる——それでも「試みたこと」自体がここで見たい不変条件
    // である（隣の describe「token-pool の復帰通知（external）は resetsAt
    // より前でも常に再武装する」と同じ形）。
    await waitFor(async () => (await releaseAttemptCount(s)) >= 1, '解除の試行が走る');

    await s.clone.stop();
  });

  it('陰性対照: identity が同じでも tokenId が違えば別の行のまま（合図は消えない）', async () => {
    const s = setupRateLimited(FUTURE_RESETS_AT_MS());
    s.clone.post(humanMessage('一件目'));
    await waitFor(() => s.clone.usageBlocked, '枠に当たって保持される');

    s.clone.post(
      tokenPoolReopenedNotice('evt-reopen-a', 0, { tokenId: 'tok-a', identity: 'id-a' }),
    );
    await waitFor(
      async () => (await s.stores.inbox.peekPending()).some((p) => p.event.id === 'evt-reopen-a'),
      'トークン A の復帰通知が受信箱に積まれる',
    );

    s.clone.post(
      tokenPoolReopenedNotice('evt-reopen-b', 0, { tokenId: 'tok-b', identity: 'id-b' }),
    );
    await waitFor(
      async () => (await s.stores.inbox.peekPending()).some((p) => p.event.id === 'evt-reopen-b'),
      'トークン B の復帰通知が受信箱に積まれる',
    );

    // **違うトークンの「戻った」は別の出来事——畳んではいけない。**
    const pending = await s.stores.inbox.peekPending();
    const reopenRows = pending.filter(
      (p) => p.event.id === 'evt-reopen-a' || p.event.id === 'evt-reopen-b',
    );
    expect(reopenRows).toHaveLength(2);

    await s.clone.stop();
  });

  it('陰性対照: 同じトークンでも how が違えば別の行のまま（根拠の強さが違うので潰さない）', async () => {
    const s = setupRateLimited(FUTURE_RESETS_AT_MS());
    s.clone.post(humanMessage('一件目'));
    await waitFor(() => s.clone.usageBlocked, '枠に当たって保持される');

    s.clone.post(
      tokenPoolReopenedNotice('evt-reopen-rotated', 0, {
        how: '回した',
        identity: 'id-回した',
      }),
    );
    await waitFor(
      async () =>
        (await s.stores.inbox.peekPending()).some((p) => p.event.id === 'evt-reopen-rotated'),
      '「回した」の通知が受信箱に積まれる',
    );

    s.clone.post(
      tokenPoolReopenedNotice('evt-reopen-recovered', 0, {
        how: 'また通るようになった',
        identity: 'id-また通るようになった',
      }),
    );
    await waitFor(
      async () =>
        (await s.stores.inbox.peekPending()).some((p) => p.event.id === 'evt-reopen-recovered'),
      '「また通るようになった」の通知が受信箱に積まれる',
    );

    // **`how` は根拠の強さが違う（`ReopenedHow` の doc）——同じトークンでも
    // 潰してはいけない。**
    const pending = await s.stores.inbox.peekPending();
    const reopenRows = pending.filter(
      (p) => p.event.id === 'evt-reopen-rotated' || p.event.id === 'evt-reopen-recovered',
    );
    expect(reopenRows).toHaveLength(2);

    await s.clone.stop();
  });
});

/**
 * 変更C: 保持中の「内部ターンが失敗した」を、人間が待っていない合図
 * （`#conversationOf(event) === null`）については1件ごとに日誌へ書かず、
 * 畳んだ件数だけを数える（`#pump` の枠ブロックの doc。Issue #1240 続き）。
 *
 * **会話に紐づく失敗（`人間との対話ターンが失敗した`）は1文字も変えていない**
 * ——別の describe（「枠で保持している間、人間へ返す1行を積み上げない」）が
 * その保証を持つ。ここで見るのは内部側だけである。
 */
describe('クローン — 保持中の内部の合図は、失敗記録を1件ごとに日誌へ書かない（Issue #1240 続き）', () => {
  const spendLimitMessage = "You've hit your individual spend limit for this account.";
  const internalFailureMark = `${EXCHANGE_KIND_FAILURE_PREFIX}内部ターンが失敗した`;

  async function internalFailureCount(s: Setup): Promise<number> {
    const exchanges = (await s.stores.journal.list({ types: ['exchange'] })) as {
      with: string;
      text: string;
    }[];
    return exchanges.filter(
      (entry) => entry.with === 'self' && entry.text.startsWith(internalFailureMark),
    ).length;
  }

  /**
   * 中身の無い内部の合図を、複数回・連続して届けるための口。**`self_initiative`
   * ではなく `external`（任意の source）を使う** —— `self_initiative` は
   * どれも「同じ tick」として `isSameTick` に畳まれる（type しか見ない）ので、
   * 前の1本がまだ待ち行列に残っているうちに次を post すると、次が畳み込みで
   * 消えてしまう（`post()` の isTick 畳み込み）。`external` は source が
   * 違えば `inboxCollapseKey` が `undefined` を返し（`isDaemonSelfNotice` に
   * 当たらない限り畳まない）、`isTick` の対象にもならないので、この畳み込みを
   * 心配せずに複数本を連続で送れる。
   */
  function internalSignal(id: string): InboxEvent {
    return { type: 'external', id, at: new Date().toISOString(), source: `test-internal-${id}` };
  }

  it('保持件数が増えても、内部の失敗記録は再武装の回数ぶんしか増えない（N×M にならない）', async () => {
    // **狙い**: 直す前は「保持 N 件 × 再武装 M 回」ぶん増えていた
    // （`#pump` の枠ブロックの doc）。ここでは3回の再武装（2本目・3本目・
    // 4本目の到着）で保持件数が 1→2→3 と増えていく間、内部の失敗記録が
    // `1 + 再武装回数`（＝1,2,3,4）という**線形**にしか増えないことを見る。
    // 保持の先頭1本だけが実際に再試行されて本物の失敗を書き（この経路は
    // 変わっていない）、残りは畳まれて書かれない。
    const s = setup(undefined, createMemoryStores(), {
      resultSubtype: 'error_during_execution',
      resultText: spendLimitMessage,
    });

    // 1本目: 実際に失敗して枠に当たる（内部ターンの失敗が1件、実際のターンの
    // 失敗として記録される——これは変更Cの対象外の経路である）。
    s.clone.post(internalSignal('evt-1'));
    await waitFor(async () => (await internalFailureCount(s)) === 1, '1本目の失敗が記録される');
    await waitFor(() => s.clone.usageBlocked, '枠に当たって保持される');

    // 2本目: 到着が1本目の再試行を誘発する（保持の先頭が実際に再試行され、
    // 同じ理由でまた失敗するので本物の失敗記録がもう1件増える＝合計2）。
    // 2本目自身は #pump の短絡（枠が閉じている）へ回り、conversationId が
    // null なので `#reportFailure` を呼ばずに畳む。
    s.clone.post(internalSignal('evt-2'));
    await waitFor(
      async () => (await internalFailureCount(s)) === 2,
      '1本目の再試行の失敗が記録される',
    );

    // 3本目: 保持は [1本目, 2本目] の2件。先頭（1本目）だけが再試行されて
    // 本物の失敗が増える（合計3）。2本目・3本目自身は畳まれる。
    s.clone.post(internalSignal('evt-3'));
    await waitFor(
      async () => (await internalFailureCount(s)) === 3,
      '2周目の再試行の失敗が記録される',
    );

    // 4本目: 保持は [1本目, 2本目, 3本目] の3件。先頭だけが再試行されて
    // 本物の失敗が増える（合計4）。**保持件数が3件に増えても、増えるのは
    // 依然として1件だけである**——これが N×M ではなく M であることの核心。
    s.clone.post(internalSignal('evt-4'));
    await waitFor(
      async () => (await internalFailureCount(s)) === 4,
      '3周目の再試行の失敗が記録される',
    );

    // ここでさらに増えないことも確かめる（余計な書き込みが遅れて来ていない）。
    await new Promise((resolve) => setTimeout(resolve, 60));
    expect(await internalFailureCount(s)).toBe(4);

    await s.clone.stop();
  });

  it('畳んだ件数は失われず、実際に解除を試した1行へ「畳んだ」件数として残り、そのつど0へ戻る', async () => {
    const s = setup(undefined, createMemoryStores(), {
      resultSubtype: 'error_during_execution',
      resultText: spendLimitMessage,
    });

    s.clone.post(internalSignal('evt-1'));
    await waitFor(() => s.clone.usageBlocked, '枠に当たって保持される');

    // 1回目の解除（2本目が誘発）: この時点ではまだ何も畳んでいないので、
    // 出る行に「畳んだ」の一文は無い。
    s.clone.post(internalSignal('evt-2'));
    await waitFor(
      async () => (await internalFailureCount(s)) === 2,
      '1本目の再試行の失敗が記録される',
    );
    await waitFor(() => s.clone.usageBlocked, '1本目の再試行もまた枠に当たる');

    // 2回目の解除（3本目が誘発）: 1回目の周で畳んだ2本目の1件ぶんがこの
    // 行へ出る。
    s.clone.post(internalSignal('evt-3'));
    await waitFor(
      async () => (await internalFailureCount(s)) === 3,
      '2周目の再試行の失敗が記録される',
    );
    await waitFor(() => s.clone.usageBlocked, '2周目の再試行もまた枠に当たる');

    // 3回目の解除（4本目が誘発）: 2回目の周で畳んだのは2本目・3本目の
    // 2件——**1回目の周で畳んだ1件を引きずっていない**（0へ戻っているので、
    // この行は2件だけを持つ）。
    s.clone.post(internalSignal('evt-4'));
    await waitFor(
      async () => (await internalFailureCount(s)) === 4,
      '3周目の再試行の失敗が記録される',
    );

    const exchanges = (await s.stores.journal.list({ types: ['exchange'] })) as { text: string }[];
    const releaseLines = exchanges
      .filter((entry) => entry.text.includes('枠の解除を試す'))
      .map((entry) => entry.text);
    // `journal.list()` は降順（新しい順）。
    expect(releaseLines).toHaveLength(3);
    expect(releaseLines[2]).not.toContain('内部の失敗記録を畳んだ');
    expect(releaseLines[1]).toContain('内部の失敗記録を畳んだ: 1 件');
    expect(releaseLines[0]).toContain('内部の失敗記録を畳んだ: 2 件');
    expect(releaseLines[0]).not.toContain('内部の失敗記録を畳んだ: 3 件');

    await s.clone.stop();
  });

  // **件数の射程を名乗る**（Issue #1344）。`#usageBlockFoldedInternalFailures` /
  // `#usageBlockSuppressedRearms` はメモリ上にしか無く、器の入れ替えを跨ぐと消え、
  // ターンの成功で枠が降りた回（`#pump` を経由しない `#usageBlocked = null`）は
  // 日誌へ出さずに0へ戻る。⟹ この1行の件数は下限である。**それを行そのものに
  // 名乗らせる**——読む人が「この枠でぜんぶで何件だったか」と読まないように。
  const FOLD_COUNT_SCOPE_PHRASES = [
    'この枠の区間でこのプロセスが数えた分だけ',
    '器の入れ替えを跨いだ分',
    'ターンの成功で枠が降りた回の分',
    '下限',
  ] as const;

  it('解除の1行の件数は、この枠の区間・このプロセスの分だけで下限であることを名乗る（件数が0の行には付けない）', async () => {
    const s = setup(undefined, createMemoryStores(), {
      resultSubtype: 'error_during_execution',
      resultText: spendLimitMessage,
    });

    s.clone.post(internalSignal('evt-1'));
    await waitFor(() => s.clone.usageBlocked, '枠に当たって保持される');
    s.clone.post(internalSignal('evt-2'));
    await waitFor(
      async () => (await internalFailureCount(s)) === 2,
      '1本目の再試行の失敗が記録される',
    );
    await waitFor(() => s.clone.usageBlocked, '1本目の再試行もまた枠に当たる');
    s.clone.post(internalSignal('evt-3'));
    await waitFor(
      async () => (await internalFailureCount(s)) === 3,
      '2周目の再試行の失敗が記録される',
    );

    const releaseEntries = (
      (await s.stores.journal.list({ types: ['exchange'] })) as JournalEntry[]
    ).filter(
      (entry): entry is Extract<JournalEntry, { type: 'exchange' }> =>
        entry.type === 'exchange' && entry.text.includes('枠の解除を試す'),
    );
    // `journal.list()` は降順（新しい順）。[0] は1件畳んだ回、[1] は0件の回。
    expect(releaseEntries).toHaveLength(2);
    const [folded, empty] = releaseEntries;
    expect(folded?.text).toContain('内部の失敗記録を畳んだ: 1 件');
    for (const phrase of FOLD_COUNT_SCOPE_PHRASES) {
      expect(folded?.text).toContain(phrase);
      expect(empty?.text).not.toContain(phrase);
    }

    // 文言を変えても、この行は「クローンが自分に向けて書いた記録」のまま
    // 振り分けられる（`turn-input.ts` の `role` の doc。判定の実体は
    // `countsAsUndistilledActivity` と `humanExchanges`）。
    expect(folded && countsAsUndistilledActivity(folded)).toBe(false);
    expect(humanExchanges(releaseEntries)).toEqual([]);

    await s.clone.stop();
  });

  it('解除の1行は、旧い文言でも射程を名乗る新しい文言でも「自分に向けて書いた記録」と判定される（陽性対照）', () => {
    // 判定は `with` を見ていて文言を見ない——それを、文言を変える前後の両方の
    // 形で固定する。旧い文言は Issue #1344 の時点の `clone.ts` の出力の形。
    const oldText =
      '枠の解除を試す。新しい合図が届いたので、保持していた 2 件を配り直す。' +
      ' 人間が待っていない内部の失敗記録を畳んだ: 2 件。';
    const newText = `${oldText}${FOLD_COUNT_SCOPE_PHRASES.join('／')}`;
    const entries: JournalEntry[] = [oldText, newText].map((text, i) => ({
      type: 'exchange',
      id: `release-${String(i)}`,
      at: '2026-09-23T00:00:00.000Z',
      with: 'self',
      role: 'outbound',
      text,
    }));
    for (const entry of entries) {
      expect(countsAsUndistilledActivity(entry)).toBe(false);
    }
    expect(humanExchanges(entries)).toEqual([]);
  });

  it('会話に紐づく失敗（人間との対話ターンが失敗した）は、内部の合図と混ざっても1文字も変わらない', async () => {
    const s = setup(undefined, createMemoryStores(), {
      resultSubtype: 'error_during_execution',
      resultText: spendLimitMessage,
    });

    s.clone.post(humanMessage('一件目'));
    await waitForTerminal(s.events);

    // **`#reportFailure` は `with: 'self'` で書く**（conversationId の有無で
    // 変わるのは先頭の文言だけ——`内部ターンが失敗した` / `人間との対話
    // ターンが失敗した`。`internalFailureCount` と同じ絞り方で、こちらは
    // 会話側の接頭辞で絞る）。
    const humanFailureMark = `${EXCHANGE_KIND_FAILURE_PREFIX}人間との対話ターンが失敗した`;
    const rows = (await s.stores.journal.list({ types: ['exchange'] })) as {
      with: string;
      text: string;
    }[];
    const humanFailures = rows.filter(
      (entry) => entry.with === 'self' && entry.text.startsWith(humanFailureMark),
    );
    // 1件目の初回失敗ぶん、会話側の失敗記録が1件出ている。中身
    // （`#reportFailure` の組み立て）はこれまでと同じ形のままである。
    expect(humanFailures).toHaveLength(1);
    expect(humanFailures[0]?.text).toContain(spendLimitMessage);

    // 内部の合図を1本挟んでも、会話側の失敗記録の作法は変わらない
    // （短絡された内部の合図は畳まれ、`人間との対話ターンが失敗した` の件数には
    // 影響しない）。
    s.clone.post(internalSignal('evt-1'));
    await waitFor(async () => {
      const after = (await s.stores.journal.list({ types: ['exchange'] })) as {
        with: string;
        text: string;
      }[];
      return (
        after.filter((entry) => entry.with === 'self' && entry.text.startsWith(humanFailureMark))
          .length === 2
      );
    }, '一件目の再試行の失敗がもう1件記録される');

    await s.clone.stop();
  });
});
