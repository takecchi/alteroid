import type { IdentifierArmReport } from "./identifier-arm.js";
import type { IdentifierHaystackKind } from "./identifier-probe-set.js";
import type { ProviderMode } from "./providers.js";
import { armHeadline } from "./retrieval-quality.js";
import type { ArmReport } from "./retrieval-quality.js";

/**
 * `identifier-probes` の機械可読な出力口(`./retrieval-json.js` と同じ作法。Issue #109)。
 *
 * 🔴 **数字だけを書いて、条件を書かないベンチ出力は、この repo で実際に3度壊れている**
 * (ADR 0068・ADR 0081 §3.2)。だからこの JSON も、arm ごとの数字に実際に使われた
 * `llmMode`/`embeddingMode`、そして `embeddingSpace`(`provider`/`model`/`dimensions`)を
 * 同居させる——**次元数だけでは区別できない**(`text-embedding-3-small` も256次元)ため、
 * `provider`/`model` を必ず添える。
 *
 * 🔑 **マネージャー指示(#106 再点検)により、条件が3つになった**: arm(japanese/
 * identifiers)・埋め込み空間・**haystack 条件**(`sparse`/`dense`)。⟹
 * `IdentifierProbeGroupJson` に `haystackKind` を持たせ、ASCII 識別子 probe は
 * `identifiersSparse`/`identifiersDense` の2本を**両方とも**出す
 * (⛔ 片方に差し替えない——`sparse` は #106 を表さないという発見自体を消さない)。
 * `japanese` 群は識別子密度という軸を持たないため1本のまま。
 *
 * ⛔ **`examples/chat/retrieval-baseline.json` とは別ファイル**(`./retrieval-json.js` が
 * 書く `RetrievalQualityRunJson` とは別の形)。既存の `retrieval` の出力口・基準値には
 * 一切触れていない。
 *
 * 🔴 **「重みを取得できなかった」と「測ったが値が悪かった」を型で区別する**
 * (`status` の判別union)。`"weights_unavailable"` のときは各群の欄が**存在しない**
 * ——0 や null で埋めない。「欄が無い」ことそのものが「測っていない」を表す
 * (ADR 0008「無いには種類がある」の適用)。
 */

export interface IdentifierProbeGroupJson {
  label: string;
  llmMode: ProviderMode;
  embeddingMode: ProviderMode;
  embeddingSpace: { provider: string; model: string; dimensions: number };
  /** `japanese` 群は識別子密度という軸を持たないため `"sparse"` を名乗る
   *  (`./probe-set.js` の既定 haystack を使う、という意味であって、識別子の疎密ではない)。 */
  haystackKind: IdentifierHaystackKind;
  mrrOverall: number;
  hit1Count: number;
  hit10Count: number;
  probeCount: number;
}

export type IdentifierProbeRunJson =
  | {
      schemaVersion: 2;
      status: "measured";
      measuredAt: string;
      commit: string | null;
      /** 既存の日本語意味 probe 7件(`./probe-set.js`、変更していない)を、この arm の
       *  embedding(local)で走らせた結果。arm B(擬似LLM+本物埋め込み)との直接比較用。 */
      japanese: IdentifierProbeGroupJson;
      /** ASCII 識別子 probe(`./identifier-probe-set.js`)、識別子を含まない既定 haystack。 */
      identifiersSparse: IdentifierProbeGroupJson;
      /** 同じ12 probe を、同じ書式ファミリーの識別子が密な haystack で走らせた結果
       *  (#106 の「同じ形式の別の識別子が近傍に来て埋もれる」を表す条件)。 */
      identifiersDense: IdentifierProbeGroupJson;
    }
  | {
      schemaVersion: 2;
      status: "weights_unavailable";
      measuredAt: string;
      commit: string | null;
      /** `warmupLocalEmbedding` が返した detail(`WEIGHTS_UNAVAILABLE_PREFIX` を含む)。 */
      detail: string;
    };

export interface EmbeddingSpaceJson {
  provider: string;
  model: string;
  dimensions: number;
}

/** `ArmReport`(`retrieval-quality.ts`)を `IdentifierProbeGroupJson` へ写す。 */
function japaneseGroupJson(
  report: ArmReport,
  embeddingSpace: EmbeddingSpaceJson,
): IdentifierProbeGroupJson {
  const headline = armHeadline(report);
  return {
    label: report.armLabel,
    llmMode: report.llmMode,
    embeddingMode: report.embeddingMode,
    embeddingSpace,
    haystackKind: "sparse",
    mrrOverall: headline.mrrOverall,
    hit1Count: headline.hit1Count,
    hit10Count: headline.hit10Count,
    probeCount: headline.probeCount,
  };
}

/** `IdentifierArmReport`(`identifier-arm.ts`)を `IdentifierProbeGroupJson` へ写す。 */
function identifierGroupJson(
  report: IdentifierArmReport,
  embeddingSpace: EmbeddingSpaceJson,
): IdentifierProbeGroupJson {
  return {
    label: report.armLabel,
    llmMode: report.llmMode,
    embeddingMode: report.embeddingMode,
    embeddingSpace,
    haystackKind: report.haystackKind,
    mrrOverall: report.mrrOverall,
    hit1Count: report.hit1Count,
    hit10Count: report.hit10Count,
    probeCount: report.probeCount,
  };
}

/**
 * 計測できたときの JSON を組み立てる。**出所は `ArmReport`/`IdentifierArmReport` と
 * `armHeadline()` だけ**(`./retrieval-json.js` の `buildRetrievalQualityJson` と同じ規律)。
 */
export function buildMeasuredIdentifierProbeJson(options: {
  japaneseReport: ArmReport;
  identifierSparseReport: IdentifierArmReport;
  identifierDenseReport: IdentifierArmReport;
  embeddingSpace: EmbeddingSpaceJson;
  measuredAt: Date;
  commit: string | null;
}): IdentifierProbeRunJson {
  return {
    schemaVersion: 2,
    status: "measured",
    measuredAt: options.measuredAt.toISOString(),
    commit: options.commit,
    japanese: japaneseGroupJson(options.japaneseReport, options.embeddingSpace),
    identifiersSparse: identifierGroupJson(options.identifierSparseReport, options.embeddingSpace),
    identifiersDense: identifierGroupJson(options.identifierDenseReport, options.embeddingSpace),
  };
}

/**
 * 重みを取得できなかったときの JSON を組み立てる。**メトリクスの欄を一切持たない**
 * ——`0`/`null` で埋めると「測ったら0件だった」と区別が付かなくなる。
 */
export function buildWeightsUnavailableIdentifierProbeJson(options: {
  measuredAt: Date;
  commit: string | null;
  detail: string;
}): IdentifierProbeRunJson {
  return {
    schemaVersion: 2,
    status: "weights_unavailable",
    measuredAt: options.measuredAt.toISOString(),
    commit: options.commit,
    detail: options.detail,
  };
}
