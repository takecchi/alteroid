# ADR 0081: 順位を決めているのは `similarity` ただ1項である — 項ごとの「何通りか」を数え、`(a)` を2つに割った実測

- **状態**: 採用 (2026-09)
- **日付**: 2026-09-09

**⚠ 各主張の出所を分ける**（[ADR 0033](./0033-what-decided-the-rank-in-the-retrieval-bench.md) /
[ADR 0055](./0055-extraction-prompt-subject-and-inference-not-added.md) の体裁を踏む）。

- **【実測】** — この ADR の作業体が実際に走らせて測った。
  **⚠ 実行したのは委譲先の作業者であり、書き手は生の出力ファイル（`out-retrieval.txt` /
  `out-retrieval-final.txt`）と打たれたコマンドを受け取っている。**書き手自身の手で再実行はしていない。
- **【現物】** — この repo のコード・文書を読んで確かめた。
- **【受】** — 報告として受け取り、再導出していない。

---

## 文脈

[ADR 0033](./0033-what-decided-the-rank-in-the-retrieval-bench.md)（2026-09-06）は
`retrieval` ベンチの `termSpreads` を足し、**「スコアが主語と時制を*見ていない*のではなく、
スコアに*見る場所が無い*」**と結論した。その根拠は **項ごとの値の「幅」（`max - min`）** である。

**⚠ 幅は「何通りの値を取ったか」を答えない。**幅が小さいことと、
**その項が候補間で1通りしか値を取らないこと**は別の主張である。
前者は「重みが小さい」と読めるが、後者は **「重みをいくら触っても何も起きない」** を意味する。

**⟹ この違いは、次にやる仕事をまったく変える。**
「重みが悪い」なら重みを調整すれば直るが、「項が動いていない」なら重みを触っても何も起きない。

その後 #95〜#100 の6本がマージされたため、**ADR 0033 の観測が今も真かも分からなくなっていた。**

**この ADR は、HEAD `01d352d`（#100 マージ後の main）でそれを測り直し、
「幅」を「何通りか」に置き換えた記録である。⟹ 実装は含まない。**

---

## 決めたこと

**測定結果を記録する。実装は含まない。**この ADR で**変えたファイルはこの文書1つだけ**である。

1. **`retrieval` ベンチの `recall()` において、順位を決めている項は `similarity` ただ1つである**
   （§1）。**⟹ スコアの重みを調整する道は、好みではなく構造として閉じている。**
2. **`hit@1` を落とす3件を `(a)` / `(b)` / `(c)` に割る際、`(a)` は2つに分かれる**（§4）。
   **`(a-1)`（重みを回せば直る）は 0件、`(a-2)`（スコアに入れる値が無い）が1件である。**
3. **[ADR 0033](./0033-what-decided-the-rank-in-the-retrieval-bench.md) §4 の
   「`observe()` に `occurredAt` を渡している箇所は repo 内 0件」を訂正する**（§5）。
   **⟹ その記述はもう真ではない。**

### ⚠ 決めていないこと

- **`hit@1` を上げる方法を決めていない。**この ADR は測っただけである。
- **§6.2 で挙げた欠陥（ベンチの印字が `decay`/`freshness` の差を隠す）を直していない。**
  **意図的に残している**——直すのはこの ADR の範囲ではない。

---

## 測った条件

**【実測】**

```
cd <repo>
DATABASE_URL=postgresql://postgres:postgres@127.0.0.1:55432/mnemora \
  env -u OPENAI_API_KEY MNEMORA_PROVIDER_SOURCE=recorded \
  pnpm --filter @mnemora/example-chat run retrieval 2>&1 | tee <out-file>
echo "EXIT=${PIPESTATUS[0]}"        # 4回とも EXIT=0
```

| 何 | 値 |
|---|---|
| HEAD | `01d352d`（#100 マージ後の main） |
| DB | **本物の PostgreSQL 16 + pgvector 0.8.6**（HNSW 索引）。マイグレーションは `0007` まで適用 |
| provider | **`recorded`**（記録した実 API 応答の再生。[ADR 0051](./0051-recorded-provider-cassette.md)） |
| カセット | `examples/chat/cassettes/retrieval.json`（`recordedAt: 2026-09-06T21:35:13.480Z`） |
| 実 API 呼び出し | **0回。**3 arm すべてで「この run では OpenAI の API を一切叩いていない」と出力に印字された |
| 実行回数 | **4回**（順位は run 間で一切動かず、完全に再現した） |

**⚠ 本物の API は1回も叩いていない。**擬似 provider でもない。
**記録した実 API 応答の再生**である（[ADR 0022](./0022-fake-provider-compare-does-not-claim-recall-quality.md)
が禁じた「擬似で測った順位を実力として報告する」には当たらない）。

**⚠ この器には `OPENAI_API_KEY` が環境変数として存在する。**
既定（`decideProviderSource`）は「キーが在れば実 API」なので、
**`env -u OPENAI_API_KEY` と `MNEMORA_PROVIDER_SOURCE=recorded`（[ADR 0068](./0068-the-bench-must-not-lie-about-what-it-measured.md)
で足した明示指定）を二重に掛けて起こしている。**片方だけでは実 API に倒れうる。

**変えなかったもの**: スコアの重み・閾値・`limit`・`overFetchFactor`・probe set・抽出プロンプト。
**足したのは記録と印字だけである**（§6.1）。

---

## 1. 実測: 順位を決めているのは `similarity` ただ1項

**【実測】**§6.1 で足した計装により、`SCORE_TERMS` の各項について
**候補集合に対する distinct な値の個数**を `new Set(values).size` で数えた。
**浮動小数の比較は厳密比較（`===`）である。**

**arm C（本物LLM + 本物埋め込みの記録再生）、候補10件。7 probe すべてで同じ構造:**

| 項 | **何通り** | 実際に取った値の範囲 |
|---|---|---|
| `similarity` | **10通り**（候補全件が異なる） | probe ごとに異なる。例: color 0.2446〜0.6744、diet 0.1829〜0.3183 |
| `decay` | 10通り | **常に 0.99999991…〜0.99999996…**（1.0 からの差が **1e-8 桁**） |
| `tagMatch` | **1通り** | **厳密に 1** |
| `freshness` | 10通り | **`decay` と行ごとに厳密等価**（§2） |
| `strength` | **1通り** | **厳密に 1** |

**arm B（擬似LLM + 本物埋め込みの記録再生）も同型である。**

**⟹ `tagMatch` と `strength` は、候補集合の上で1通りしか値を取らない。**
**⟹ この2項は順位に構造上ゼロ寄与している。定数を掛けているのと同じである。**
**⟹ この2項の重みをいくら触っても、順位は1つも動かない。**

**⟹ `decay` は形式上10通りだが、その10通りが収まる変域は 1e-8 桁である。**
`similarity` の変域（0.1〜0.5幅）より **7桁以上小さい。**

**⟹ `total = similarity × decay × tagMatch × freshness × strength` の順位を決めているのは、
`similarity` ただ1項である。**

### 1.1 なぜ「幅」ではなく「何通りか」を数えたか

**ADR 0033 は `termSpreads`（`max - min`）を出しており、`tagMatch` と `strength` の幅が
厳密に 0 であることを記録していた。**【現物】

**⚠ 幅 0 と「1通り」は、この文脈では同じ結論に着くが、同じ主張ではない。**
幅は「両端がどれだけ離れているか」だけを言い、**中間に何個の値が在るかを言わない。**
`decay` はその違いが出た項である——**幅は 1e-5 と書かれていたが、通り数は 10 である。**
**⟹ 「幅が小さい項」と「値が1つしかない項」を、幅だけでは区別できない。**

**⟹ 「重みが悪いのか、項が動いていないのか」という問いに答えるには、通り数が要る。**

---

## 2. 実測: `freshness` は `decay` の行ごと厳密な複製である

**【実測】**§6.1 で足した `checkDecayFreshnessRowwiseEqual()` により、
**同じ候補行の `decay` と `freshness` を1件ずつ厳密比較（`===`）した。**

**10件 × 7 probe × 3 arm（A・B・C）で、`decay !== freshness` は 0件だった。**

**⚠ ADR 0033 はこれを間接証拠で書いていた**——「`decay` と `freshness` の幅が
7 probe すべてで互いに同一の値である」【現物】。**幅が一致することは、行ごとに一致することを含意しない。**

**⟹ この ADR は、それを直接証拠に格上げする。**

なぜそうなるか【現物】: `freshness` の起点は `occurredAt ?? recordedAt`、
`decay` の起点は `lastReinforcedAt ?? recordedAt` である
（`packages/core/src/strategies/scoring.ts` の `defaultScoringStrategy`）。
このベンチでは `occurredAt` も `lastReinforcedAt` も全件 `null` なので、
**両方とも `recordedAt` 起点の同じ数になる。**

**⟹ `freshness` は独立した項として存在していない。`total` は実質 `similarity × decay²` である。**

### 2.1 `freshness` の丸めは現 HEAD に実在する

**【現物】**`packages/core/src/strategies/scoring.ts` の `defaultScoringStrategy` は、
`freshness` を **`Math.min(MAX_FRESHNESS, defaultDecayStrategy.strengthAt(...))`** の形で計算している。
**⟹ [ADR 0036](./0036-clamp-freshness-at-one.md)（`freshness` を 1 で頭打ちにする）は、
現 HEAD に入っている。**

**⚠ 行番号を出典にしていない。**行番号は動くので、**式の形で書いてある。**

**【実測】**この丸めには歯が在る（`packages/core/src/__tests__/scoring.test.ts` の
「`freshness` は 1 で頭打ちにする（ADR 0036）」ブロック）。
`pnpm exec vitest run src/__tests__/scoring.test.ts` は **16件すべて緑（EXIT=0）**であり、
**`Math.min(MAX_FRESHNESS, …)` を剥がす変異を入れると 3件が赤くなる（EXIT=1）**
（`expected 2 to be 1` / `expected 1.0000000002674179 to be 1` / `expected 4597.60454987519 to be 1`）。
**⟹ この歯は固有に噛む。**変異は確認後に戻してある。

---

## 3. 実測: arm ごとの数字と、ADR 0033 との不一致

**【実測】**

| arm | LLM | 埋め込み | MRR(全体) | MRR(lexicalControl) | MRR(非語彙) | `hit@1` | `hit@10` |
|---|---|---|---|---|---|---|---|
| A | 擬似 | 擬似 | 0.018 | 0.000 | 0.021 | 0/7 | 1/7 |
| B | 擬似 | 記録 | 0.714 | 1.000 | 0.667 | 4/7 | 6/7 |
| **C** | **記録** | **記録** | **0.738** | **1.000** | **0.694** | **4/7** | **7/7** |

**probe ごとの `goldRank`（arm C）**: color=1, pet=1, exercise=**2**, diet=**6**,
family=1, language=1, travel=**2**。**4回の run で完全に再現した。**

### 3.1 ⚠ ADR 0033 §5.1 の arm C（MRR 0.750）とは一致しない

**【現物】**ADR 0033 §5.1 は arm C を **0.750**（`diet` の `goldRank` = 4）と記録している。
**【実測】**本測定は **0.738**（`diet` の `goldRank` = **6**）である。

**⚠ 0.738 は [ADR 0055](./0055-extraction-prompt-subject-and-inference-not-added.md) の
baseline 6 run の MRR 平均（0.739）とほぼ一致し、そちらは #95〜#100 の*前*に取られている。**【現物】

**⟹ #95〜#100 で順位が動いた、と読むべき証拠は無い。**
**【現物】**#95〜#100 の6コミットは `packages/core/src/strategies/scoring.ts` /
`packages/core/src/recall-runtime.ts` の段2（スコア計算）/ `packages/core/src/extraction.ts` /
`examples/chat/src/probe-set.ts` を**1つも触っていない**
（`scoring.ts` の最終更新は #88、`probe-set.ts` は **#15**）。

**⚠ `diet` の `goldRank` が 4 → 6 に動いた原因は、切り分けていない。**
ADR 0033 §2.3 は `diet` の `goldRank` が実行ごとに 5 / 9 / 7 / 4 と揺れることを記録しており、
ADR 0055 は別の18 run で baseline でも 3〜9 に散ることを再確認している【現物】。
**⟹ 今回の 6 もその揺れの延長と読むのが自然だが、そう読んでいるだけで確かめていない。**

### 3.2 ⚠ arm を取り違えないこと

**0.714 は arm B（擬似LLM + 本物埋め込み）の値であり、arm C ではない。**
この測定を依頼した側の記憶では、**0.714 が arm C の値として保持されていた。**【受】
**⟹ MRR を記録するときは、必ず arm を添えること。**

---

## 4. 実測: 失敗3件の割り直し — `(a-1)` は 0件、`(a-2)` が1件

`hit@1` を落とす3件を、次の3つに割った:

- **(a) スコアの問題** — 正解が候補に在るのに、順位が下
- **(b) 抽出の問題** — そもそも正解にあたる Memory が作られていない／中身が違う
- **(c) 索引の問題** — Memory は在るのに、埋め込みが無い／候補に入ってこない

### 4.1 `(c)` は 0件

**【実測】**測定が残した arm C のテナント（`retrieval-quality-arm-c-mtuf4qmi-1`）を SQL で数えた:

| 何を数えたか | 値 |
|---|---|
| `memories` 総件数 | **75** |
| `occurred_at IS NOT NULL` | **0** |
| `cardinality(tags) > 0` | 9 |
| `provenance->>'kind' = 'inferred'` | **0** |
| `subject_id IS NOT NULL` | **0** |
| **`strength <> 1`** | **0** |
| **埋め込みが存在しない Memory** | **0**（`memory_embeddings_openai_text_embedding_3_small_256` と left join） |
| `outbox` の `extract` | 74件、pending 0 / failed 0 |
| `outbox` の `embed` | 75件、pending 0 / failed 0 |

**⟹ 75件すべてに埋め込みが1対1で存在し、[ADR 0079](./0079-requeue-embed-jobs.md) が開けた
積み直しの待ち行列にも滞留・失敗が無い。⟹ `(c)` は 0件である。**
`hit@10 = 7/7` という順位側の観測とも整合する。

**⚠ `strength <> 1` が 0件であることに注意。**
[ADR 0078](./0078-strength-value-range.md)（#98）は `strength` の値域を `(0, 1]` に締めたが、
**値を動かす口は開けていない**（PR 本文がそう明記している）【現物】。
`buildNewMemoryFromCandidate`（`packages/core/src/extraction.ts`）は今も無条件に `strength: 1` を書く【現物】。
**⟹ §1 の「`strength` は1通り」は、この設計の帰結である。**

### 4.2 `(a)` は2つに分かれる

**§1 で「順位を決めているのは `similarity` ただ1項」と測れたので、`(a)` は割れる:**

| | 定義 | 件数 |
|---|---|---|
| **(a-1)** | 正解が候補に在り、**重みや閾値を回せば順位が直る** | **0件** |
| **(a-2)** | 正解が候補に在り順位が下だが、**スコアに入れる値が無い**（動く項が `similarity` しかない） | **1件**（travel） |

**⟹ `(a-1)` が 0件であることは、好みの問題ではなく §1 の構造から出ている。**
`tagMatch` と `strength` は1通りしか取らず、`freshness` は `decay` の複製であり、
`decay` の変域は 1e-8 桁である。**⟹ 逆転幅（exercise 0.022 / diet 0.133 / travel 0.043）を、
`similarity` 以外のどの項も動かせない。**

**⟹ 「重みを調整する」という選択肢は、この測定によって閉じている。**

### 4.3 3件の内訳

**【実測】**（反実仮想の cos は、実 API の `embeddings.create` を **3回**・
`chat.completions.create` を **0回**叩いて測った。231 tokens、概算 **$0.000005**。
モデルは `text-embedding-3-small` / 256次元でベンチと同一。使い捨てスクリプトで測っており、
**ベンチ本体は `recorded` のまま**である。）

| probe | gold の実 `content` | 分類 | 実測の根拠 | スコアの項を足せば直るか |
|---|---|---|---|---|
| **exercise** | `毎朝5時に起きてジョギングをしている。`（主語なし） | **(b)** | cos: gold 0.4498 < distractor 0.4718。**主語を補った文にすると 0.5083 で逆転** | **いいえ** |
| **diet** | `牛乳を飲むとお腹を壊します。`（症状のみ） | **(b)** | cos: gold 0.1854 < distractor 0.3183。主語を補っても 0.2453 で**届かない**。帰結の推論文（`牛乳は避けたほうがよい`）なら **0.5947** | **いいえ** |
| **travel** | `来月、京都へ出張する。`（**content は正しい**） | **(a-2)** | cos: gold 0.3792 < distractor 0.4213。**質問を現在形にすると gold 0.3974 > distractor 0.3871 で反転** | **いいえ**（§5。入れる値が無い） |

**⟹ `travel` を `(b)` に入れないこと。**gold の `content` は原発話どおりに作られており、
**抽出は失敗していない。**分けているのは質問側の表層の時制である。

**⚠ この反実仮想の cos は、ベンチのログの `similarity` と小数第3〜4位まで一致した。**
**⟹ 測定器の校正になっている**——同じ `content`・同じモデル・同じ次元を測っていることの裏取りである。

**⚠ この節の反実仮想の解釈は、`hit@1` を上げる根拠にはならない。**
[ADR 0055](./0055-extraction-prompt-subject-and-inference-not-added.md) が実 API 18 run で測ったとおり、
**「主語を補った文のほうが cos が高い」ことと「抽出プロンプトに主語を補わせれば `hit@1` が上がる」ことは別である**（§6）。

---

## 5. 訂正: `occurredAt` は「原理的に常に null」ではない

**【現物】**[ADR 0033](./0033-what-decided-the-rank-in-the-retrieval-bench.md) §4 は
**「リポジトリ内で `observe()` に `occurredAt` を渡している箇所は 0件」**と書いている。

**⟹ その記述は、現 HEAD `01d352d` では真ではない。**渡している箇所は **11箇所**在る:

| ファイル | 箇所 | 性質 |
|---|---|---|
| `packages/core/src/__tests__/observe-occurred-at.test.ts` | 8 | `observe()` → `Memory.occurredAt` → `recall()` の境界検査 |
| `examples/chat/src/backfill.ts` | 2 | [ADR 0037](./0037-callers-pass-occurred-at.md) のデモ（`withCtx` 側のみ） |
| `examples/chat/src/time-term-arm.ts` | 1 | [ADR 0058](./0058-measure-the-time-term-in-a-separate-arm.md) の時間項 arm |

いずれも [ADR 0037](./0037-callers-pass-occurred-at.md)（#39、2026-09-06）由来であり、
**ADR 0033 より後に経路が開いた。**

**⚠ ただし `retrieval` ベンチは、その口を通していない。**
**【実測】**§4.1 のとおり、arm C の 75件すべてで `occurred_at IS NULL` である。

**⟹ 「原理的に不可能」ではなく、「このベンチが通していないだけ」である。**
**⟹ ADR 0033 §4 の欠陥は、格下げされたが解消されていない。**

---

## 6. [ADR 0055](./0055-extraction-prompt-subject-and-inference-not-added.md) との関係

**⭐ この節は、次に来る人が2つの ADR を両方とも再発見せずに済むために在る。**

**ADR 0055 は「抽出プロンプトを変えて値を作る経路」を実 API 18 run で測り、
`hit@1` とは別の理由（`stated`/`inferred` の区別を汚す・記憶の件数を膨らませる・
効果が run ごとの揺れである）で閉じた。**【現物】

**ADR 0081（本文書）は「スコアの側に何が起きているか」を測り、
`similarity` 以外の項が順位に寄与していないことを示した。**

**⟹ 2つを合わせると、`hit@1` が 4/7 である原因はこう絞られる:**

> **スコアに入れる値が無く（本 ADR §1・§4.2）、かつ抽出プロンプトで値を作るのは代償が大きすぎる（ADR 0055）。**

**⚠ 本 ADR §4.3 の反実仮想を、ADR 0055 の結論を覆す証拠として読まないこと。**
§4.3 は**人が手で書いた理想の文**の cos であり、**LLM に実際に書かせた結果ではない。**
ADR 0055 §理由3 は、主語復元系の9 run で `exercise` の `goldRank` が
**「LLM が distractor 側にも一人称を付けたかどうか」と 9/9 で一致した**ことを測っている【現物】。
**⟹ 1回の反実仮想は、18 run の分布を覆さない。**

### 6.1 問1〜問4 を測るために足したもの（この ADR には含まれていない）

**【実測】**`termSpreads` は**幅**を出すが**通り数**を出さないため、
`examples/chat/src/retrieval-quality.ts` に**一時的に**次を足して測った
（単一ファイル、66行追加・2行削除）:

1. `TermSpread.distinctCount`（`new Set(values).size`。既存の min/max/spread の計算は不変）
2. `checkDecayFreshnessRowwiseEqual()`（`decay`/`freshness` の行ごと厳密等価チェック）
3. `ProbeOutcome.decayFreshnessRowwise`
4. `formatTermDistinctCounts()`
5. `formatArmDetail` に2行の出力

**足したのは記録と印字だけである**（重み・閾値・`limit`・`overFetchFactor`・プロンプトに触れていない。
ADR 0033 決定2 と同じ線）。

**⚠ この計装は捨てた。この ADR には含まれていない。**
**⟹ 再現するには、上の5つを足し直す必要が在る。**それがこの節の存在理由である。

### 6.2 ⚠ ベンチの既存の印字は、この測定を隠す

**【実測】**計装の途中で、既存の `formatScoreValue` を流用したところ、
**`decay` と `freshness` の 1e-8 桁の差が丸めで消え、
「`distinctCount=10` なのに `min=max=1.000000`」という自己矛盾した表示になった。**
生精度の文字列化に直して測り直した。

**【現物】**`formatScoreValue`（`examples/chat/src/retrieval-quality.ts`）は、
**絶対値が `1e-4` 未満なら指数表記（`toExponential(3)`）、それ以外は `toFixed(6)`** である。
**⟹ `termSpreads` の `spread`（1e-5〜1e-8 桁）は指数表記になるので消えない。**
**⚠ 消えるのは `scoreDetails` が印字する `decay` / `freshness` の値そのものである**——
`0.99999991…` も `0.99999996…` も、どちらも `1.000000` と表示される。

**⟹ いまのベンチの印字を見ても、`decay`/`freshness` が候補間で動いているかは判定できない。**

**🔴 この ADR はこれを直していない。意図的に残している。**
**⟹ 直すのは別の変更である。**（[ADR 0068](./0068-the-bench-must-not-lie-about-what-it-measured.md)
が引いた「ベンチは測っていないことを測ったかのように印字しない」の族に入るが、
本 ADR は測定の記録であり、ベンチの修正を含まない。）

---

## 7. 検討した代替案

- **スコアの重みを調整して3件を通す。** **採らない。**§1 と §4.2 のとおり、
  **動く項が `similarity` しかないので、重みを触っても順位は1つも動かない。**
  これは好みではなく構造である。
  （[ADR 0022](./0022-fake-provider-compare-does-not-claim-recall-quality.md) と
  ADR 0033 §7 は同じ案を「測る条件を選び直すことになる」として却下しているが、
  **本 ADR はそれ以前に、機構として効かないことを測った。**）
- **抽出プロンプトに主語を復元させる。** **採らない。**
  [ADR 0055](./0055-extraction-prompt-subject-and-inference-not-added.md) が実 API 18 run で測って
  却下済みである（§6）。
- **推論（`inferred`）記憶を作る。** **この ADR では採らない。**
  §4.3 のとおり `diet` の cos は 0.1854 → 0.5947 と動くが、ADR 0055 は記憶件数が
  **+72〜84%** に膨らむことを測っており【現物】、**北極星の物差し（積む量を減らせたか）に逆行する。**
  ADR 0033 §6 が挙げた先行条件（`RecalledMemory` が `provenance` を持つこと）は
  [ADR 0035](./0035-recalled-memory-provenance-kind.md) で満たされているが、
  **量の問題は解消していない。**
- **`retrieval` ベンチに `occurredAt` を通す。** **この ADR では採らない。**
  **⚠ そして、この道は既に明文で却下されている**——
  [ADR 0058](./0058-measure-the-time-term-in-a-separate-arm.md)（採用、2026-09-08）が
  **「`examples/chat/src/probe-set.ts` に `occurredAt` を手で書き込まない。
  既存の gold/distractor 14件は1文字も変えない」**と決め、
  **代わりに別 arm（`examples/chat/src/time-term-*.ts`）で測ることにしている。**【現物】
  [ADR 0037](./0037-callers-pass-occurred-at.md) の「採らなかった案」にも
  「`probe-set` の会話に時刻を付ける。却下。測定条件そのものを変えることになり、
  前後が比較できなくなる」が在る。【現物】
  **⟹ `Probe` / `ProbeUtterance`（`examples/chat/src/probe-set.ts`）には `Date` を持つ欄が無く、
  通すには欄を足す必要が在る。⟹ それは `probe-set.ts` の変更に当たる。**【現物】
  **⚠ haystack には時間文脈の*語*が在る**（`HAYSTACK_TIME_CONTEXT`。`buildHaystackUtterance` が
  「時間文脈 × 対象 × 述語」の直積で干し草文を組み立てる）**が、それは文字列であって
  `occurredAt` に渡せる値ではない。**「先週」から日付を導出する経路はどこにも無い。【現物】
  **⟹ 「触らずに通す」道は存在しない。この緊張は未解決ではなく、既に決着している。**

---

## 8. 引き受けた負債・覆えていない範囲

- **§6.2 の欠陥（ベンチの印字が `decay`/`freshness` の差を隠す）を直していない。**
- **§5 の欠陥（`retrieval` ベンチが `occurredAt` を通していない）を直していない。**
  §7 のとおり、通す道は ADR 0058 が閉じている。
- **§3.1 の `diet` の `goldRank` が 4 → 6 に動いた原因を切り分けていない。**
  実行間の揺れと読んでいるが、**そう読んでいるだけである。**
  切り分けるには抽出を実 API で回す必要が在り、この測定ではそれを叩いていない。
- **§1 の distinct 個数は arm B・C について測った。arm A（擬似埋め込み）については
  §2 の行ごと等価だけを確認しており、通り数の表は arm C を代表として載せている。**
- **§4.3 の反実仮想は n=1 である。**ADR 0055 が「1 run の差を効いたと読めない」と警告した
  状況に、そのまま当たる。**⟹ この節の数字を改善の根拠に使わないこと**（§6）。
- **測定に使った生の出力（`out-retrieval.txt` / `out-retrieval-final.txt`）は repo に入れていない。**
  作業器の中に置いたものであり、器が入れ替われば消える。
  **⟹ だから「測った条件」節と §6.1 に手順を書いた。そこが唯一の保全である**
  （ADR 0055 の負債節と同じ形）。

---

## 9. これが覆るとしたら

- **`recall()` に `tags` や `subjectId` を渡す呼び出し側が現れたとき。**
  §1 の「`tagMatch` が1通り」は、**このベンチの呼び方**（`recall(ctx, {text})` だけ）に対する観測であり、
  スコアリング戦略そのものの性質ではない（ADR 0033 §9 と同じ向き）。
- **抽出が `strength` に 1 以外を書くようになったとき。**
  §1 の「`strength` が1通り」は `buildNewMemoryFromCandidate` の無条件 `strength: 1` に依存している。
- **`observe({kind:'memory_usage'})` を呼ぶ arm が足されたとき。**
  強化が起きれば `lastReinforcedAt` が埋まり、**`decay` と `freshness` の起点が分かれる**
  （§2 の「行ごと厳密等価」はそこで崩れる）。
- **取り込みが長時間に分散したとき。**
  §1 の「`decay` の変域が 1e-8 桁」は、取り込み全体が数分で終わることに依存している。
  半減期の既定は 720時間である。
- **埋め込みモデルを替えたとき。** §4.3 の cos はすべて
  `text-embedding-3-small`(256次元) に固有である（ADR 0033 §9 / ADR 0055 と同じ）。
- **カセットを録り直したとき。** §3 の数字は
  `retrieval.json`（`recordedAt: 2026-09-06T21:35:13.480Z`）の再生である。
  **抽出プロンプトを1文字でも変えると鍵が変わり、このカセットは無効になる。**【現物】
