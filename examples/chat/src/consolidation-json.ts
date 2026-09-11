import { heuristicTokenCounter } from "@mnemora/core";
import type { ProviderMode } from "./providers.js";

/**
 * `consolidation-cost` サブコマンド（Issue #136）の機械可読出力口。
 *
 * **なぜこれが要るか**: `Runtime.consolidate()`（ADR 0089）は入ったが、`examples/chat`
 * に配線が無く、北極星の物差し（「使う側が会話ログを全部プロンプトへ積むのをやめられたか」）
 * に効いたかを誰も測っていなかった（Issue #136）。さらに ADR 0090 は逐語で
 * 「反復で `content` が縮む保証はコードに無い（⚠ 実際に単調増加することは測っていない）」
 * と書いている。**この bench は「そもそも縮んだか」を実測する器である。**
 *
 * `./retrieval-json.ts`（ADR 0088）・`./identifier-json.ts`（ADR 0094）と同じ分担:
 * ファイル I/O・環境変数・時刻取得を一切行わない純関数だけを置く。DB/LLM/embedding を
 * 要求する側（`consolidation-cost.ts`）が、ここの関数へ既に取り終えた値を渡して
 * JSON を組み立てる。
 *
 * ⛔ **縮み率（前後の比）はここでは書かない**（ADR 0088 §4「数字をどこにも書き写さない」）。
 * 差分は `scripts/consolidation-cost-summary.mjs` 側が基準値との比較として計算する。
 */

export interface ConsolidationEmbeddingSpaceJson {
  provider: string;
  model: string;
  dimensions: number;
}

/**
 * `ConsolidateOutcome`（`packages/core`）をそのまま数え上げたもの。
 * `dryRun` は使わない運用だが、型を1つに揃えるため欄は持つ（常に0のはず）。
 */
export interface ConsolidationOutcomeCountsJson {
  consolidated: number;
  nothing_to_consolidate: number;
  not_examined: number;
  llm_failed: number;
  dry_run: number;
}

export interface ConsolidationEmbeddingStatusJson {
  ok: number;
  pending: number;
  failed: number;
}

export interface ConsolidationRoundConsolidationJson {
  /** この round で `runtime.consolidate()` を呼んだ群の数。 */
  groups: number;
  llmCalls: number;
  outcomes: ConsolidationOutcomeCountsJson;
  /** この round で新しく作られた統合先 Memory の件数(`outcome==="consolidated"`の数と同じ)。 */
  newMemoryCount: number;
  /** 新しい Memory の `embeddingStatus`(drain 後)の内訳。 */
  embeddingStatus: ConsolidationEmbeddingStatusJson;
  /**
   * `embeddingStatus: "failed"` に着地した Memory の失敗理由(ADR 0090 の `kind`)を、
   * 重複を潰して列挙したもの。`kind` を判別できなかった場合は `"unknown"`。
   * 1件も failed が無ければ空配列。
   */
  embeddingFailureKinds: string[];
}

export interface ConsolidationStoreJson {
  activeCount: number;
  supersededCount: number;
  /** active のみ。 */
  activeContentChars: number;
  activeContentTokens: number;
  activeDigestChars: number;
  activeDigestTokens: number;
  /** active + superseded の合計。⚠ これは必ず増える(隠さない)。 */
  allContentChars: number;
}

export interface ConsolidationRecallProbeJson {
  probeId: string;
  carriedCount: number;
  carriedDigestTokens: number;
  usageChars: number;
  usageEstimatedTokens: number;
  usageIndexChars: number;
  totalInScope: number;
  goldRank: number | null;
  /** `result.memories.length / store.activeCount`。1.0 に近いと「全部載せる」に退化している。 */
  recalledActiveShare: number;
  omittedKinds: string[];
  budgetExceeded: boolean;
}

export interface ConsolidationRecallMeanJson {
  carriedCount: number;
  carriedDigestTokens: number;
  usageChars: number;
  usageEstimatedTokens: number;
  usageIndexChars: number;
  totalInScope: number;
  recalledActiveShare: number;
  /** `goldRank` が非 null の probe だけの平均。全件 null なら `null`。 */
  goldRank: number | null;
  /** `goldRank` が null で平均から除いた probe の件数。 */
  goldRankExcludedCount: number;
}

export interface ConsolidationRecallUnbudgetedJson {
  probes: ConsolidationRecallProbeJson[];
  mean: ConsolidationRecallMeanJson;
}

/** 予算の階段(既定 [8,16,24,32,48,64,128,256,512]、`maxMemoryTokens`)の1段。 */
export interface ConsolidationRecallBudgetRungJson {
  budgetTokens: number;
  probes: ConsolidationRecallProbeJson[];
  mean: ConsolidationRecallMeanJson;
}

export interface ConsolidationRoundJson {
  /** 0 = 統合前。 */
  round: number;
  /** round 0 は統合を行っていないので `null`。 */
  consolidation: ConsolidationRoundConsolidationJson | null;
  store: ConsolidationStoreJson;
  recall: {
    unbudgeted: ConsolidationRecallUnbudgetedJson;
    /** `budgetLadder` と同じ長さ・同じ順序。 */
    budgeted: ConsolidationRecallBudgetRungJson[];
  };
}

export type ConsolidationStopReason =
  /** 指定した最大 round 数まで実行できた(打ち切りではない)。 */
  | "completed_all_rounds"
  /** ある round の開始時点で、統合対象(filler 由来の active な候補)が2件未満だった。 */
  | "insufficient_candidates";

/**
 * `status` で「測ったが値がこうだった」と「そもそも測れなかった」を区別する
 * (`identifier-json.ts` の `IdentifierProbeRunJson` と同じ形。Issue #136 も
 * `@mnemora/local-embedding` を使うため、同じ「重みを取得できなかった」失敗モードを持つ)。
 * **`"weights_unavailable"` のときは round の欄が丸ごと存在しない**——0 や空配列で
 * 埋めない(ADR 0008「無いには種類がある」)。
 */
export type ConsolidationCostRunJson =
  | {
      schemaVersion: 1;
      status: "measured";
      measuredAt: string;
      commit: string | null;
      /** 宣言値ではなく handle の実値(ADR 0088 §4 と同じ規律)。 */
      llmMode: ProviderMode;
      embeddingMode: ProviderMode;
      embeddingSpace: ConsolidationEmbeddingSpaceJson;
      probeCount: number;
      haystackSize: number;
      groupSize: number;
      budgetLadder: number[];
      recallLimit: number;
      /** 実際に実行できた最後の round 番号(0始まりではなく、実行した round の最大値)。 */
      stoppedAfterRound: number;
      stopReason: ConsolidationStopReason;
      rounds: ConsolidationRoundJson[];
    }
  | {
      schemaVersion: 1;
      status: "weights_unavailable";
      measuredAt: string;
      commit: string | null;
      /** `warmupLocalEmbedding` が返した detail(`WEIGHTS_UNAVAILABLE_PREFIX` を含む)。 */
      detail: string;
    };

// ---------------------------------------------------------------------------
// 純関数の本体
// ---------------------------------------------------------------------------

/**
 * `carriedCount / activeCount`。`activeCount === 0` のときは 0
 * (分母が0の割り算を undefined/NaN のまま JSON へ出さない)。
 */
export function computeRecalledActiveShare(carriedCount: number, activeCount: number): number {
  if (activeCount <= 0) {
    return 0;
  }
  return carriedCount / activeCount;
}

/** 単純平均。空配列は 0(呼び出し側は空配列を渡さない前提だが、0除算で NaN を出さない)。 */
function mean(values: readonly number[]): number {
  if (values.length === 0) {
    return 0;
  }
  return values.reduce((sum, v) => sum + v, 0) / values.length;
}

/**
 * `goldRank` が null の要素を除いた平均と、除いた件数を返す。
 * 全件 null なら `mean: null`。
 */
export function meanExcludingNullGoldRank(values: readonly (number | null)[]): {
  mean: number | null;
  excludedCount: number;
} {
  const present = values.filter((v): v is number => v !== null);
  const excludedCount = values.length - present.length;
  return { mean: present.length === 0 ? null : mean(present), excludedCount };
}

/** `heuristicTokenCounter` を digest の連結(`"\n"` 区切り)に当てる(`docs/recall.md` §6 と同じ数え方)。 */
export function carriedDigestTokensOf(digests: readonly string[]): number {
  return heuristicTokenCounter.count(digests.join("\n")).tokens;
}

/** `buildConsolidationProbeJson` への入力。DB/embedding を経由して既に取り終えた値だけを持つ。 */
export interface RawProbeMeasurement {
  probeId: string;
  /** `recall().memories` の digest だけを取り出したもの。 */
  memoryDigests: readonly string[];
  goldRank: number | null;
  totalInScope: number;
  omittedKinds: readonly string[];
  usageChars: number;
  usageEstimatedTokens: number;
  usageIndexChars: number;
  budgetExceeded: boolean;
}

export function buildConsolidationProbeJson(
  raw: RawProbeMeasurement,
  activeCount: number,
): ConsolidationRecallProbeJson {
  return {
    probeId: raw.probeId,
    carriedCount: raw.memoryDigests.length,
    carriedDigestTokens: carriedDigestTokensOf(raw.memoryDigests),
    usageChars: raw.usageChars,
    usageEstimatedTokens: raw.usageEstimatedTokens,
    usageIndexChars: raw.usageIndexChars,
    totalInScope: raw.totalInScope,
    goldRank: raw.goldRank,
    recalledActiveShare: computeRecalledActiveShare(raw.memoryDigests.length, activeCount),
    omittedKinds: [...raw.omittedKinds],
    budgetExceeded: raw.budgetExceeded,
  };
}

/** `probes[]` の数値欄の平均(`goldRank` は null を除く。§仕様どおり)。 */
export function buildConsolidationMeanJson(
  probes: readonly ConsolidationRecallProbeJson[],
): ConsolidationRecallMeanJson {
  const goldRanks = meanExcludingNullGoldRank(probes.map((p) => p.goldRank));
  return {
    carriedCount: mean(probes.map((p) => p.carriedCount)),
    carriedDigestTokens: mean(probes.map((p) => p.carriedDigestTokens)),
    usageChars: mean(probes.map((p) => p.usageChars)),
    usageEstimatedTokens: mean(probes.map((p) => p.usageEstimatedTokens)),
    usageIndexChars: mean(probes.map((p) => p.usageIndexChars)),
    totalInScope: mean(probes.map((p) => p.totalInScope)),
    recalledActiveShare: mean(probes.map((p) => p.recalledActiveShare)),
    goldRank: goldRanks.mean,
    goldRankExcludedCount: goldRanks.excludedCount,
  };
}

/** `store` に既に読み終えた active/superseded Memory の content/digest から数える。 */
export interface RawStoreMeasurement {
  activeContentsAndDigests: readonly { content: string; digest: string }[];
  supersededCount: number;
  /** active + superseded の content 文字数の合計(呼び出し側が別途合算する)。 */
  allContentChars: number;
}

export function buildConsolidationStoreJson(raw: RawStoreMeasurement): ConsolidationStoreJson {
  const activeContentChars = raw.activeContentsAndDigests.reduce(
    (sum, m) => sum + m.content.length,
    0,
  );
  const activeDigestChars = raw.activeContentsAndDigests.reduce(
    (sum, m) => sum + m.digest.length,
    0,
  );
  return {
    activeCount: raw.activeContentsAndDigests.length,
    supersededCount: raw.supersededCount,
    activeContentChars,
    activeContentTokens: heuristicTokenCounter.count(
      raw.activeContentsAndDigests.map((m) => m.content).join("\n"),
    ).tokens,
    activeDigestChars,
    activeDigestTokens: heuristicTokenCounter.count(
      raw.activeContentsAndDigests.map((m) => m.digest).join("\n"),
    ).tokens,
    allContentChars: raw.allContentChars,
  };
}

export interface BuildConsolidationCostRunJsonOptions {
  llmMode: ProviderMode;
  embeddingMode: ProviderMode;
  embeddingSpace: ConsolidationEmbeddingSpaceJson;
  probeCount: number;
  haystackSize: number;
  groupSize: number;
  budgetLadder: readonly number[];
  recallLimit: number;
  stoppedAfterRound: number;
  stopReason: ConsolidationStopReason;
  rounds: ConsolidationRoundJson[];
  measuredAt: Date;
  commit: string | null;
}

/** トップレベルの JSON を組み立てる(`status: "measured"`)。純関数——`rounds` は呼び出し側が
 *  既に組み立てたものを渡す。 */
export function buildConsolidationCostRunJson(
  options: BuildConsolidationCostRunJsonOptions,
): Extract<ConsolidationCostRunJson, { status: "measured" }> {
  return {
    schemaVersion: 1,
    status: "measured",
    measuredAt: options.measuredAt.toISOString(),
    commit: options.commit,
    llmMode: options.llmMode,
    embeddingMode: options.embeddingMode,
    embeddingSpace: options.embeddingSpace,
    probeCount: options.probeCount,
    haystackSize: options.haystackSize,
    groupSize: options.groupSize,
    budgetLadder: [...options.budgetLadder],
    recallLimit: options.recallLimit,
    stoppedAfterRound: options.stoppedAfterRound,
    stopReason: options.stopReason,
    rounds: options.rounds,
  };
}

/**
 * 重みを取得できなかったときの JSON を組み立てる(`identifier-json.ts` の
 * `buildWeightsUnavailableIdentifierProbeJson` と同じ形)。**メトリクスの欄を
 * 一切持たない**——`0`/`null` で埋めると「測ったら0件だった」と区別が付かなくなる。
 */
export function buildWeightsUnavailableConsolidationCostRunJson(options: {
  measuredAt: Date;
  commit: string | null;
  detail: string;
}): ConsolidationCostRunJson {
  return {
    schemaVersion: 1,
    status: "weights_unavailable",
    measuredAt: options.measuredAt.toISOString(),
    commit: options.commit,
    detail: options.detail,
  };
}

/** `ConsolidateOutcome` の5値をすべて0に初期化した内訳。 */
export function emptyOutcomeCounts(): ConsolidationOutcomeCountsJson {
  return { consolidated: 0, nothing_to_consolidate: 0, not_examined: 0, llm_failed: 0, dry_run: 0 };
}
