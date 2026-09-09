# ADR 0068: `retrieval` ベンチが「測っていないこと」を測ったかのように印字するのをやめる — 2回目の実行の嘘・arm を跨いで数字を拾える形・キーが在るだけで実 API へ倒れること

- **状態**: 採用 (2026-09)
- **日付**: 2026-09-09

**⚠ 各主張の出所を分ける。**この文書では次の3つを混ぜない
（[AGENTS.md](../../AGENTS.md)「確かめていないことは『確かめていない』と書く」の適用）。

- **【現物】** — この決定の担当者が、リポジトリのファイルを読んで確かめた。
- **【計算】** — 既に記録されている実測値から、担当者が算術で導いた。**測り直してはいない。**
- **【実測】** — この決定のために、担当者が実際に走らせて得た数字。環境を明記する。

**この ADR の測定環境 【実測】**: PostgreSQL 17.11 + pgvector 0.8.6（担当者がローカルに立てたもの。
CI の `pgvector/pgvector:pg17` と同じメジャーバージョン）。provider は
[ADR 0051](./0051-recorded-provider-cassette.md) のカセット再生
（`examples/chat/cassettes/retrieval.json`、`recordedAt: 2026-09-06T21:35:13.480Z`）。
**実 API は1回も叩いていない。**

---

## 文脈 — この ADR は `hit@1` を1ポイントも動かさない

**この ADR が直すのは、想起の質ではなく、それを測る道具である。**

[ADR 0033](./0033-what-decided-the-rank-in-the-retrieval-bench.md) は
「`retrieval` ベンチが順位の理由を捨てていた」ことを塞いだ。本 ADR はその続きであり、
**同じベンチに残っていた別の3つの嘘**を塞ぐ。どれも
**「値が間違っている」のではなく「その値が何についての値なのかを取り違えさせる」**種類の欠陥である。

### なぜ今これを書くか — オーナー自身が実例になった

**出所: オーナーの申告（逐語）** —

> 私は **`MRR 0.714`（arm B）と `hit@10 = 7/7`（arm C）を束ねて**、それを記憶に持ち、
> 委譲文に書き、**2本の委譲に同じ誤りを測らせました。**

**⟹ これは個人の不注意として片付けてはいけない。**
**arm を跨いで数字を拾える形が出力の側に在る限り、次に誰が来ても同じ間違いをする。**
だから本 ADR は、注意書きではなく**出力の形**を変える。

---

## 1. 測ったこと 【実測】— 2回目の実行が、逆の結論を印字する

同じ条件で `pnpm --filter @mnemora/example-chat run retrieval` を**2回続けて**回し、
出力を `diff` した。

**順位は完全に再現した。**`goldRank` / `distractorRank` / `hit@1` / `hit@10` / MRR は
**3 arm・7 probe すべてで一致**。動いたのは `decay` / `freshness` の下位桁だけで
（`1.000000` → `0.999996`）、順位は1つも動かない。

**しかし `ingest` の欄だけが、逆の結論を印字した:**

```
run 1: ingest: observations=74 ticks=3 firstTickProcessed=50 totalProcessed=74 totalFailed=0
         ⚠ 既定の tick() を1回だけ呼ぶ実装だったら、この arm では 24 件が
           埋め込まれないまま残っていたはず(背景2)。

run 2: ingest: observations=74 ticks=1 firstTickProcessed=0  totalProcessed=0  totalFailed=0
         (この arm では既定の tick() 1回で全件処理できる件数だった)      ← 嘘
```

### 1.1 なぜそうなるか 【現物】

- `cli.ts` の `runRetrieval` は **DB をリセットしない**。arm の `tenantId` は
  `retrieval-quality-arm-a` / `-b` / `-c` の**固定値**である。
- 2回目の実行では、`observe()` が `externalId` の冪等性により**新しい Observation を作らない**。
- ⟹ outbox に `extract` ジョブが1件も積まれず、`drainEmbedTicks` は
  `totalProcessed = 0` / `firstTickProcessed = 0` を返す。
- ⟹ `singleTickWouldHaveStalled = (drain.firstTickProcessed < drain.totalProcessed)`
  は `(0 < 0)` すなわち **`false`** になる。
- ⟹ `formatArmDetail` が
  「(この arm では既定の tick() 1回で全件処理できる件数だった)」と印字する。

### 1.2 🔑 これがいちばん危ない形である理由

**順位のほうは正しく出る。**前回の実行で作られた Memory が DB に残っているため、
`recall()` は1回目とまったく同じ順位を返す。MRR も `hit@1` も `hit@10` も変わらない。

**⟹ 出力を読んでも気付けない。**数字が壊れていれば疑うが、
**壊れているのは1行だけで、しかもその1行は「問題ありません」と言っている。**

**⟹ そしてこの嘘は、緑のまま通る。**この文を殺す歯はどこにも無かった 【現物】。

### 1.3 🔴 決定的な現物 — 信号は既に返ってきていた

`packages/core/src/runtime.ts` の `handleExtractableObservation` は、
冪等な再送のとき **`{ observationId, memoryIds: [], extraction: "skipped" }`** を返す
（`created === false` の分岐）【現物】。

**⟹ ベンチは「今回は取り込んでいない」という信号を、`observe()` の返り値として
既に受け取っていた。**そして `runRetrievalQualityArm` は、その `ObserveResult` を
**受け取らずに捨てていた**（`for (const utterance of utterances) { await options.runtime.observe(...) }`）【現物】。

**⟹ ADR 0033 が塞いだのと、構造が同じ欠陥である。**
返り値に答えが載っているのに、それを捨てて、代わりに解釈を印字していた。

---

## 2. 測ったこと 【実測】— arm を跨いで数字を拾える形

**なぜ拾えてしまうのか** 【現物】:

- `formatArmSummaryTable`（arm ごとに1行）は **MRR しか持っていない。**
- `hit@1` / `hit@10` を知るには `formatProbeComparisonTable`
  （probe ごとに1行、**arm ごとに5列 × 3 arm = 17列**）へ行き、**行を横に数える**必要がある。
- ⟹ **arm の見出し数字を1つ揃えるために、必ず別の表へ移り、列を跨ぐ。**そこで arm が混ざる。

**実際に混ざる例 【実測】**（本 ADR の測定環境での値）:

| arm | MRR（全体） | `hit@1` | `hit@10` |
| --- | --- | --- | --- |
| A: 擬似LLM+擬似埋め込み | 0.018 | 0/7 | 1/7 |
| B: 擬似LLM+本物の埋め込み | **0.714** | 4/7 | **6/7** |
| C: 本物LLM+本物の埋め込み | **0.738** | 4/7 | **7/7** |

**⟹ `MRR = 0.714` と `hit@10 = 7/7` は、同じ arm の数字ではない。**
前者は arm B、後者は arm C である。**この2つを束ねた記述は、どの arm についても真ではない。**

---

## 3. 測ったこと 【現物】— キーが在るだけで、カセット再生のつもりが実 API へ倒れる

`examples/chat/src/cli.ts` の `resolveCassetteForRun` は、こう始まる 【現物】:

```ts
if (process.env.OPENAI_API_KEY) {
  return undefined;   // ← キーが在れば無条件に実 API
}
```

**⟹ `OPENAI_API_KEY` が設定された環境で `pnpm --filter @mnemora/example-chat run retrieval`
と打つと、カセットが在っても実 API を叩く。意図せず課金される。**

**⟹ そして `MNEMORA_LLM=recorded` では救えない** 【現物】——
`runRetrieval` は arm ごとに `MNEMORA_LLM: arm.llmOverride` を明示的に上書きするし、
`compare` の経路でも `cassette` が `undefined` のまま渡るので
`providers.ts` の `requireCassette` が例外で落ちる。
**「キーが在るときにカセットを使う」口が、どこにも無い。**

**⚠ これは①②と同じ形の欠陥である。**利用者は「カセットで測っている」つもりでいるのに、
道具は黙って別のこと（実 API を叩くこと）をしている。
**①は順位が正しく出るから気付けない。②は数字が正しいから気付けない。
③は結果が返ってくるから気付けない** —— 気付くのは請求書が来たときである。

---

## 4. ⚠ 独立な2本の段0 が、抽出側の件数で食い違った — どちらも正しい

本件は**独立に2回**調べられた（`mgr-0b8d3ff7` と、本 ADR の担当者）。
**arm 表・4項の定数性・`occurredAt` が 75/75 で null・ベンチが決定的であること・
`OPENAI_API_KEY` が在るだけで実 API へ倒れること**は一致した。

**食い違ったのは1点だけである:**

| | `mgr-0b8d3ff7` | 本 ADR の担当者 |
| --- | --- | --- |
| `hit@1` で外す3件のうち、抽出側の問題は何件か | **0件** | **2件**（`exercise` / `travel`） |

### 4.1 裁定 【実測】

**カセットに記録された `gpt-4o-mini` の応答そのものを、機械的に突き合わせた。**

| probe | 順位 | 原発話 | 抽出された `content` | 原発話に一人称主語が在るか | 抽出がそれを落としたか |
| --- | --- | --- | --- | --- | --- |
| color | 1位 | 私の好きな色は青です。誕生日は4月3日です。 | 好きな色は青である。／誕生日は4月3日である。 | **在る** | **落とした** |
| pet | 1位 | 私は猫を2匹飼っています。 | 猫を2匹飼っている | **在る** | **落とした** |
| exercise | **2位（外し）** | 毎朝5時に起きてジョギングをしています。 | 毎朝5時に起きてジョギングをしている。 | 無い | — |
| diet | **6位（外し）** | 牛乳を飲むとお腹を壊します。 | 牛乳を飲むとお腹を壊します。 | 無い | — |
| family | 1位 | 弟は札幌に住んでいます。 | 弟は札幌に住んでいます。 | 無い | — |
| language | 1位 | TypeScript より Rust のほうが好みです。 | Rust のほうが TypeScript より好みである。 | 無い | — |
| travel | **2位（外し）** | 来月、京都へ出張します。 | 来月、京都へ出張する。 | 無い | — |

**⟹ `mgr-0b8d3ff7` の主張は正しい。**逐語で確かめられる:

- **一人称主語を落としたのは `color` と `pet` の2件だけで、その2件は既に1位である。**
- **失敗3件の gold は、原発話の時点で主語を持たない。**抽出は語尾を常体化しただけであり、
  `diet` に至っては**完全な恒等変換**である。

### 4.2 🔑 二人は同じものを見て、違う問いに答えていた

**問いが2つある。分けて書く。**

| 問い | 答え | 意味 |
| --- | --- | --- |
| **Q-A: 抽出は、原発話に在った情報を落としたか** | **0件**（失敗3件について） | 抽出は何も壊していない |
| **Q-B: その失敗を直すとしたら、手を入れる場所は抽出段か** | **2件**（`exercise` の主語、`travel` の時刻） | 直す場所は抽出段に在る |

**⟹ どちらも正しい。**そして**本 ADR の担当者が使った「抽出側の問題」という言い方のほうが、
不正確だった** —— 「問題」と書くと Q-A（抽出が壊した）と読めるが、実際に指していたのは
Q-B（抽出が**持っていない能力**）である。**「復元しなかった」を「落とした」と書いてはいけない。**

**⟹ そして両方の答えが、同じ場所に着く。**
`exercise` を直すとは、**原発話に無い一人称主語を付け足す**ことであり、
[ADR 0055](./0055-extraction-prompt-subject-and-inference-not-added.md) が
実 API 18 run で測ったうえで却下した、まさにその変更である
（保存される `content` が「**私の**妹の好きな色は緑です。」になり、
しかも `provenanceKind` は `stated` のままになる）。

---

## 5. ⚠ この仕事の依頼文に含まれていた前提のうち、現物と食い違ったもの 【実測】

**これはオーナーの恥ではなく、repo の危険である。**§2 の通り、原因は出力の形に在る。

| # | 依頼文の前提 | 現物 |
| --- | --- | --- |
| 1 | `MRR = 0.714` が実運用配置（arm C）の値 | **arm B の値。** arm C は **0.738** |
| 2 | `hit@10 = 7/7` を上と同じ arm の値として束ねていた | **arm C の値。** arm B は **6/7**（`diet` が返らない） |
| 3 | 「ベンチが説明を捨てている」ので測定を先に直す必要がある | **ADR 0033 / PR #32 で塞がれ済み。** `computeTermSpreads` / `collectScoreDetails` が既に在る |
| 4 | 「実 API の compare は実行ごとに数字が動く」ので、測定の再現性が先 | **`retrieval` のカセット再生は決定的。** 2回回して順位・MRR が完全一致した（§1）。⟹ この順序は既に済んでいた |
| 5 | 失敗3件のうち2件は「抽出側」 | **言い方が二義的だった**（§4.2）。Q-A では 0件、Q-B では 2件 |

**⟹ 5件のうち 1・2 は §2 の欠陥が直接生んだものであり、3・4 は「既に直っている」ことを
知る手段が無かったことによる。**本 ADR は 1・2 の側を塞ぐ。

---

## 決定

**`retrieval` ベンチが、測っていないことを測ったかのように印字するのをやめる。3つ直す。**

1. **取り込みを実際に測ったかどうかを、`observe()` の返り値から数えて記録する。**
   `ArmIngestSummary` は「この run で取り込みを測ったのか」を**分類として**持つ
   （[ADR 0008](./0008-absence-taxonomy.md) の「無いには種類がある」を、取り込み側にも適用する）。
   **`singleTickWouldHaveStalled` を `boolean` のままにしない** ——
   **「測っていない」と「1回で足りた」が同じ顔になる形を禁じる。**これが §1 の嘘の正体である。
2. **arm の見出し数字（MRR・`hit@1`・`hit@10`）を、`ArmReport` を1つだけ受け取る
   1つの関数から作り、arm ごとの1行に3つとも並べる。**
   ⟹ **arm の見出し数字を知るために別の表へ行く理由を無くす。**
3. **キーが在っても、明示すればカセットを使える口を足す**（`MNEMORA_PROVIDER_SOURCE`）。
   判定は `EnvLike` を受け取る純関数に切り出し、**選ばれた側と、なぜそう決まったかの両方**を返す。
   **⛔ 既定の振る舞いは変えない。**「キーが在れば実 API」は誰かの意図かもしれない ——
   **能力を足すだけにする。**未知の値は例外にする（黙って既定へ倒れない）。

**⛔ 注意書きは足さない。**注意書きは検査されない。**形で塞ぐ。**

**⛔ この ADR は `hit@1` を1ポイントも動かさない。動かさないことが意図である**
（[ADR 0058](./0058-measure-the-time-term-in-a-separate-arm.md) と同じ線）。

---

## 検討して採らなかった案

### (a) probe set の gold/distractor に `occurredAt` を書き込む ⛔

**採らない。**`travel` の gold は「来月」（未来）、distractor は「先月」（過去）なので、
`occurredAt` を書けば `freshness` が clamp（[ADR 0036](./0036-clamp-freshness-at-one.md)）で
1 対 0.5 になり、`hit@1` は 4/7 → 5/7 になる 【計算・測り直していない】。

**それが採らない理由である。**これは「**数字が良くなる方向へ、測る条件を選び直す**」ことであり、
[ADR 0022](./0022-fake-provider-compare-does-not-claim-recall-quality.md) が引いた線を越える。
**ADR 0058 が既に同じ結論に達しており、本 ADR はそれを覆さない。**

### (b) 抽出スキーマに時刻の欄を入れ、`occurredAt` を実データから埋める ⛔（今回は）

**筋は良い。**これは「測る条件」ではなく「製品の能力」を変える変更であり、
ADR 0033 の負債 §4 と ADR 0058 の「これが覆るとしたら」の筆頭に挙がっている。

**しかし本 PR には載せない。**[ADR 0037](./0037-callers-pass-occurred-at.md) が
「**基準日を渡すと抽出プロンプトが日ごとに変わる**」を保留にしており、
**決定的になったカセットを、また非決定的に戻す危険が在る。**

**⟹ 順序が在る。測定器を固めてから、測る対象に触る。**本 ADR は前半だけをやる。
後半は別 ADR で、設計から始める。

### (c) `retrieval` の実行前に DB をリセットする ⛔

**採らない。**`cli.ts` はサンプルアプリであり、利用者の DB を消す権限は無い。
`resetTestDatabase` は `examples/chat/src/__tests__/` の道具であって、CLI の道具ではない。

### (d) 固定 `tenantId` のまま、2回目は例外を投げて止まる ⛔

**採らない。**「壊れているものを壊れていない顔で返さない」は満たすが、
**オーナーの要求（「2回目の実行で `ingest` の結論が変わらない」ことを歯で測る）を満たさない。**
止まる run は、結論を出していない。

---

### (e) `ann_truncated`（35件が一度もスコアされていないこと）を一緒に直す ⛔

**本 PR には入れない。主題が違う。**

**測ったこと 【実測】**: 本 ADR の測定環境で、**7 probe すべての `omitted` に
`ann_truncated` が出ている。**スコープ内 75件に対して段1の ANN は
`k' = limit × overFetchFactor = 10 × 4 = 40` 件しか通しておらず、
**35件は一度もスコアされていない。**

**⟹ これは件数が増えるほど効く欠陥であり、75件ですら半分近くが見られていない。**
オーナーの台帳へ移した。**次は「`k'` はどう決まるか / 35件が落ちるのは設計か事故か」を
数えるところから始める。**本 ADR は測定器の側しか触らない。

## 実装

**`packages/*`（製品コード）は1行も変えていない。**触ったのは `examples/chat/`（測定の側）と
`docs/` だけである（ADR 0058 と同じ線）。

### ① `ingest` の嘘

- `runRetrievalQualityArm` が `observe()` の `ObserveResult.extraction` を数える
  （`ExtractionOutcomeCounts`）。**捨てていた返り値を捨てるのをやめる。**
- `IngestMeasurement = "measured" | "replayed" | "partial"` を `ArmIngestSummary` に足す。
  **`boolean` に潰さない** —— 2値では `"partial"` を表現できず、寄せた瞬間に嘘になる。
- `singleTickWouldHaveStalled` を `boolean | null` にし、`"replayed"` のとき `null` にする。
  **これが嘘の正体だった** —— `(0 < 0) === false` が「1回で足りた」と同じ顔をしていた。
- `formatArmDetail` / `formatArmSummaryTable` は `null` を「(測っていない)」と印字する。
- `cli.ts` の `runRetrieval` は `newRunToken()` / `buildArmTenantId()` を経由し、
  **実行ごとに新しいテナントを使う。**`newRunToken()` は `Date.now()` にプロセス内カウンタを
  足す —— 同一ミリ秒内の2連続呼び出しでも衝突しない（クロックの分解能に依存させない）。

### ② arm を跨いで数字を拾える形

- `armHeadline(report: ArmReport): ArmHeadline` を足す。**引数は `ArmReport` 1つだけ** ——
  複数の arm を受け取らないので、**構造上、別の arm の数字が混ざりようがない。**
- `formatArmSummaryTable` に `ingest計測` / `hit@1` / `hit@10` の列を足す。
  ⟹ **arm の見出し数字を知るために `formatProbeComparisonTable` へ行く理由が無くなる。**
- `formatArmDetail` の `MRR:` 行も同じ `armHeadline()` から作る。
  ⟹ **2箇所が食い違うことが構造上あり得なくなる。**

**実測 【実測】**（本 ADR の測定環境、カセット再生）:

```
| arm | ... | ingest計測 | 既定tick1回なら止まっていたか | MRR(全体) | ... | hit@1 | hit@10 |
| A: 擬似LLM+擬似埋め込み | ... | measured | はい | 0.018 | ... | 0/7 | 1/7 |
| B: 擬似LLM+本物の埋め込み | ... | measured | はい | 0.714 | ... | 4/7 | 6/7 |
| C: 本物LLM+本物の埋め込み | ... | measured | はい | 0.738 | ... | 4/7 | 7/7 |
```

**⟹ §2 で束ねられた `0.714` と `7/7` は、いま別々の行に在る。**

### ③ カセットを強制できないこと

- `decideProviderSource(env: EnvLike): ProviderSourceDecision` を `providers.ts` に足す。
  **選ばれた側（`source`）と、なぜそう決まったか（`reason`）の両方を返す** ——
  「たまたま recorded になった」と「明示して recorded にした」を画面から区別できないと、
  ADR 0051 の「どちらで走ったかを隠さない」が骨抜きになる。
- `MNEMORA_PROVIDER_SOURCE=recorded` は**キーが在っても**カセットを強制する。
  **未指定なら既定は1文字も変えていない**（キーが在れば実 API）。
- 未知の値は例外（`parseModeOverride` と同じ作法）。

### 🔴 ③ の実装が、この ADR が塞ごうとしている欠陥を新しく作っていた 【実測】

**最初の実装では `MNEMORA_PROVIDER_SOURCE="openai"` をキー無しで指定できた。**
その状態で `compare` を走らせたところ:

```
[cassette] provider source: openai(理由: MNEMORA_PROVIDER_SOURCE=openai の明示指定（実 API を叩く）)
[provider] LLM       : @mnemora/testkit の決定的な擬似 provider
[provider] Embedding : @mnemora/testkit の決定的な擬似 provider
...（数字の表がそのまま出て）...
EXIT=0
```

**⟹ 画面には「実 API を叩く」と出しながら、意味を持たない擬似 provider で走り、
数字の表を出して緑で終わる。**`source === "openai"` のとき呼び出し側はカセットを読まずに
`process.env` を `createProviders` へ渡すので、`selectProviderMode` が
「キーが無い ⟹ deterministic」と判定するためである。

**⟹ ③ の実装が、①②③とまったく同じ形の欠陥を新しく作っていた。**
しかも**その状態を固定する歯まで書かれていた**（`decideProviderSource({ MNEMORA_PROVIDER_SOURCE: "openai" })`
が `forced` を返すことを assert する歯）。**全門は緑だった。**

**直した**: `decideProviderSource` は、キー無しで `"openai"` を強制されたら例外を投げる。
これは ADR 0051 が `requireCassette` で引いたのと同じ線であり、反対側（`recorded` を
強制したのにカセットが無い）は既にそこで落ちている。**片側だけ塞がっていた。**

---

## 歯

**⚠ `examples/chat` には `test` スクリプトが無く `test:db` しかない**（ADR 0015 / 0016 の分割）。
CI は `DATABASE_URL` を持つのでこれらは CI で走る。

| 歯 | 何を測るか |
| --- | --- |
| ①-1 | `newRunToken()` で別テナントにすれば、**2回目の `ingest` が1回目と deep-equal** |
| ①-2 | **同一テナント**で2回走らせると、2回目は `measurement="replayed"` かつ `singleTickWouldHaveStalled === null`（「足りた」と言わない） |
| ①-3 | `formatArmDetail` が、測っていない run で「1回で全件処理できる件数だった」を印字しない |
| ①-4 | `newRunToken` / `buildArmTenantId` の契約（必ず違う値・同 token 同値・arm 跨ぎで別値） |
| ②-1 | `formatArmSummaryTable` の各行が**自分の arm の数字だけ**を含む（3 arm を区別できる値で組む） |
| ②-2 | 各行に **MRR・`hit@1`・`hit@10` が揃っている**（別の表へ行く理由が無い） |
| ②-3 | `armHeadline()` が `report.probes` からのみ導かれる |
| ③-1 | **キーが在っても** `MNEMORA_PROVIDER_SOURCE=recorded` なら recorded を強制する |
| ③-2 | 未指定なら既定（キーの有無だけ）が変わっていない |
| ③-3 | 未知の値で例外 |
| ③-4 | **偽キーが在る状態で**通しに組み立てて `llmMode`/`embeddingMode` が実際に `recorded` になる |
| ③-5 | `"openai"` をキー無しで強制したら例外（擬似 provider へ黙って倒れない） |

**⚠ ①-1 と ③-1/③-4 は、「2回目」「キーが在る状態」でなければ緑のままになる。**
1回目だけ・キー無しだけの歯では、この3つの欠陥はどれも一生捕まらない。

### 変異試験 【実測】

4段（段0 変異が木に載ったか＝`git diff` と `md5sum` → 段1 赤 → 段2 `AssertionError` の件数
→ 段3 戻して緑・`md5sum` 一致）で9本撃った。**`TypeError` は全変異で0件**
（＝型が壊れて落ちたのではなく、歯が実際に噛んでいる）。

| # | 変異 | 赤になった歯 | `AssertionError` |
| --- | --- | --- | --- |
| 1 | `classifyIngestMeasurement` を常に `"measured"` | ①-2 / ①-3 | 2 |
| 2 | `singleTickWouldHaveStalled` を無条件の比較に戻す（欠陥の復元） | ①-2 | 1 |
| 3 | `newRunToken` を定数化 | ①-1 / ①-4 | 3 |
| 4 | `formatArmSummaryTable` が全行に `armHeadline(reports[0])` を使う | ②-1 | 2 |
| 5 | `hit@10` 列を落とす | ②-1 / ②-2 | 4 |
| 6 | `decideProviderSource` の `recorded` 強制を落とす | ③-1 / ③-4 | 2 |
| 7 | 既定を常に `recorded` に | ③-2 | 2 |
| 8 | 未知の値の例外を落とす | ③-3 | 1 |
| 9 | **キー無し `openai` 強制の番人を落とす**（§実装の🔴の復元） | ③-5 | 1 |

**⭐ 対照 —「その歯が無い世界で同じ変異を撃つ」** 【実測】:

- 変異2（①用）・変異4（②用）について、新設した歯のファイルを一時退避して同じ変異を撃った。
  **どちらも既存の門は緑のまま**（17ファイル/125テスト・17ファイル/121テスト）。
  ⟹ **この2つの欠陥は、既存の歯では捕まらない。**
- 変異9 については対照を撃つまでもない —— **③ の最初の実装は全門が緑であり、
  その状態がまさに「歯が無い世界」だった**（§実装の🔴）。

### 変異2 について、正直に書く

**変異2 で赤くなったのは ①-2 だけで、①-3 は緑のままだった。**
①-3（表示層）は `measurement` で分岐しており、`singleTickWouldHaveStalled` の
計算式だけを戻しても文面が変わらないためである。**⟹ ①-3 単独では元の欠陥を殺せない。**
殺しているのは ①-2（分類そのもの）と変異1 である。**歯の強さは一様ではない。**

---

## 引き受ける負債・覆えていない範囲

- **🔴 実行のたびに DB にテナントが増える。掃除しない** 【実測】。
  1 run あたり **memories +223 / observations +222 / outbox +445 / テナント +3**。
  `examples/chat` はサンプルアプリであり、利用者の DB を消す権限が無い（§(c)）。
  **⟹ ベンチを繰り返すと DB は単調に膨らむ。**手で掃除するか、使い捨ての DB を使うこと。
- **🔴 `cli.ts` の `resolveCassetteForRun` 自体には歯が届いていない** 【現物】。
  `cli.ts` は末尾で `main().catch(...)` を無条件に実行するため、import するとサブコマンドが
  走ってしまい、単体で呼べない。③-4 は `decideProviderSource` → `createExampleRuntime` の
  配線を**歯の側で組み直して**検査しており、`cli.ts` 内の実配線そのものは見ていない。
  **⟹ `resolveCassetteForRun` の中で判定を握り潰す変異は、この歯では捕まらない。**
  （通しの実行では確認した —— 偽キー `sk-test-dummy` + `MNEMORA_PROVIDER_SOURCE=recorded` で
  `retrieval` がカセット再生になり EXIT=0 で終わることを実測した。）
- **`"partial"` の分岐は、公開経路から作り出せていない** 【現物】。
  `runRetrievalQualityArm` は毎回同じ probe set 全件を `observe()` するので、
  新規と冪等な再送が混ざる状態を CLI からは作れない。
  ⟹ **これは「いま効いている検査」ではなく、`"replayed"` へ寄せて嘘をつかないための名前である。**
  ADR 0024 の「届かない分岐を残さない」に触れる。**残す側に寄せた理由は、2値に潰すと
  `"partial"` がどちらかの嘘になるからである**（ADR 0058 の `collapsed` と同じ判断）。
- **`armHeadline` は `mrrLexicalControl` / `mrrNonLexical` を含んでいない。**
  この2つは `formatArmSummaryTable` / `formatArmDetail` が `ArmReport` から直接読む。
  **同じ `report` 変数から読むので arm は跨がないが、`armHeadline` の
  「1つの `ArmReport` からしか作れない」という構造上の保証は、この2つには及んでいない。**
- **`.md` は `format:check` の対象外** 【現物】（対象は `ts,tsx,mts,cts,js,mjs,cjs,json`）。
  ⟹ **この ADR 本文を検査する門は無い。**
- **`hit@1` は1ポイントも動いていない。**動かさないことが本 ADR の意図である。

---

## これが覆るとしたら

- **`examples/chat` が DB をリセットできる立場になったら。**§(c) の理由が消え、
  実行ごとにテナントを増やす必要が無くなる。
- **抽出スキーマに時刻の欄が入ったら**（§(b)）。そのとき本 ADR の「測定器を先に固める」という
  順序は役目を終える。
- **arm の数が 3 でなくなったら。**§2 の「17列」という具体は変わるが、
  **「見出し数字を別の表へ取りに行かせない」という決定は残る。**
- **ベンチの出力を人が読まなくなったら**（機械が読む形になったら）。
  §2 の決定は「人が拾い間違える」ことを前提にしている。

---

## 確かめたこと / 確かめていないこと

**確かめた 【実測】**

- 同じ条件で2回回すと、順位・`hit@1`・`hit@10`・MRR は3 arm・7 probe すべて一致する。
- 2回目の `ingest` 欄は逆の結論を印字する。
- arm A / B / C の MRR・`hit@1`・`hit@10` は §2 の表の通りで、
  `MRR 0.714` と `hit@10 7/7` は同じ arm の値ではない。
- 一人称主語を落としたのは `color` と `pet` の2件だけで、失敗3件の gold は
  原発話の時点で主語を持たない（§4.1）。
- **③ の最初の実装が、画面に「実 API を叩く」と出しながら擬似 provider で走り EXIT=0 で
  終わる状態を作っていた**（§実装の🔴）。走らせて出力を確認し、番人を足して塞いだ。
- 直したあと、ベンチを2回回して `ingest` 行・まとめ表が完全一致することを確認した。
- 偽キー `sk-test-dummy` を置いた状態で `MNEMORA_PROVIDER_SOURCE=recorded` を指定すると、
  `retrieval` がカセット再生で走り EXIT=0 で終わる（実 API へ倒れれば 401 で落ちるので、
  緑であること自体が倒れていない証拠になる）。
- 全門（`typecheck` / `lint` / `format:check` / `build` / `DATABASE_URL` 付きの `test`）が
  EXIT=0。`test` は「✔ DB テストも実行し、通りました。」と名乗った。

**確かめた 【現物】**

- `observe()` は冪等な再送で `extraction: "skipped"` を返し、ベンチはそれを捨てていた。
- `cli.ts` の `runRetrieval` に DB リセットは無く、`tenantId` は固定値である。
- `formatArmSummaryTable` は MRR しか持っていない。
- `resolveCassetteForRun` は `OPENAI_API_KEY` が在れば無条件に `undefined` を返し、
  `MNEMORA_LLM=recorded` はこれを救えない（§3）。

**確かめていない**

- **`hit@1` が 4/7 であることの原因**は、本 ADR では測り直していない。
  ADR 0033 / 0055 / 0058 の記録に依る（担当者が独立に再現した値は一致した）。
- **§(a) の「4/7 → 5/7 になる」は計算であり、走らせていない。**
- **実 API との乖離**は測っていない（本 ADR は API を1回も叩いていない）。
  カセットが与えるのは実 API との一致ではなく測定の再現性である（ADR 0051）。
