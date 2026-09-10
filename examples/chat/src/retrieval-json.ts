import type { Cassette } from "@mnemora/testkit";
import type { ProviderMode } from "./providers.js";
import { armHeadline } from "./retrieval-quality.js";
import type { ArmReport } from "./retrieval-quality.js";

/**
 * `retrieval` の機械可読な出力口（PR「retrieval を CI に載せる」）。
 *
 * **背景**: `cli.ts` の `runRetrieval()` は `console.log` の表しか持っておらず、CI が
 * 「今回いくつだったか」を掴む手段が無かった（ADR 0022 が名指しした負債）。
 * `MNEMORA_RETRIEVAL_JSON=<path>` が設定されたときだけ、このモジュールが組み立てた
 * オブジェクトを `cli.ts` がファイルへ書く（このファイル自身はファイル I/O を持たない
 * ——**純関数のまま保ち、DB を要求せずに検査できるようにする**ため）。
 *
 * 🔴 **数字だけを書いて、条件を書かないベンチ出力は、この repo で実際に3度壊れている**
 * （ADR 0068 が丸ごとその再発防止、ADR 0081 §3.2 が3度目の記録: 「arm を取り違えて
 * 記憶した」）。だからこの JSON は、arm ごとの数字に **その arm で実際に使われた
 * `llmMode`/`embeddingMode`** を同じオブジェクトに同居させ、実行全体には
 * provider source・カセットの `recordedAt`・埋め込み空間・probe/haystack の件数・
 * 測定時刻・commit を同居させる。**後から数字だけを切り離して readable にできない形**
 * にすることが、この形の存在理由である。
 *
 * **出所は `ArmReport` と `armHeadline()` だけ**（PR 本文の指定）。
 * `mrrOverall`/`hit1Count`/`hit10Count`/`probeCount` は `armHeadline(report)` から取る
 * ——`formatArmSummaryTable`/`formatArmDetail` と同じ関数を経由することで、
 * 表示用の文字列とこの JSON が別々に集計して食い違う経路を、構造上閉じる
 * （ADR 0068 ②と同じ考え方）。`mrrLexicalControl`/`mrrNonLexical` は `armHeadline` が
 * 持っていない（ADR 0068「引き受ける負債」に明記された既知の欠け）ため、
 * `formatArmSummaryTable` 自身と同じく `report` から直接読む。
 */

export interface RetrievalQualityArmJson {
  armLabel: string;
  /** その arm で**実際に**使われたモード（`ArmReport.llmMode` = `handle.llmMode` の実値）。 */
  llmMode: ProviderMode;
  embeddingMode: ProviderMode;
  mrrOverall: number;
  mrrLexicalControl: number;
  mrrNonLexical: number;
  hit1Count: number;
  hit10Count: number;
  probeCount: number;
}

export interface RetrievalQualityCassetteJson {
  /** カセットを記録した時刻（ISO 8601）。カセットを使っていない run では欄自体が無い。 */
  recordedAt: string;
  embedding: {
    provider: string;
    model: string;
    dimensions: number;
  };
}

export interface RetrievalQualityRunJson {
  /** この形が変わったら上げる。読み手（summary スクリプト）が形の変化を検知できるように。 */
  schemaVersion: 1;
  /** ISO 8601。JSON を組み立てた時刻——arm の実行が全部終わった後。 */
  measuredAt: string;
  /** `git rev-parse HEAD`。取れなければ `null`（推測で埋めない。`./git-info.js` 参照）。 */
  commit: string | null;
  /** ADR 0068 ③ の `decideProviderSource` が選んだ側。 */
  providerSource: "recorded" | "openai";
  /** `providerSource === "openai"`（実 API 直叩き）のときは `null`。 */
  cassette: RetrievalQualityCassetteJson | null;
  /** 全 arm 共通の probe 件数（`reports[0].probes.length`。arm ごとに違うことは無い）。 */
  probeCount: number;
  /** 全 arm 共通の haystack 件数。`ingest.observationCount` から probe 分（gold+distractor）を
   *  引いて求める——`DEFAULT_HAYSTACK_SIZE` を書き写すと、呼び出し側が別の値を渡したときに
   *  この JSON だけが古い値のまま残る（ADR 0068 ②と同じ「出所を1箇所にする」判断）。 */
  haystackSize: number;
  arms: RetrievalQualityArmJson[];
}

export interface BuildRetrievalQualityJsonOptions {
  /** 3 arm 分。空配列は渡さない想定だが、渡されても例外にはしない（下記参照）。 */
  reports: readonly ArmReport[];
  providerSource: "recorded" | "openai";
  /** `providerSource === "openai"` なら `undefined` を渡すこと。 */
  cassette: Cassette | undefined;
  measuredAt: Date;
  commit: string | null;
}

/**
 * `runRetrieval()` が集めた `ArmReport[]` から、機械可読な JSON を組み立てる。
 *
 * **純関数**（ファイル I/O・環境変数・時刻取得を一切行わない）——呼び出し側が
 * `measuredAt`/`commit` を明示的に渡す。これにより DB もネットワークも無い環境で
 * 検査できる（`__tests__/retrieval-json.test.ts`）。
 *
 * **`reports` が空のとき** `probeCount`/`haystackSize` は 0 になる。`cli.ts` の
 * `runRetrieval()` は必ず3 arm を作ってから呼ぶため実際には起きないが、
 * 「起きたら例外にする」という選択は取らない——このオブジェクトを作ること自体は
 * 失敗させず、`0` という値そのものに「今回は arm が無かった」が現れるようにする
 * （ADR 0008「無いには種類がある」の軽い適用。空配列を渡して落ちるほうが、
 * 呼び出し側のミスを実行時例外という重い形で伝えることになり、この用途には合わない）。
 */
export function buildRetrievalQualityJson(
  options: BuildRetrievalQualityJsonOptions,
): RetrievalQualityRunJson {
  const first = options.reports[0];
  const probeCount = first?.probes.length ?? 0;
  const haystackSize = first ? first.ingest.observationCount - probeCount * 2 : 0;

  return {
    schemaVersion: 1,
    measuredAt: options.measuredAt.toISOString(),
    commit: options.commit,
    providerSource: options.providerSource,
    cassette: options.cassette
      ? {
          recordedAt: options.cassette.recordedAt,
          embedding: {
            provider: options.cassette.embedding.space.provider,
            model: options.cassette.embedding.space.model,
            dimensions: options.cassette.embedding.space.dimensions,
          },
        }
      : null,
    probeCount,
    haystackSize,
    arms: options.reports.map((report) => {
      const headline = armHeadline(report);
      return {
        armLabel: report.armLabel,
        llmMode: report.llmMode,
        embeddingMode: report.embeddingMode,
        mrrOverall: headline.mrrOverall,
        mrrLexicalControl: report.mrrLexicalControl,
        mrrNonLexical: report.mrrNonLexical,
        hit1Count: headline.hit1Count,
        hit10Count: headline.hit10Count,
        probeCount: headline.probeCount,
      };
    }),
  };
}
