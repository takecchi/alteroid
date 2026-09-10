// packages/local-embedding — EmbeddingProvider の、外部サービスへ繋がない実装。
// transformers.js（onnxruntime）でプロセス内推論する。
// core にも呼び出し側にも transformers.js の型を漏らさない（docs/architecture.md §3.8）。

export * from "./local-embedding-provider.js";
export * from "./pipeline.js";
