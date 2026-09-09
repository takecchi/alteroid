# AGENTS.md

このリポジトリで作業する人・エージェント向けの手引き。

---

## 最初に読むもの

**[docs/north-star.md](./docs/north-star.md) を読むこと。**

そこに、**このプロジェクトが何であろうとしているか**・**何を物差しにするか**・
**迷ったときにどの順で問うか**が書いてある。

**判断に迷ったら、そこへ戻る。**機能を足すかどうか、どちらの設計を採るかは、
北極星の「迷ったときの問い」に当てて決める。**その問いは、実際に案を落とすためにある。**

### ⚠ ここに北極星の要約を置かない

**複製した瞬間から、正文と要約はずれ始める。**
片方を直してもう片方を直し忘れることは、規律ではなく注意力に依存しており、必ず失敗する。

**だから、この文書は北極星を「指す」だけで、中身を持たない。**
`CLAUDE.md` も同じ理由で `AGENTS.md` への symlink であり、独立した中身を持たない。
**要約を置きたくなったら、代わりに北極星のほうを短くすること。**

### 正典と実装が食い違ったら

**バグなのは実装のほうである。**
実装の都合で `docs/north-star.md` を書き換えないこと。
**方向そのものを変えるときだけ、書き換える。**その変更はオーナーの判断である。

---

## いまの状態

**Phase 1（MVP）の実装が一巡した。**`docs/roadmap.md` §2 の段階1〜7 がすべて着地している。

| package | 中身 |
|---|---|
| `packages/core` | 型・interface・`runtime.observe/tick/recall`・純関数の戦略。実行時依存は zod だけ（機械的に検査している） |
| `packages/testkit` | adapter の適合テスト一式（conformance suite）とインメモリのプレースホルダ実装 |
| `packages/postgres` | `MemoryStore` / `VectorStore` / `EventStore` / `OutboxStore` / `TenantSettingsStore`。手書きマイグレーション |
| `packages/openai` | `EmbeddingProvider` / `LLMProvider` |
| `examples/chat` | サンプル CLI と、**naive（会話ログ全部）と mnemora を実測比較する `compare`** |

**Phase 1 に入っていないもの**は `docs/roadmap.md` §1.3 の通り（関係グラフ本体・reranking・
`reflect()` の実運用・`packages/bullmq`・HTTP server）。

**テストは本物の Postgres + pgvector に対して走る。**`packages/postgres` と `examples/chat` の
検査は `DATABASE_URL` が無いと失敗する——**擬似物へ黙ってフォールバックしない。**
ただし LLM と埋め込みは CI に API キーが無いため決定的な擬似 provider を使う
（`OPENAI_API_KEY` があれば本物に切り替わる）。この非対称は
[examples/chat/README.md](./examples/chat/README.md) に明記してある。

**provider は3層ある**（[ADR 0051](./docs/decisions/0051-recorded-provider-cassette.md)）。
**用途で使い分けること。**

| 層 | 何か | 使う場所 |
|---|---|---|
| `deterministic` | 意味を持たない stub（文字コードからベクトルを作る／発話を40字で切る） | 配線・契約・適合テスト |
| `recorded` | 記録した実 API の応答の再生。**記録に無い入力は例外** | 北極星の物差し（`retrieval`） |
| `openai` | 実 API | 記録を録るとき・乖離を測るとき |

**⚠ `deterministic` で測った想起の質は、性能について何も言っていない**——arm A の MRR は
**0.018**（実質ランダム）である。**擬似物での ✅ を「引けた」と読まないこと。**

**ルートの `pnpm run test` は、DB テストを走らせたかどうかを必ず報告する。**
`DATABASE_URL` が無ければ**「実行していない」と名指しで出力して緑のまま通り**、
在れば DB テストも実行して**落ちれば赤くなる**。**緑をそのまま「全部通った」と読まないこと**——
出力に「DB テストは実行していません」と出ていたら、その門は DB 側を見ていない。
理由と、採らなかった案は [ADR 0015](./docs/decisions/0015-root-test-gate-reports-skipped-db-tests.md)。

---

## 文書の地図

| 文書 | 何が書いてあるか |
|---|---|
| [docs/north-star.md](./docs/north-star.md) | **正典。**目的 / 目指す姿 / 物差し / 迷ったときの問い / やらないこと |
| [docs/vision.md](./docs/vision.md) | プロジェクトの理解 / 用語 / 設計上の非目標 / 名前 |
| [docs/architecture.md](./docs/architecture.md) | 全体アーキテクチャ / package 構成 / 主要 interface |
| [docs/memory-model.md](./docs/memory-model.md) | DB schema 案 / Memory lifecycle / provenance / 矛盾 / 忘却 / 監査ログ |
| [docs/recall.md](./docs/recall.md) | Recall pipeline / 「無い」の分類 / 目次帯 / 量の計測と予算 |
| [docs/roadmap.md](./docs/roadmap.md) | Phase 1 実装計画 / リスク / **まだ判断が必要な点** |
| [docs/alteroid-findings.md](./docs/alteroid-findings.md) | 設計の材料にした運用知見を、現物で検証した記録 |
| [docs/autonomy.md](./docs/autonomy.md) | **自律作業の手引き** — 何を選ぶか / どこで止まるか / 何をしてはいけないか / 踏むと痛い穴 |
| [docs/decisions/](./docs/decisions/) | ADR — 重大な設計判断と、その理由 |

**`docs/vision.md` の「やらないこと」と `docs/north-star.md` の「やらないこと」は別物である。**
前者は設計上の非目標、**後者はオーナーが仕様に明示した非目標**であり、
**後者に勝手に項目を足さないこと。**

---

## 作業のときの決まり

- **重大な設計判断は ADR に残す。**「何を決めたか」だけでなく、
  **採らなかった案・引き受けた負債・これが覆るとしたら何が起きたときか**まで書く。
  形式は [docs/decisions/README.md](./docs/decisions/README.md) を見ること。
- **確かめていないことは「確かめていない」と書く。**
  推測を事実の顔で書かない。これは北極星の問い3（説明できるか）の、文書への適用である。
- **オーナーの判断を待っている点は
  [docs/roadmap.md](./docs/roadmap.md) の「設計上まだ判断が必要な点」に集めてある。**
  勝手に決めない。逆に、そこに無いものは設計側で決めて理由を残す。
- **オーナーに逐一確認せずに進めるなら、
  [docs/autonomy.md](./docs/autonomy.md) を読むこと**（ADR 0071）。
  **何を選ぶか / どこで止まるか / 何をしてはいけないか**と、
  **実際に踏まれた穴**が書いてある。**ここには要約を置かない**——上の
  「⚠ ここに北極星の要約を置かない」と同じ理由である。

---

## 名前について

**名前は `mnemora`、スコープは `@mnemora/*` に確定している。**もう仮ではない。
npm の org `@mnemora` はオーナーが作成し、使用できることを確認した（確認したのは
オーナーであり、このリポジトリの作業者ではない）。

**`mnemo` / `@mnemo/*` という旧名で新しい記述を書かないこと。**ただし
`docs/vision.md`「名前について」の経緯節・`docs/roadmap.md` §5.1 と §6・
`docs/memory-model.md` の「確かめていないこと」に残る `mnemo` は**当時の記録であり、
書き換えない**（他人の npm パッケージ `mnemo` と Rufus::Mnemo への言及を含む）。

決定の記録は [ADR 0014](./docs/decisions/0014-package-name-mnemora.md)、
改名前の経緯は [docs/vision.md](./docs/vision.md) の「名前について」にある。
