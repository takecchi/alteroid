# @mnemora/anthropic

`LLMProvider` の Anthropic 実装。zod スキーマを Anthropic のネイティブ構造化出力
（`output_config.format: json_schema`）へ翻訳する
（[docs/architecture.md](../../docs/architecture.md) §3.8）。

## ⚠ `EmbeddingProvider` は実装しない

**Anthropic は埋め込み API を提供していない**（公式には外部の埋め込みモデルの利用を案内している）。
そのため `@mnemora/anthropic` は `LLMProvider` のみを実装する
（[docs/architecture.md](../../docs/architecture.md) §4「オーナー案から変えた3点」）。

`@mnemora/core` の `createRuntime()` は `RuntimeDeps` として `llmProvider` と
`embeddingProvider` の**両方**を必須で要求する（`packages/core/src/runtime.ts`）。
⟹ **`@mnemora/anthropic` 単独では runtime を組めない。** 埋め込みが要る構成では、
`@mnemora/openai` 等の別 provider を embeddingProvider として併用すること。

```ts
import { createRuntime } from "@mnemora/core";
import { AnthropicLLMProvider } from "@mnemora/anthropic";
import { OpenAIEmbeddingProvider } from "@mnemora/openai";

// LLM は Anthropic、埋め込みは OpenAI ——LLMProvider と EmbeddingProvider は
// 独立した interface なので、provider を混在させて runtime を組める。
const runtime = createRuntime({
  // ...memoryStore / vectorStore / eventStore / outboxStore / tenantSettingsStore / hashContent は省略
  llmProvider: new AnthropicLLMProvider({ model: "claude-opus-5" }),
  embeddingProvider: new OpenAIEmbeddingProvider({
    model: "text-embedding-3-small",
    dimensions: 1536,
  }),
});
```

## インストール

```bash
pnpm add @mnemora/anthropic @mnemora/core
# または
npm i @mnemora/anthropic @mnemora/core
```

## 前提

- Node.js >= 22
- **ESM のみ**（`"type": "module"`）。CommonJS からは Node 22.12 以降の
  `require(esm)` で読み込める（TypeScript は `moduleResolution` が `node10` か
  `nodenext` なら通る。`node16` は `TS1479` になるので `nodenext` にすること）
- **`ANTHROPIC_API_KEY` 環境変数**（または `apiKey` オプション）が要る。無いと Anthropic SDK の
  呼び出しが認証エラーになる
- **`model` は必須。既定値を持たない**——どのモデルを使うかは常に呼び出し側が決める
  （`@mnemora/openai` の `OpenAILLMProvider` と同じ規律）

## 動く最小の例（型検査のみ確認・ANTHROPIC_API_KEY が無いため未実行）

```ts
import { AnthropicLLMProvider } from "@mnemora/anthropic";
import { z } from "zod";

// apiKey を省略すると ANTHROPIC_API_KEY 環境変数を読む。
// model は必須（既定値を持たない）。
const llmProvider = new AnthropicLLMProvider({ model: "claude-opus-5" });

const ctx = { tenantId: "tenant-1" };

const response = await llmProvider.complete(ctx, {
  messages: [{ role: "user", content: "こんにちは" }],
});
console.log(response.content);

// zod スキーマを渡すと、Anthropic のネイティブ構造化出力（output_config.format）経由で
// 検証済みの値が返る（core・呼び出し側に Anthropic SDK の型は一切出てこない）。
const schema = z.object({ summary: z.string() });
const structured = await llmProvider.completeStructured(ctx, {
  prompt: { messages: [{ role: "user", content: "要約して" }] },
  schema,
});
console.log(structured.summary);
```

## ⚠ 失敗は種類として返る（拒否を「空の成功」にしない）

**Anthropic の拒否は HTTP 200 で返る。**`stop_reason: "refusal"` が付いた成功応答であり、
SDK は例外を投げず、`content` にはテキストブロックが1つも無いことがある。
⟹ **このパッケージは `content` を読む前に `stop_reason` を見る。**

失敗は `AnthropicLLMProviderError` として投げられ、**`kind` で区別できる**:

| `kind` | 何が起きたか | 付いてくる情報 |
|---|---|---|
| `"refusal"` | 安全性の分類器が介入した | `refusalCategory`（`cyber` / `bio` / `frontier_llm` …。**開いた集合**） |
| `"truncated"` | 応答が途中で切れた | `stopReason`（`max_tokens` / `model_context_window_exceeded`）。**`maxTokens` を上げるか、プロンプトを短くする** |
| `"no_content"` | 上記のどれでもないのに、テキストブロックが無かった | — |

```ts
import { AnthropicLLMProviderError } from "@mnemora/anthropic";

try {
  await llmProvider.completeStructured(ctx, { prompt, schema });
} catch (error) {
  // ⚠ `instanceof` ではなく `kind` で分岐する
  //（bundler が同じクラスを二重に読み込むと `instanceof` は落ちる）。
  const kind = (error as AnthropicLLMProviderError).kind;
  if (kind === "refusal") {
    // 「モデルが答えなかった」ではなく「モデルが断った」。区別して扱えるようにしてある。
  }
}
```

**⚠ `complete()` は、拒否でも切り詰めでもない空応答に対しては、いまも空文字を返す。**
望ましい姿ではない——`@mnemora/openai` も同じ形であり、直すなら両方同時
（公開 API の破壊的変更）になるため、提起までにしてある
（[ADR 0072](../../docs/decisions/0072-anthropic-llm-provider.md) の追記）。

## `@mnemora/openai` との違い

| 観点 | `@mnemora/openai` | `@mnemora/anthropic` |
|---|---|---|
| `EmbeddingProvider` | 実装する | **実装しない**（上記） |
| 構造化出力の形 | `response_format: json_schema`（`{ name, strict: true, schema }`） | `output_config.format: json_schema`（`{ type, schema }`。`name`/`strict` 無し） |
| optional フィールド | strict モードの制約で「全キー required + null 許容」に変換してから、null を省略へ戻す（`hardenForStrictMode` / `stripNulls`） | 変換不要——`.optional()` は optional のまま Anthropic 側の `required` に反映される |
| `system` | `role: "system"` のメッセージとして `messages` に積む | top-level `system` パラメータ（`prompt.system` と `role: "system"` のメッセージを連結する） |
| `max_tokens` | 省略可 | **必須**（`maxTokens` 省略時は `DEFAULT_MAX_TOKENS`） |
| `enum` / `min` / `max` | JSON Schema の制約としてそのまま送る | **制約としては送らない**——SDK の変換が `description` へ JSON 文字列として降格させる（[ADR 0072](../../docs/decisions/0072-anthropic-llm-provider.md) 決定3b の実測） |

**⚠ 最後の行は「制約が緩い」という意味だが、`completeStructured` の戻り値は
両実装ともに `req.schema.parse` を通った検証済みの値である**——列挙から外れた値が
黙って通ることは無い（例外になる）。**止まる場所が違うだけである。**

`LLMProvider.complete` / `LLMProvider.completeStructured` の契約（core 側の interface）は
[`@mnemora/core`](../core/README.md) を参照。両実装が同じ契約に従うことは
`src/__tests__/provider-parity.test.ts` で検査している。

## もっと詳しく

- [docs/architecture.md](../../docs/architecture.md) §3.8・§4・§5.4 — `LLMProvider` の契約と provider 構成
- [ADR 0072](../../docs/decisions/0072-anthropic-llm-provider.md) — このパッケージを足した判断と、
  採らなかった案・引き受けた負債・確かめていないこと
- リポジトリ: https://github.com/takecchi/mnemora
