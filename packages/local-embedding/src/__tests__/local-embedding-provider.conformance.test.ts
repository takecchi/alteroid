// Issue #116 の残債: ADR 0095 が新設した適合テストを、**本物の `LocalEmbeddingProvider`** に当てる。
//
// ADR 0095 は suite を作ったが、当てたのは testkit 自身の2実装だけだった。ここがもう片方を返す。
//
// ## 🔴 何を測っていて、何を測っていないか（正直に書く）
//
// **測っている**: `LocalEmbeddingProvider` が実際に書いたロジック——`space` を
// コンストラクタで凍結すること・`embed([])` でモデルを起こさないこと・prefix を通す経路・
// 件数の実行時検査・宣言した次元との一致の実行時検査。
// **そして、そこを流れるベクトルは本物の ruri-v3-30m (ONNX/q8) が実際に返したものである**
// （`./fixtures/real-ruri-embeddings.json`。出所は同ファイルの `provenance`）。
//
// **測っていない**: onnxruntime の推論そのもの・トークナイザ・モデルの取得。
// ⚠ **もう1つ、性質として測れていないものがある**: 注入した pipeline は表引きなので
// **バッチの組み方に依らず同じベクトルを返す**が、本物のモデルは padding を伴う
// バッチ処理をするため、そうとは限らない（ADR 0090 §1.4、ADR 0095 決定5）。
// ⟹ **順序の歯が本物のモデルでも成り立つかは、ここでは分からない。**
// それを問うのは `./live.local-embedding.test.ts` 側（opt-in）である。
//
// ⚠ **この検査はモデルの重みを一切落とさない**（`createPipeline` を注入するため）。
// ⟹ CI の費用も、CI が落ちる回数も増えない。

import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import { describeEmbeddingProviderConformance } from "@mnemora/testkit";
import {
  DEFAULT_LOCAL_EMBEDDING_DIMENSIONS,
  DEFAULT_LOCAL_EMBEDDING_MODEL_ID,
  LOCAL_EMBEDDING_PROVIDER_ID,
  LocalEmbeddingProvider,
} from "../local-embedding-provider.js";
import type { CreateLocalEmbeddingPipeline } from "../pipeline.js";

interface RealRuriEmbeddings {
  space: { provider: string; model: string; dimensions: number };
  entries: { text: string; vector: number[] }[];
}

const real = JSON.parse(
  readFileSync(
    fileURLToPath(new URL("./fixtures/real-ruri-embeddings.json", import.meta.url)),
    "utf8",
  ),
) as RealRuriEmbeddings;

const byText = new Map(real.entries.map((e) => [e.text, e.vector]));
const [a, b, c] = real.entries.map((e) => e.text) as [string, string, string];

/**
 * 本物のモデルの出力を再生する `createPipeline`。
 *
 * 🔴🔴 **空配列で呼ばれたら投げる。これは意図であって、手抜きではない。**
 *
 * `LocalEmbeddingProvider.embed` は `if (texts.length === 0) return []` で
 * **モデルを起こさずに返す**（`warmup()` の doc が「`embed(ctx, [])` ではウォームアップ
 * できない」と書いているのは、この早期 return が在るからである）。
 * **足場が `[]` を受けて `[]` を返してしまうと、この早期 return を丸ごと消しても
 * 「`embed(ctx, [])` は `[]` を返す」の歯は緑のままになる。**＝ 歯が偽陽性になる。
 * 投げるようにして初めて、「空配列でモデルを起こしていない」ことを測れる。
 * （実際に早期 return を消す変異を入れて、この歯が落ちることを確かめてある。PR 本文参照。）
 *
 * ⛔ 記録に無い入力にも投げる（黙って作りもののベクトルへ倒れない。ADR 0051 と同じ規律）。
 */
const createReplayPipeline: CreateLocalEmbeddingPipeline = async () => {
  return async (texts) => {
    if (texts.length === 0) {
      throw new Error(
        "再生 pipeline: 空配列で呼ばれた。LocalEmbeddingProvider は embed(ctx, []) で" +
          "モデルを起こさずに返す契約であり（early return）、ここへ到達してはならない",
      );
    }
    return texts.map((text) => {
      const vector = byText.get(text);
      if (vector === undefined) {
        throw new Error(
          "再生 pipeline: この入力は記録に無い（黙って作りもののベクトルへ倒れない）。" +
            `入力: ${JSON.stringify(text)}。記録に在るのは ${real.entries.length} 件だけである` +
            "（fixtures/real-ruri-embeddings.json）",
        );
      }
      return vector;
    });
  };
};

describe("適合テストの前提", () => {
  /**
   * 🔴 順序の歯は `embed([a,b])[0] === embed([b,a])[1]` を見る。**もし a と b の
   * ベクトルが同じなら、対応が壊れていてもこの等式は成り立ち、歯は何も測らずに通る。**
   */
  it("記録した3本のベクトルは互いに異なる", () => {
    const [va, vb, vc] = real.entries.map((e) => e.vector);
    expect(va).not.toEqual(vb);
    expect(vb).not.toEqual(vc);
    expect(va).not.toEqual(vc);
  });

  /**
   * ⚠ fixture の `space` を**本物の定数から**照合する。ベタ書きの文字列どうしを
   * 比べても、既定が変わったことは検出できない（`vitest.config.mts` が
   * `@mnemora/postgres` を「本物を import して使う」ことにしているのと同じ理由）。
   */
  it("fixture の space は LocalEmbeddingProvider の既定と一致する（ずれていたら写しが古い）", () => {
    expect(real.space).toEqual({
      provider: LOCAL_EMBEDDING_PROVIDER_ID,
      model: DEFAULT_LOCAL_EMBEDDING_MODEL_ID,
      dimensions: DEFAULT_LOCAL_EMBEDDING_DIMENSIONS,
    });
  });
});

describeEmbeddingProviderConformance({
  name: "LocalEmbeddingProvider（本物のモデルの出力を写した pipeline の再生）",
  // ⚠ `createPipeline` 以外は渡さない——**既定のまま = production と同じ `space`** で測る。
  createProvider: () => new LocalEmbeddingProvider({ createPipeline: createReplayPipeline }),
  // 決定性を与えているのは再生（表引き）であって、モデルではない。
  // **本物のモデルが決定的かどうかは `./live.local-embedding.test.ts` 側が測る。**
  deterministic: true,
  texts: { a, b, c },
});
