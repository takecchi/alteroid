# @mnemora/testkit

adapter（`MemoryStore` / `VectorStore` / `EventStore` / `OutboxStore` /
`TenantSettingsStore` の実装）が満たすべき適合テスト一式（conformance suite）と、
決定的な擬似 `LLMProvider` / `EmbeddingProvider`。

## インストール

```bash
pnpm add -D @mnemora/testkit @mnemora/core vitest
# または
npm i -D @mnemora/testkit @mnemora/core vitest
```

`@mnemora/testkit` は `vitest` に依存している（`describe`/`it`/`expect` を内部で呼ぶ）ため、
**vitest から実行するコード**として使う。テスト対象の adapter を書く側の devDependency として入れる。

**`vitest` は `peerDependencies` である**（ADR 0066）——このパッケージは vitest を同梱せず、
**使う側が入れた vitest をそのまま使う。**そうしないと、使う側の vitest と
このパッケージが引き込む vitest の2つが `node_modules` に並び、`describe` の実体が
食い違って「テストが1本も見つからない」形の壊れ方をしうる。

## 前提

- Node.js >= 22
- **ESM のみ**（`"type": "module"`）。CommonJS からは Node 22.12 以降の
  `require(esm)` で読み込める（TypeScript は `moduleResolution` が `node10` か
  `nodenext` なら通る。`node16` は `TS1479` になるので `nodenext` にすること）
- 呼び出し側が [vitest](https://vitest.dev/) を使っていること（`describeXxxConformance` は
  内部で `describe`/`it`/`expect` を呼ぶ）

## 動く最小の例（実際に vitest で実行して確認済み）

**adapter 作者は、自分の実装を conformance suite に食わせるだけで、テナント分離・
append-only・並び順・外部キー相当の契約などを検査できる。**以下は `EventStore` を
自作した場合の例（`describeEventStoreConformance` を使う。他に
`describeMemoryStoreConformance` / `describeVectorStoreConformance` /
`describeOutboxStoreConformance` / `describeTenantSettingsStoreConformance` がある)。

```ts
// my-event-store.test.ts
import { randomUUID } from "node:crypto";
import type { Ctx, EventFilter, EventId, EventStore, MemoryEvent, NewMemoryEvent } from "@mnemora/core";
import { describeEventStoreConformance } from "@mnemora/testkit";

// 適合テストは「memoryId が実在の Memory を指しているか」（外部キー相当）も検査する。
// ここでは実際の MemoryStore を持たない最小の例なので、prepareMemoryId が登録した id
// だけを「実在する」ことにする素朴な実装にしてある。
const knownMemoryIds = new Set<string>();

class MyEventStore implements EventStore {
  private rows: MemoryEvent[] = [];

  async append(ctx: Ctx, event: NewMemoryEvent): Promise<MemoryEvent> {
    if (event.memoryId !== null && !knownMemoryIds.has(event.memoryId)) {
      throw new Error(`append: unknown memoryId: ${event.memoryId}`);
    }
    const row: MemoryEvent = { id: randomUUID(), at: event.at ?? new Date(), ...event };
    this.rows.push(row);
    return row;
  }

  async get(ctx: Ctx, id: EventId): Promise<MemoryEvent | null> {
    return this.rows.find((row) => row.tenantId === ctx.tenantId && row.id === id) ?? null;
  }

  async list(ctx: Ctx, filter: EventFilter): Promise<MemoryEvent[]> {
    return this.rows
      .filter((row) => row.tenantId === ctx.tenantId)
      .filter((row) => filter.kind === undefined || row.kind === filter.kind)
      .filter((row) => filter.memoryId === undefined || row.memoryId === filter.memoryId)
      .filter((row) => filter.since === undefined || row.at >= filter.since)
      .filter((row) => filter.until === undefined || row.at <= filter.until)
      .sort((a, b) => a.at.getTime() - b.at.getTime())
      .slice(0, filter.limit);
  }
}

describeEventStoreConformance({
  name: "my-event-store",
  createStore: () => new MyEventStore(),
  prepareMemoryId: async () => {
    const id = randomUUID();
    knownMemoryIds.add(id);
    return id;
  },
});
```

```bash
npx vitest run my-event-store.test.ts
```

## 決定的な擬似 provider

`LLMProvider` / `EmbeddingProvider` の本物（[`@mnemora/openai`](../openai/README.md)）を
CI で叩けない（API キーが無い）場合に備えて、決定的な擬似実装を export している。

```ts
import { DeterministicLLMProvider, DeterministicEmbeddingProvider } from "@mnemora/testkit";

const llmProvider = new DeterministicLLMProvider();
const embeddingProvider = new DeterministicEmbeddingProvider(); // 既定で 8次元
```

**⚠ これは本物の LLM・埋め込みモデルを模したものではない。**文字コードや文字列長から
機械的に出力を作るだけで、意味的な類似度・言語理解は一切表現しない。**配線・契約・
適合テストのための stub**であり、想起の質を測る物差しにはならない
（`recorded` 層・`openai` 層との違いは [ADR 0051](../../docs/decisions/0051-recorded-provider-cassette.md) を参照）。

## もっと詳しく

- [docs/architecture.md](../../docs/architecture.md) §5 — 各 interface の契約
- [ADR 0051](../../docs/decisions/0051-recorded-provider-cassette.md) — provider の3層
  （`deterministic` / `recorded` / `openai`）の使い分け
- [ADR 0047](../../docs/decisions/0047-fake-referential-integrity-existence-only.md) — 擬似実装の外部キー相当の扱い
- リポジトリ: https://github.com/takecchi/mnemora
