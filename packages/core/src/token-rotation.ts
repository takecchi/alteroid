import type { RateLimitFacts, UsageLimitNotice } from './usage-limits.js';
import type { TokenRotationPolicy } from './token-pool.js';

/**
 * 「いま回すか」の判定（Issue #393 PR3）。**純粋関数だけを置く。**
 *
 * 器（記憶ストア）にもサービスにも依存しない——選ぶ・撒く側（回し手）はここを
 * 呼ぶだけで、判定そのものはここで閉じる。**判定をここへ寄せてあるのは、
 * これを間違えたときの壊れ方が「まだ通るトークンを捨てる」だからである**
 * （Issue #393 の追記1が、当初の設計をこの理由で訂正している）。
 *
 * ## この判定が答える問いは1つではない
 *
 * `status === 'rejected'` は**「その枠1つが尽きた」であって「仕事が止まった」
 * ではない**（`clone.ts` に逐語で在る。`grep -n '1つぶんの状態でしかない'
 * packages/core/src/clone.ts`）。課金枠（overage）に落ちてターンが成功する組み合わせが
 * 構造上あり、それは異常系ではなく通常の遷移である。⟹ 2つの別の問いになる:
 *
 * | 問い | `rejected` で答えられるか |
 * | --- | --- |
 * | もう通らないか | **答えられない**（課金枠で通りうる） |
 * | 無料枠を使い切ったか | **まさにその答えである** |
 *
 * **どちらを聞くかは人間の設定（{@link TokenRotationPolicy}）が決める。**
 * 実装が既定を勝手に動かさないことだけが条件である。
 */

/**
 * 何を見てそう決めたか。**構造化された印であって、文言ではない。**
 *
 * 日誌にはこれと**生の文言の両方**を出す。文言だけだと後から集計できず、印だけだと
 * 人間が claude.ai と突き合わせられない（Issue #393「当たった文言はそのまま残す」）。
 *
 * - `reached`: 仕事が実際に止まった（`classifyUsageNotice` が `reached`）
 * - `quota_rejected`: その枠が尽きた（`status === 'rejected'`）。**課金枠は見ていない**
 * - `overage_closed`: 枠が尽きたうえに課金枠も閉じている
 * - `entered_overage`: 課金枠から引き始めた（まだ動く）
 * - `org_policy`: 組織の方針で止められている。**枠ではない**
 * - `warning`: 近いだけ
 * - `none`: 回す材料が何も無い
 */
export type TokenRotationSignal =
  | 'reached'
  | 'quota_rejected'
  | 'overage_closed'
  | 'entered_overage'
  | 'org_policy'
  | 'warning'
  | 'none';

/** 判定の結果。**`rotate` だけでなく、なぜそう決めたかを必ず持って返る。** */
export interface TokenRotationDecision {
  rotate: boolean;
  /** 上の印。分岐に使ってよい。 */
  signal: TokenRotationSignal;
  /**
   * 人間とクローンへ出す1行。**トークンの値を含まない**（含めてよいのは設定値と
   * 印だけで、観測した文言は呼び出し側が別に添える）。
   */
  why: string;
}

/**
 * 判定の材料。**6つの検知点がここへ合流する**（Issue #393「検知」の表）。
 *
 * 検知点によって持っているものが違うので、3つとも省略可にしてある——文言だけ
 * 持っている経路（`system/notification` / 失敗した `result`）と、`rate_limit_event`
 * から事実を持っている経路がある。
 */
export interface TokenRotationObservation {
  /**
   * 文言から分類した通知。
   *
   * **⚠️ 生の文言を直接渡さないこと。** `classifyUsageNotice` は部分一致なので、
   * **構造化された印で「応答ではない」を確定させた後にだけ**通す
   * （`sdk-failure.ts` の doc。逆順にすると、クローンが「上限に当たった」と日報に
   * 書いた瞬間に上限と誤判定する）。
   */
  notice?: UsageLimitNotice;
  /** その時点で覚えている枠の事実。**重ねた形**（`mergeRateLimitFacts`）を渡す。 */
  facts?: RateLimitFacts;
  /**
   * `usageTransitionOf` が返した遷移。
   *
   * **状態ではなく遷移を受けるのは、`rate_limit_event` がターンの頭ごとに来るから
   * である。** 状態をそのまま判定に流すと、同じ `rejected` で毎ターン回そうとする。
   */
  transition?: 'entered_overage' | 'rejected';
}

/** 課金枠も閉じているか。**「取れなかった」を「閉じている」と読まない。** */
function overageClosed(facts: RateLimitFacts | undefined): boolean {
  if (facts === undefined) return false;
  // 明示的に閉じていると言っているものだけを数える。`overageDisabledReason` が
  // 在ることは「使えない理由が付いている」＝閉じている、である。
  if (facts.overageStatus === 'rejected') return true;
  if (facts.overageDisabledReason !== undefined) return true;
  // **`usingOverage === false` を「閉じている」と読まないこと。** あれは「いま
  // 引いていない」であって「引けない」ではない。`undefined` はそもそも観測が無い。
  return false;
}

/**
 * いま回すか。**設定を読むのはここだけである。**
 *
 * ## 判定の順序に意味がある
 *
 * 1. **`org_policy` を最初に見て、必ず回さない**（受け入れ基準9）。枠ではないので、
 *    別のトークンでも同じ組織なら同じ結果になる。**待っても直らないが、回しても
 *    直らない**——ここで回すと、プールを1周ぶん無駄に食って同じところで止まる
 * 2. **`off` なら回さない**（記録はする）。人間が自動を切ったという意思である
 * 3. **`reached` は、`off` 以外のどちらの設定でも回す**（下の注記）
 * 4. あとは設定ごとの契機
 *
 * ## `reached` を両方の設定で回す理由（**これは推論である。Issue の表には無い**）
 *
 * Issue #393 の追記2 の表は、`free_exhausted` の契機を
 * 「`rejected` または `usingOverage` が立った」と書き、`reached` を
 * `overage_exhausted` の側にだけ挙げている。**そのまま読むと
 * 「`free_exhausted` は `reached` で回さない」になるが、それは成り立たない。**
 *
 * `free_exhausted` は `overage_exhausted` より**弱い契機で回す**設定である
 * （課金枠を焼く前に回す）。`reached` は「仕事が実際に止まった」＝ `rejected` より
 * **強い**観測なので、**弱い契機で回す設定が強い観測で回らないのは矛盾する。**
 * ⟹ 表は `free_exhausted` に固有の契機を挙げているのであって、`reached` を
 * 除外しているのではないと読んだ。
 *
 * **これは実装側の推論であって、人間の決定として記録されているものではない。**
 * 逆にしたい（`free_exhausted` では `reached` で回さない）なら、ここを1行変える。
 */
export function decideTokenRotation(
  policy: TokenRotationPolicy,
  observation: TokenRotationObservation,
): TokenRotationDecision {
  const { notice, facts, transition } = observation;

  // 1. 組織の方針。**どの設定でも回さない。**
  if (notice?.kind === 'org_policy') {
    return {
      rotate: false,
      signal: 'org_policy',
      why: '組織の方針で止められている（枠ではない）。別のトークンでも同じ組織なら同じ結果になるので回さない',
    };
  }

  // 2. 人間が自動を切っている。**記録はするが回さない。**
  if (policy === 'off') {
    return {
      rotate: false,
      signal: signalOf(notice, facts, transition),
      why: '回す契機の設定が off（記録だけする）',
    };
  }

  // 3. 仕事が実際に止まった。**どちらの設定でも回す。**
  if (notice?.kind === 'reached') {
    return {
      rotate: true,
      signal: 'reached',
      why: '仕事が止まった文言が出た（設定に関わらず回す）',
    };
  }

  if (policy === 'overage_exhausted') {
    // 課金枠まで使ってから回す設定。**`rejected` だけでは回らない。**
    if (transition === 'rejected' && overageClosed(facts)) {
      return {
        rotate: true,
        signal: 'overage_closed',
        why: '枠が尽きたうえに課金枠も閉じている（overage_exhausted）',
      };
    }
    return {
      rotate: false,
      signal: signalOf(notice, facts, transition),
      why: '設定が overage_exhausted なので、課金枠が生きている限り回さない',
    };
  }

  // 4. 既定（`free_exhausted`）。課金枠を焼く前に回す。
  if (transition === 'rejected') {
    return {
      rotate: true,
      signal: overageClosed(facts) ? 'overage_closed' : 'quota_rejected',
      why: '無料枠が尽きた（free_exhausted。課金枠を焼く前に回す）',
    };
  }
  if (transition === 'entered_overage') {
    return {
      rotate: true,
      signal: 'entered_overage',
      why: '課金枠から引き始めた（free_exhausted。課金枠を焼く前に回す）',
    };
  }

  return {
    rotate: false,
    signal: signalOf(notice, facts, transition),
    why: '回す契機に当たる観測が無い',
  };
}

/**
 * 回さないときに、何を見ていたかを印にする。**`none` へ潰さない。**
 *
 * 潰すと日誌から「近づいていたのか、何も無かったのか」が消える——`warning` は
 * 「そろそろ止まる」の唯一の予告なので、記録の側では区別を保つ。
 */
function signalOf(
  notice: UsageLimitNotice | undefined,
  facts: RateLimitFacts | undefined,
  transition: 'entered_overage' | 'rejected' | undefined,
): TokenRotationSignal {
  // **`reached` を最初に見る。** 回らない経路（設定が `off`）でもここへ来るので、
  // 落とすと**いちばん重い観測が日誌から消える**——「自動を切っていたあいだに
  // 何回止まったか」が取れなくなる。
  if (notice?.kind === 'reached') return 'reached';
  if (notice?.kind === 'org_policy') return 'org_policy';
  if (notice?.kind === 'warning') return 'warning';
  if (transition === 'rejected') return overageClosed(facts) ? 'overage_closed' : 'quota_rejected';
  if (transition === 'entered_overage') return 'entered_overage';
  if (notice?.kind === 'transition') return 'entered_overage';
  return 'none';
}

/**
 * 冷却の期限に使う epoch ミリ秒を、事実から取る。取れなければ `undefined`。
 *
 * **`resetsAt` が権威ある値である**（`DEFAULT_TOKEN_COOLDOWN_MS` の doc）。ここが
 * `undefined` を返したら、呼ぶ側は**設定の既定**へ倒す——**この関数の中に既定を
 * 持たないこと。** 持つと、設定を変えたのに片方の経路だけ古い値で動く形が作れる。
 *
 * **どちらを採るか。** 枠そのものの `resetsAt` を優先し、無ければ課金枠の
 * `overageResetsAt` を採る。逆順にすると、無料枠が先に開くのに課金枠のリセットまで
 * 寝ることになる——**早く起きすぎるほうが安全側**である（同じ doc）。
 *
 * **⚠️ 過去の値を未来へ丸めない。** 既に過ぎていれば「もう戻っている」が正しい
 * （`markTokenUnusable` の doc）。
 */
export function cooldownUntilFrom(facts: RateLimitFacts | undefined): number | undefined {
  if (facts === undefined) return undefined;
  return facts.resetsAt ?? facts.overageResetsAt;
}
