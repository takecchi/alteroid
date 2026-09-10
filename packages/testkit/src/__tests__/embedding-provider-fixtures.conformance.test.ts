// Issue #116: `EmbeddingProvider` の適合テストを、testkit 自身が持つ2実装に当てる。
//
// `@mnemora/openai` / `@mnemora/local-embedding` はこの PR の対象外（別の委譲が走っている、
// PR 本文の「線」参照）——ここで当てるのは testkit の中だけで完結する2つ:
// `DeterministicEmbeddingProvider`（文字コードから機械的にベクトルを作る stub）と
// `RecordedEmbeddingProvider`（ADR 0051、記録した入出力を再生する provider）。

import type { Ctx } from "@mnemora/core";
import { describeEmbeddingProviderConformance } from "../embedding-provider-conformance.js";
import { DeterministicEmbeddingProvider } from "../__fixtures__/deterministic-embedding-provider.js";
import { RecordedEmbeddingProvider } from "../__fixtures__/recorded-embedding-provider.js";
import { CassetteRecorder, RecordingEmbeddingProvider } from "../__fixtures__/cassette-recorder.js";
import type { EmbeddingCassetteSection } from "../__fixtures__/cassette.js";

const ctx: Ctx = { tenantId: "embedding-provider-conformance-fixtures" };

describeEmbeddingProviderConformance({
  name: "DeterministicEmbeddingProvider",
  createProvider: () => new DeterministicEmbeddingProvider(),
  deterministic: true,
  texts: { a: "赤", b: "青", c: "緑" },
});

// `RecordedEmbeddingProvider` は記録に無い入力で例外を投げる（`recorded-embedding-provider.ts`
// のクラス doc）ため、suite に渡す `texts` は「カセットに実際に在るテキスト」でなければならない
// ——PR 本文の注記どおり、suite 側で文字列を決め打ちできない理由がこれである。
//
// `examples/chat/cassettes/*.json` は変更しない（読むだけの対象ですらなく、ここでは触れない）。
// 代わりに `CassetteRecorder`/`RecordingEmbeddingProvider`（`cassette.test.ts` が使うのと
// 同じ道具、ADR 0051）で、この歯のためだけの最小のカセットをテスト内で組み立てる。
// 記録元には `DeterministicEmbeddingProvider` を使う——「本物の API を叩けない CI」という
// 制約はここでも同じであり、記録元が何であれ `RecordedEmbeddingProvider` は録れた値を
// そのまま返すだけなので、適合テストの検査対象としては影響しない。
let cachedSection: EmbeddingCassetteSection | undefined;

async function buildSection(): Promise<EmbeddingCassetteSection> {
  if (cachedSection) {
    return cachedSection;
  }
  const recorder = new CassetteRecorder();
  const recording = new RecordingEmbeddingProvider(new DeterministicEmbeddingProvider(), recorder);
  // ここで録る3本が、下の `texts` にそのまま対応する。
  await recording.embed(ctx, ["なつめ", "いちじく", "ざくろ"]);
  // `CassetteRecorder.toCassette()` は embedding/llm の両節が1件以上無ければ落ちる
  // （空の節を持つカセットを書き出させない、という ADR 0051 のガード）。この suite が
  // 使うのは embedding 節だけだが、ガードを満たすためだけにダミーの LLM 記録を1件足す
  // ——本番のカセット（`examples/chat` が録るもの）はこの形を踏まない、この suite だけの
  // 事情である。
  recorder.recordLLM(
    "embedding-provider-conformance-fixtures",
    { messages: [{ role: "user", content: "n/a" }] },
    "n/a（この suite は embedding 節しか読まない）",
  );
  cachedSection = recorder.toCassette().embedding;
  return cachedSection;
}

describeEmbeddingProviderConformance({
  name: "RecordedEmbeddingProvider",
  createProvider: async () => new RecordedEmbeddingProvider({ section: await buildSection() }),
  deterministic: true,
  texts: { a: "なつめ", b: "いちじく", c: "ざくろ" },
});
