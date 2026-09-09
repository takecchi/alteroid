import { describe, it, expect } from "vitest";
import { z } from "zod";
import { AnthropicLLMProvider } from "../llm-provider.js";

/**
 * live テスト（本物の Anthropic を叩く。**明示的な opt-in が要る**）。
 *
 * **`packages/openai` の `live.openai.test.ts` と同じ形にしてある**——理由もそちらから
 * 引き継ぐ。要点だけ再掲する:
 *
 * **⚠ 鍵を持っていることは、いま課金してよいという意思表示ではない。**
 * `packages/openai` 側では、以前 `OPENAI_API_KEY` の有無だけで発火していた結果、
 * キーを環境に持っている人が `pnpm run test` を1回走らせるだけで
 * **画面から読み取れない形で課金が発生していた**
 * （[ADR 0019 §5c](../../../../docs/decisions/0019-real-openai-measurement-cost.md)）。
 * **同じ穴を Anthropic 側で掘り直さない。**
 *
 * **⟹ 走る条件は2つ**: `ANTHROPIC_API_KEY` が在り、**かつ**
 * `MNEMORA_LIVE_ANTHROPIC` が空でない値で設定されていること。
 * どちらか一方でも欠ければ skip する。
 *
 * `MNEMORA_LIVE_ANTHROPIC` は**空でない値なら何でも opt-in とみなす**（`1` / `true` / `yes`）。
 * 特定の綴りだけを受け付けて他を黙って無視すると、「設定したのに走らない」という
 * 静かな罠を作る——ここでは「値の解釈」を持たないことでその罠を消している。
 *
 * **CI では走らない。** GitHub Actions のワークフローに `ANTHROPIC_API_KEY` は設定していない
 * ため、CI 上ではこの `describe` ブロックの各 it が常に `skipped` として表示される
 * （`it.skipIf` を使う——`describe.skip` や「ファイル自体を読み込まない」形にはしない。
 * テスト名を消してしまう `if (!apiKey) return` は採らない——それだと
 * 「1件パスした」という誤った印象を残す）。
 *
 * **⚠ ADR 0072 に書いたこと**: この PR を書いた作業者の実行環境には `ANTHROPIC_API_KEY` が
 * 無く、**実 API は一度も叩いていない**（カセットも作っていない）。⟹ 下の2件が実際に
 * 通ることは**確かめていない**。確かめたのは、偽 client を使ったリクエスト組み立ての検査と、
 * 翻訳結果そのものの検査だけである。
 *
 * ローカルで実行するには（**本物の API を叩き、課金が発生する**）:
 *   ANTHROPIC_API_KEY=sk-ant-... MNEMORA_LIVE_ANTHROPIC=1 pnpm --filter @mnemora/anthropic test
 */
const apiKey = process.env.ANTHROPIC_API_KEY;
const optedIn = (process.env.MNEMORA_LIVE_ANTHROPIC ?? "") !== "";
const live = optedIn && apiKey !== undefined && apiKey !== "";

/** live テストで使うモデル。**パッケージ本体は既定モデルを持たない**
 * （`AnthropicLLMProviderOptions.model` は必須）ので、ここはこのテストの裁量値である。 */
const LIVE_MODEL = "claude-opus-5";

describe("live: Anthropic (ANTHROPIC_API_KEY と MNEMORA_LIVE_ANTHROPIC の両方が無ければ skipped と表示される)", () => {
  it.skipIf(!live)("AnthropicLLMProvider.complete が実際のテキストを返す", async () => {
    const provider = new AnthropicLLMProvider({ apiKey, model: LIVE_MODEL });
    const result = await provider.complete(
      { tenantId: "live-test" },
      { messages: [{ role: "user", content: "Say hello in one short sentence." }] },
    );
    expect(typeof result.content).toBe("string");
    expect(result.content.length).toBeGreaterThan(0);
  });

  it.skipIf(!live)("AnthropicLLMProvider.completeStructured が実際の構造化出力を返す", async () => {
    const provider = new AnthropicLLMProvider({ apiKey, model: LIVE_MODEL });
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
  });
});
