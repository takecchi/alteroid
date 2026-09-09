# @mnemora/postgres

`MemoryStore` / `VectorStore` / `EventStore` / `OutboxStore` / `TenantSettingsStore` の
Postgres + pgvector 実装（[docs/memory-model.md](../../docs/memory-model.md) §10）。
マイグレーション実行用の CLI（`mnemora-postgres-migrate`）も含む。

## publish について

**publish を始める判断は下った**（[ADR 0066](../../docs/decisions/0066-start-publishing-with-oidc.md)）。
`private: true` は外れ、**GitHub Releases で `v<版>` の Release を publish すると**
`.github/workflows/publish.yml` が npm の Trusted Publishing (OIDC) で上げる
（pre-release にチェックを入れた Release は `latest` ではなく `next` に入る）。

**⚠ この package.json の `version` は権威ある値ではない**（[ADR 0070](../../docs/decisions/0070-version-comes-from-the-release-tag.md)）。
版は Release の tag が決め、publish の直前に書き込まれる。**registry に訊くこと。**

```bash
npm view @mnemora/postgres version
```

初回の `0.1.0` だけは手元から出す必要がある——npm の Trusted Publishing は
**設定する時点でパッケージが registry に在ること**を前提にしており、初版を OIDC で
出すことはできない（[npm/cli#8544](https://github.com/npm/cli/issues/8544)）。
その手順は ADR 0066 の「publish の手順」にある。

## インストール

```bash
pnpm add @mnemora/postgres @mnemora/core
# または
npm i @mnemora/postgres @mnemora/core
```

## 前提

- Node.js >= 22
- ESM（`"type": "module"`）
- **本物の Postgres + pgvector が要る。**擬似物・インメモリでの代替は無い
  （このリポジトリの CI は [`pgvector/pgvector:pg17`](https://hub.docker.com/r/pgvector/pgvector) の
  Docker イメージに対して実行している。実物は
  [`.github/workflows/ci.yml`](../../.github/workflows/ci.yml) を参照）。
- 接続先には次の3拡張が要る: **`vector`**（pgvector）・**`btree_gin`**・**`pgcrypto`**。
  `mnemora-postgres-migrate`（後述）の `migrations/0001_init.sql` が
  `CREATE EXTENSION IF NOT EXISTS` で作成を試みるが、接続ロールに拡張を作る権限が無い
  環境ではあらかじめ DBA 側で作っておくこと。
- 接続文字列は環境変数 `DATABASE_URL` で渡す。

## マイグレーション（`mnemora-postgres-migrate`）

このパッケージは bin `mnemora-postgres-migrate` を提供する
（実体は [`src/bin/migrate.ts`](./src/bin/migrate.ts)）。**`DATABASE_URL` を読むだけで、
それ以外の引数は取らない。**保留中の `migrations/*.sql` をファイル名の昇順で適用する。

```bash
DATABASE_URL=postgresql://user:pass@localhost:5432/mydb npx mnemora-postgres-migrate
```

- 適用対象が無ければ「適用対象のマイグレーションはありません（すべて適用済み）。」と出て終わる。
- 適用したファイル名を一覧で出す。
- 複数プロセスが同時に実行しても安全（advisory lock で直列化する）。

`package.json` の `scripts` に組み込む例:

```json
{
  "scripts": {
    "migrate": "mnemora-postgres-migrate"
  }
}
```

## 動く最小の例（型検査のみ確認・DB へは未実行）

```ts
import {
  createPostgresClient,
  registerEmbeddingSpace,
  PostgresMemoryStore,
  PostgresVectorStore,
  PostgresEventStore,
  PostgresOutboxStore,
  PostgresTenantSettingsStore,
} from "@mnemora/postgres";
import { OpenAIEmbeddingProvider, OpenAILLMProvider } from "@mnemora/openai";
import { createRuntime } from "@mnemora/core";
import { createHash } from "node:crypto";

const connectionString = process.env.DATABASE_URL;
if (!connectionString) {
  throw new Error("DATABASE_URL が設定されていません。");
}

const client = createPostgresClient(connectionString);

const embeddingProvider = new OpenAIEmbeddingProvider({
  model: "text-embedding-3-small",
  dimensions: 1536,
});

// 埋め込み空間ごとのテーブルは、先に registerEmbeddingSpace で作っておく必要がある
// （未登録の空間に PostgresVectorStore.upsert を呼ぶと "relation does not exist" で失敗する）。
await registerEmbeddingSpace(client.pool, embeddingProvider.space);

const runtime = createRuntime({
  memoryStore: new PostgresMemoryStore(client.db),
  vectorStore: new PostgresVectorStore(client.db),
  eventStore: new PostgresEventStore(client.db),
  outboxStore: new PostgresOutboxStore(client.db),
  tenantSettingsStore: new PostgresTenantSettingsStore(client.db),
  llmProvider: new OpenAILLMProvider({ model: "gpt-4o-mini" }),
  embeddingProvider,
  hashContent: (content) => createHash("sha256").update(content).digest("hex"),
});

const ctx = { tenantId: "tenant-1" };
await runtime.observe(ctx, {
  kind: "utterance",
  text: "明日、京都へ出張する",
  speaker: "user",
});
```

上のコードを動かす前に、`mnemora-postgres-migrate` で該当 DB にスキーマを適用しておくこと。

## adapter として自作する場合

`MemoryStore` 等の自作実装を書くなら、[`@mnemora/testkit`](../testkit/README.md) の
適合テスト（conformance suite）に食わせて検査できる。`@mnemora/postgres` 自身の実装も
この適合テストで検査している。

## もっと詳しく

- [docs/memory-model.md](../../docs/memory-model.md) §10 — DB schema・規約
- [docs/architecture.md](../../docs/architecture.md) §5 — 主要 interface
- [migrations/](./migrations) — 手書きの DDL（`drizzle-kit push` には頼らない。docs/memory-model.md §10「規約」・[ADR 0001](../../docs/decisions/0001-orm-drizzle.md)「ORM は Drizzle」）
- リポジトリ: https://github.com/takecchi/mnemora
