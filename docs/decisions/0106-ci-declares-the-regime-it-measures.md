# ADR 0106: CI が自分の測っている regime を宣言する — 6本のうち測るのは1本、宣言は6本すべて

- **状態**: 採用 (2026-09)
- **日付**: 2026-09-12

**⚠ 各主張の出所を分ける**([ADR 0102](./0102-bench-keeps-partial-measurements-on-abort.md) /
[ADR 0103](./0103-negative-tooth-declares-its-precondition.md) の体裁を踏む)。

- **【現物】** — この repo のコード・文書を書き手が読んで確かめた。
- **【実測】** — main の CI run が実際に吐いた成果物を書き手が読んで確かめた。
- **【受】** — 報告として受け取り、再導出していない。

---

## 問い

[Issue #148](https://github.com/takecchi/mnemora/issues/148) ②。ADR 0103 は
「CI は encoding もロケールも宣言していない」ことを現物として指摘し(文脈7)、
「`POSTGRES_INITDB_ARGS` で encoding をピン留めする」案を**この PR ではやらない**として
明示的に見送った(採らなかった案3)——「6ジョブすべてに触るので、別の PR にする」。

Issue #148 の①(可視化)は [PR #149](https://github.com/takecchi/mnemora/pull/149) で
着地済みである。**この ADR は②——見送っていたピン留めそのものを行う。**

## 文脈

### 1. 【現物】6本の pgvector ジョブが、regime を一切宣言していない

`.github/workflows/ci.yml` で `image: pgvector/pgvector:pg17` を services に持つジョブは
6本(`postgres` / `example-chat` / `root-gate-db-stage` / `retrieval-quality` /
`identifier-probes` / `consolidation-cost`)。6本すべての services の `env:` は
`POSTGRES_USER` / `POSTGRES_PASSWORD` / `POSTGRES_DB` の3行でバイト単位に同一であり、
`POSTGRES_INITDB_ARGS` / `LANG` / `LC_ALL` / `LC_COLLATE` はいずれも0件だった。
**⟹ CI の緑は、pgvector イメージの `initdb` 既定に依存している。repo 側は何も
主張していなかった。** イメージの更新でこの既定が変われば、regime は**誰も気づかないまま**
反転しうる。

### 2. 【実測】main の CI が実際に測っている値

PR #149 が足した可視化(`lexical-regime-summary.mjs` / `MNEMORA_LEXICAL_REGIME_JSON`)が、
main の run [`34635954755`](https://github.com/takecchi/mnemora/actions/runs/34635954755) の
`postgres` ジョブで実際に吐いた artifact `lexical-regime` を読んだ:

| 項目 | 値 |
|---|---|
| server_encoding | **UTF8** |
| server_version | 17.11 (Debian 17.11-1.pgdg12+2) |
| nonAsciiIsIndexed | true |
| regime | non_ascii_indexed |

**⟹ Issue #148 が求めた順序(「B をやるなら、先に『いまの実際の値』を A で可視化してから、
それと同じ値を明示すること」)は満たされている。**この ADR が宣言する `UTF8` は、
可視化が実際に吐いた値をそのまま書き写したものであり、推測ではない。

**⚠ ただし、これを直接測ったのは `postgres` ジョブ1本だけである。**他5本の
service も同じ `pgvector/pgvector:pg17` イメージ・同じ3行の `env:` を使っているため
「同じ regime のはず」という推論はできるが、**5本については実測していない。**
この ADR は、その5本を実測する代わりに、**6本の宣言が同一であることを歯で固定する**
という設計で代用する(決定4)——「実測していないが、宣言がずれたら機械的に気づける」形。

## 決定

### 決定1: 🔴 6本すべてに `POSTGRES_INITDB_ARGS: "--encoding=UTF8"` を宣言する

ADR 0103 が見送った案3をここで実行する。値は上の実測(文脈2)そのものであり、
6本の services の `env:` へ同じ3行のコメント付きで追記する。

### 決定2: 🔴 ロケールは**測っただけで宣言しない**(順序を逆にしない)

`packages/postgres/src/__tests__/lexical-store-identifier.test.ts` の理由の歯へ
`lc_collate` / `lc_ctype` / `default_text_search_config` の実測を足し
(`LexicalRegimeJson` を `schemaVersion: 2` にした)、`scripts/lexical-regime-summary-lib.mjs`
の `validateMeasured` / `buildSummaryMarkdown` もこの3項目を扱うようにしたが、
**ci.yml にはロケールの宣言を1行も足していない。** ロケールが `nonAsciiIsIndexed` に
効くかどうかは ADR 0103 の総当たりでも測っておらず(効いていたのは `server_encoding`
だけだった)、**測っていない値を宣言するのは Issue #148 が名指しで禁じた「⛔ 順序を
逆にしない」を破ることになる。** 次にロケールを宣言するなら、この PR で足した実測値を
見てからである。

### 決定3: 🔴 宣言と実測の食い違いだけを門にする。**値の良し悪しは門にしない**

`scripts/lexical-regime-summary.mjs` に `--expect-encoding`(必須)を足し、
`compareDeclaredEncoding` で宣言値と実測値を突き合わせる。一致しなければ非0で終わるが、
**「UTF8 が正しい」「SQL_ASCII が悪い」とはどこにも書かない**——見るのは
「ci.yml が宣言した値と実際に測れた値が一致したか」だけである。

**⚠ この決定が変える「赤の意味」**: このジョブが赤くなったとき、`server_encoding`
関連の赤は「実装のバグ」ではなく「CI の regime が動いた」ことを意味する。
`compareDeclaredEncoding` の失敗メッセージにその読み方をそのまま書いた——
疑うのは `.github/workflows/ci.yml` の `POSTGRES_INITDB_ARGS`、または service image の
既定であり、宣言値と実測値の両方を出す。

### 決定4: 🔴 6本の宣言が同一であることを歯で固定する

`scripts/__tests__/ci-yml-postgres-regime-wiring.test.mjs` に、(a) 6本すべてが
`POSTGRES_INITDB_ARGS` を持つこと、(b) 6本の値がすべて同一であること、(c) その値の
`--encoding=` と summary 段の `--expect-encoding` が一致すること、を足した。
**(b) が「1本で測った regime が6本に効く」根拠そのものである**——実測は1本だけだが、
宣言のずれは機械的に検出できる。

## オーナーの決定(2026-09-12 追記): SQL_ASCII をサポート対象にする

**⚠ この ADR の決定1〜4は、当初「mnemora が SQL_ASCII/LATIN1 をサポート対象にするかは
オーナーが決めていない」ことを前提に書かれていた(下の「検討して採らなかった案」2番)。**
**この前提は、2026-09-12T00:09Z に解けた。**以下は決定の記録であり、以降このドキュメントは
この決定を事実として扱う。

- **決定**: mnemora は `server_encoding` が **`SQL_ASCII`** の PostgreSQL をサポート対象にする。
- **決めた人**: **オーナー(takecchi)**。⛔ この repo の作業者でもマネージャーでもない。
- **決まった日時**: **2026-09-12T00:09Z**。
- **経路**: alteroid の承認キュー(`ask_human`)で、マネージャーが (a)(b)(c) の3択を提示し、
  オーナーが **(b)** を選んだ。

オーナーが選んだ選択肢 (b) の逐語:

> **(b) サポートする**
> → CI を matrix にして **UTF8 と SQL_ASCII の両方**で走らせる。⟹ ジョブが1本増える
> (費用と時間)。そのかわり「どちらでも動く」が機械で保たれる

⚠ **マネージャーの推奨は (a)「サポートしない」であり、却下された。**⭐ これをここに書くのは、
この決定がマネージャーの意見ではなく**オーナーの判断**であることを、後から読む人が分かる
ようにするためである。

⚠ **`LATIN1` はこの決定に含めない。**オーナーへ別途確認中で未回答である(`LATIN1` では
日本語をそもそも書き込めない境界があるかもしれない)。⛔ 「LATIN1 をサポートする」とも
「しない」とも、ここには書かない。

**⟹ この決定は、上の決定1〜4(宣言と実測の食い違いだけを門にし、値の良し悪しは門にしない)
を変えない。**`SQL_ASCII` が「サポート対象」になったからといって、`lexical-regime-summary.mjs`
が `SQL_ASCII` を良い値として、あるいは `UTF8` を悪い値として門にし始めるわけではない
——門にするのは変わらず「宣言と実測が一致したか」だけである(スクリプト側の docstring にも
同じ趣旨を追記した)。

## 検討して採らなかった案

### 1. ロケールも同時に宣言する — 却下

⛔ 測っていない値を宣言することになる。Issue #148 が名指しで禁じた「順序を逆にしない」
の逆転そのものであり、決定2の理由で見送る。

### 2. 案 C(matrix で UTF8 / SQL_ASCII 両方を走らせる) — 却下ではない。**この PR に入れない理由は「順序」だけ**

⭐ **案 C は「採らなかった案」ではない。**上の「オーナーの決定」節のとおり、matrix 化は
オーナーが決めた方向であり、必ず入る。ここに項を残しているのは、**この PR に入れない理由**
を記録するためである。

**入れない理由1(範囲)**: Issue #148 / [Issue #145](https://github.com/takecchi/mnemora/issues/145)
が頼んだのは「**測った regime が緑のときに誰にも見えない**」を直すことである。matrix は
「**`SQL_ASCII` を実際に走らせる**」という**新しい被覆**であって、別の仕事である。
⟹ 1本の PR に混ぜると、**どちらの受け入れ基準で判定すればよいかが消える。**
(Issue #148 本文自身が「⛔ ①と②を1本の PR に混ぜない」と書いている規律の、同じ形の適用である。)

**入れない理由2(埋もれさせない)**: 「サポート対象だと決めた regime を CI が一度も踏んで
いない」ことは、**それ自体で独立した価値のある仕事**である。⟹ この PR の付け足しにせず、
**別 Issue として起票する。**

⛔ **「`SQL_ASCII` 側が通るか分からないから」を理由にしない。**それは先送りの理由にならない
——測らなければ永久に分からない。

**⚠ 副作用として記録しておく**: matrix にすると CI のジョブの表示名が
`packages/postgres (本物の Postgres + pgvector)` から2本に分かれる。⟹ **その名前に言及して
いる記述を、matrix を入れる PR の中で同時に直す必要が在る。**
⚠ 【現物】**2026-09-12 時点では、この repo にジョブ名を照合する歯は無い**
(`scripts/__tests__/` の24本を一覧して確認した。`docs/measured-in-ci.md` も存在しない)。
⟹ **いま直す対象が在るという意味ではない。**matrix を入れる時点で改めて探す必要が在る、
という注意である。

### 3. 門にしない(可視化だけ) — 却下

PR #149 の可視化は「反転が見えるようになる」だけで、**反転を止めない**
(Issue #148 本文の「A は②を直さない」)。宣言と実測が食い違っても誰も気づかないままなら、
可視化を足した意味の半分が失われる。

## 引き受けた負債

1. **regime を実際に測っているのは6本中1本(`postgres` ジョブ)だけである。**他5本は
   「同じ宣言を持つ」ことを歯で固定しているだけで、実測はしていない。
2. **ロケールは測るが宣言していない。**`lc_collate`/`lc_ctype`/`default_text_search_config`
   が実際に `nonAsciiIsIndexed` へ効くかどうかは、依然として未検証である。
3. **この PR の作業環境には本物の Postgres が無く、`test:db` を一度も走らせていない**
   (docker / initdb / psql が無く、非 root で apt も使えない)。⟹ 新しく足した
   `current_setting('lc_collate')` 等の SQL が実際に動くかは、この PR の CI が初めて
   確かめる。ローカルでは `typecheck` 止まりの検証しかできていない。
4. **`POSTGRES_INITDB_ARGS` が実際に pgvector イメージへ効くこと自体も、この PR の CI が
   初めて確かめる。** postgres の公式 entrypoint はこの変数を尊重する仕様だが
   【受】、`pgvector/pgvector:pg17` イメージでの実地の確認はこの PR より前には無い。

## 【実測】負債3は、この PR の CI が答えを出した — **動かなかった**（2026-09-12、追記）

⛔ **上の「負債3」は書いたとおり未検証のまま出し、CI が答えを出した。訂正ではなく、その答えの記録である。**

**PR #151 の CI（`pgvector/pgvector:pg17`）で `packages/postgres` の測定段が落ちた。**逐語:

```
error: unrecognized configuration parameter "lc_collate"
code: '42704', file: 'guc.c', routine: 'find_option'
  at src/__tests__/lexical-store-identifier.test.ts:348
```

⟹ **PostgreSQL 16 で `lc_collate` / `lc_ctype` は GUC ではなくなり、DB ごとの属性になった。**
⟹ GUC として引く形は pg16 以降で必ず落ちる。⟹ `pg_database.datcollate` / `datctype` から引く形へ直した。

### 🔑 この落ち方が教えたこと

**「名前が3つとも在る」を測る歯は通っていた。**歯が測れていなかったのは「**その式が実際に動く SQL か**」である——歯自身がそう名乗っていた（逐語「⚠ この器には DB が無いので、これが『本当に Postgres で動く SQL か』までは測っていない。測っているのは『問い合わせる行がソースから消えていないこと』だけである」）。

⟹ ⭐ **歯は自分の射程を正しく名乗っており、その射程の外で落ちた。**⟹ **歯の欠陥ではない。**⟹ だから歯は消さず、**射程の外側を CI が埋める**という分担のまま、式だけを直した。

⟹ 併せて「**弾いていないことを測る歯**」を対にした: `current_setting('lc_collate')` / `current_setting('lc_ctype')` へ戻したら赤くなる。⛔ 検出する歯だけを置くと、この決定は静かに巻き戻る。

### ⚠ 負債4（`POSTGRES_INITDB_ARGS` が pgvector イメージへ効くか）は、まだ答えが出ていない

同じ CI で測定段が先に落ちたため、regime JSON が書かれず Job Summary も出なかった。⟹ **次の CI が初めて答える。**

## これが覆るとしたら

- **pgvector の image が `POSTGRES_INITDB_ARGS` を無視するようになったとき。**
  そのとき6本の宣言は意味を失い、決定1 は別の固定手段(例えばイメージの `docker-entrypoint-initdb.d`
  スクリプト)に置き換わる。
- **SQL_ASCII のサポート判断は 2026-09-12T00:09Z に記録済みである(上の「オーナーの決定」
  節)。**matrix 化(案C)自体は**別 Issue で実装される。**それが着地したときは、この ADR の
  「検討して採らなかった案」2番から「入れない理由」の記述を外し、決定として本文へ統合する。
- **LATIN1 のサポート判断が記録されたとき。**そのときはオーナーの決定へ LATIN1 の扱いを
  追記する(現時点では未回答であり、この ADR は含めていない)。
