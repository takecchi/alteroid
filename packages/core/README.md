# @mnemora/core

mnemora の core パッケージ。型・interface・`runtime.observe/tick/recall` の実装・
純関数の既定戦略（減衰・スコアリング）を持つ。実行時依存は [zod](https://www.npmjs.com/package/zod) だけ。

## インストール

```bash
pnpm add @mnemora/core
# または
npm i @mnemora/core
```

## 前提

- Node.js >= 22（`package.json` の `engines`）
- **ESM のみ**（`"type": "module"`）。CommonJS からは Node 22.12 以降の
  `require(esm)` で読み込める（TypeScript は `moduleResolution` が `node10` か
  `nodenext` なら通る。`node16` は `TS1479` になるので `nodenext` にすること）
- 実行時の依存は zod のみ

## ⚠ `@mnemora/core` だけでは動く物が組めない

**このパッケージは interface・型・純関数が中心で、それ単体では DB にも LLM にも
埋め込みモデルにもつながらない。**`runtime.observe()` / `runtime.tick()` / `runtime.recall()` を
実際に動かすには、`MemoryStore` / `VectorStore` / `EventStore` / `OutboxStore` /
`TenantSettingsStore`（すべて Postgres 実装は [`@mnemora/postgres`](../postgres/README.md)）と、
`LLMProvider` / `EmbeddingProvider`（OpenAI 実装は [`@mnemora/openai`](../openai/README.md)、
テスト用の決定的な擬似実装は [`@mnemora/testkit`](../testkit/README.md)）を
呼び出し側が用意して渡す必要がある。

```ts
import type {
  EmbeddingProvider,
  EventStore,
  LLMProvider,
  MemoryStore,
  OutboxStore,
  TenantSettingsStore,
  VectorStore,
} from "@mnemora/core";
import { createRuntime } from "@mnemora/core";
import { createHash } from "node:crypto";

// この7つは @mnemora/core が実装を持たない——ここでは型だけを示す骨格。
// 実際の値は @mnemora/postgres（store）と @mnemora/openai（provider）、
// またはテスト用に @mnemora/testkit の決定的な擬似 provider から調達する。
declare const memoryStore: MemoryStore;
declare const outboxStore: OutboxStore;
declare const vectorStore: VectorStore;
declare const eventStore: EventStore;
declare const tenantSettingsStore: TenantSettingsStore;
declare const llmProvider: LLMProvider;
declare const embeddingProvider: EmbeddingProvider;

const runtime = createRuntime({
  memoryStore,
  outboxStore,
  vectorStore,
  eventStore,
  tenantSettingsStore,
  llmProvider,
  embeddingProvider,
  // D16: SHA-256 hex 等、content からハッシュを計算する関数。core は計算しない。
  hashContent: (content) => createHash("sha256").update(content).digest("hex"),
});

const ctx = { tenantId: "tenant-1" };
const { observationId } = await runtime.observe(ctx, {
  kind: "utterance",
  text: "明日、京都へ出張する",
  speaker: "user",
});
```

配線をすぐ試したいだけなら、`@mnemora/postgres` と `@mnemora/openai` の README にある
そのままの例をつなげば動く（`@mnemora/postgres` 側は本物の Postgres + pgvector が要る）。

## 単体で呼べる純関数（動く最小の例）

一方で、以下は `@mnemora/core` だけで完結して**そのまま実行できる**——
記憶の減衰（`DecayStrategy`）・スコアリング（`ScoringStrategy`）・時刻（`Clock`）・
トークン数の推定（`TokenCounter`）は、DB もネットワークも要らない純関数として公開している。

```ts
import {
  defaultDecayStrategy,
  defaultScoringStrategy,
  heuristicTokenCounter,
  systemClock,
} from "@mnemora/core";

const now = systemClock.now();

// 半減期720時間（30日）で、記録から時間が経つほど強度が下がる。
const decayed = defaultDecayStrategy.strengthAt(now, {
  recordedAt: new Date("2026-01-01T00:00:00Z"),
  lastReinforcedAt: null,
  strength: 1,
  halfLifeHours: 720,
});

// 減衰・タグ一致・鮮度・強度を掛け合わせた合計スコア。
const score = defaultScoringStrategy({
  now,
  tags: ["work"],
  queryTags: ["work"],
  occurredAt: new Date("2026-01-01T00:00:00Z"),
  recordedAt: new Date("2026-01-01T00:00:00Z"),
  lastReinforcedAt: null,
  strength: 1,
  halfLifeHours: 720,
});

// 文字種で重み付けした粗い推定（CJK 0.9トークン/字・非CJK 0.25トークン/字）。
// counter: "heuristic" を必ず返す（推定値を実測値の顔で返さない、という契約そのもの）。
// ⚠ CJK 以外の非ラテン文字（キリル・タイ・アラビア文字）は依然として過小評価する。
// 厳密さが要るなら TokenCounter を差し替えること（docs/decisions/0083-*.md）。
const { tokens, counter } = heuristicTokenCounter.count("hello world");

console.log({ decayed, total: score.total, tokens, counter });
```

## もっと詳しく

- [docs/architecture.md](../../docs/architecture.md) — 全体アーキテクチャ・主要 interface（§5）
- [docs/recall.md](../../docs/recall.md) — `recall()` の7段パイプライン
- [docs/memory-model.md](../../docs/memory-model.md) — Memory のライフサイクル・減衰・忘却
- リポジトリ: https://github.com/takecchi/mnemora
