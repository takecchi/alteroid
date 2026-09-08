# mnemora

**既存の LLM アプリケーションの下に敷く「認知レイヤー」。**

単発の `入力 → LLM → 出力` の外側に、永続する記憶と継続する認知処理を置く。

```
Application → Agent / LLM → Cognitive Runtime → Storage / LLM / Queue
                              ├── Observation
                              ├── Memory / Recall / Association
                              ├── Reinforcement / Forgetting / Consolidation
                              └── Reflection / Background Cognition
```

**エージェントフレームワークを作り直すものではない。** LangGraph・Mastra・自作 Agent の
**下に足せる**位置を狙う。

---

## 目指しているもの

**LLM アプリケーションに「思い出す」を与えること。「保存する」ではなく。**

保存はすでに解けている。解けていないのは、
**大量に貯めたものの中から、いま必要な分だけを引き当てること**である。

**近づいたかどうかを測る物差しは一つだけ**——
**使う側が、会話ログを全部プロンプトへ積むのをやめられたか。**

→ **[docs/north-star.md](./docs/north-star.md)**（正典。目的 / 目指す姿 / 物差し / 迷ったときの問い）

---

## 何をするものか

特定のチャットボット専用ではなく、Web アプリ・AI 秘書・Discord Bot・ゲーム NPC・
コーディングエージェント・ロボット・個人 AI・業務エージェントから再利用できる汎用基盤を目指す。

大量の会話ログを毎回 LLM へ全部渡すのではなく、**必要な記憶だけを**
意味・構造・時間・重要度・利用頻度・関連性から思い出す。

そこから新しい知識を統合し、使われない記憶は自然に想起されにくくなり、
必要なときだけ過去の記憶を呼び戻せる。

外から見える API は小さく保つ:

```ts
await brain.observe({ type: "message", actor: "user", content: "..." })
const recalled = await brain.recall({ query: "..." })
const thought = await brain.reflect()
await brain.consolidate()
await brain.forget()
```

---

## いまの状態

**Phase 1（MVP）の実装が一巡した。**`packages/core`（型・interface・runtime）、`packages/postgres`、
`packages/openai`、`packages/testkit`（適合テスト）、`examples/chat`（サンプル CLI）がある。
Phase 1 の範囲と、そこに入れなかったものは [docs/roadmap.md](./docs/roadmap.md) を参照。

**まだ 0.x であり、公開 API は動く。**名前は `mnemora`（`@mnemora/*`）に確定しており、
暫定ではない（経緯は [docs/vision.md](./docs/vision.md) の「名前について」と
[ADR 0014](./docs/decisions/0014-package-name-mnemora.md)）。

| 文書 | 何が書いてあるか |
|---|---|
| [docs/north-star.md](./docs/north-star.md) | **正典。**目指すもの・物差し・迷ったときの問い |
| [docs/vision.md](./docs/vision.md) | プロジェクトの理解 / 用語 / やらないこと / 名前 |
| [docs/architecture.md](./docs/architecture.md) | 全体アーキテクチャ / package 構成 / 主要 interface |
| [docs/memory-model.md](./docs/memory-model.md) | DB schema 案 / Memory lifecycle / 矛盾 / 忘却 / 監査ログ |
| [docs/recall.md](./docs/recall.md) | Recall pipeline / 「無い」の分類 / 目次帯 / 量の計測と予算 |
| [docs/roadmap.md](./docs/roadmap.md) | Phase 1 実装計画 / リスク / まだ判断が必要な点 |
| [docs/alteroid-findings.md](./docs/alteroid-findings.md) | 設計の材料にした運用知見を、現物で検証した記録 |
| [docs/decisions/](./docs/decisions/) | ADR — 重大な設計判断と、その理由 |

このリポジトリで作業する人・エージェント向けの手引きは [AGENTS.md](./AGENTS.md) にある。

**設計が固まってから Phase 1（Observation / Memory / PostgreSQL + pgvector / `observe()` /
`recall()` / スコアの内訳と説明）の実装に入る。**

---

## インストール

⚠ **まだ npm へ publish していない。**publish の判断は別に行う（4パッケージすべてに
`private: true` が立ったままである。[ADR 0060](./docs/decisions/0060-publish-with-pnpm-four-packages-at-0-1-0.md)）。
以下は publish 後の使い方である。

```bash
pnpm add @mnemora/core @mnemora/postgres @mnemora/openai
# または
npm i @mnemora/core @mnemora/postgres @mnemora/openai
```

adapter を自作してテストするなら `@mnemora/testkit` も devDependency として入れる。
各パッケージの install コマンドと動く最小の例:

- [packages/core/README.md](./packages/core/README.md)
- [packages/postgres/README.md](./packages/postgres/README.md)
- [packages/openai/README.md](./packages/openai/README.md)
- [packages/testkit/README.md](./packages/testkit/README.md)

---

## 外から見える API

```ts
observe(ctx, input)      // 起きたことを記録する
recall(ctx, query)       // 問いに対して記憶を取り出す
reflect(ctx, opts)       // 入力が無い状態で、既存の記憶から新しい記憶を作る
consolidate(ctx, opts)   // 複数の記憶を統合する
forget(ctx, target)      // 記憶を落とす / 失効させる
```

**内部が複雑でも、外側はこの5つに保つ。6つ目は作らない。**

---

## 記憶を誰に紐づけるか（`tenantId` / `subjectId`）

**上の5つは、すべて第一引数に `ctx` を取る。**その `ctx` が、記憶を誰に紐づけるかを決める。

```ts
// tenantId は必須。subjectId は省略できる。
const ctx = { tenantId: "guild-123", subjectId: "user-456" }

await observe(ctx, input)
const recalled = await recall(ctx, { text: "..." })
```

| | 何の単位か | 跨いだら |
|---|---|---|
| **`tenantId`** | **隔離境界。安全性の単位** | **事故** |
| **`subjectId`**（省略可） | テナント**内**の整理の単位 | 事故ではない |

**この非対称が芯である。**ひとつの Discord Bot をいくつものサーバーへ導入する場合、
**導入先のサーバーが `tenantId`、そのサーバー内の各ユーザーが `subjectId`** になる。
別のサーバーの記憶が出てくることは設計上あってはならない事故だが、同じサーバー内で
ユーザー A と B の記憶が混ざるのは整理の失敗であって、性質が違う。

**⟹ ひとつの DB で複数のエージェントを動かすなら、`tenantId` を分ける。**
`subjectId` を渡すと `recall()` はテナント内のその subject に絞られ、**省略するとテナント全体**になる。

**クロステナントで漏れないことは、`packages/testkit` の適合テストが測っている**——
どの adapter 実装に対しても走る:

- `VectorStore conformance` — 「クロステナントの search には他テナントの vector が現れない」
- `OutboxStore conformance` — 「クロステナントの claimBatch は他テナントの未処理ジョブを返さない」
- `EventStore conformance` — 「クロステナントの list は他テナントのイベントを含まない」

### ⚠ mnemora が保証していないこと

**`tenantId` は呼び出し側が渡す不透明な文字列である。mnemora はテナントの台帳を持たず、
`tenantId` の存在確認も認証もしない。**

**⟹ 隔離は「使う側が正しい `tenantId` を渡すこと」に依存している。**
誰がどの `tenantId` を名乗ってよいかを決めるのは、mnemora ではなく上のアプリケーションである。

詳細は [docs/vision.md](./docs/vision.md) の「Tenant と Subject を混同しない」と
[docs/architecture.md](./docs/architecture.md) §3.7。

---

## ⚠ 暫定

- **ここに書かれているのは設計であって、実装された事実ではない。**
  実装の進み具合は [docs/roadmap.md](./docs/roadmap.md) を見ること
