// Issue #116 の残債: ADR 0095 が新設した適合テストを、**本物の `OpenAIEmbeddingProvider`** に当てる。
//
// ADR 0095 は suite を作ったが、当てたのは testkit 自身の2実装
// （`DeterministicEmbeddingProvider` / `RecordedEmbeddingProvider`）だけだった。
// ⟹ 「4つの実装が同じ契約を満たす」ことは確かめられていなかった。ここがその片方を返す。
//
// ## 🔴 何を測っていて、何を測っていないか（正直に書く）
//
// **測っている**: `OpenAIEmbeddingProvider` が実際に書いたロジック——`space` を
// `(provider, model, dimensions)` で固定すること・空配列で client を呼ばずに `[]` を返すこと・
// 応答を `index` で並べ直すこと・件数と次元が入力に対応すること。
// **そして、そこを流れるベクトルは本物の `text-embedding-3-small` が実際に返したものである**
// （`./fixtures/recorded-openai-embeddings.json`。出所は同ファイルの `provenance`）。
// ⟹ 「各ベクトル長 = space.dimensions」「成分が有限」は、**足場が自分で作った数**ではなく
// 実 API の出力に対して成り立っている。
//
// **測っていない**: HTTP・認証・リトライ・レート制限、そして**実 API 自身の振る舞い**。
// 注入した client は記録の再生であって OpenAI ではない。実 API に対して同じ9本を当てるのは
// `./live.openai.test.ts` の側で、そちらは `OPENAI_API_KEY` と `MNEMORA_LIVE_OPENAI` の
// 二重の opt-in が要る（ADR 0019 §5c）。**この2つを混同しないこと。**
//
// 既存の `./embedding-provider.test.ts` の冒頭コメントと同じ規律である
// （「ここで注入する client は本物の OpenAI SDK ではない」）。

import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import type OpenAI from "openai";
import { describeEmbeddingProviderConformance } from "@mnemora/testkit";
import { OpenAIEmbeddingProvider } from "../embedding-provider.js";

interface RecordedEmbeddings {
  space: { provider: string; model: string; dimensions: number };
  entries: { text: string; vector: number[] }[];
}

// JSON を `import` せずに読む——`resolveJsonModule` を有効にするのは、この歯1本のために
// パッケージの tsconfig を広げることになる。読み込みはテスト実行時の1回きりで足りる。
const recorded = JSON.parse(
  readFileSync(
    fileURLToPath(new URL("./fixtures/recorded-openai-embeddings.json", import.meta.url)),
    "utf8",
  ),
) as RecordedEmbeddings;

const MODEL = recorded.space.model;
const DIMENSIONS = recorded.space.dimensions;

const byText = new Map(recorded.entries.map((e) => [e.text, e.vector]));
const [a, b, c] = recorded.entries.map((e) => e.text) as [string, string, string];

/**
 * 記録した実応答を再生する、`Pick<OpenAI, "embeddings">` の形をした client。
 *
 * 🔴🔴 **`data` を index の降順（＝逆順）で返す。これは意図であって、手抜きではない。**
 *
 * `OpenAIEmbeddingProvider.embed` は `[...response.data].sort((a, b) => a.index - b.index)` で
 * 応答を並べ直している（「OpenAI は入力順を保つと文書化しているが、前提を作らない」）。
 * **足場が入力順のまま返すと、並べ直しは一度も仕事をしない**——並べ直しを消しても
 * 出力が1ビットも変わらない構成で「並べ直しを測った」とは言えない。逆順で返すことで、
 * 返り値が `.sort(...)` の実行に実際に依存する状態を作っている。
 *
 * ⚠⚠ **ただし、逆順にするだけでは順序の歯は `.sort(...)` の除去を検出しない。**
 * これは推測ではなく実測である: 逆順の再生 client のまま `.sort(...)` を外す変異を
 * 入れたところ、**適合テスト10本は全部緑のまま**で、落ちたのは
 * `./embedding-provider.test.ts` の「index 順に並べ替えて返す」1本だけだった。
 * 理由は当時の順序の歯が2件の入れ替え（`[a,b]` と `[b,a]`）で測っていたことにあり、
 * **つねに逆順で返す実装はその等式を恒等的に満たしてしまう。**
 * ⟹ 適合 suite 側の順序の歯を**3件の巡回**（`[a,b,c]` と `[b,c,a]`）へ強めた
 * （`packages/testkit/src/embedding-provider-conformance.ts` の当該コメント）。
 * その後に同じ変異を入れ直すと、**順序の歯がちょうど1本落ちる。**
 *
 * ⛔ **記録に無い入力には例外を投げる。**黙って作りものベクトルへ倒れない
 * ——`RecordedEmbeddingProvider`（ADR 0051）が守っているのと同じ規律である。
 * 倒れると「本物のベクトルで測った」と読める出力に、意味の無い値が混ざる。
 */
function createReplayClient(): Pick<OpenAI, "embeddings"> {
  const embeddings = {
    async create(params: { model: string; input: string[]; dimensions: number }) {
      // provider が何を送っているかも、ここで測る（送っていなければ記録を引く資格が無い）。
      if (params.model !== MODEL) {
        throw new Error(
          `再生クライアント: model が記録と違う（受け取り: ${params.model} / 記録: ${MODEL}）`,
        );
      }
      if (params.dimensions !== DIMENSIONS) {
        throw new Error(
          `再生クライアント: dimensions が記録と違う（受け取り: ${String(params.dimensions)} / 記録: ${DIMENSIONS}）`,
        );
      }
      // 🔴🔴 **空入力で呼ばれたら投げる。これも意図である。**
      // `OpenAIEmbeddingProvider.embed` は `if (texts.length === 0) return []` で
      // **client を呼ばずに**返す契約である（既存の `./embedding-provider.test.ts` が
      // `expect(create).not.toHaveBeenCalled()` で固定している）。
      // ⚠ **足場が空入力に `data: []` を返してしまうと、この早期 return を丸ごと消しても
      // 「`embed(ctx, [])` は `[]` を返す」の歯は緑のままになる**——実測でそうなった。
      // 投げるようにして初めて、「空配列で API を叩いていない」ことを測れる。
      if (params.input.length === 0) {
        throw new Error(
          "再生クライアント: 空の input で呼ばれた。OpenAIEmbeddingProvider は " +
            "embed(ctx, []) で client を呼ばずに返す契約であり、ここへ到達してはならない",
        );
      }
      const data = params.input.map((text, index) => {
        const vector = byText.get(text);
        if (vector === undefined) {
          throw new Error(
            "再生クライアント: この入力は記録に無い（黙って作りもののベクトルへ倒れない）。" +
              `入力: ${JSON.stringify(text)}。記録に在るのは ${recorded.entries.length} 件だけである` +
              "（fixtures/recorded-openai-embeddings.json）",
          );
        }
        return { index, embedding: vector, object: "embedding" as const };
      });
      // 🔴 逆順で返す（上記の理由）。
      return {
        object: "list" as const,
        model: MODEL,
        data: data.reverse(),
        usage: { prompt_tokens: 0, total_tokens: 0 },
      };
    },
  };
  return { embeddings } as unknown as Pick<OpenAI, "embeddings">;
}

/**
 * 🔴 適合テストの前に、**足場が歯を空回りさせていない**ことを1本測る。
 *
 * 順序の歯は `embed([a,b])[0] === embed([b,a])[1]` を見る。**もし a と b のベクトルが
 * 同じなら、並べ直しが壊れていてもこの等式は成り立ってしまい、歯は何も測らずに通る。**
 * ⟹ 3本が互いに違うことは、順序の歯が意味を持つための前提である。ここで固定しておく。
 */
describe("適合テストの前提: 記録した3本のベクトルは互いに異なる", () => {
  it("a / b / c のベクトルは、どの2本を取っても一致しない", () => {
    const [va, vb, vc] = recorded.entries.map((e) => e.vector);
    expect(va).not.toEqual(vb);
    expect(vb).not.toEqual(vc);
    expect(va).not.toEqual(vc);
  });
});

describeEmbeddingProviderConformance({
  name: "OpenAIEmbeddingProvider（記録した実応答の再生）",
  createProvider: () =>
    new OpenAIEmbeddingProvider({
      model: MODEL,
      dimensions: DIMENSIONS,
      client: createReplayClient(),
    }),
  // ⚠ **決定性を与えているのは再生であって、実 API ではない。**
  // 同じ入力に同じ記録を返すのだから、この構成は定義上決定的である——が、
  // **実 API が決定的かどうかは、ここでは一切測っていない。**それを問うのは
  // `./live.openai.test.ts` 側で、そちらは `deterministic: false` を宣言している
  // （私たちは実 API の再現性の保証を持っていない。ADR 0095 決定1 の却下理由）。
  deterministic: true,
  texts: { a, b, c },
});
