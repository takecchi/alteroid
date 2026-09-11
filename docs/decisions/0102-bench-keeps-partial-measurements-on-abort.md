# ADR 0102: ベンチが例外で死ぬとき、測れた分を捨てない — 包むことの増分は「例外」ではなく「文脈」である

- **状態**: 採用 (2026-09)
- **日付**: 2026-09-11

**⚠ 各主張の出所を分ける**（[ADR 0101](./0101-how-to-measure-whether-consolidate-moved-the-north-star.md) の体裁を踏む）。

- **【現物】** — この repo のコード・文書を書き手が読んで確かめた。
- **【実測】** — この repo で書き手が自分の手で走らせた。
- **【受】** — 報告として受け取り、再導出していない。

---

## 問い

[ADR 0100](./0100-supersede-with-new-memories.md) は、自分が作った負債の**住所をわざと開けたまま**残した。逐語:【現物】

> ⚠ **ベンチが実測中の失敗で大きな音を立てて落ちるのは、むしろ望ましい**とも言えるが、
> **それはこの ADR が決めたことではなく、`examples/chat` 側の判断である。**
> ⛔ 本 PR では `examples/chat` を触っていない（PR #143 が着地した直後のファイルであり、
> そこへ手を入れるかは別の判断）。**この住所をここに残す。**

**この ADR が、その保留された判断を下す。**

問いは「`try`/`catch` で包むか」ではない。**「このベンチの読み手は、store が予期せず失敗したときに何を知りたいか」**である。

---

## 文脈

### 1. 【現物】裸で投げても、今日すでに非0で終わるし、`cause` も stderr に出る

`examples/chat/src/cli.ts:1039-1042` に最外周の catch-all が在る:

```ts
main().catch((err) => {
  console.error(err);
  process.exitCode = 1;
});
```

`console.error(err)` は `Error` オブジェクトをそのまま渡しており、Node の `util.inspect` は
`[cause]:` を辿って出す。⟹ **「非0で終わる」も「`String(error)` に畳まない」も、今日すでに
満たされている。**

🔑 **⟹ だから「包む」ことの増分は、*例外そのもの*ではない。**

### 2. 🔴 【現物】しかし、例外が出ると機械可読な成果物が1バイトも書かれない

`cli.ts` の `runConsolidationCostCommand()` は、**`runConsolidationCost()` が返った後**に
初めて人が読む表を印字し、`MNEMORA_CONSOLIDATION_JSON` を書き出す。

⟹ **投げれば、そのどちらにも到達しない。**round 0 から N-1 まで実際に測り終えた
store の件数・文字数・recall の予算段も、**全部消える。**CI の成果物は「ファイルが無い」に
なり、「何 round まで進んだか」すら残らない。

🔑 **⟹ 増分はここである: *文脈*（どの round で死んだか）と、*測れた分*。**

### 3. 【現物】どの round で死んだかは、診断を分ける

round 0 で死ぬのと round 3 で死ぬのは**別の診断**である。前者は無条件の失敗（接続不能・
権限・スキーマ）、後者は**量に依存する失敗**（統合で育った `content` が何かの上限を越えた等
——[ADR 0090](./0090-embedding-input-token-limit.md) が「単調増加は未測定」と書いた筋の
すぐ隣である）。

⟹ **測定プログラムにとってこれは本質的な情報であり、付け足しの親切ではない。**

### 4. 🔴 【現物】drizzle が pg のエラーを包むので、`.code` の直読みは `undefined` になる

`packages/postgres/src/__tests__/foreign-key-violation.postgres.test.ts:49-59` の `sqlStateOf`
は、深さ8まで `cause` を辿って**文字列の `.code`** を探す。同 :80 が `23503`
（`foreign_key_violation`）を実際に当てている。`packages/postgres/src/advisory-lock.ts:118`
が、このコードを「辿る例」として名指ししている。

⟹ **例外を `String(error)` に畳むと、いちばん知りたい SQLSTATE が消える。**

### 5. 【現物】この repo は「無い」を潰さない

`docs/recall.md` §4 が正典である。判定の基準はただ一つ、**「その区別があると、呼び出し側の
次の一手が変わるか」**。区別のための区別はしない。

⟹ 本件で次の一手が変わる区別は **4つ**在る（決定6）。

---

## 決定

### 決定1: 包む位置は **round のループの中**である

⛔ **関数全体を1つの `try` で囲まない。**そうすると「どの round で死んだか」が消え、
文脈2（量に依存する失敗かどうか）を区別できなくなる。

`try` は **round の本体まるごと**を囲む（群のループ・`drainEmbedTicks`・
`measureNewMemoriesEmbedding`・`measureStore`・`measureRecallForRound`）。**全部 store を
触る**ので、`consolidate()` 以外の段で落ちても同じ扱いにする。

⚠ `stoppedAfterRound = round` は `rounds.push(...)` の**後**に置く ⟹ **落ちた round は
「完走した round」に数えない。**

### 決定2: 🔴 打ち切っても、**表を印字し、JSON を書き出してから**終わる

**これがこの ADR の芯である。**文脈2のとおり、今日の欠落は「非0にならない」ことではなく
**「成果物が1バイトも書かれない」**ことである。

⟹ `runConsolidationCost()` は**投げ返さずに返る**。`cli.ts` は今までどおり
`formatConsolidationCostReport()` を印字し `MNEMORA_CONSOLIDATION_JSON` を書き出す。
**その後で**終了コードを立てる。

### 決定3: 非0で終わる。ただし**判断を純関数へ出す**

`exitCodeForConsolidationCostRun(json): 0 | 1` を `consolidation-json.ts` に置き、`cli.ts` は
それを呼ぶだけにする。

🔑 **理由は測定可能性である。**`process.exitCode` への副作用そのものは歯で直接当てにくい。
⟹ **判断を純関数に切り出すと、`cli.ts` が実際に使うのと同じ関数を歯で撃てる。**
⛔ 歯のために別の判断を書き写さない（「同じことを2箇所で決める」形を作らない）。

### 決定4: 🔴 `String(error)` に畳まない。`cause` の連鎖を辿る

`describeThrownError(error, round)` が、**深さ上限8**で `cause` を辿り、各段の `message` を
集め、**どこかの段の文字列 `.code`** を SQLSTATE として拾う。

⚠ **辿り方は `sqlStateOf`（文脈4）に倣った——同じ理由による。**`Error` でない値
（文字列・`null`・`undefined`）が投げられても落ちず、`causeChain` は**空配列にならない。**

### 決定5: 「途中で終わった」を**出力の型と、人が読む表の両方**に載せる

- 型: `stopReason: "aborted_on_error"` ＋ `abort` 欄
- 表: `stopReason=` の行の**直後**に、打ち切った round・`sqlState`・`cause` の連鎖を段ごとに印字

⚠ **`abort === null` のときは1行も足さない** ⟹ **完走したときの表は1文字も変わらない。**
⛔ **途中までの表が、完走した表と見分けが付かない形にしない。**

### 決定6: 🔴 「無い」を **4つ**に割る。⛔ そして**軸は2本のまま**にする

`docs/recall.md` §4 の基準（「その区別があると、呼び出し側の次の一手が変わるか」）に当てると、
次の一手が**4通り**ある:

| 状態 | 次の一手 | 乗せた軸 |
| --- | --- | --- |
| 完走した | 値を読む | `status: "measured"` ＋ `stopReason: "completed_all_rounds"` |
| 意図した停止（候補が2件未満） | 値を読む。**`haystackSize` を増やす**かを考える | `status: "measured"` ＋ `stopReason: "insufficient_candidates"` |
| 例外で打ち切った | **部分的な値を読み**、`sqlState` を見て store を直す | `status: "measured"` ＋ `stopReason: "aborted_on_error"` |
| そもそも測っていない | 値は1つも無い。**ネットワーク・HF repo を直す** | `status: "weights_unavailable"` |

🔴 **中の2つ（意図した停止／例外で打ち切り）を畳まないことが、この決定の要点である。**
どちらも「`MAX_ROUNDS` まで行かなかった」だが、**前者は成功、後者は失敗**であり、
終了コードが逆になる。畳むと `docs/recall.md` §4 が禁じていることそのものになる。

#### ⛔ 3つ目の軸を足していない

**軸は既に在る2本のまま**である:

- **`status`** = 「測ったか／そもそも測っていないか」
- **`stopReason`**（`measured` の中）= 「なぜ止まったか」

🔑 **`abort` は3つ目の軸ではない。**`abort` は **`stopReason === "aborted_on_error"` の
*積荷*** であり、**判別子ではない。**読み手が「どの状態か」を決めるために `abort` を
見ることは無い——`stopReason` が答えた**後で**詳細を読むだけである。
⟹ **読み手に3箇所を突き合わせさせない。**

---

## 検討して採らなかった案

### 1. 包まない（裸で投げさせる）——却下

「ベンチが大きな音を立てて落ちるのは望ましい」（ADR 0100 の言い分）は**半分正しい**。
今日すでに非0で終わり、`cause` も stderr に出る（文脈1）。
⛔ **しかし、測れた round 0..N-1 を捨てる。**

⚠ この repo は「**名乗れる以上の精度を主張する**」形を族として嫌ってきた
（ADR 0011/0025/0027/0028/0034/0042/0045/0047/0065）。
🔑 **測れた分を捨てるのは、その族の*裏返し*である——名乗れる分まで名乗らない。**
**測定プログラムにとっては、同じだけ悪い。**

### 2. `ConsolidationStopReason` を判別可能ユニオン（オブジェクト）にする——却下

`{ kind: "aborted_on_error"; round; causeChain; sqlState }` の形は `Omission`（`docs/recall.md`
§4）に最も似ており、`stopReason` と `abort` が相関する問題（下記「引き受ける負債」）も消える。

⛔ **却下の理由は `schemaVersion: 1` である。**`stopReason` を**トップレベルの文字列**として
要求している読み手が既に在る（`scripts/consolidation-cost-summary-lib.mjs` の
`REQUIRED_TOP_STRING_FIELDS`）。
⟹ **文字列 union に値を足すのは加算的だが、欄の*形*を変えるのは破壊的**であり、
`schemaVersion` を上げずに済ませられない。**この ADR は測り方を変えたいのであって、
成果物のスキーマを切りたいのではない。**

### 3. トップレベルの `status` に `"aborted"` を足す——却下

`status` は「**測ったか／測っていないか**」を割る軸である。
⛔ **打ち切った run も「測った」データを持っている**（round 0..N-1）。
`status` に混ぜると、`status: "measured"` を見て `rounds` を読んでいる既存の読み手が
**部分結果を丸ごと見落とす**（`Extract<..., { status: "measured" }>` から外れる）。
⟹ 「なぜ止まったか」は `stopReason` の軸の話である（決定6）。

### 4. `local-embedding-warmup.ts` の形（`detail: string` 1本）に倣う——却下

同じ repo の、例外を出力へ変換する唯一の先例である。⛔ **しかし前提が違う。**
あれは **warmup を全 round の*前*に済ませ、失敗したら1件も測らずに打ち切る**設計であり、
`cause` も**1段しか**辿らない。
⟹ **「部分結果を出す」という本件の目的と噛み合わない。**

### 5. 打ち切った round の、そこまでの群の結果も `rounds` に載せる——却下（今は）

round 2 の群を5つ中3つまで統合し終えて落ちた場合、その3つ分の `outcomes` は捨てている。
⛔ **却下——「完走した round」と「途中まで進んだ round」を同じ `rounds` の要素にすると、
表の行の意味が行ごとに変わる。**それは決定6 が避けたかったことそのものである。
⟹ **負債として引き受ける**（下記）。

---

## 引き受ける負債

- 🔴 **`stopReason` と `abort` が相関する。**`abort !== null` ⟺ `stopReason === "aborted_on_error"`
  という不変条件を、**型では強制していない**（却下案2 の理由で）。
  ⟹ **歯で固定した**が、`buildConsolidationCostRunJson` に矛盾した組を渡すことは今も書ける。
- **落ちた round の、そこまでの群の `outcomes` を捨てている**（却下案5）。
  ⟹ 「round 2 の5群中3群までは統合できていた」は成果物に残らない。
- ⚠ **`describeThrownError` の深さ上限 8 は `sqlStateOf` から写した値であり、
  この repo で 8 段を超える連鎖を*実測した*わけではない。**
- **`examples/chat/README.md` の `consolidation-cost` の節に、この停止理由を書き足していない。**

---

## 測ったこと

⚠ **【実測】はすべて、この器（DB 無し）で走らせたものである。**
🔴 **`DATABASE_URL` が無いため、本物の PostgreSQL に対しては1回も走らせていない**
——「確かめていないこと」を参照。

### 門【実測】

| 門 | 終了コード |
| --- | --- |
| `pnpm run typecheck` | **0** |
| `pnpm run lint` | **0** |
| `pnpm run format:check` | 最初 **1**（新しい歯が未整形）→ `pnpm run format` 後 **0** |
| `pnpm vitest run`（root＝`scripts/`）1回目 / 2回目 | **0 / 0**（どちらも 21 files / 425 tests） |
| `pnpm vitest run --exclude **/*.postgres.test.ts`（`examples/chat`）1回目 / 2回目 | **0 / 0**（どちらも 21 files / 202 tests） |

⚠ **2回走らせて `Test Files` / `Tests` が一致した**（器の飽和の指紋は出ていない）。
⚠ **全ログに `Errors N error(s)` の行は1件も無い。**

🔴 **⚠ root の `vitest.config.mts` は `include: ["scripts/**/*.test.mjs"]` であり、
この ADR が足した歯は1本も含まれない。**本件の歯は `examples/chat` の側にしか無い
——CI では `examples/chat`（本物の Postgres を持つジョブ）で走る。

### 歯の数【実測】

| | 基準線（`origin/main` = `f5f151c`） | 本 PR 後 | 差 |
| --- | --- | --- | --- |
| `examples/chat`（`*.postgres.test.ts` を除く） | 20 files / 190 | **21 / 202** | **+1 file / +12** |

⚠ **skip は1本も増えていない。**

### 変異試験（⚠ **手で撃った**）

⚠ **`.claude/skills/mutation-testing/` のハーネスはこの repo に存在しない**（`ls` で確認）。
⟹ **ハーネスではなく手で当てた。**各変異は 適用 → `tsc` → 対象の歯を実行 →
**退避コピーから `cp` で復元** → `diff` で一致確認、の順。⛔ `git checkout` に頼っていない。
**変異が当たっているあいだ commit も push もしていない。**

| # | 変異 | 予想（撃つ前に固定） | 実測 | 赤/総数 | 赤くなった歯 | 赤の出どころ |
| --- | --- | --- | --- | --- | --- | --- |
| M1 | `describeThrownError` を `String(error)` に畳む | 赤 | **赤** | 2/31 | `cause の連鎖を3段辿って…` ほか | `expected null to be 23503` |
| M2 | `sqlState` を常に `null` | 赤 | **赤** | 1/31 | `cause の連鎖を3段辿って…` | `expected null to be 23503` |
| M3 | `exitCodeForConsolidationCostRun` が常に 0 | 赤 | **赤** | 2/31 | `aborted_on_error は 1` / `weights_unavailable は 1` | `expected +0 to be 1` |
| M4 | formatter の abort ブロックを無効化 | 赤 | **赤** | 2/31 | `round 3 で打ち切った場合…` ほか | `to contain outer-format-test-message-7q2z` |
| **MX-1** | **round の `try` を関数全体を囲む位置へ動かす** | 赤（e2e の歯だけ、1/32） | **赤（予想どおり）** | **1/32** | `round 2 で例外を投げても、round 0・1 の結果を捨てず…` | 🔴 `expected -1 to be 2`（**どの round で死んだかが消える**） |
| **MX-2** | **catch の `break` を `continue` に** | 赤（e2e の歯だけ、1/32） | **赤（予想どおり）** | **1/32** | 同上 | 🔴 `expected [ +0, 1, 3 ] to deeply equal [ +0, 1 ]` |
| **M-control-1**（⭐ 赤くなってはいけない） | formatter の打ち切りメッセージの**文言のみ**を書き換え | 緑のまま | **✅ 緑のまま** | 0/31 | — | — |
| **M-control-2**（⭐ 赤くなってはいけない） | `cli.ts` の**別のサブコマンド**（`time-term` / `identifier-probes`）の入口を壊す | 本件の歯は緑のまま | **✅ 緑のまま**（`tsc` も 0） | 0/31 | — | — |
| **MX-3**（⭐ 赤くなってはいけない） | catch の中を中間変数へ分割（ふるまい不変） | 緑のまま | **✅ 緑のまま**（`tsc` も 0） | 0/32 | — | — |

**各行について:**
- ⭐ **対照3本はすべて緑のまま**だった ⟹ 歯が「ふるまい」ではなく「書き方・文言」に
  反応しているのではないことの確認。**特に M-control-2 は `tsc` が 0 で通っており**、
  変異が実在してコンパイルもされた上で**本件の歯が1本も巻き込まれなかった**
  ——⟹ **この PR の歯は他のサブコマンドを測っていない。**
- 🔴 **MX-1 / MX-2 は e2e の歯を足すまで1本も殺せなかった**（純関数の歯11本は
  round のループの**構造**を見ていない）。⟹ **e2e の歯は「あれば良い」ものではなく、
  決定1（`try` の位置）を支える唯一の歯である。**
- ⚠ **予想は3本とも当たった**（MX-1 / MX-2 / MX-3）。外れは無かった。

---

## 確かめていないこと

- 🔴 **本物の PostgreSQL に対して、`consolidate()` が実際に投げたときの挙動を実測していない。**
  この器に DB が無い。⟹ **`sqlState` が現実の接続断・FK 違反で実際に拾えるか**は、
  `sqlStateOf`（文脈4）が同じ辿り方で `23503` を当てている**現物からの類推**であって、
  この経路での**実測ではない。**
- **8段を超える `cause` の連鎖が現実に起きるか。**
- ⚠ **`scripts/consolidation-cost-summary-lib.mjs` に本物の成果物を食わせていない。**
  【現物】検証器を読んだ限り**必須欄の allow-list** であり、**未知の欄を拒まない**
  （`abort` を足しても落ちない）。`stopReason` も「空でない文字列」しか見ていないので
  `"aborted_on_error"` は通る。⟹ **読んで確かめたが、走らせて確かめてはいない。**

---

## これが覆るとしたら

- **`consolidate()` が投げるのをやめたら**（ADR 0100 決定8 が覆ったら）、決定1〜5 の前提が消える。
  ⚠ ただし決定6（「無い」を4つに割る）は、`insufficient_candidates` と
  `completed_all_rounds` の区別として**残る。**
- **このベンチが CI の門になったら**（[ADR 0088](./0088-retrieval-quality-measured-in-ci.md) §2.1 と
  [ADR 0101](./0101-how-to-measure-whether-consolidate-moved-the-north-star.md) 決定6 は
  「⛔ 門にしない」と決めている）、決定3 の終了コードの意味が変わる
  ——今は「人が見るための信号」であって、何かを止める門ではない。
- **打ち切った round の部分的な `outcomes` を読みたくなったら**、却下案5 を取り直すことになる。
