import type { RateLimitFacts, UsageLimitNotice } from './usage-limits.js';
import {
  tokenAvailabilityAt,
  type ActiveAgentToken,
  type AgentToken,
  type TokenRotationPolicy,
} from './token-pool.js';

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

// ---------------------------------------------------------------------------
// 遅れて届いた通知を捨てる（世代の照合）
// ---------------------------------------------------------------------------

/**
 * その観測が、いまの現役についてのものか。**2値にしない。**
 *
 * - `current`: いまの現役についての観測。効かせてよい
 * - `stale`: **もう回した後の通知。捨てる**
 * - `unknown`: **どちらとも言えない**（観測が身元を持っていない）
 *
 * ## なぜ `unknown` を作るか
 *
 * 2値にすると、身元を持たない観測がどちらかへ黙って倒れる。**どちらへ倒しても
 * 害があり、しかも害の見え方が違う:**
 *
 * | 倒す先 | 何が起きるか | 見えるか |
 * | --- | --- | --- |
 * | `stale`（捨てる） | **本物の当たりを飲み込む。** 回るべきときに回らない | **見えない**（何も起きないので） |
 * | `current`（効かせる） | 1回の当たりでトークンを2本以上消費しうる | **見える**（日誌に回した記録が並ぶ） |
 *
 * ⟹ **回し手は `unknown` を `current` として扱う**（飲み込むほうが悪い）。
 * **ただしそれをこの関数が決めない** — 3つ目の値として返し、呼ぶ側が日誌へ
 * 「身元が無い観測だった」と残せるようにする。**倒した事実が出力に残ることが、
 * 2値にしないことの目的である。**
 */
export type ObservationFreshness = 'current' | 'stale' | 'unknown';

/**
 * 観測に付いている身元を、いまの現役と突き合わせる。
 *
 * **`tokenId` と `generation` の両方を見る。** id だけだと、**同じトークンが冷却
 * 明けにもう一度選ばれた後**に届いた遅れた通知を「現役の通知」として受け取る
 * （id は一致するので）。世代は回すたびに増えるので、そこで捕まる。
 *
 * **現役がまだ無いとき（`null`）は `unknown` である。** まだ一度も指名していない
 * ＝器の環境変数だけで走っている状態で、照合する相手が存在しない。**`current` と
 * 答えると「照合した」という嘘になる。**
 */
export function observationFreshness(
  active: ActiveAgentToken | null,
  observed: { tokenId?: string; generation?: number },
): ObservationFreshness {
  if (active === null) return 'unknown';
  if (observed.generation !== undefined && observed.generation !== active.generation)
    return 'stale';
  if (observed.tokenId !== undefined && observed.tokenId !== active.tokenId) return 'stale';
  // どちらも運ばれてこなかった＝身元が無い。**一致したとは言えない。**
  if (observed.generation === undefined && observed.tokenId === undefined) return 'unknown';
  return 'current';
}

// ---------------------------------------------------------------------------
// 次の候補を選ぶ
// ---------------------------------------------------------------------------

/**
 * 選んだ結果。**「候補が無い」を1つの出口に畳んである。**
 *
 * Issue #393 が明示している——プールが空 / 全部冷却中 / 1本しか無くてそれが冷却中
 * の**3つを別々の分岐にしない。** 別にすると、呼ぶ側が3回同じ「先頭へ戻らずに
 * 待つ」を書くことになり、1つ忘れた分岐だけが黙って先頭へ戻る。
 */
export type TokenSelection =
  | { kind: 'candidate'; token: AgentToken }
  | {
      kind: 'none';
      /**
       * いちばん早く戻るもの。**プールが空・全部 disabled・全部失効なら無い。**
       *
       * 無いことを `0` や `now` で埋めないこと（AGENTS.md 地雷「取れない軸に 0 の
       * 行を作る」）——埋めると「すぐ戻る」と読める。
       */
      earliest?: { tokenId: string; label: string; cooldownUntil: number };
      /** 人間とクローンへ出す1行。**トークンの値を含まない。** */
      why: string;
    };

export interface SelectNextTokenOptions {
  /** 判定の基準時刻（epoch ミリ秒）。 */
  at: number;
  /**
   * 降りたトークンの id。**これを候補から外す。**
   *
   * **外さないと「自分自身へ回した」が起きる。** 冷却の期限は `resetsAt` 由来で、
   * **既に過ぎている値が来ることがある**（`markTokenUnusable` の doc: 過去の値を
   * 未来へ丸めない）。過ぎていれば `tokenAvailabilityAt` は `ready` を返すので、
   * 降りた本人が最初の候補として選び直される——**日誌には「回した」と残るのに、
   * 撒いた先は1文字も変わらない。** Issue が禁じている「黙って先頭へ戻る」の
   * いちばん静かな形である。
   */
  exclude?: string;
}

/**
 * 次に試す候補を1本選ぶ。**純粋関数。**
 *
 * `order` の昇順で、記録の上で候補から外す理由が無い最初の1本
 * （`tokenAvailabilityAt` が `ready`）。**「通る」ことは保証しない** — それは
 * `probeTokenCandidate`（PR2）が観測する領域である。
 */
export function selectNextToken(
  tokens: readonly AgentToken[],
  options: SelectNextTokenOptions,
): TokenSelection {
  const ordered = [...tokens].sort((a, b) => a.order - b.order);
  const eligible = ordered.filter((token) => token.id !== options.exclude);

  const ready = eligible.find((token) => tokenAvailabilityAt(token, options.at) === 'ready');
  if (ready !== undefined) return { kind: 'candidate', token: ready };

  // **ここから下は1つの出口である。** 空・全部冷却中・全部外されている、を
  // 分けない。
  const cooling = eligible
    .filter((token) => tokenAvailabilityAt(token, options.at) === 'cooling')
    .sort((a, b) => (a.cooldownUntil ?? 0) - (b.cooldownUntil ?? 0));

  const first = cooling[0];
  if (first?.cooldownUntil === undefined) {
    return {
      kind: 'none',
      why:
        eligible.length === 0
          ? '試せる候補が1本も無い（プールが空、または降りた1本しか無い）'
          : '試せる候補が1本も無い（すべて人間が外したか失効している。冷却中のものは無いので、待っても戻らない）',
    };
  }

  return {
    kind: 'none',
    earliest: { tokenId: first.id, label: first.label, cooldownUntil: first.cooldownUntil },
    why: `候補が全部冷却中である。いちばん早く戻るのは「${first.label}」`,
  };
}
