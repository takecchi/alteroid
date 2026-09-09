// packages/testkit — `src/index.ts` とは別の入口。
//
// `src/index.ts` 冒頭の宣言（「プレースホルダ実装（`__fixtures__`）は意図的にここから
// export しない。adapter 作者は自分の実装を `createStore` に渡して conformance suite を
// 走らせる」）は、そのまま維持する。**このファイルはその宣言を弱めるものではない。**
//
// ⚠ なぜ別の入口が要るか、そして危険:
//
// **adapter 作者がこれを `createStore` に渡して適合スイートを走らせると、自分の実装を
// 1文字も測らないまま緑になる。** `index.ts` から出さないのはそのためである。
//
// この入口は**リポジトリ内のテストが `Runtime` を組み立てるため**のものである
// （例: `packages/openai` が本物の `OpenAILLMProvider` を `@mnemora/core` の
// `createRuntime` に渡して、`runtime.observe()` を実際に走らせる通しの歯を書く場合。
// `runtime.observe()` が呼ぶストアは `MemoryStore` / `VectorStore` / `EventStore` /
// `OutboxStore` / `TenantSettingsStore` の5種すべてであり、全メソッドが throw する
// 偽ストアでは最初の1歩で止まってしまう——本物の provider を配線するには、
// 何かしら実際に動くインメモリ実装が要る）。
//
// **この入口は適合スイートの入力にしてはいけない。**「別の目的のための入口」であって、
// 「`index.ts` の制約を回避する裏口」ではない——適合テストを書く・走らせるときは、
// 引き続き自分の adapter 実装を `createStore` に渡すこと。

export { InMemoryMemoryStore } from "./__fixtures__/in-memory-memory-store.js";
export { InMemoryVectorStore } from "./__fixtures__/in-memory-vector-store.js";
export { InMemoryEventStore } from "./__fixtures__/in-memory-event-store.js";
export { InMemoryOutboxStore } from "./__fixtures__/in-memory-outbox-store.js";
export { InMemoryTenantSettingsStore } from "./__fixtures__/in-memory-tenant-settings-store.js";
