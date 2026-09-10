import { describe, it, expect } from "vitest";
import { z } from "zod";
import { describeEmbeddingProviderConformance } from "@mnemora/testkit";
import { OpenAIEmbeddingProvider } from "../embedding-provider.js";
import { OpenAILLMProvider } from "../llm-provider.js";

/**
 * live テスト（本物の OpenAI を叩く。**明示的な opt-in が要る**）。
 *
 * **⚠ 以前は `OPENAI_API_KEY` の有無だけで発火していた。**
 * その結果、キーを環境に持っている人が `pnpm run test` を1回走らせるだけで、
 * **画面から読み取れない形で課金が発生していた**
 * （[ADR 0019 §5c](../../../../docs/decisions/0019-real-openai-measurement-cost.md)
 * がこの事象を記録している。本 PR の作業中にも実際に踏んだ）。
 * **鍵を持っていることは、いま課金してよいという意思表示ではない。**
 *
 * **⟹ 走る条件を2つにした**: `OPENAI_API_KEY` が在り、**かつ**
 * `MNEMORA_LIVE_OPENAI` が空でない値で設定されていること。
 * どちらか一方でも欠ければ skip する。
 *
 * `MNEMORA_LIVE_OPENAI` は**空でない値なら何でも opt-in とみなす**（`1` / `true` / `yes`）。
 * 特定の綴りだけを受け付けて他を黙って無視すると、「設定したのに走らない」という
 * 静かな罠を作る——ここでは「値の解釈」を持たないことでその罠を消している。
 *
 * **CI では走らない。** GitHub Actions のワークフローに `OPENAI_API_KEY` は設定していない
 * ため、CI 上ではこの `describe` ブロックが常に `skipped` として表示される
 * （`it.skipIf` を使う——`describe.skip` や「ファイル自体を読み込まない」形にはしない。
 * これは「skip ではなく走っていないと分かる形にする」という要求を、
 * vitest のレポートに「このテストの名前・このテストが skip されたこと」を必ず出す、
 * という形で満たすための選択である。テスト名を消してしまう `if (!apiKey) return` は
 * 採らない——それだと「1件パスした」という誤った印象を残す）。
 * **opt-in を足してもこの性質は変わらない**——条件が1つ増えただけで、
 * 走らなかったことはレポートに skipped として必ず出る。
 *
 * ローカルで実行するには（**本物の API を叩き、課金が発生する**）:
 *   OPENAI_API_KEY=sk-... MNEMORA_LIVE_OPENAI=1 pnpm --filter @mnemora/openai test
 */
const apiKey = process.env.OPENAI_API_KEY;
const optedIn = (process.env.MNEMORA_LIVE_OPENAI ?? "") !== "";
const live = optedIn && apiKey !== undefined && apiKey !== "";

describe("live: OpenAI (OPENAI_API_KEY と MNEMORA_LIVE_OPENAI の両方が無ければ skipped と表示される)", () => {
  it.skipIf(!live)("OpenAIEmbeddingProvider.embed が実際の次元数のベクトルを返す", async () => {
    const provider = new OpenAIEmbeddingProvider({
      apiKey,
      model: "text-embedding-3-small",
      dimensions: 64,
    });
    const [vector] = await provider.embed({ tenantId: "live-test" }, ["mnemora live test"]);
    expect(vector).toHaveLength(64);
  });

  it.skipIf(!live)(
    "OpenAILLMProvider.completeStructured が実際の Structured Output を返す",
    async () => {
      const provider = new OpenAILLMProvider({ apiKey, model: "gpt-4o-mini" });
      const schema = z.object({
        greeting: z.string(),
        isFriendly: z.boolean().optional(),
      });
      const result = await provider.completeStructured(
        { tenantId: "live-test" },
        {
          prompt: {
            system: "You return a short greeting as structured JSON.",
            messages: [{ role: "user", content: "Say hello in one short sentence." }],
          },
          schema,
        },
      );
      expect(typeof result.greeting).toBe("string");
      expect(result.greeting.length).toBeGreaterThan(0);
    },
  );
});

/**
 * live: **実 API そのもの**に、ADR 0095 の適合テスト9本を当てる（Issue #116 の残債）。
 *
 * `./embedding-provider.conformance.test.ts` は同じ9本を、**記録した実応答を再生する
 * client** に対して当てている。そちらが測れないのは「実 API 自身の振る舞い」——
 * ここがそこを埋める唯一の経路である。
 *
 * 🔴 **`deterministic: false` を宣言する。**
 * 私たちは**実 API が同じ入力に同じベクトルを返すという保証を持っていない。**
 * ADR 0095 が「決定性を無条件に要求する案」を却下したのは、まさにこの理由である
 * （適合テストが「実装が守れない契約」を主張することになる）。
 * ⟹ 決定性に依存する2本は `it.skip` として**名前が残る**——「そもそも歯が無い」と
 * 「走って通った」を、ログ上で区別できる形を保つ（ADR 0095 決定3）。
 * ⚠ **もし将来、実 API の再現性を実測したのなら、そのときは測定の記録と一緒に
 * `true` へ変えること。⛔ 「たぶん決定的だから」で変えないこと。**
 *
 * ⚠ **課金が増えることを名乗る（ADR 0019 §5c）。**この追加で、live を1回走らせるごとに
 * `embeddings.create` の呼び出しが **5回**増える（`space` の不変・件数・次元・有限性・1件——
 * `embed(ctx, [])` は client を呼ばない）。入力はどれも短い1〜3件なので実費はごく小さいが、
 * **「小さいから黙って足してよい」ではない。**二重の opt-in の内側であることが前提である。
 *
 * ⚠ **この節は一度も走らせていない。**この変更を書いた器に `OPENAI_API_KEY` が無いためで、
 * CI にも鍵は無い（`.github/workflows/ci.yml` に `OPENAI_API_KEY` は出てこない）。
 * ⟹ **「実 API が9本を満たすか」は、いまだ誰も測っていない。**この節は、鍵を持つ人が
 * それを1コマンドで測れるようにするために置いてある。
 */
describe.skipIf(!live)(
  "live: 実 API に対する EmbeddingProvider 適合テスト（ADR 0095 / Issue #116）",
  () => {
    describeEmbeddingProviderConformance({
      name: "OpenAIEmbeddingProvider（実 API）",
      createProvider: () =>
        new OpenAIEmbeddingProvider({
          apiKey,
          model: "text-embedding-3-small",
          dimensions: 256,
        }),
      deterministic: false,
      // ⚠ 互いに違う短い文字列にする。順序の歯は `deterministic: false` で skip されるが、
      // 「3件渡して3件返る」を測る以上、同じ文字列を並べる意味は無い。
      texts: { a: "mnemora conformance a", b: "mnemora conformance b", c: "mnemora conformance c" },
      // ネットワーク往復は vitest の既定（5秒）に収まらないことがある。
      timeout: 60_000,
    });
  },
);
