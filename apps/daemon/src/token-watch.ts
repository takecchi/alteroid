import {
  judgeTokenCandidate,
  type AccountUsageState,
  type TokenCandidateVerdict,
  type TokenReconsiderReason,
  type TokenRotationOutcome,
  type TokenRotator,
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
    currentVerdict?: TokenCandidateVerdict,
  ): Promise<void> {
    lastStartedAt = now();
    const work = (async () => {
      try {
        const outcome = await options.rotator.reconsider({
          reason,
          ...(currentVerdict === undefined ? {} : { currentVerdict }),
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
      void run('account_probe', verdict);
    },
    stop,
  };
}
