import {
  judgeTokenCandidate,
  type AccountUsageState,
  type TokenCandidateVerdict,
  type TokenReconsiderReason,
  type TokenRotationOutcome,
  type TokenRotator,
  type TokenVerdictOrigin,
} from '@alteroid/core';

/**
 * 認証トークンの**見張り**（人間の決定 2026-09-07）。
 *
 * ## 何のためにあるか —— 「止まったら回らない」を塞ぐ
 *
 * 回し手（`packages/core/src/token-rotator.ts`）の `observe` へ届く検知点は
 * **6つとも「セッションが回っているあいだ」に鳴る**（クローンのターン /
 * マネージャーの `usage_notice` / `rate_limit`）。⟹ **全層が枠で止まった状態は、
 * 観測を上げる主体が1つも居ない状態でもある。**
 *
 * そこから抜けるには誰かがもう一度本番で失敗して観測を上げるしかなく、
 * **プールに通る鍵が残っていても何も起きない**時間ができた。人間が新しい鍵を
 * 足しても同じで、`PUT /tokens` は記憶ストアを書くだけだった。
 *
 * ⟹ ここが**セッションに依存しない契機**を持つ。3種類ある:
 *
 * | 契機 | 何で起きるか |
 * | --- | --- |
 * | 目盛り（`tick`。冷却明けもここで拾う） | このファイルのタイマー |
 * | 突つき（`pool_changed` / `settings_changed` / `runner_connected` / `startup`） | {@link TokenRotationWatch.poke} |
 * | 枠の観測（`account_probe`） | {@link TokenRotationWatch.observeAccount}（`usage-poller.ts` から） |
 *
 * ## タイマーは安い
 *
 * 目盛りが呼ぶ `reconsider` は、**ふつうの状態では記憶ストアを3回読むだけで
 * 終わる**（現役が `ready` なら即座に `ignored`）。候補選びは記録だけを見る純粋
 * 関数なので、`ready` な行が1本も無ければ probe も1本も焼かない。⟹ **サブ
 * プロセスが起きるのは「現役が通らないのに `ready` な候補が在る」＝まさに
 * 回したい瞬間だけ**である（`sweepCandidates` の doc が同じことを core 側の
 * 言葉で書いている）。
 *
 * ## ⚠️ 目盛りが 60 秒だからといって、復帰の下限が 60 秒とは限らない
 *
 * **「記録の上で現役が `ready`」の状態からは、目盛りは何回鳴っても動かない**
 * （それが「健全な鍵から勝手に移らない」の歯止めそのものである）。記録を
 * `ready` から動かせるのは2つだけである:
 *
 * | 誰が | 何を書くか | 周期 |
 * | --- | --- | --- |
 * | `observe`（セッション由来の観測） | 降りる鍵の冷却 | 観測が届いたとき |
 * | **`account_probe`** | `currentVerdict: 'unusable'` で現役の冷却 | **5分**（`USAGE_POLL_INTERVAL_MS`。ただし下） |
 *
 * **`currentVerdict` を渡す口は1つだけである** —— このファイルの
 * `run('account_probe', verdict)`。⟹ `tick` / `pool_changed` /
 * `runner_connected` / `startup` は**記録しか見ない。**
 *
 * ⟹ **観測が全部飲まれていて記録が `ready` のままの回、復帰の下限は 60 秒では
 * なく 5 分である**（観測が1本でも新鮮なら `observe` が冷却を書くので、そのときは
 * 次の目盛り＝60秒以内）。
 *
 * **⚠️ そして「5分」は全部の器に効く数ではない。** `GET /usage` が
 * `state: 'unavailable'` を返す器では**間隔が伸びる**（`usage-poller.ts` の
 * `USAGE_POLL_UNAVAILABLE_INTERVAL_MS` ＝ 30分）。**伸ばす条件は 2026-09-08 に
 * 狭くなった** —— 理由が言い分けられない回（`cause: 'undetermined'`）は
 * 通常の5分へ戻した（逐語は
 * `grep -Fn -- '判定できない」を「取れない」へ倒したことになる' apps/daemon/src/usage-poller.ts`）。
 * **直す前は理由を問わず30分で、本番はまさにその器だった** ⟹ **下の表が
 * 「成り立たない」と書いている帰結には、周期が6倍だったことも重なっていた。**
 *
 * ## ⚠️ 観測が飲まれる形は2つあった。#668 で1つ塞いだ
 *
 * | 飲まれる形 | いま |
 * | --- | --- |
 * | `manager.ts` / `clone.ts` の `case 'rate_limit'` の**遷移の門** | **塞いだ**（#668） |
 * | `observe` の `freshness === 'stale'` が**冷却を書く手前で `return`** | **残す**（#667。**これは正しい**） |
 *
 * **塞いだ側** —— 遷移の判定材料（`#rateLimits`）は**そのインスタンスの寿命ぶん**
 * 残るので、同じ `kind` の `rejected` が**別のトークンで**再発しても回し手へ一度も
 * 届かなかった（実運用の日誌で20分以上の停止として観測。2026-09-07）。いまは
 * **状態でも回る。ただし観測がいまの世代を名乗ったときだけ**である
 * （`decideTokenRotation` の `freshness`）——「毎ターン回さない」を保証する歯が
 * 遷移から世代へ移った（回せば世代が上がるので、続く turn head の観測は `stale`
 * になって自動で黙る）。
 *
 * **残した側** —— `stale` な観測が名乗っているのは**前の世代の鍵**で、いまの現役が
 * 通るかどうかについて1文字も言っていない。そこから冷却を書くと、`resetsAt` を
 * 運んでいない観測では `min(記録, now + 既定)` が書かれるため**本物の期限が未来に
 * 在る鍵を早く `ready` に見せる**（#667 の候補1を採らない理由。`token-rotator.ts` の
 * `observe` の `freshness === 'stale'` の直上に全文がある。**2026-09-07 に入れた
 * `min` は逆向き——推測が記録を後ろへ動かす側——だけを塞いだもので、この理由は
 * そのまま残っている**）。
 *
 * ⟹ **身元を運ぶ観測が届く器では、復帰の下限は観測が届いた時点へ戻る。**
 * **⚠️ 身元を運ばない観測（`freshness === 'unknown'`）しか無い器では、いまも
 * 5分刻みである** —— そちらでは状態で回す判断を使わない（世代を照合できないので、
 * 使うと `rejected` が続くあいだ毎ターン回してプールを食い潰す）。
 *
 * ## 🔴 ⚠️ probe が1つも判定を返さない器が在る（本番がそれだった）
 *
 * **実測（2026-09-07、Railway の本番）**: `GET /usage` が返したのは
 *
 * ```json
 * { "state": "unavailable", "reason": "この認証では claude.ai の枠が無い（apiProvider: firstParty）" }
 * ```
 *
 * **⚠️ この文言は #681 で変わった（上の JSON は 2026-09-07 の実測そのままである）。**
 * いまの同じ器が返すのは `cause: 'undetermined'` と
 * `枠が効かない理由を言い分けられない…` で、**「サブスクが無い」とは言わなくなった**
 * （`usage-snapshot.ts` の `LimitsUnavailableCause`）。**⟹ 直ったのは読み手の
 * 誤読であって、下の表の帰結は1行も直っていない** —— 判定はいまも `undecidable`
 * である。
 *
 * `judgeTokenCandidate` は `unavailable` を `undecidable` にする（「迷ったら
 * `unusable` にしない」）⟹ **この器では `currentVerdict` が永久に `usable` も
 * `unusable` も返さない。** 帰結:
 *
 * | 上で約束したこと | その器での実際 |
 * | --- | --- |
 * | `unusable` が「観測が上がらないまま止まり続ける」を塞ぐ**本体** | **一度も返らない** |
 * | `usable` で `event: 'recovered'` が出て、待っている層を起こす | **一度も出ない** |
 * | 復帰の下限は probe の周期（5分） | **成り立たない**（判定が来ない。**しかも周期が30分だった**） |
 *
 * **⟹ 上の「復帰の下限は 5 分」は、probe が判定を返す器での話である。** 返さない
 * 器では、記録を `ready` から動かせるのは `observe`（セッション由来の観測）**だけ**に
 * なる —— つまり**セッションが1本走って失敗するまで動かない。**
 *
 * **⚠️ この器では周期そのものも違っていた**（2026-09-08 に直した）。`unavailable`
 * を返す器は理由を問わず 30 分間隔だったので、**判定が来るようになっても6倍遅い**
 * ままだった。いまは `cause: 'undetermined'` は 5 分へ戻る（直上の但し書き）。
 * **⟹ 直ったのは周期だけで、この表の3行はいまも成り立たない。**
 *
 * ## そしてセッション上限は probe の窓に無い
 *
 * probe が読むのはアカウントの枠（`five_hour` / `seven_day` / … と課金枠）で、
 * **セッション単位の上限に対応する窓は無い。** ⟹ 判定を返す器でも
 * `You've hit your session limit` の形は `unusable` として検出できない。
 *
 * **⚠️ ただしこの見立ては弱い。** 本番の実測では、その文言（`resets 7:30pm`）に
 * 対応する `resetsAt` が `kind: five_hour` の事実として**届いていた**（冷却の期限が
 * 逐語で一致した）⟹ **窓としては観測されている可能性がある。** 切り分けは
 * probe が判定を返す器でしかできない。
 *
 * ## ⟹ いちばん効いているのは probe ではなく「起こすこと」である
 *
 * 起こすことは「仕事を再開させる」だけでなく**「飲まれていた観測を新鮮にし直す」**
 * でもある（引き取られたセッションは `#rememberTokenIdentity` を通るので、いまの
 * 世代を名乗る。`manager.ts` の3箇所）⟹ **`stale` で全部飲まれていた状態は、
 * 起こした時点で解ける。** probe が死んでいる器でも、ここは効く。
 *
 * ## ⚠️ ここは判断を持たない
 *
 * 回すかどうか・どれへ回すか・撒くかは**全部回し手が決める**。ここが持つのは
 * 「いつ聞くか」だけである —— 判断を2箇所に置くと、設定（`rotateOn`）を見る
 * 場所が2つになり、`off` でも回る経路が生まれる。
 */
export interface TokenRotationWatch {
  /**
   * 契機を1つ渡して、いま見直させる。
   *
   * **待たない（`void`）。** 呼ぶのは HTTP のハンドラや runner の名乗りの処理で、
   * どちらも「回し手が候補を probe し終わるまで」待つ場所ではない。
   *
   * **重ねない。** 回し手の中は直列（`serial()`）なので並列には走らないが、
   * ここでも短い間隔の連打を畳む（{@link MIN_RECONSIDER_GAP_MS}）——
   * `PUT /tokens` を10回打った回に probe を10周焼かないため。
   */
  poke(reason: TokenReconsiderReason): void;
  /**
   * **現役を probe で観測した結果**を渡す（`usage-poller.ts` の `onState`）。
   *
   * `judgeTokenCandidate` に通してから回し手へ渡す。**判定はここに書かない** ——
   * 候補を試すときと同じ関数を通すことが、「現役を測る目」と「候補を測る目」を
   * 揃える唯一の方法である（別に書くと、片方だけが `undecidable` を `unusable`
   * へ丸める形が作れる）。
   *
   * **`undecidable` でも呼ぶ。** 呼ばないと、記録だけで判定する道
   * （冷却が明けたかどうか）がその回だけ走らなくなる。
   */
  observeAccount(state: AccountUsageState): void;
  /**
   * **ターンが実際に成功したという観測**を渡す（#681 (1)。`usable` の2本目の
   * 生産者。`manager.ts` の `case 'usage':` / `clone.ts` の `case 'turn_ended':`
   * の成功枝から `apps/daemon/src/index.ts` の `onUsageObservation` 経由で
   * 届く）。
   *
   * **`account_probe` の穴を埋める。** あちらが読むのはアカウントの枠だけで、
   * セッション単位の上限（`You've hit your session limit`）には効かない
   * （`TokenRotator.reconsider` の doc）。成功はどんな枠でも「いまの現役が
   * 通った」直接の証拠になる。
   *
   * **`tokenId` / `generation` のどちらかでも欠けていたら何もしない。**
   * 世代を名乗れない観測は `TokenRotator.reconsider` の世代の門
   * （`observationFreshness`）を通れないので、そもそも上げない——上げても
   * 型（`TokenVerdictOrigin` の `turn_success` は `observedBy` を必須にする）
   * が受け付けない。
   */
  observeTurnSuccess(observedBy: { tokenId?: string; generation?: number } | undefined): void;
  stop(): void;
}

/**
 * 目盛りの間隔。
 *
 * **秒を追いかけない。** 枠は5時間 / 7日単位なので、冷却明けを1分の粒度で
 * 拾えれば十分である（`usage-poller.ts` の間隔と同じ判断）。
 *
 * **これは上限ではなく下限側の目盛りである。** 冷却が明けた瞬間に回すのではなく、
 * **明けてから高々この間隔のうちに**回る。
 */
export const TOKEN_WATCH_TICK_MS = 60_000;

/**
 * 突つきを畳む最小の間隔。
 *
 * **`PUT /tokens` の連打で probe を何周も焼かないためである。** 人間が並べ替えを
 * 5回続けて保存すると、そのたびに契機が飛ぶ。
 *
 * **⚠️ 落としても失われない。** 目盛り（{@link TOKEN_WATCH_TICK_MS}）が必ず次に
 * 拾うので、畳んだ突つきは「無くなった」ではなく「最大1分遅れる」である。
 */
export const MIN_RECONSIDER_GAP_MS = 5_000;

export interface TokenRotationWatchOptions {
  rotator: TokenRotator;
  /**
   * 結果の行き先（日誌・stderr・クローンのセッションの作り直し）。
   *
   * **ここでは何も書かない。** 書く先を知っているのは `index.ts` で、`observe`
   * の結果と**同じ1本**へ流さなければ「回った」の記録が2通りの形で残る。
   */
  onOutcome: (outcome: TokenRotationOutcome) => Promise<void>;
  /** 主にテスト用。 */
  tickMs?: number;
  minGapMs?: number;
  now?: () => number;
  /** 外から畳む（デーモンの終了時）。 */
  signal?: AbortSignal;
}

export function startTokenRotationWatch(options: TokenRotationWatchOptions): TokenRotationWatch {
  const tickMs = options.tickMs ?? TOKEN_WATCH_TICK_MS;
  const minGapMs = options.minGapMs ?? MIN_RECONSIDER_GAP_MS;
  const now = options.now ?? (() => Date.now());

  let stopped = false;
  let timer: ReturnType<typeof setTimeout> | undefined;
  /** いま走っている見直し。**重ねない**（回し手の中も直列だが、ここでも畳む）。 */
  let inFlight: Promise<void> | null = null;
  /** 最後に見直しを始めた時刻。突つきの畳み込みに使う。 */
  let lastStartedAt = Number.NEGATIVE_INFINITY;
  /**
   * 畳んだ突つきの契機。**捨てない。**
   *
   * 畳むのは probe を焼かないためであって、契機を無かったことにするためでは
   * ない ⟹ 走っている見直しが終わったら、**溜まっている契機で1回だけ**やり直す。
   * 「`PUT /tokens` の直後に見直しが1回走る」がここで保証される。
   */
  let pending: TokenReconsiderReason | undefined;

  const stop = (): void => {
    stopped = true;
    if (timer !== undefined) {
      clearTimeout(timer);
      timer = undefined;
    }
  };
  options.signal?.addEventListener('abort', stop, { once: true });

  /**
   * 1回ぶんの見直し。**投げない。**
   *
   * 落ちたことは呼ぶ側（`onOutcome` の実装）ではなく**ここ**で跡を残す ——
   * `reconsider` そのものが落ちた回は `onOutcome` へ届かないので、あちらに
   * 任せると「見直しが一度も走っていない」が誰からも見えない。
   */
  function run(
    reason: TokenReconsiderReason,
    current?: { verdict: TokenCandidateVerdict; origin: TokenVerdictOrigin },
  ): Promise<void> {
    lastStartedAt = now();
    const work = (async () => {
      try {
        const outcome = await options.rotator.reconsider({
          reason,
          ...(current === undefined ? {} : { current }),
        });
        await options.onOutcome(outcome);
      } catch (error) {
        process.stderr.write(
          `alteroidd: 認証トークンの見直し（${reason}）が落ちました: ${String(error)}\n`,
        );
      }
    })();
    inFlight = work.finally(() => {
      inFlight = null;
      // **溜まっている契機を1回だけ拾う。** 溜めた分を全部走らせない（同じ
      // 結論を何周も出すだけである）。
      const next = pending;
      pending = undefined;
      if (next !== undefined && !stopped) void run(next);
    });
    return inFlight;
  }

  /** 突つきを受ける。**走っている最中なら溜める。近すぎるなら遅らせる。** */
  function poke(reason: TokenReconsiderReason): void {
    if (stopped) return;
    if (inFlight !== null) {
      pending ??= reason;
      return;
    }
    if (now() - lastStartedAt < minGapMs) {
      // **落とさない。** 次の目盛りが拾う（`MIN_RECONSIDER_GAP_MS` の doc）。
      pending ??= reason;
      return;
    }
    void run(reason);
  }

  const schedule = (): void => {
    if (stopped) return;
    timer = setTimeout(() => {
      // **溜まっている契機を優先する。** 目盛りとしてではなく、人間が起こした
      // 契機として記録される（日誌の `reason` がそう読める形になる）。
      const reason = pending ?? 'tick';
      pending = undefined;
      const work = inFlight ?? run(reason);
      void work.finally(() => {
        schedule();
      });
    }, tickMs);
    // 観測が終了を引き止めないように。
    timer.unref?.();
  };
  schedule();

  return {
    poke,
    observeAccount: (state: AccountUsageState) => {
      if (stopped) return;
      /**
       * **候補を測るのと同じ関数を通す**（この口の doc）。
       *
       * `judgeTokenCandidate` は保守的である —— probe の失敗・通信断・締め切りは
       * すべて `undecidable` へ落ちるので、**器が混んでいる回に現役を冷却へ
       * 入れてしまうことはない**（あちらの doc「迷ったら `unusable` にしない」）。
       */
      const verdict = judgeTokenCandidate(state);
      if (inFlight !== null) {
        // **判定は捨てる（契機だけ溜める）。** 走っている見直しが終わった後で
        // 記録だけを見て判定し直す —— **古い probe の結果を後から効かせない。**
        pending ??= 'account_probe';
        return;
      }
      // **身元を持たない観測**（{@link TokenVerdictOrigin} の doc）。世代の門は
      // 掛からない——照合する相手がそもそも無い。
      void run('account_probe', { verdict, origin: { source: 'account_probe' } });
    },
    observeTurnSuccess: (observedBy) => {
      if (stopped) return;
      // **どちらかでも欠けていたら何もしない**（このメソッドの doc）。世代を
      // 名乗れない成功は `TokenVerdictOrigin` の型で作れない——上げても
      // `TokenRotator.reconsider` 側の世代の門を素通りできないので、そもそも
      // 上げない。
      if (observedBy?.tokenId === undefined || observedBy.generation === undefined) return;
      const origin: TokenVerdictOrigin = {
        source: 'turn_success',
        observedBy: { tokenId: observedBy.tokenId, generation: observedBy.generation },
      };
      if (inFlight !== null) {
        // **溜めずに捨てる。** 直上の `observeAccount` は契機だけ `pending` へ
        // 溜めるが、ここで同じことをしてはいけない —— `pending` は
        // {@link TokenReconsiderReason} しか運べず、`origin`（＝世代）が落ちる。
        // ⟹ 後から `run('turn_succeeded')` が `current` 無しで走る。
        // `reconsider` の世代の門も、成功では回さないための分岐も、どちらも
        // 「`current` が在ること」を条件にしているので**両方とも素通りし、
        // 通常の回転判定へ落ちる** —— 成功が回す契機に化け、しかも日誌には
        // `reason: 'turn_succeeded'` と出る（回転と無関係な成功のせいで回った
        // ように読める）。
        //
        // **捨てて安全なのは、成功が何度でも来るからである。** probe は5分に
        // 1回しか来ないので契機を溜める価値があるが、ターンの成功は次のターンで
        // また上がる。そして溜めた世代は、走っている見直しが終わる頃には古く
        // なっていることがある —— **古い観測を後から効かせない**のが #668 の
        // 門の趣旨そのものであり、`pending` へ溜めるのはその逆をやることになる。
        return;
      }
      void run('turn_succeeded', { verdict: { verdict: 'usable' }, origin });
    },
    stop,
  };
}
