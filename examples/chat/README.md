# examples/chat

roadmap.md 段階7「サンプル」。**このサンプルの主目的は「動くデモ」ではなく、
[docs/north-star.md](../../docs/north-star.md) の物差し——

> 使う側が、会話ログを全部プロンプトへ積むのをやめられたか。

——を実際に測ることである。** 機能が動くこと自体は物差しに対して何も言えない
（同 doc「記憶の件数でも、機能の数でも、recall の平均スコアでもない」）。

同じ会話に対して2つの経路を並べて走らせ、実際にプロンプトへ積む量を実測して比較する。

- **経路A（naive）**: 会話ログを全部プロンプトへ積む（mnemora を使わない、今の普通のやり方）。
- **経路B（mnemora）**: `observe()` で会話を取り込み、`recall()` が返した `memories`（の
  digest）と `index` だけを積む。`budget` を渡すと実際に切り詰められる。

---

## 動かし方

前提: Node 22 / pnpm（corepack）。ローカルに Postgres + pgvector が必要
（[AGENTS.md](../../AGENTS.md) 参照、または CI の `example-chat` ジョブと同じ
`pgvector/pgvector:pg17` イメージ）。

```bash
# リポジトリルートで
pnpm install
pnpm run build   # @mnemora/core 等の workspace パッケージを dist へビルドする
                 # （tsx で直接実行する examples/chat の CLI は dist を node_modules 経由で
                 #   解決するため、ビルドが要る。vitest はテスト時だけ src を直接見るため
                 #   ビルド無しでも動く——後述「テスト」参照）

export DATABASE_URL="postgresql://user@host/dbname?host=/path/to/sockdir&port=5544"
pnpm --filter @mnemora/postgres run migrate

# observe → recall の往復、omitted/usage/budget を実演する
pnpm --filter @mnemora/example-chat run chat

# 会話の長さを変えて、経路A/経路Bの量を実測する（このサンプルの主目的）
pnpm --filter @mnemora/example-chat run compare

# tenantId/subjectId のスコープを実演する（後述「scope」節）
pnpm --filter @mnemora/example-chat run scope

# 意味的関連性を測る（後述「retrieval」節）
#   OPENAI_API_KEY があれば実 API、無ければ記録した応答を再生する（ADR 0051）
pnpm --filter @mnemora/example-chat run retrieval

# 記録した応答を録り直す / 実 API との乖離を測る（どちらも実キーが要る）
pnpm --filter @mnemora/example-chat run record          # retrieval（74回 / 約 $0.005）
pnpm --filter @mnemora/example-chat run record:compare  # compare（657回 / 約11分 / 約 $0.032）
pnpm --filter @mnemora/example-chat run verify
pnpm --filter @mnemora/example-chat run verify:compare
```

`OPENAI_API_KEY` を環境に設定すると本物の OpenAI（LLM 抽出・Embedding）で動く。
設定しなければ `@mnemora/testkit` の決定的な擬似 provider で動く——**どちらで動いているかは
起動直後に必ず画面へ出す**（黙って擬似物にフォールバックしない）。

**⚠ ただし `packages/openai` の live テストは、`OPENAI_API_KEY` だけでは走らない。**
`MNEMORA_LIVE_OPENAI` も設定したときだけ本物を叩く——**鍵を持っていることは、いま課金して
よいという意思表示ではない**（`packages/openai/src/__tests__/live.openai.test.ts`）。
このサンプルアプリ側（`chat` / `compare` / `scope` / `retrieval`）は従来どおり `OPENAI_API_KEY` の
有無で切り替わる。**これらは手で叩くコマンドであり、門の一部として黙って走ることはない。**

### テスト

```bash
export DATABASE_URL=...
pnpm --filter @mnemora/example-chat run test:db
```

本物の Postgres に接続する（擬似物では代替しない）。`observe → recall` の往復・
`budget` による切り詰め・`runComparison` の量の計測をすべて実DBに対して検査する。
ビルド不要（`vitest.config.mts` が `@mnemora/*` を各パッケージの `src` へ直接エイリアスする）。

リポジトリのルートから `DATABASE_URL=... pnpm run test` を実行すれば、この検査も一緒に走る。
`DATABASE_URL` を設定していない場合、ルートの門は**この検査を実行していないと明示して**通る
（[ADR 0015](../../docs/decisions/0015-root-test-gate-reports-skipped-db-tests.md)）。

---

## `chat`: observe/recall の往復・omitted・usage・budget

固定の合成会話（後述）を `observe()` で取り込み、終盤の質問を `recall()` する。
`recall()` の返り値のうち roadmap.md 段階7の完了条件そのものである `omitted` と
`usage` を画面に出し、さらに小さな `budget`（`maxMemoryChars`）を渡した場合に実際に候補が
落ちること（`omitted` に `budget_dropped` が現れ、`memories` の件数が減ること）を示す。

---

## `scope`: tenantId/subjectId のスコープを実演する

ルート [README.md](../../README.md)「記憶を誰に紐づけるか（`tenantId` / `subjectId`）」が
`Ctx = { tenantId, subjectId? }` の非対称——`tenantId` は隔離境界（跨いだら事故）、
`subjectId` はテナント**内**の整理の単位（跨いでも事故ではない）——を説明している。
`compare`/`retrieval` を含め、これまで `examples/chat` は一度も `ctx.subjectId` を
設定していなかった。この節はその隙間を、`src/scope.ts` の「動く例」で塞ぐ。

```bash
DATABASE_URL=... pnpm --filter @mnemora/example-chat run scope
```

**`OPENAI_API_KEY` が無くても動く**（`@mnemora/testkit` の決定的な擬似 provider。
`chat`/`compare` と同じ切り替え）。同じテナントの中に `alice`/`bob` という2つの
subject を作り（ペットの事実——alice は犬「ポチ」、bob は猫「タマ」——を1件ずつ
observe する。取り違えたら一目で分かるようにしてある）、別テナントも1つ用意して、
同じ質問文を3通りの `ctx` で `recall()` する。

### 出力の読み方

1. **`{ tenantId, subjectId: "alice" }` で recall** → alice の記憶（「ポチ」）だけが返り、
   bob の記憶（「タマ」）は返らない。
2. **`{ tenantId }`（`subjectId` を省略）で recall** → テナント全体が対象になり、
   alice・bob 両方の記憶が返る。
3. **`{ tenantId: otherTenantId }`（別テナント）で recall** → 元のテナントの記憶は
   1件も返らない（0件）。

画面には各ケースの件数と、返ってきた記憶の digest（本文そのもの）をそのまま出す——
「何が返って、何が返らなかったか」を文字列で確認できる。

### 測定ごとに `tenantId` を分けているのは「隔離の実演」ではない

`compare`（会話の長さ＝ filler 往復数ごと）・`retrieval`（arm A/B/C ごと）は、どちらも
複数の `tenantId` を使う。**これは `tenantId` の隔離を見せるためではない。**

- `compare`（`src/compare.ts` の `runComparison`）は会話の長さごとに新しい `tenantId`
  を使う。同じテナントに会話を積み増すと、後の計測が前の会話の記憶を引きずり、
  「その長さの会話単体で何文字になるか」を独立に測れなくなるため（同ファイルの
  コメント参照）——**測定同士を混ぜないため**の分離であり、隔離の実演ではない。
- `retrieval`（`src/cli.ts` の `runRetrieval`）は arm（A/B/C）ごとに別の `tenantId`
  を使う。同じ probe set をそのまま arm ごとに観測し直すため、同じテナントを
  使い回すと前の arm の記憶が後の arm の recall に混ざってしまう——ここも
  **測定同士を混ぜないため**の分離であり、`tenantId` を分けること自体は
  「隔離が安全に効く」ことの実演を意図していない。

  ⚠ **`retrieval` の `tenantId` は実行ごとにも変わる**（`newRunToken()` /
  `buildArmTenantId()`。
  [ADR 0068](../../docs/decisions/0068-the-bench-must-not-lie-about-what-it-measured.md)）。
  かつては arm ごとの固定文字列（`retrieval-quality-arm-a` 等）だったが、この harness は
  DB をリセットしないため、**2回目の実行が同じテナントへ同じ probe set を `observe()`
  し直すことになり、`externalId` の冪等性に当たって新規 observation を1件も作らなかった**
  ——`ingest` の欄が、今回は測っていないのに「1回で全件処理できる件数だった」という
  **逆の結論**を印字する。順位のほうは DB に残った前回の記憶で正しく出続けるので、
  **数字を見ていても気付けない。**
  ⟹ **混ぜてはいけないのは arm 同士だけではなく、実行同士もである。**

**`tenantId`/`subjectId` のスコープが実際にどう効くかを動く形で見せるのは、この
`scope` サブコマンドが初めてである。**

### 🔴 正直に書く限界

**`compare` と `retrieval` は `subjectId` を一切使っていない。そしてそれはわざとである。**
`examples/chat` の主目的は北極星の物差し——「会話ログを全部プロンプトへ積むのを
やめられたか」——を実測することであり、`compare`/`retrieval` の `recall()` は
その主測定の経路そのものである。もし `subjectId` をそこに入れると、`recall()` の
候補は subject 単位に絞られ、擬似 haystack（`compare` の filler・`retrieval` の
haystack）との競合が減る——量の削減率や順位が「実際に絞り込みに勝った」からでは
なく「競争相手を減らした」ことで良く見えるようになる。これは
[ADR 0022](../../docs/decisions/0022-fake-provider-compare-does-not-claim-recall-quality.md)
が却下した「数値を良く見せるために測定条件を選び直す」の一種であり、この `scope`
サブコマンドを足す作業でも同じ理由で `compare.ts`/`retrieval-quality.ts`/
`probe-set.ts`/`scenario.ts`/`naive-path.ts` には一切手を入れていない。

**`subject` は整理の単位であって隔離の保証ではない**——`tenantId` を跨ぐ漏れは
事故だが、同じテナント内で `subjectId` を省略・誤指定して alice/bob の記憶が
混ざることは、mnemora の欠陥ではなく呼び出し側の使い方の問題である
（ルート README.md「記憶を誰に紐づけるか」参照）。

---

## `backfill`: `observe()` の `occurredAt` を実演する

```bash
DATABASE_URL=... pnpm --filter @mnemora/example-chat run backfill
```

**同じ2発話・同じ問い合わせを、`occurredAt` を渡す側と渡さない側の2テナントで走らせる。**

```
取り込んだ2件: 「三週間前に沖縄へ旅行しました。」(20日前の出来事) / 「一昨日に金沢へ旅行しました。」(2日前の出来事)
問い合わせ: recall({ text: "わたしの旅行について知っていますか?", occurredAfter: <10日前> })

--- 1. observe() に occurredAt を渡した ---
件数: 1
  - "一昨日に金沢へ旅行しました。"
  omitted: filtered:period

--- 2. ⚠ occurredAt を渡さなかった ---
件数: 2
  - "一昨日に金沢へ旅行しました。"
  - "三週間前に沖縄へ旅行しました。"
  omitted: (無し)
```

**⟹ 同じ問い合わせが、取り込み方だけで別の答えを返す。**

`recall-runtime.ts` は `effectiveTime = memory.occurredAt ?? memory.recordedAt` で
`occurredAfter` / `occurredBefore` を当てる。**`occurredAt` を渡さないと `recordedAt`
（＝取り込んだ今日）に落ちるので、「いつの出来事か」を絞ったつもりの条件が、実際には
「いつ言われたか」を絞る。**生の会話ログを後から取り込む（backfill）とき、
**この取り違えは黙って間違う**——2件目のほうがエラーも警告も出さない。

### ⚠ これは想起を良くするものではない

**`hit@1` は改善しない。**これは*嘘をつかなくする*変更である。
「来月、京都へ出張します」の中の「来月」を読むのは別の話（発話中の時間表現の抽出）であり、
**このデモの範囲外である**（[ADR 0037](../../docs/decisions/0037-callers-pass-occurred-at.md)）。

### ⚠ 北極星の主測定には触れていない

`src/backfill.ts` は `compare.ts` / `retrieval-quality.ts` / `probe-set.ts` /
`scenario.ts` / `naive-path.ts` のどれも import しない（`scope.ts` と同じ規律）。
**`compare` / `retrieval` の数字は本 PR の前後で変わっていない**（実測。ADR 0037）。

---

## `compare`: 量の比較（このサンプルの主目的）

会話の長さ（filler の往復数）を `[0, 1, 2, 3, 4, 5, 10, 20, 40, 80, 160, 320, 642(turns)]`
と変化させ、各長さについて独立のテナントで:

- **経路A**: 全ターンを `role: text` 形式で連結した文字列の長さ（`chars`）と、
  `heuristicTokenCounter`（core の既定の推定。文字種で重み付けする——[ADR 0083](../../docs/decisions/0083-cjk-aware-heuristic-token-counter.md)）によるトークン数。
- **経路B**: 同じ会話を `observe()` で取り込み、終盤の質問を `recall()`（**budget 無し**）
  した際の `usage.chars` / `usage.estimatedTokens`——`recall()` 自身が計測した値を
  そのまま使う（自前で数え直さない）。

を測る。**budget は渡さない**——docs/roadmap.md §4「計測と抑止を混同しない」の通り、
ここで見せたいのは「切り詰めずに、そのままだと何文字になるか」であり、強制ではなく
計測の比較だからである（budget が実際に切り詰めることは `chat` サブコマンドの方で見せる）。

### 実測結果（2026-09-05、`@mnemora/testkit` の決定的な擬似 provider・`pgvector/pgvector:pg17` 相当のローカル環境）

`pnpm --filter @mnemora/example-chat run compare` の実際の出力（再現可能。同じ環境・
同じ会話生成関数であれば同じ数字になる——`buildConversation()` は乱数を使わない）。

⚠ **この表の「tokens(概算)」の2列は、[ADR 0083](../../docs/decisions/0083-cjk-aware-heuristic-token-counter.md)
以前の既定カウンタ（`Math.ceil(text.length / 4)`）で測った値である。測り直していない。**
この会話コーパスは全文が日本語であり、ADR 0083 の係数では**同じ入力に対しておよそ 3.3 倍の値**
になるはずである（実測: 日本語の合計比が 0.353 → 1.182）。**「はず」であって、実行して
確かめてはいない**——測り直しには Postgres が要り、ADR 0083 の作業をした器に無かった。
**`chars` の2列と `mnemora/naive (chars)` の列（＝北極星の主測定）はこの変更の影響を受けない。**

| 会話ターン数 | naive chars | naive tokens(概算) | mnemora chars | mnemora tokens(概算) | mnemora/naive (chars) |
|---|---|---|---|---|---|
| 2 | 49 | 13 | 131 | 33 | **267.3%** |
| 4 | 97 | 25 | 142 | 36 | **146.4%** |
| 6 | 150 | 38 | 161 | 41 | **107.3%** |
| 8 | 197 | 50 | 178 | 46 | 90.4% |
| 10 | 243 | 61 | 193 | 50 | 79.4% |
| 12 | 294 | 74 | 211 | 54 | 71.8% |
| 22 | 552 | 138 | 288 | 75 | 52.2% |
| 42 | 1048 | 262 | 292 | 76 | 27.9% |
| 82 | 2064 | 516 | 310 | 80 | 15.0% |
| 162 | 4083 | 1021 | 303 | 78 | 7.4% |
| 322 | 8134 | 2034 | 303 | 78 | 3.7% |
| 642 | 16223 | 4056 | 303 | 78 | 1.9% |

**⚠ 2026-09-06 追記（本 PR）: 上の表のうち 322・642 ターン行の `mnemora chars`/`tokens` を
実測値で更新した（305→303 / 79→78）。** CI（本物の PostgreSQL 17 + pgvector、擬似 provider、
GitHub Actions run 34006151739、head `e87da3b`）で `compare` を再実行して取った値であり、
他の行はこの実測と一致した。305→303 の差は、[ADR 0021](../../docs/decisions/0021-drain-embed-ticks-in-ingest.md)
の修正で ANN が競う母集団が「先着50件」から「スコープ内全件」に広がり、`recall()` が返す
上位10件の中身（＝ digest の合計文字数）が変わったために生じている——削減率（3.7% / 1.9%）
自体は変わっていない。

**⚠⚠ 2026-09-06 追記: この表は、いまのコードでは再現しない。** 同じ擬似 provider・
本物の PostgreSQL 17 + pgvector 0.8.2 で測り直したところ、長い会話（322 / 642 ターン）の
数字は一致したが、**短〜中の会話では mnemora 側が記録値より小さく出た**——経路Bが naive を
下回り始める閾値も **8ターン → 6ターン**へ動いている（例: 6ターンで 161 chars / 107.3% と
記録されているものが 109 chars / 72.7% になる）。測り直した表は
[ADR 0019 §5b](../../docs/decisions/0019-real-openai-measurement-cost.md) にある。
**どの変更がこの差を作ったかは特定していない。**

**⚠ 2026-09-06 追記（本 PR、上とは別の測定）: この「再現しない」という再測定のほうが、
CI での実測では再現しなかった。** 本 PR で CI（本物の PostgreSQL 17 + pgvector、GitHub
Actions run 34006151739、head `e87da3b`）で `compare` を走らせたところ、上の直前の追記
（閾値が 8ターン→6ターンへ動く、6ターンで 109 chars / 72.7% になる）は再現せず、**元の表
（閾値8ターン、6ターンで 161 chars / 107.3%）と一致した。** これで手元の3つの測定のうち
2つ（2026-09-05 の元の表と 2026-09-06 本 PR の CI 実測）が一致し、1つ（2026-09-06 の
別の測り直し）だけが食い違っている、という事実のみをここに記録する。**どちらが正しいかは
断定しない**——測定環境の違い（ローカル vs CI、pgvector のバージョン、Postgres の設定等）
を切り分けていないため。

**⚠ この表の数値は 2026-09-05 に、改名前の名前（`mnemo`）で走らせた実測そのままである。**
`mnemora` への改名は呼称の変更であって計測の経路には触れていないが、**改名後に測り直しては
いない**——この改名作業を行った環境には Postgres が無く、`compare` を実行できなかった。
列見出しだけは現在の `compare` の出力（`mnemora chars` 等）に合わせてある。

### 正直に読むべきこと

**⚠ 会話が短いうちは経路Bのほうが多い。** `2`〜`6` ターンでは mnemora のほうが naive より
**大きい**（最大 +167%）。理由は2つ:

1. `recall()` は index band（目次帯・第3階の群カウント）の JSON を必ず含む固定費を持つ。
   会話が短いとこの固定費が相対的に大きく見える。
2. `observe()` → 抽出 → 埋め込み → `recall()` という往復自体にも、返す memory 1件あたり
   digest という形の一定のオーバーヘッドがある。

**この実測では、`8` ターン（filler 往復3組＋事実表明1組）から経路Bが下回り始める。**
それ以降は単調に差が開く——naive は会話が伸びる限り線形に増え続けるのに対し、mnemora は
既定の `recall()` の `limit`（10件）と index band の固定費でほぼ頭打ちになる
（`162`→`642` ターンで naive は 4倍になるが mnemora はほぼ変わらない）。

**この閾値（8ターン）は、この会話生成関数・この既定パラメータ（`limit=10` 等）・
この擬似 provider に固有の数字であり、一般的な閾値として主張しない。** 会話の内容
（filler の長さ・事実の長さ）や `recall()` のオプションを変えれば動く。


### 本物の OpenAI で走らせた実測（2026-09-06、`gpt-4o-mini` + `text-embedding-3-small`(256次元)）

**所要 約11分 / 実費 約 3.2セント**（呼び出し 889回。内訳は
[ADR 0019 §7.8](../../docs/decisions/0019-real-openai-measurement-cost.md)）。

| 会話ターン数 | naive chars | mnemora chars（本物） | 比（本物） | 比（擬似・同日測定） |
|---|---|---|---|---|
| 2 | 49 | 125 | 255.1% | 222.4% |
| 6 | 150 | 134 | **89.3%** | 72.7% |
| 22 | 552 | 211 | 38.2% | 19.7% |
| 82 | 2064 | 247 | 12.0% | 5.4% |
| 322 | 8134 | 231 | 2.8% | 3.7% |
| 642 | 16223 | **244** | **1.5%** | 1.9% |

（全12行は [ADR 0019 §7.7](../../docs/decisions/0019-real-openai-measurement-cost.md)）

**⟹ 北極星の物差しは本物の provider でも成立する——むしろ良くなる**（642ターンで 1.5%）。
経路Bが naive を下回り始める閾値は **6ターン**で擬似と同じ。

**⚠ ただし干し草の中身が擬似とは別物である。**本物の LLM は世間話の多くを記憶にしないので、
スコープ内 Memory は擬似の 321件より少ない。**この表が言えるのは「積む量」までである。**

### 🔴 2026-09-07 追記（ADR 0052）: 「答えが残るか」も本物で測った——**❌ は消えた**

上の表が「積む量まで」しか言えなかったのは、**当時の生存判定が `digest.includes("青")` という
文字列一致で、本物の LLM の言い換えに耐えなかった**からである。判定を
**`sourceObservationId` を辿って `externalId` で照合する**形へ置き換え（`provenance-trace.ts`）、
改めて実 API で測った（657回 / **10分49秒** / **$0.032075**）。

| 会話ターン数 | スコープ内の Memory | 返った件数 | 冒頭の事実 | mnemora chars | 比 |
|---|---|---|---|---|---|
| 42 | 15 | 10 | ✅ | 250 | 23.9% |
| 82 | 27 | 10 | ✅ | 244 | 11.8% |
| 162 | 56 | 10 | ✅ | 229 | 5.6% |
| 322 | **108** | 10 | **✅** | 227 | 2.8% |
| 642 | **209** | 10 | **✅** | 184 | **1.1%** |

**⟹ 全12行が ✅。**下の「⭐ 削減率だけでは意味を持たない」節にある **322 / 642 の ❌ は、
擬似 provider の産物だった。**642ターンでは 209件のスコープから10件だけを返して、なお
冒頭の事実が残っている。

**⚠ 「干し草が消えたから ✅ になった」のではない。**[ADR 0019 §4](../../docs/decisions/0019-real-openai-measurement-cost.md)
は3発話の標本から「本物では数件にしかならない」と外挿していたが、**実測は 209件**である
——filler には本物の LLM が記憶として抽出する文が混ざっている。**209件の中から実際に
引き当てている。**

**⚠ 実 API の `compare` は、実行ごとに数字が動く。**642ターンの `mnemora chars` は
上の 2026-09-06 の実測で 244、この 2026-09-07 の実測で 184。原因は LLM の非決定性である。

### ⭐ 削減率だけでは意味を持たない——答えが残っているか

> **⚠⚠ この節の表は擬似 provider の測定である。**下の 322 / 642 ターンの ❌ は、
> **本物の provider では再現しない**——上の「🔴 2026-09-07 追記」の実測では全行が ✅ になる
> （[ADR 0052](../../docs/decisions/0052-compare-cassette-and-provenance-survival.md)）。
> **この節の ❌ を mnemora の限界として引用しないこと。**擬似埋め込みは意味的な類似度を
> 表現しないため、順位付け自体が成立していない（`retrieval` の arm A の MRR は 0.018）。
> それでもこの節を残すのは、**擬似物で測るとどう見えるかの記録として価値があるため**である。

**何も返さなければ削減率は 0% になる。** 削減が意味を持つのは、**呼び出し側が探している
答えが、削られた後にも残っている**場合だけである。物差し（「会話ログを全部プロンプトへ
積むのをやめられたか」）は、積むのをやめても答えが得られることを含意している。

そこで、冒頭で一度だけ表明した事実（`FACT_STATEMENT` = 「私の好きな色は青です。……」）が、
絞り込みの後にも `recall()` の返り値に残っているかを、全ての会話長で確認する。

**⚠⚠⚠ 2026-09-06 追記（本 PR）: 下の表は、それ以前にあった「全行 ✅・3列」の表を
実測値で置き換えたものである。** [ADR 0021](../../docs/decisions/0021-drain-embed-ticks-in-ingest.md)
の修正（`ingestConversation` が `tick()` を干上がるまで回す）を適用したうえで、CI（本物の
PostgreSQL 17 + pgvector、擬似 provider、GitHub Actions run 34006151739、head `e87da3b`）で
`formatRecallQualityTable`（本 PR で新設）を実際に走らせて取った値である。列も
「スコープ内の Memory」「ANN の候補になれた件数」「返った件数」「冒頭の事実が残っているか」
「`omitted` の内訳」の6列に広げた（以前は「スコープ内の Memory」「返った件数」「残っているか」
の3列しか無く、ANN に実際に何件が候補として上がったかが見えなかった）。

| 会話ターン数 | スコープ内の Memory | ANN の候補になれた件数 | 返った件数 | 冒頭の事実が残っているか | `omitted` の内訳 |
|---|---|---|---|---|---|
| 2 | 1 | 1 | 1 | ✅ | (無し) |
| 4 | 2 | 2 | 2 | ✅ | (無し) |
| 6 | 3 | 3 | 3 | ✅ | (無し) |
| 8 | 4 | 4 | 4 | ✅ | (無し) |
| 10 | 5 | 5 | 5 | ✅ | (無し) |
| 12 | 6 | 6 | 6 | ✅ | (無し) |
| 22 | 11 | 11 | 10 | ✅ | over_limit:1 |
| 42 | 21 | 21 | 10 | ✅ | over_limit:11 |
| 82 | 41 | 41 | 10 | ✅ | ann_truncated, over_limit:30 |
| 162 | 81 | 81 | 10 | ✅ | ann_truncated, over_limit:30 |
| 322 | 161 | 161 | 10 | ❌ | ann_truncated, over_limit:30 |
| 642 | 321 | 321 | 10 | ❌ | ann_truncated, over_limit:30 |

**読み方1: [ADR 0021](../../docs/decisions/0021-drain-embed-ticks-in-ingest.md) の修正は
効いている。** 「ANN の候補になれた件数」列が全行で「スコープ内の Memory」列と**一致**して
おり、`not_indexed(pending)` はどの行の `omitted` にも現れていない。642ターンでは、宣言
どおり321件全部が実際に ANN で競った——[ADR 0019 §5](../../docs/decisions/0019-real-openai-measurement-cost.md)
が実測した「271件が `pending` のまま、実際に競ったのは50件だけ」という欠陥は、もう起きていない。

**読み方2: 🔴 そして、321件と実際に競わせたら、冒頭の事実は落ちた。** 322ターン（161件）と
642ターン（321件）が ❌ になっている。**以前の表（2026-09-05以前）が全行 ✅ だったのは、
「候補50件としか競っていなかった」から出ていた ✅ であり、321件と競った結果ではなかった。**
以前この節に書かれていた次の一文は、その ✅ を根拠にしていたため、**いまや偽である**:

> ~~642ターン（321件のうち10件だけを返す＝ naive の 1.9%）まで削っても、冒頭の事実は落ちなかった。
> これが「1.9%」という数字に意味を与えている唯一の根拠である。~~

**正しくは**: 642ターンでは、321件のうち10件だけを返す（naive の1.9%）ところまで削ると、
冒頭の事実は**実際に落ちる**。「1.9%」という削減率の数字だけを見て「答えも残っている」と
決め打つことはできない——82〜162ターンまでは残るが、322ターン以降は残らない。**削減率と
「答えが残るか」は別の軸であり、削減率が良いほど答えが残りやすいとは限らない。**

**これは [ADR 0021](../../docs/decisions/0021-drain-embed-ticks-in-ingest.md) が*作った*
劣化ではなく、*見つけた*ものである。** ADR 0021 が直す前は、321件のうち271件がそもそも
埋め込まれておらず（`not_indexed(pending)`）、ANN の土俵にすら上がっていなかった。修正前の
「✅」は「84%が索引されていない状態で、たまたま冒頭の事実だけは先着50件の枠に入っていた」
という偶然であり、修正後に321件全部を土俵に上げて初めて、擬似 embedding の下での真の限界
（下記「読み方4」）が見えるようになった。**直したから壊れたのではなく、直したから見えた。**

**読み方3: ⚠ しかし mnemora は黙って落としていない。** `omitted` には
`over_limit:30`（返した10件の外に、閾値は超えたが `limit` に入らなかったものが30件ある）
として正直に報告されている（[ADR 0008](../../docs/decisions/0008-absence-taxonomy.md)
「無いには種類がある」）。呼び出し側が `recall()` の `limit` を上げれば、冒頭の事実は
取り戻せる——「消えた」のではなく「`limit`=10 の外に押し出された」だけであり、`omitted`
を見ればそれが分かるようになっている。

**読み方4: これは擬似 embedding の性質であって、mnemora の欠陥ではない。**
`DeterministicEmbeddingProvider` は文字コードの和からベクトルを作るだけで意味的な類似度を
持たない。マネージャーがその純関数を手元で再実装して計算したところ、12種類の filler の
うち `"最近のニュースについてどう思いますか。"` の1種類だけが、質問文に対して冒頭の事実
より近い（コサイン距離 0.1333 対 0.1719）。会話が伸びるとこの filler の複製が増え、事実を
少しずつ押し下げる: **事実の順位は81件で7位 → 161件で14位 → 321件で27位**（`limit`=10 の
外）。⟹ 本物の埋め込みでは別の結果になる——
[ADR 0019 §7](../../docs/decisions/0019-real-openai-measurement-cost.md) は本物の provider
で MRR 0.714、hit@10 は7件中7件だったと実測している。
**⚠ この順位の計算は `DeterministicEmbeddingProvider.vectorFor()` という純関数の再実装に
よるものであり、実際に `recall()` を撃って確かめたものではない**（段2で掛かる
decay/freshness/strength の再スコアは考慮していない）。

**`omitted` を読まなかったことが誤解を生んでいた。** `recall()` 自身は以前から
`not_indexed(pending)` も `over_limit` も `omitted` に正直に出していた——読まずに以前の
表を書いていたのは `examples/chat` 側である。

この検査は `src/__tests__/mnemora-path.postgres.test.ts` に歯として入れてある（162ターン）。
歯には「実際に大幅な絞り込みが起きていること」の前提検査も含めてある——
絞り込みが起きていなければ「残った」ことに意味が無く、`limit` が緩んだ瞬間に
この歯は無意味な緑になるため。

**⚠ この表が主張しないこと**: 擬似 embedding は意味的な類似度を持たないので、これは
「意味的に関連する記憶が正しく上位に来る」ことの証明では**ない**。北極星の「削っても目的の
記憶が落ちない」を、この擬似 provider の `compare` で主張することはやめた——擬似 provider の
`compare` は**量の削減**を測る道具として使い、**想起の質の主張はここには載せない**。
想起の質の主張は本物の埋め込みを使う `retrieval`（下記、
[ADR 0019 §7](../../docs/decisions/0019-real-openai-measurement-cost.md)）が担う、という
判断を [ADR 0022](../../docs/decisions/0022-fake-provider-compare-does-not-claim-recall-quality.md)
に記録した。

### この実測の限界

- **擬似 embedding は意味的な類似度を表現しない。** `DeterministicEmbeddingProvider`
  は文字コードの合計から機械的にベクトルを作るだけで、実際に「関連する記憶が正しく
  上位に来ているか」はこの実測では検証していない（`packages/testkit` 自身のコメントに
  明記されている限界であり、隠していない）。**主に測っているのは「recall がどれだけの量を
  返すか」である。**「正しいものを返すか」については、上記の通り
  **322/642ターンでは、この決定的なシナリオでも目的の記憶が実際に落ちた**
  （「⭐ 削減率だけでは意味を持たない」節・[ADR 0022](../../docs/decisions/0022-fake-provider-compare-does-not-claim-recall-quality.md)
  参照）。**一般に意味的な関連度で正しく順位付けできるかは確認していない。**この2つを
  混同しないこと。**⚠ この「確認していない」は 2026-09-10 に改められた**
  （[ADR 0088](../../docs/decisions/0088-retrieval-quality-measured-in-ci.md)）——
  後者は `retrieval` が測っており、**それが CI で毎 PR 実測されるようになった。**
  実 API キーは要らない（[ADR 0051](../../docs/decisions/0051-recorded-provider-cassette.md)
  のカセットを `MNEMORA_PROVIDER_SOURCE=recorded` で再生する）。
  **⚠ ただし `compare` 自身は依然として `deterministic` で走る**——
  この項が言う「この実測では検証していない」は、**`compare` については今も真である。**
  **⚠ そして `retrieval` の標本は probe 7 件である**（ADR 0033 §3）。
- **naive path はシステムプロンプト・ツール定義を含まない生の transcript だけを測る。**
  実際のアプリケーションはこれらが上乗せされる分、絶対値としての削減幅はさらに
  大きくなりうる（逆に mnemora 側の固定費の比率は相対的に小さくなる）。
- **`budget` は `memories` tier（digest の合計文字数）だけを切り詰め、`index` tier
  （目次帯の JSON）は切り詰めない。** これは意図した設計である——目次帯の唯一の存在理由は
  「recall が0件でも、何が在るかは言える」ことであり
  （[ADR 0008](../../docs/decisions/0008-absence-taxonomy.md)）、
  **呼び出し側が渡した数字ひとつでその保証が消えてはならない。**
  したがって `budget.maxMemoryChars` より目次帯のほうが大きい場合、
  `usage.chars`（全量）は予算を上回る。これは隠さずそのまま出す。
  ただし `usage.share` は「**予算の対象が予算のどれだけを使ったか**」なので 1 を超えない。
  目次帯の実費は `usage.indexChars` として別に返るため、
  呼び出し側は `chars` と `indexChars` を見れば「なぜ全量が予算を上回ったか」が分かる。

  **この節は当初、`share` が 248.3% になることを「仕様どおりの挙動」として記録していた。
  それは誤りだった**——割合として成立しない数を割合の顔で返していた。
  予算の項目名（`maxChars` → `maxMemoryChars`）と `share` の定義を直してある
  （[docs/recall.md §6](../../docs/recall.md) の2つの訂正節を参照）。
  「セッション全体でどれだけ削れたか」ではない（[docs/recall.md §6](../../docs/recall.md)
  「セッション基準値を持たない」を参照。mnemora はセッションという概念を持たない）。
- この比較は**会話1本・固定のシナリオ**に基づく。実際の効果は会話の性質
  （どれだけ「思い出す価値のある事実」対「filler」の比率があるか）に強く依存する。

---

## `retrieval`: 意味的関連性の測定（本 PR で追加）

`compare` の限界として上に明記した通り、擬似 embedding は意味的な類似度を表現しないため、
「recall がどれだけの量を返すか」は測れても「正しいものを返すか」は測れない。`retrieval`
サブコマンドはこの後者——**意味的に関連する記憶が正しく上位に来るか**——を、本物の
OpenAI（LLM・embedding）を使って測るためのものである。

```bash
DATABASE_URL=... OPENAI_API_KEY=... pnpm --filter @mnemora/example-chat run retrieval
```

**⚠ この記述は 2026-09-10 に改められた**
（[ADR 0088](../../docs/decisions/0088-retrieval-quality-measured-in-ci.md)）。
**上のコマンドの形——`OPENAI_API_KEY` を渡して実 API を叩く実行——は、いまも CI に無い。**
実 API は記録を録るとき（`record`）と乖離を測るとき（`verify`）のためのものである。

**⟹ 一方 `retrieval` サブコマンド自体は、CI の `retrieval-quality` ジョブに載っている。**
[ADR 0051](../../docs/decisions/0051-recorded-provider-cassette.md) のカセット
（実 API の埋め込み 152 件・`text-embedding-3-small`/256 次元）を
`MNEMORA_PROVIDER_SOURCE=recorded` で再生するので、**鍵なしに毎 PR 走る。**
手元で同じものを鍵なしに走らせるには:

```bash
DATABASE_URL=... MNEMORA_PROVIDER_SOURCE=recorded pnpm --filter @mnemora/example-chat run retrieval
```

**⛔ CI は値を出すだけで、門にはしていない**——基準値と違っても落ちない
（`decay` が実行ごとに揺れ、標本も probe 7 件しかないため。ADR 0088 §2）。

### 何を測るか(`src/probe-set.ts`・`src/retrieval-quality.ts`)

- `src/probe-set.ts` に、色・ペット・運動・食べ物/アレルギー・家族の居住地・
  プログラミング言語・出張の7領域の probe を置く。probe ごとに gold(冒頭で1度だけ
  表明される事実)・distractor(同じ話題・違う主語や値)・質問(gold と内容語を
  共有しない——`lexicalControl: true` の1件だけ例外)を持つ。
- gold・distractor(計14件)の後ろに、probe の話題と重ならない領域(事務手続き・
  家電の修理・書籍や文房具の購入・部屋の片付け・郵便物・季節の行事の準備)の
  「haystack」を敷き詰める。haystack は決定的に生成され(乱数を使わない)、
  probe の話題語を含まないことを機械的に検査してある(`findTopicKeywordViolations`)。
  ⚠ `scenario.ts` の filler(「今日はいい天気ですね。」等)は使っていない——本物の
  gpt-4o-mini で実際に確認したところ、この種の世間話には `{"memories":[]}` が返り、
  記憶として残らないため(干し草が消えてしまう)。
- `recall().memories` に返ってきた `memoryId` から、`memoryStore.get`/`getObservation`
  (`packages/core`/`packages/postgres` 既存の公開 interface。変更していない)を辿って
  元の `externalId`(`gold-<id>`/`distractor-<id>`/`filler-NNNN`)へ戻し、gold/distractor
  の順位(`goldRank`/`distractorRank`)・`hit@1`/`hit@10`・`distractorBeatsGold`・MRR
  (全体・`lexicalControl`・非語彙で分けて集計)を probe ごとに計算する。
- **順位と一緒に、`recall()` が返したスコア内訳も記録する**
  ([ADR 0033](../../docs/decisions/0033-what-decided-the-rank-in-the-retrieval-bench.md))。
  gold・distractor・1位の `ScoreBreakdown`(`scoreDetails`)と、返った候補全体で各項が
  取った値の幅(`termSpreads`)を出す。**幅が最大の項が、その `recall()` の順位を実際に
  決めた項である**——幅が 0 の項は「重みが小さい」のではなく、候補間で差が付いておらず
  順位に一切寄与していない。**⚠ これは記録と印字だけであり、閾値・重み・`limit`・
  `overFetchFactor` は1つも変えていない**([ADR 0022](../../docs/decisions/0022-fake-provider-compare-does-not-claim-recall-quality.md))。

### 3つの arm

LLM と embedding を別々に選べる(`MNEMORA_LLM`/`MNEMORA_EMBEDDING`、`src/providers.ts`)
ようにしたのはこのため——「順位が変わったのは embedding のせいか抽出のせいか」を
切り分けられないと、どちらが効いたか言えない。

| arm | LLM | Embedding |
|---|---|---|
| A | 擬似(`DeterministicLLMProvider`) | 擬似(`DeterministicEmbeddingProvider`) |
| B | 擬似 | 本物(`text-embedding-3-small`) |
| C | 本物(`gpt-4o-mini`) | 本物(`text-embedding-3-small`) |

arm ごとに別テナントを使う。outbox は `tick()` の `processed === 0` まで繰り返して
干上がらせる——haystack の既定件数(`DEFAULT_HAYSTACK_SIZE`)は `tick()` の既定 `limit`
(50、`packages/core/src/runtime.ts` の `DEFAULT_TICK_LIMIT`)を超えており、
`ingestConversation`(`chat`/`compare` が使う、`tick()` を1回しか呼ばない実装)のままでは
51件目以降が埋め込まれずに残ることを、`retrieval` 自身が実行結果として示す。

呼び出し回数・トークン・USD の実測(`src/usage-meter.ts`。費用は2026-09時点の公開価格を
コードに書いた定数表による概算であり、OpenAI の請求 API から取得した実額ではない)を
arm ごとに画面へ出す。擬似 provider だけの arm(A)ではその旨を明示する
(「OpenAI の API は一切叩いていない」)。

### 実キー無しで走らせる——記録した応答の再生（ADR 0051）

`retrieval` は **`OPENAI_API_KEY` が無ければ、記録した実 API の応答を再生する**
（`examples/chat/cassettes/retrieval.json`）。どちらで走ったかは起動直後に必ず画面へ出す。

```bash
# 記録する（実キーが要る。arm B と C の両方を走らせて録る）
DATABASE_URL=... OPENAI_API_KEY=... pnpm --filter @mnemora/example-chat run record

# 再生する（キー不要。arm B/C の provider が "recorded" になる）
DATABASE_URL=... pnpm --filter @mnemora/example-chat run retrieval

# 記録が実 API から乖離していないか測る（実キーが要る）
OPENAI_API_KEY=... pnpm --filter @mnemora/example-chat run verify
```

**記録に無い入力は例外になる。**黙って擬似 provider へ倒れない——一部が意味を持たない値で
埋まった出力は、どの行が信用できるかを分からなくするため。probe set を変えたら録り直すこと
（`cassette-coverage.test.ts` が、その食い違いを検査の時点で捕まえる）。

**⚠ 再生が保証するのは「測定の再現性」であって「実 API との一致」ではない。**
実際に測った差は次のとおり（**ADR 0051 に実測として記録した**）。

| arm | 実 API | 再生 | |
|---|---|---|---|
| B: 擬似LLM+本物の埋め込み | 0.714 | **0.714** | ✅ 完全一致（probe 7件すべてで順位が一致） |
| C: 本物LLM+本物の埋め込み | 0.714 | **0.738** | ❌ ずれる（`gpt-4o-mini` の応答が揺れるため） |

**カセットの arm C は「ある1回のサンプル」であり、「本物の LLM の実力」ではない。**

**⚠⚠ 埋め込みも、ビット単位では再現しない。**同じ日・同じモデルに記録済み152件を投げ直したところ、
**完全一致したのは5件だけ**（最小コサイン類似度 **0.998646713**）。方向はほぼ保たれるが値は揺れる。
`verify` はこれを踏まえ、「完全一致したか」と「閾値 0.99 を割ったか」を別々に数える。

### 実測結果（2026-09-06、本物の `gpt-4o-mini` / `text-embedding-3-small`(256次元)）

観測 74件（gold 7 + distractor 7 + haystack 60）。`recall()` は既定（`limit`=10）。
**閾値・件数・over-fetch は一切いじっていない。**

| arm | LLM | Embedding | MRR（全体） | MRR（対照群・語彙が重なる1件） | MRR（語彙が重ならない6件） |
|---|---|---|---|---|---|
| **A（＝ `compare` と同じ配置）** | 擬似 | 擬似 | **0.018** | **0.000** | 0.021 |
| **B** | 擬似 | 本物 | **0.714** | 1.000 | 0.667 |
| **C（実運用の配置）** | 本物 | 本物 | **0.743** | 1.000 | 0.700 |

probe ごとの gold の順位（`(無し)` は `recall().memories` に返らなかったことを表す）:

| probe | 語彙が重なるか | A | B | C | distractor が gold より上（C） |
|---|---|---|---|---|---|
| color（好きな色） | **重なる（対照群）** | **(無し)** | 1 | 1 | いいえ |
| pet（ペット） | 重ならない | (無し) | 1 | 1 | いいえ |
| exercise（運動の習慣） | 重ならない | (無し) | 2 | 2 | **はい** |
| diet（避けるべき食べ物） | 重ならない | (無し) | **(無し)** | 5 | **はい** |
| family（家族の居住地） | 重ならない | (無し) | 1 | 1 | いいえ |
| language（好きな言語） | 重ならない | 8 | 1 | 1 | いいえ |
| travel（次の行き先） | 重ならない | (無し) | 2 | 2 | **はい** |

#### 読み方1: 擬似 provider は、この物差しに対して目が見えていない

**arm A は7件中6件で gold を返せなかった。**残る1件も8位である。
**語彙が重なる対照群（色）ですら落ちた。**

**⟹ 上の「冒頭の事実が残るか ✅」の表は、
「意味的に関連する記憶が正しく上位に来た」ことを示していない。**
あの表の干し草は12種類の filler の使い回しだが、**別々の内容が60件並ぶとこの通り崩れる。**

**⚠ ただし、これは上の表を実行し直して否定したものではない。**測ったのは
新しい probe シナリオでの arm A であり、旧シナリオを多様な干し草で回し直してはいない。

#### 読み方2: 効いているのは埋め込みのほうである

**arm A → arm B で MRR が 0.018 → 0.714。**この間で変えたのは**埋め込みだけ**である。
arm B → arm C（LLM も本物に）の上積みは 0.714 → 0.743 と小さい。

**⟹ 北極星の物差しに対して: 本物の埋め込みでは hit@10 が 7/7。**
`limit`=10 は 74件の 13% であり、**87% を削っても目的の記憶は落ちなかった。**
擬似 provider の `compare`（上記「⭐ 削減率だけでは意味を持たない」節）では、量を
2桁近く削った322/642ターンで実際に目的の記憶が落ちている（❌）ため、この物差しに
対する主張は擬似 provider の `compare` からは立てない（[ADR 0022](../../docs/decisions/0022-fake-provider-compare-does-not-claim-recall-quality.md)）。
**本物では「意味で引いた上で落ちなかった」まで言える**——擬似と本物で答えが割れる
場面がある以上、この主張の根拠は本物の provider による `retrieval` の実測に置く。

#### 読み方3: ⚠ 悪い結果もそのまま——「話題は合うが、答えが違う」

**本物の埋め込みでも、7件中3件で distractor が gold より上に来た（hit@1 は 4/7）。**

| probe | 質問 | 1位に来たもの（distractor） | gold |
|---|---|---|---|
| exercise | 「私の運動の習慣はどんなものでしたか?」 | **「父は毎晩ウォーキングをしています。」** | 「毎朝5時に起きてジョギングをしています。」（2位） |
| diet | 「私が避けたほうがいい食べ物はありますか?」 | **「妻は卵アレルギーがあります。」** | 「牛乳を飲むとお腹を壊します。」（**5位**） |
| travel | 「次の遠出の行き先はどこでしたか?」 | **「先月は大阪へ出張しました。」** | 「来月、京都へ出張します。」（2位） |

**⚠ この表は当時（ADR 0019）の実測値である。**本物の LLM が作る `content` は実行ごとに変わるため、
**diet の goldRank は 4 / 5 / 7 / 9 と揺れる**（[ADR 0033](../../docs/decisions/0033-what-decided-the-rank-in-the-retrieval-bench.md) §2.3）。
**`hit@1` が 4/7 であることと、外す3件の顔ぶれは、測り直しても変わらなかった。**

**🔴 ここには当初「共通する形が2つある（主語を見ていない／時制を見ていない）」と
書いてあった。後日スコア内訳を実際に記録して測ったところ、それは成立しなかった**
（[ADR 0033](../../docs/decisions/0033-what-decided-the-rank-in-the-retrieval-bench.md)）。
**あれは返り値から測ったものではなく、順位の表を人が読んで立てた解釈だった。**
測った結果は次の3つである。

1. **順位を決めていたのは `similarity` だけだった。**
   [docs/recall.md](../../docs/recall.md) §7 のスコアは
   `similarity × decay × tagMatch × freshness × strength` だが、この測定では
   `tagMatch` と `strength` は**厳密に 1**（クエリタグを渡さない／`strength` は
   作成時に 1 で固定）、`decay` と `freshness` は**同じ値**（`occurredAt` が
   全件 null なので起点が同じ）で、その幅は probe ごとに 1.1〜1.8×10⁻⁵ しかない。
   **hit@1 を落とした3件の最小の逆転幅は 0.0191 であり、最も不利に取っても約1050倍の開きがある。**
   **⟹ 「スコアが主語と時制を見ていない」のではなく、スコアに見る場所が無い。**
2. **失敗3件の原因は、3件とも違う。** travel は時制だが、**埋め込みは時制を見ており**、
   質問「次の遠出の行き先はどこ**でしたか**?」の表層が過去形であることが効いている
   （質問の表層だけ現在形にすると gold が勝つ）。exercise は**埋め込みが主語の一致を
   見ているのに、gold の主語がゼロ代名詞で落ちている**（gold に「私は」を戻すと勝つ）。
   diet はどちらでもなく、**記憶は症状（「牛乳を飲むとお腹を壊す」）、質問は帰結
   （「避けたほうがいい食べ物」）**という推論の飛躍である。
3. **`occurredAt` は、ADR 0033 を測った時点では全件 null だった。**抽出スキーマに時刻の欄が無く、
   その時点では `observe()` に `occurredAt` を渡している箇所がリポジトリ内に0件だったためである。
   **`RecallQuery.occurredAfter`/`occurredBefore` はいま「いつ言われたか」を絞っている。**

   **🔴 ここには当初、上の2つを現在形で（「原理的に常に null になる」「渡している箇所は
   リポジトリ内に0件である」と）書いてあった。後半はもう偽である**——
   [ADR 0037](../../docs/decisions/0037-callers-pass-occurred-at.md) が足した
   `examples/chat/src/backfill.ts` は実際に `occurredAt` を渡しており、
   [ADR 0058](../../docs/decisions/0058-measure-the-time-term-in-a-separate-arm.md) の
   `time-term` arm も渡す。**前半（抽出スキーマに時刻の欄が無いこと）は変わっていない**——
   `ExtractedMemoryCandidateSchema` の欄は `content` / `digest` / `tags` / `provenanceKind` /
   `confidence` の5つで、時刻に相当する欄は無い。

**⚠ 質問文を書き直して数字を上げることはしない。**それは
[ADR 0022](../../docs/decisions/0022-fake-provider-compare-does-not-claim-recall-quality.md)
の「測る条件を選び直さない」を越える。**「〜でしたか」は日本語の想起質問として自然であり、
実運用で来る形である。**

**⟹ 「載せる量を削っても答えが残る」は言えるが、
「一番上に正しいものが来る」はまだ言えない。**この2つを混同しないこと。

**⚠ 標本は probe 7件である。**ここから一般的な失敗率は主張できない。
言えるのは**この失敗の形が実在する**ということまでである。

#### 実測した実費

| arm | chat 呼び出し | LLM tokens (in/out) | embeddings 呼び出し | embed tokens | USD |
|---|---|---|---|---|---|
| A | 0（API を叩いていない） | — | 0 | — | $0 |
| B | 0 | — | 81 | 2,154 | $0.000043 |
| C | 74 | 15,968 / 3,433 | 83 | 1,790 | $0.004491 |
| **合計** | 74 | | 164 | | **約 $0.0045（0.45セント）** |

3 arm 合わせて所要 約4分。**実費の 99% は LLM 抽出側であり、埋め込みは 1% に満たない。**
費用の内訳と、`compare` を本物で走らせた場合の実費は
[ADR 0019](../../docs/decisions/0019-real-openai-measurement-cost.md) にある。


---

## `identifier-probes`: 識別子・固有名詞を含む query の測定（Issue #109）

`retrieval` の probe 7件（`src/probe-set.ts`）は**すべて日本語の query**であり、
ASCII の識別子・固有名詞を含む query が0件だった——Issue #106 の報告者の用途
（人名・チャンネル名・社内システム名・案件コード・チケット番号。例:
`PROJ-1234` と `PROJ-5678` の取り違え）を、既存ベンチは1件も測っていなかった。

```bash
DATABASE_URL=... pnpm --filter @mnemora/example-chat run identifier-probes
```

`retrieval` のカセット（`cassettes/retrieval.json`）は入力文字列の SHA-256 を鍵にしており、
記録に無い入力は例外になる——probe を1件足すたびに録り直しが要る。この制約を避けるため、
`identifier-probes` は `@mnemora/openai` ではなく **`@mnemora/local-embedding`**
（外部サービスへ繋がないプロセス内推論、[ADR 0085](../../docs/decisions/0085-local-embedding-provider.md)）
を使う——**鍵もカセットも要らない**ので probe を自由に増やせる。

### 何を測るか(`src/identifier-probe-set.ts`・`src/identifier-arm.ts`)

- Issue #106 が名指しした5領域（人名・チャンネル名・社内システム名・案件コード・
  チケット番号）を、まず**12件**（領域あたり2〜3件）で覆う。
- **既存 `probe-set.ts` と probe の設計が「逆」である。**既存は gold の質問が
  gold の事実と内容語を共有しない（本物の埋め込みでしか引けないことを確かめるため）。
  `identifier-probes` は**query に識別子そのものを含める**——「その文字列を含むか」で
  引けることが Issue #106 の報告者の要求そのものだからである。distractor は
  **「同じ書式・違う識別子」**（例: `PROJ-1234` に対する `PROJ-5678`）。これが gold より
  上に来たら「書式は合っているが対象が違う」ものを返しているということであり、
  まさに #106 が報告した失敗である。
- **haystack を2条件用意する**（`src/identifier-probe-set.ts` の `buildIdentifierProbeSetConversation`
  の第2引数 `haystackKind`）。
  - `sparse`（既定）: `probe-set.ts` の既定 haystack をそのまま使う。識別子を1件も含まない。
  - `dense`: probe と**同じ書式ファミリー**（`PROJ-`/`TICKET-`/`INC-`/`SYS-`/`EMP-`/
    `#proj-`/`#team-`/`#incident-2024-`/`@<surname>.<given>`）の識別子を計60件含む
    haystack。Issue #106 の逐語「ベクタ検索だと、同じ形式の別の識別子（`PROJ-5678`）が
    近傍に来て、欲しいものが埋もれます」を表す条件——`sparse` は probe ごとに
    distractor 1件しか同じ書式の競合を置かないため、この状況を表していない。
  - どちらの haystack も、probe の識別子と1件も重ならないことを構築時に機械的検査する
    （`findIdentifierTopicKeywordViolations`。違反があれば例外——`probe-set.ts` の
    `findTopicKeywordViolations` と同じ作法）。

### 3群を別々に集計する（⛔ 混ぜた単一の MRR にしない）

`identifier-probes` は擬似LLM（`DeterministicLLMProvider`）＋ローカル埋め込みで、
3群を走らせる。LLM 層は `retrieval` の arm B と同一——差は埋め込みだけであり、
`@mnemora/local-embedding` の README が「確かめていないこと」として名指しした
「`@mnemora/openai` と比べて想起の質がどうなるか」を、ここで初めて測る。

| 群 | probe | haystack | 直接比較できる相手 |
|---|---|---|---|
| `japanese` | 既存の日本語意味 probe 7件（`probe-set.ts`、変更していない） | sparse | `retrieval` の arm B（embedding=recorded、実質 `text-embedding-3-small`/256次元） |
| `identifiersSparse` | ASCII 識別子 probe 12件 | sparse（識別子0件） | `identifiersDense`（同じ12 probe、haystack だけが違う） |
| `identifiersDense` | 同じ12 probe | dense（識別子60件） | `identifiersSparse` |

### 実測結果（2026-09-10、`ruri-v3-30m/sym`・256次元、`DeterministicLLMProvider`）

🔴 **数字には必ず arm 名・`(provider, model, dimensions)`・haystack 条件を添える**
（この repo で「条件を落とした数字」が実際に3度壊れているため。ADR 0068・ADR 0081 §3.2）。

| 群 | `(provider, model, dimensions)` | haystack | MRR | hit@1 | hit@10 |
|---|---|---|---|---|---|
| `japanese`(7件) | `local`/`ruri-v3-30m/sym`/256次元 | sparse | **0.810** | 5/7 | 7/7 |
| `identifiersSparse`(12件) | `local`/`ruri-v3-30m/sym`/256次元 | sparse | **1.000** | 12/12 | 12/12 |
| `identifiersDense`(12件) | `local`/`ruri-v3-30m/sym`/256次元 | dense | **1.000** | 12/12 | 12/12 |

比較のため、既存 `retrieval` の基準値（[retrieval-baseline.json](./retrieval-baseline.json)、
再掲）:

| arm | `(provider, model, dimensions)` | MRR | hit@1 | hit@10 |
|---|---|---|---|---|
| B: 擬似LLM+本物の埋め込み | `openai`/`text-embedding-3-small`/256次元(recorded再生) | 0.714 | 4/7 | 6/7 |
| C: 本物LLM+本物の埋め込み | `openai`/`text-embedding-3-small`/256次元(recorded再生) | 0.738 | 4/7 | 7/7 |

生の実測値は[identifier-probe-baseline.json](./identifier-probe-baseline.json)に置いてある
（2回実行し、`measuredAt` を除いて完全一致した——ただし ADR 0088 §2 と同じ理由で
「決定的である」の証明ではない）。

#### 読み方: `identifiersSparse` の hit@1=12/12 を「易しすぎた」と即断しない

`TICKET-48213`/`TICKET-48214` は1文字違いで、query は両者と「不具合の報告」という
語彙を共有しており、識別子だけが弁別子である——それを正しく1位にできたのは実際の発見。
一方で `sparse` は probe ごとに同じ書式の競合を1件しか置かず、Issue #106 が
報告した「同じ形式の識別子が多数居て埋もれる」状況を表していない。**`dense` 条件は、
易しくした/難しくした値を見てから作ったものではない**——`identifiersSparse` の実測後に
1度だけ設計し、1度だけ測った（識別子は既存24件と衝突しない値を選び、構築時の
機械的検査で衝突が無いことを確認済み）。結果は `identifiersSparse` と同じく
hit@1=12/12・`distractorBeatsGold` 0件——**密な haystack でも gold は常に1位のままだった。**
distractor の順位そのものは密度の影響を受けている（例:
`channel-c` の `distractorRank` は sparse で2位、dense で8位）。

### 🔴 このベンチが測れないこと（正直に書く）

- **`(provider, model, dimensions)` が違う arm どうしの数字は比較できない**——
  埋め込み空間が違えば、同じ MRR の値でも意味が違う（`local`/`ruri-v3-30m/sym`/256次元 と
  `openai`/`text-embedding-3-small`/256次元は、次元数が同じでも別の空間である）。
- **`identifiersSparse`/`identifiersDense` の probe は `openai`/`text-embedding-3-small`
  では測れない。**`retrieval` のカセット（`cassettes/retrieval.json`）にこの12 probe の
  記録が無いため、`RecordedEmbeddingProvider` は例外を投げる。**⟹「OpenAI の埋め込みなら
  失敗する／成功する」はこのベンチからは一切言えない。**
- **標本は7件・12件である**（[ADR 0033](../../docs/decisions/0033-what-decided-the-rank-in-the-retrieval-bench.md) §3）。
  ここから失敗率・成功率を統計的に主張しない——言えるのは「今回、この母数のうち
  何件引けたか」までである。
- **埋め込みは否定・時制・矛盾を解かない**
  （`@mnemora/local-embedding` の README。実測: 「コーヒーより紅茶が好き」と
  「紅茶よりコーヒーが好き」の cos は 0.996 である）。この bench の probe は
  否定・時制・矛盾を突く形にしていない——識別子の弁別だけを見ている。
- **順位を決めているのはほぼ `similarity` の1項である**
  （[ADR 0081](../../docs/decisions/0081-similarity-is-the-only-term-that-ranks.md)。
  `occurredAt`/`recordedAt` を渡していないため `decay`/`freshness` は候補間でほぼ同値
  ——`identifier-probes` の実測でも幅は 10⁻⁷〜10⁻⁸ の桁である）。**`tagMatch`/`strength`
  が効く状況はこのベンチでは検査していない。**
- **CI ジョブ（`identifier-probes`）はこのベンチを門にしていない。**基準値と違っても
  落ちない——落ちるのは「重みを取得できなかった」ときだけであり、それは意図した
  仕様である（下記）。⚠ **「門にしない」は「基準値と比べない」ではない**——
  CI は毎回 `identifier-probe-baseline.json` と突き合わせ、
  **一致していれば1行、違うときだけ内訳を** Job Summary に出す（下記）。

🔑 **probe 集合そのものが「何を測れるか」を決めている。**
probe を増やす・haystack を変える判断をするときは、必ずこの節を更新すること——
更新を忘れると、次に読む人が同じ壁に当たる。

### 「重みを取得できなかった」と「測ったが値が悪かった」を区別する

`@mnemora/local-embedding` はモデルの重み（初回のみ、約42MB）を Hugging Face から
取得する。取得に失敗した状態と、取得できて測った値が悪い状態を同じ顔で返すと、
「HF から取れなかった」が「想起の質が下がった」に見えてしまう。

`identifier-probes` は arm を走らせる前に必ず `embeddingProvider.warmup()` を呼ぶ
（`src/local-embedding-warmup.ts`）。取得に失敗したら、**メトリクスを1件も出さずに**
`process.exitCode = 1` で終わる（前回の値・既定値・`0` のいずれへも倒さない）。
機械可読な出力（`MNEMORA_IDENTIFIER_PROBE_JSON`）も、この2状態を型で区別する
（`status: "measured" | "weights_unavailable"`）——`weights_unavailable` のときは
`japanese`/`identifiersSparse`/`identifiersDense` の欄が**存在しない**。

CI（`.github/workflows/ci.yml` の `identifier-probes` ジョブ）は、モデル重みの
置き場所を `MNEMORA_LOCAL_EMBEDDING_CACHE_DIR`（`LocalEmbeddingProvider` の
`cacheDir` オプションへそのまま渡す）で固定し、`actions/cache` でキャッシュする——
transformers.js の既定キャッシュ場所は環境によって変わりうるため。

### 基準値との差分を Job Summary に出す（⛔ 門ではない）

⚠ **「⛔ 門にしない」と「⛔ 基準値と比べない」は別のことである**
（[ADR 0094](../../docs/decisions/0094-identifier-probes-local-embedding.md) §8。
[ADR 0088](../../docs/decisions/0088-retrieval-quality-measured-in-ci.md) §3 は
**両方を同時にやっている**）。基準値ファイルがコミットされているのに誰もそれと
比べないなら、値が動いても誰も気づかず、誰も基準値を更新せず、**新しい値が PR の
diff に現れる輪が閉じない。**

CI は毎回こう打つ:

```bash
node scripts/identifier-probe-summary.mjs \
  --measured <MNEMORA_IDENTIFIER_PROBE_JSON の書き先> \
  --baseline examples/chat/identifier-probe-baseline.json \
  >> "$GITHUB_STEP_SUMMARY"
```

- **一致していれば1行で黙る。違うときだけ内訳（群・項目・基準値・実測）を展開する**
  ——⭐ 常に同じ量を出す観測口は読まれない（ADR 0088 §3-3）。
- 🔴 **比べるのは数字だけではない。**`embeddingSpace`（`provider`/`model`/`dimensions`）・
  `haystackKind`・`label` も比べる——**256次元は両方の空間で同じ**なので、
  数字だけを比べると「空間が変わったのに数字が同じ」を「一致」と出してしまう。
- ⛔ **相違では落ちない（`exit 0`）。**非0になるのは**入力そのものが壊れているとき**だけ
  （JSON が読めない・`status` が未知・`measured` なのに必須項目が無い・基準値が壊れている）。
- 🔴 **`status: "weights_unavailable"` のときは、`--baseline` を渡していても比較を
  1つも出さない**——⛔ 「測れなかった」を「基準値と違う」に化けさせない。

**値が意図して動いたときは、基準値ファイルを手で更新すること**（CI は自動更新しない）。
⭐ **その手間は目的である**——更新しないと差分が Job Summary に出続け、
更新すれば新しい値が PR の diff に必ず現れる。


---

## `consolidation-cost`: `Runtime.consolidate()` が「載る量」に効くかの実測（Issue #136）

`Runtime.consolidate()`（ADR 0089）は入ったが、`examples/chat` に配線が無く、北極星の物差し
（「使う側が会話ログを全部プロンプトへ積むのをやめられたか」）に効いたかを誰も測っていなかった
（Issue #136）。さらに ADR 0090 は逐語で「反復で `content` が縮む保証はコードに無い
（⚠ 実際に単調増加することは測っていない）」と書いている。**この bench は「そもそも縮んだか」
——載る量が動いたかどうか——を実測する器である。**

```bash
DATABASE_URL=... pnpm --filter @mnemora/example-chat run consolidation-cost
```

### 何を測るか（想起の「質」ではない）

- **測っているのは「載る量」である。**`store`（active/superseded の件数・文字数・
  トークン数）と `recall().usage`（実際に carry した digest の件数・トークン数・
  `recalledActiveShare`）を、統合前（round 0）と統合1〜3回（round 1〜3）で並べる。
- ⛔ **想起の質（`goldRank`/MRR）の物差しではない。**`goldRank` は載っている——
  「統合後も gold が引けているか」を見失わないための保険として付いているだけであり、
  `retrieval`/`identifier-probes` のように率を主張する目的の欄ではない
  （標本は probe 7件。下記「読み方の注意」参照）。
- **`groupSize`（既定5件）ずつ filler を束ね、群ごとに `runtime.consolidate()` を呼ぶ**
  ラウンド制（`src/consolidation-cost.ts`）。round 2 以降は前回の統合結果も対象に含める。
  ある round の開始時点で対象が2件未満なら、その回で打ち切る
  （`stopReason: "insufficient_candidates"`）。
- **`budget.maxMemoryTokens` の階段（既定 `[8,16,24,32,48,64,128,256,512]`、
  `src/consolidation-cost-options.ts` の `DEFAULT_BUDGET_LADDER`）ごとに、
  「gold を載せるのに要った最小の予算」を診断表として出す**
  （`scripts/consolidation-cost-summary-lib.mjs` の `computeMinBudgetForGold`）。
  ⚠ **下の段を細かくしてあるのは実測に基づく**——既定 `[32,64,128,256,512]` では
  probe 7件のうち6件が最下段(32)で既に gold を載せてしまい、この診断表が床に
  張り付いて分解能を失った（統合前後で Σ が 320 → 224 としか動かなかった）。

### provider 層: 擬似LLM（`deterministic`）＋ `local` 埋め込み——なぜ `recorded` が使えないか

`identifier-probes`（ADR 0094）と同じ組み合わせを使う。**`recorded`（カセットの再生。
ADR 0051）は使えない**——理由は2つある。

1. **`consolidate()` が呼ぶ LLM プロンプトが、カセット（`cassettes/retrieval.json`）に
   記録されていない。**カセットの鍵は入力文字列の SHA-256 であり、記録に無い入力は
   `RecordedLLMProvider` が例外を投げる。統合プロンプトは `retrieval`/`compare` が
   録ったどの入力とも一致しない。
2. **統合結果として新しく作られる Memory の `content` の埋め込みも、カセットに無い。**
   統合前には存在しなかった文字列であり、記録のしようがない。

⟹ **鍵もカセットも要らない `deterministic` LLM（`@mnemora/testkit`）＋
`local` 埋め込み（`@mnemora/local-embedding`、ADR 0085）を固定で使う。**

### ⚠ 擬似 LLM の `content`/`digest` は擬似物の性質であり、実 LLM の要約性能について何も言わない

`DeterministicLLMProvider`（`packages/testkit/src/__fixtures__/deterministic-llm-provider.ts`）
の統合結果は、**プロンプト全文をそのまま `content` として返す**（統合対象の
`content`/`digest` を連結した文字列であり、必ず育つ）。`digest` は先頭40字を切って `…` を
付けたもの（必ず41字以下になる）。

⟹ **`activeContentChars`/`activeDigestChars` に見える非対称（content は伸び続け、digest は
頭打ちになる）は、この擬似 LLM の実装そのものが作っている性質であり、本物の LLM が
「うまく要約できている／できていない」を一切反映していない。** 測っているのはあくまで
「`Runtime.consolidate()` を呼ぶと、パイプラインの配線として載る量がどう動くか」である。

### ⛔ 門ではない

`identifier-probes`/`retrieval` と同じ判断（ADR 0088）。CI（`.github/workflows/ci.yml` の
`consolidation-cost` ジョブ）は毎回 `scripts/consolidation-cost-summary.mjs` で基準値と
突き合わせ、**一致していれば1行で黙り、違うときだけ内訳を展開する**——**相違では
落ちない（`exit 0`）。**非0になるのは入力そのものが壊れているとき（JSON が読めない・
必須項目が無い）と、`@mnemora/local-embedding` の重み取得に失敗したとき
（`status: "weights_unavailable"`。前回の値・既定値・`0` のいずれへも倒さず、
メトリクスを1件も出さずに落ちる）だけである。

### ⚠ `recalledActiveShare` が 1.0 に近い行は「退化（全部載せる）」＝比較不能

`recalledActiveShare`（`carriedCount / activeCount` の平均）が 1.0 に近いとき、それは
「budget を上げて対象を絞れた」のではなく、**その時点の active Memory 数がそもそも少なく、
budget に関係なく全件載っている**ことを意味する。この状態の段どうしを比べても意味を持たない
——`scripts/consolidation-cost-summary-lib.mjs` の Job Summary は、この状態を検出した行に
必ず印を付ける（`buildDegenerateShareSection`）。**黙って良い数字として並べない。**

### 読み方の注意（Job Summary に必ず随伴する）

1. **LLM は擬似であり、統合結果の `content`/`digest` の長さは擬似物の性質である**（上記）。
2. **標本は probe 7件である。ここから率を主張しない**
   （[ADR 0033](../../docs/decisions/0033-what-decided-the-rank-in-the-retrieval-bench.md) §3）。
3. **件数が減ったこと自体は良し悪しを言わない。**`activeCount` が減っても
   `allContentChars`（active+superseded の合計）は増え続ける——「載る記憶の件数」と
   「実際に保持している文字量」は別の軸である。


---

## この会話生成（`src/scenario.ts`）について

`buildConversation(fillerPairs)` は乱数を使わない決定的な関数——同じ `fillerPairs` を
渡せば誰が実行しても同じ会話・同じ文字数になる（測定の再現性のため）。冒頭に1件だけ
「後から参照される事実」（好きな色・誕生日）を置き、その後に filler な世間話の往復を
`fillerPairs` 組並べ、最後に冒頭の事実を尋ねる質問を置く。

**決めたこと**: `observe()` するのは user の発話だけで、assistant の応答は取り込まない
（`ingestConversation` 参照）。実際のアプリケーションが「ユーザーが言った事実だけを
覚えさせ、assistant 側の文面は都度生成する」という使い方をする、という想定に基づく
裁量である。naive path（経路A）は逆に両方の発話を含む全 transcript を積む——
これは「今の普通のやり方」（会話ログを全部渡す）を模すためであり、両者に同じ会話を
与えつつ、経路ごとに扱いが違うのは意図的である。

---

## 設計上の決めたこと（本 PR の裁量）

- **`ingestConversation`（取り込み）と `queryRecall`（想起）を分離した。** 当初
  `runMnemoraPath` に両方を混ぜていたところ、`budget` 有り/無しで2回 recall を試すために
  同じ会話をもう一度 `observe()` してしまい、Memory が重複するバグを自分で踏んだ
  （`externalId` を設定していなかったため）。修正として `externalId: turn-${index}` を
  付けて冪等にした上で、取り込みと想起を別関数に分けた。**この経緯は
  `src/mnemora-path.ts` のコメントに残してある。**
- 会話の長さを変えて測る際（`runComparison`）、**長さごとに別のテナントを使う。**
  同じテナントに会話を積み増すと、後の計測が前の会話の記憶を引きずり、
  「その長さの会話単体で何文字になるか」を独立に測れなくなるため
  （`src/compare.ts` 参照。この分離が効いていることは
  `src/__tests__/compare.postgres.test.ts` の「長い会話を先に測ってから短い会話を測る」
  テストで検査している——短い方を先に測る順序ではこの種のバグを検出できないことに、
  実際にテストを書く過程で気づいた）。

---

## 本 PR で見つけて直した既存の不具合

`@mnemora/core` の `package.json` に `"type": "module"` が無く、`dist/` が
CommonJS として出力されていた（他の3パッケージ——`@mnemora/openai`・`@mnemora/postgres`・
`@mnemora/testkit`——はいずれも `"type": "module"` を持ち ESM を出力する）。

このサンプルアプリが `tsx` で `dist` を実際に実行する初めての利用者になったところ、
`import { heuristicTokenCounter } from "@mnemora/core"` が
`SyntaxError: does not provide an export named 'heuristicTokenCounter'` で落ちた
（プレーンな `node` 経由の ESM import では問題が顕在化せず、`tsx` のローダー経由でのみ
再現した——CJS→ESM 相互運用の名前付き export 検出が、ローダーの実装によって挙動が
変わるため）。これまでの `packages/*` のテストはすべて `vitest.config.mts` が
`@mnemora/core` を `src` へ直接エイリアスしており、`dist` を経由する経路が
一度も検査されていなかった。`packages/core/package.json` に `"type": "module"` を
追加し、`dist/index.js` が名前付き `export` 文を持つ本物の ESM になることを確認して
修正した。**新しい ADR は起こしていない**——既存のどの ADR の決定も覆していない、
実装側の設定漏れの修正であるため。
