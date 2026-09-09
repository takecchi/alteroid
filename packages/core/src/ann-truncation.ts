import type { ScoringStrategy } from "./strategies/scoring.js";
import { isBoundedScoringStrategy } from "./strategies/scoring.js";

/**
 * over-fetch の窓（k'）の外に、本来 top-k に入るべき候補が残っていたかを判定する
 * （[ADR 0069](../../../docs/decisions/0069-ann-truncated-says-nothing-about-loss.md) 案A）。
 *
 * ## なぜこれが要るか
 *
 * かつて `ann_truncated` の発火条件は `annHits.length >= kPrime` **だけ**だった。
 * `kPrime` はスコープの件数を一切見ないので、**スコープに k' 件以上あれば必ず鳴る**——
 * **⟹ 札は「スコープが k' 以上ある」としか言っておらず、損したかどうかを一切言っていなかった。**
 * 実測では 7 probe すべてで鳴り、実損は 0/7 だった（ADR 0069 §1.1）。
 *
 * そして `docs/recall.md` は、この札の次の一手を「厳密検索へのフォールバックを選べる」と
 * 書いている。**100% 鳴る札でそれをやると、ANN 索引を一度も使わないのと同じになる。**
 *
 * ## 判定式
 *
 * ```
 * R = bar / ( sim_k' × M_max )        R >= 1 なら「窓の外は原理的に top-k へ入れない」
 * ```
 *
 * **健全性の根拠**: ANN は距離順に返すので、窓の外の候補 c は必ず `sim_c <= sim_k'` である。
 * その total は `sim_c × M_c <= sim_k' × M_max`。これが `bar` 以下なら c は k 位を抜けない。
 * **⟹ k'+1 位以降を取りに行かずに、上界だけで判定できる。**
 *
 * **⚠ これは「ANN が距離順に返す」という機構の性質に依っており、実装の偶然ではない。**
 * ただし `sim_k'` は**索引が返した** k' 番目であって**真の** k' 番目ではない——
 * 近似索引が scope の他の場所へ行っていた場合、上界は破れる。その事象は本判定の対象ではなく
 * `ann_unreached`（ADR 0025 / 0026）が別に扱う。**塞げていない範囲を塞いだことにしない。**
 */

/** 判定の結果。**3つの状態を潰さない**（ADR 0008 の「無いには種類がある」を判定へ適用する）。 */
export type AnnTruncationVerdict =
  /**
   * 窓の外の候補は原理的に top-k へ入れない、と証明できた。
   * **⟹ 呼び出し側は `ann_truncated` を積まない（沈黙は「不在」で表す）。**
   */
  | { kind: "provably_safe"; safetyRatio: number; assumptions: readonly string[] }
  /** 損失が起こりえた。`safetyRatio` は必ず 1 未満。 */
  | { kind: "loss_possible"; safetyRatio: number; assumptions: readonly string[] }
  /** 判定そのものができなかった。**「損しなかった」ではない。** */
  | { kind: "undecidable"; reason: string };

export interface DecideAnnTruncationInput {
  /**
   * 段2で使ったスコアリング戦略。**上界の宣言を持たない戦略なら `undecidable` に落ちる**——
   * 黙って既定戦略の上界を当てはめない（別の式のスコアに、既定の上界は当たらない）。
   */
  strategy: ScoringStrategy;
  /** `RecallQuery.tags`。`tagMatch` の上界はここだけで決まる。 */
  queryTags: readonly string[];
  /** ANN が返した最後（k' 位）の similarity（`1 - distance`）。 */
  lastAnnSimilarity: number;
  /**
   * 返した最後（k 位）の `total`。**`limit` に満たなかったら `null`。**
   *
   * `null` のとき、比較の基準は `scoreThreshold` になる——**閾値を超える候補なら
   * 必ず返っていたはず**だからである（`limit` に余りが在るのに返らなかったのは、
   * 閾値を超えなかったからでしかない）。⟹ 窓の外の候補が「入れたはず」と言えるのは、
   * 閾値を超えられた場合だけ。
   */
  lastReturnedTotal: number | null;
  /** 段2の閾値（`RecallQuery.scoreThreshold` の実効値）。 */
  scoreThreshold: number;
}

function isUsableNumber(v: number): boolean {
  return Number.isFinite(v);
}

export function decideAnnTruncation(input: DecideAnnTruncationInput): AnnTruncationVerdict {
  if (!isBoundedScoringStrategy(input.strategy)) {
    return {
      kind: "undecidable",
      reason:
        "スコアリング戦略が nonSimilarityUpperBound を宣言していない。" +
        "上界が分からないので、窓の外の候補が top-k へ入れたかどうかを判定できない" +
        "（既定戦略の上界を黙って当てはめない。ADR 0069 §7）。",
    };
  }

  const bound = input.strategy.nonSimilarityUpperBound({ queryTags: input.queryTags });
  if (bound.kind === "undeclared") {
    return {
      kind: "undecidable",
      reason: `スコアリング戦略が上界を宣言できないと申告した: ${bound.reason}`,
    };
  }

  // 分母。`M_max <= 0` や非有限は「上界として使えない」——0 で割って Infinity を
  // 「安全だ」と読ませない（ADR 0044 が NaN を below_threshold に混ぜなかったのと同じ線）。
  if (!isUsableNumber(bound.value) || bound.value <= 0) {
    return {
      kind: "undecidable",
      reason: `宣言された上界が判定に使えない値である（value=${String(bound.value)}）。`,
    };
  }

  // `sim_k'` は 1 - distance であり、**コサインは負になりうる**（直交より遠い候補）。
  // 分母が 0 以下になったら「窓の外は total を稼げない」と読める誘惑があるが、そう読まない——
  // **`total` の符号まで含めた大小関係は、この上界の議論の外に在る**（負の similarity を
  // 掛けた total 同士の順序は、上界の不等式が保証しない）。判定不能に落とす。
  if (!isUsableNumber(input.lastAnnSimilarity) || input.lastAnnSimilarity <= 0) {
    return {
      kind: "undecidable",
      reason:
        `ANN が返した最後の similarity が 0 以下または非有限である（${String(input.lastAnnSimilarity)}）。` +
        "この場合、上界の不等式は total の順序を保証しない。",
    };
  }

  // 比較の基準。`lastReturnedTotal` が NaN のときは判定不能——これは
  // `score_not_comparable`（ADR 0044、埋め込みがゼロベクトル）の領域であり、
  // 「閾値を緩める」でも「窓を広げる」でも直らない別の出来事である。
  const bar = input.lastReturnedTotal ?? input.scoreThreshold;
  if (!isUsableNumber(bar)) {
    return {
      kind: "undecidable",
      reason: `比較の基準になる値が非有限である（bar=${String(bar)}）。`,
    };
  }

  const safetyRatio = bar / (input.lastAnnSimilarity * bound.value);
  if (!isUsableNumber(safetyRatio)) {
    return {
      kind: "undecidable",
      reason: `安全余裕が非有限になった（safetyRatio=${String(safetyRatio)}）。`,
    };
  }

  // **境界は `>= 1` が安全側である。**ちょうど 1 のとき、窓の外の候補は「k 位と同点」までしか
  // 届かず、**k 位を抜けはしない**（並べ替えは `total` の降順で、同点は既存の順序を崩さない）。
  // ⟹ 等号を安全側に含める。
  return safetyRatio >= 1
    ? { kind: "provably_safe", safetyRatio, assumptions: bound.assumptions }
    : { kind: "loss_possible", safetyRatio, assumptions: bound.assumptions };
}
