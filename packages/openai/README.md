# @mnemora/openai

`EmbeddingProvider` / `LLMProvider` の OpenAI 実装。zod スキーマを OpenAI の
Structured Output（`response_format: json_schema`）へ翻訳する
（[docs/architecture.md](../../docs/architecture.md) §3.8）。

## publish について

**publish を始める判断は下った**（[ADR 0066](../../docs/decisions/0066-start-publishing-with-oidc.md)）。
`private: true` は外れ、**GitHub Releases で `v<版>` の Release を publish すると**
`.github/workflows/publish.yml` が npm の Trusted Publishing (OIDC) で上げる
（pre-release にチェックを入れた Release は `latest` ではなく `next` に入る）。

**⚠ registry に実際に上がっているかは、この文書ではなく registry に訊くこと。**

```bash
npm view @mnemora/openai version
```

初回の `0.1.0` だけは手元から出す必要がある——npm の Trusted Publishing は
**設定する時点でパッケージが registry に在ること**を前提にしており、初版を OIDC で
出すことはできない（[npm/cli#8544](https://github.com/npm/cli/issues/8544)）。
その手順は ADR 0066 の「publish の手順」にある。

## インストール

```bash
pnpm add @mnemora/openai @mnemora/core
# または
npm i @mnemora/openai @mnemora/core
```

## 前提

- Node.js >= 22
- ESM（`"type": "module"`）
- **`OPENAI_API_KEY` 環境変数**（または `apiKey` オプション）が要る。無いと OpenAI SDK の
  呼び出しが認証エラーになる
- 1つの `OpenAIEmbeddingProvider` インスタンスは1つの埋め込み空間（`provider`/`model`/`dimensions`の組）に固定される。次元をモデルに応じて動的に変える使い方はできない

## 動く最小の例（型検査のみ確認・OPENAI_API_KEY が無いため未実行）

```ts
import { OpenAIEmbeddingProvider, OpenAILLMProvider } from "@mnemora/openai";
import { z } from "zod";

// apiKey を省略すると OPENAI_API_KEY 環境変数を読む。
const embeddingProvider = new OpenAIEmbeddingProvider({
  model: "text-embedding-3-small",
  dimensions: 1536,
});

const llmProvider = new OpenAILLMProvider({ model: "gpt-4o-mini" });

const ctx = { tenantId: "tenant-1" };

const [vector] = await embeddingProvider.embed(ctx, ["hello world"]);
console.log(vector?.length); // 1536

const response = await llmProvider.complete(ctx, {
  messages: [{ role: "user", content: "こんにちは" }],
});
console.log(response.content);

// zod スキーマを渡すと、OpenAI の Structured Output 経由で検証済みの値が返る
// （core・呼び出し側に OpenAI SDK の型は一切出てこない）。
const schema = z.object({ summary: z.string() });
const structured = await llmProvider.completeStructured(ctx, {
  prompt: { messages: [{ role: "user", content: "要約して" }] },
  schema,
});
console.log(structured.summary);
```

`EmbeddingProvider.embed` / `LLMProvider.complete` / `LLMProvider.completeStructured` の
契約（`core` 側の interface）は [`@mnemora/core`](../core/README.md) を参照。
`createRuntime()` にそのまま渡して使う例は [`@mnemora/postgres`](../postgres/README.md) の
README にある。

## もっと詳しく

- [docs/architecture.md](../../docs/architecture.md) §3.8・§5.4・§5.5 — `LLMProvider` / `EmbeddingProvider` の契約
- [ADR 0019](../../docs/decisions/0019-real-openai-measurement-cost.md) — 本物の OpenAI を使った計測のコスト
- [ADR 0051](../../docs/decisions/0051-recorded-provider-cassette.md) — 本物の provider と記録・擬似 provider の使い分け
- リポジトリ: https://github.com/takecchi/mnemora
