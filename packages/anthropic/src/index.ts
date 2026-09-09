// packages/anthropic — LLMProvider の Anthropic 実装。
// core にも呼び出し側にも Anthropic SDK の型を漏らさない（docs/architecture.md §3.8）。
//
// ⚠ EmbeddingProvider は実装しない。Anthropic は埋め込み API を提供していないため
// （docs/architecture.md §4「オーナー案から変えた3点」）。埋め込みが要る構成では
// `@mnemora/openai` 等、別の provider を併用すること（README.md 参照）。

export * from "./llm-provider.js";
export * from "./json-schema.js";
