import { afterAll, describe, expect, it } from "vitest";
import { cassetteExists, cassettePathFor, loadCassette } from "../cassette-io.js";
import { decideProviderSource } from "../providers.js";
import { createExampleRuntime } from "../runtime-factory.js";
import { closeTestClient, requireDatabaseUrl, resetTestDatabase } from "./test-db.js";

/**
 * ③-4(通しの歯。ADR 0068)。
 *
 * `providers.test.ts` の `decideProviderSource` の歯は判定そのものが正しいことしか
 * 見ていない——**実際の provider 構築の配線までこの判定が届いているか**は別に測る
 * 必要がある(`cli.ts` の `resolveCassetteForRun` はかつて `process.env.OPENAI_API_KEY`
 * を直接見ており、`decideProviderSource` を経由していなかった)。
 *
 * ⚠ **本物のキーは絶対に使わない。**`OPENAI_API_KEY` には偽の値
 * (`"sk-test-dummy-not-real"`)を、`process.env` ではなく `createExampleRuntime` へ渡す
 * `env` オブジェクトの中だけに置く。`decideProviderSource` が正しく `"recorded"` を
 * 選べば `RecordedLLMProvider`/`RecordedEmbeddingProvider` しか構築されずネットワークに
 * 触れない——**万一 `"openai"` に倒れたら、この偽キーで実 API を叩こうとして例外になり、
 * この歯はその形で赤くなる**(「歯が機能していない」ことにはならない。むしろ歯として
 * 働いている——構築の時点で落ちるということは、`RecordedLLMProvider` ではなく
 * `OpenAILLMProvider` が作られたことを意味するため)。
 *
 * DB は使う(`createExampleRuntime` がマイグレーションを走らせるため)が、
 * LLM/embedding は記録の再生であり実 API・実ネットワークには一切触れない。
 */
describe("provider source の解決が実際の runtime 構築まで届く（ADR 0068 ③-4）", () => {
  it(
    "OPENAI_API_KEY が(偽値で)在っても、MNEMORA_PROVIDER_SOURCE=recorded を明示すれば " +
      "llmMode/embeddingMode が recorded になる（実 API に倒れない）",
    async () => {
      await resetTestDatabase();

      const retrievalCassettePath = cassettePathFor("retrieval");
      if (!cassetteExists(retrievalCassettePath)) {
        throw new Error(
          "examples/chat/cassettes/retrieval.json が無い。この歯は実測のカセットを前提にしている。",
        );
      }
      const cassette = loadCassette(retrievalCassettePath);

      // **`cli.ts` の `runRetrieval` が実際にやる配線をそのまま再現する**——
      // 偽キーが在る env を `decideProviderSource` に通し、その結果を
      // `MNEMORA_LLM`/`MNEMORA_EMBEDDING` の明示上書きとして渡す。
      const env = {
        OPENAI_API_KEY: "sk-test-dummy-not-real",
        MNEMORA_PROVIDER_SOURCE: "recorded",
      };
      const decision = decideProviderSource(env);
      expect(decision).toEqual({ source: "recorded", reason: "forced" });

      const handle = await createExampleRuntime(
        requireDatabaseUrl(),
        { ...env, MNEMORA_LLM: decision.source, MNEMORA_EMBEDDING: decision.source },
        { cassette },
      );
      try {
        expect(handle.llmMode).toBe("recorded");
        expect(handle.embeddingMode).toBe("recorded");
        // 記録の再生は API を叩かないので usage-meter を持たない
        // (`providers.ts` の `createProviders` の既存の契約)。
        expect(handle.usageMeter).toBeUndefined();
      } finally {
        await handle.close();
      }
    },
  );

  it("MNEMORA_PROVIDER_SOURCE を指定しなければ、キーが在るとき従来通り openai になる（既定は変えていない）", () => {
    const env = { OPENAI_API_KEY: "sk-test-dummy-not-real" };
    expect(decideProviderSource(env)).toEqual({ source: "openai", reason: "key-present" });
  });
});

afterAll(async () => {
  await closeTestClient();
});
