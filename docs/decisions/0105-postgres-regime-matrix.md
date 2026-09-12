# ADR 0105: `postgres` ジョブを server_encoding の matrix にする — UTF8 と SQL_ASCII を両方走らせ、揃って走ったかを別ジョブで測る

- **状態**: 採用 (2026-09)
- **日付**: 2026-09-12

**⚠ 各主張の出所を分ける**([ADR 0103](./0103-negative-tooth-declares-its-precondition.md) /
[ADR 0106](./0106-ci-declares-the-regime-it-measures.md) の体裁を踏む)。

- **【現物】** — この repo のコード・文書を書き手が読んで確かめた。
- **【実測】** — この書き手が自分の手で(CI 上で)走らせて確かめた。
- **【受】** — 報告として受け取り、再導出していない。

⚠ **この器に本物の PostgreSQL は無い**(`docker` / `psql` が無く、`DATABASE_URL` も
設定されていない——`echo $DATABASE_URL` は空)。**この ADR の中で「測った」と書けるのは
`typecheck` / `lint` / `format:check` / `build` / `pack:check` / `check:cjs-parse` と、
DB を要求しない単体テスト(`pnpm run test` のうち `vitest run` と各パッケージの
`test`)だけである。`test:db` は一度も走らせていない。**

---

## 問い

[Issue #155](https://github.com/takecchi/mnemora/issues/155)
(`SQL_ASCII` を CI が一度も踏んでいない/#148 案 C/ADR 0106 負債4)。

オーナー(takecchi)は 2026-09-12T00:09Z に「`server_encoding` が `SQL_ASCII` の
PostgreSQL をサポート対象にする」と決めた([ADR 0106](./0106-ci-declares-the-regime-it-measures.md)
の「オーナーの決定」節)。**しかし CI は、6本の pgvector ジョブすべてが同じ1つの
regime(`UTF8`)でしか走っていない。**サポート対象だと決めた側が、CI に1本も無い。

**この ADR は、`postgres` ジョブだけを regime の matrix にして、その穴を埋める。**

## 文脈

### 1. 【現物】ADR 0106 決定4の「負債4」がまだ答えを持っていない

ADR 0106 は「`POSTGRES_INITDB_ARGS` が実際に pgvector イメージへ効くこと自体、
この PR の CI が初めて確かめる」ことを負債として引き受けたまま残していた。
`compareDeclaredEncoding` は「宣言した値と実測値が一致したか」だけを見る門だが、
**イメージの既定がもともと `UTF8` なら、`POSTGRES_INITDB_ARGS` が1バイトも効いていなくても
一致してしまう。** これまで `UTF8` の宣言でしか走らせていなかったので、この区別が
一度もついていなかった。

### 2. 【現物】6本のうち matrix にするのは `postgres` の1本だけ

`.github/workflows/ci.yml` で `pgvector/pgvector:pg17` を services に持つジョブは
6本(`postgres` / `example-chat` / `root-gate-db-stage` / `retrieval-quality` /
`identifier-probes` / `consolidation-cost`)。Issue #155 はこの6本のうち `postgres`
1本だけを matrix にすることを明示している——「まず1本で機序を確かめる」。
他5本を matrix にすることはこの ADR の範囲外である。

## 決定

### 決定1: 🔴 `postgres` ジョブに `strategy.fail-fast: false` の2脚 matrix を足す

```yaml
strategy:
  fail-fast: false
  matrix:
    include:
      - serverEncoding: UTF8
        initdbArgs: "--encoding=UTF8"
      - serverEncoding: SQL_ASCII
        initdbArgs: "--encoding=SQL_ASCII --locale=C"
```

- **`UTF8` 脚の値は1バイトも変えていない。** Issue #148 由来の実測(main の run
  `34635954755`)をそのまま使う——過去の実測との比較可能性を壊さないためである。
- **`fail-fast: false` を必ず付ける。** これを付けないと、`SQL_ASCII` 脚が落ちたときに
  GitHub Actions が `UTF8` 脚を道連れにキャンセルしうる——その場合 `UTF8` 脚の
  artifact/Job Summary という「証拠」まで失われる。`SQL_ASCII` 側が初めて走る実験である
  以上、落ちても `UTF8` 側の結果は必ず残す。
- ジョブ表示名を `packages/postgres (本物の Postgres + pgvector,
  server_encoding=${{ matrix.serverEncoding }})` にし、脚ごとに区別できるようにした
  (下の「ジョブ表示名の参照」節)。

### 決定2: 🔴 `SQL_ASCII` 脚には `--locale=C` を足す。`UTF8` 脚には足さない

`initdb` は encoding とロケールの整合を検査する。`SQL_ASCII` は「バイト列を素通しする」
規約であり、`en_US.utf8`(実測された既定ロケール)のような UTF-8 系ロケールとは
組み合わせを拒否されうる。**そのため `SQL_ASCII` 脚だけ `--locale=C` を足す。**

⚠ **これは Issue #148 が順序として見送った「ロケールを ci.yml で宣言すること」を
先取りしているわけではない。** ADR 0106 決定2が見送ったのは、**測っていない値**
(`LANG`/`LC_*` の env や `--expect-locale` の門)を宣言することだった。ここでの
`--locale=C` は、`SQL_ASCII` を選んだこと自体が要求する `initdb` の整合条件であり、
「未測定の regime を追加で主張する」ものではない。

### 決定3: 🔴 artifact 名と `--expect-encoding` を脚ごとに分ける

artifact 名を `lexical-regime-${{ matrix.serverEncoding }}` にした——分けないと2脚が
同じ名前へ upload しようとして衝突・上書きする(Issue #155 満たすべきこと1)。
summary 段の `--expect-encoding` は `"${{ matrix.serverEncoding }}"` にした——
リテラル値を書き写すのではなく、同じ matrix 変数へ直接配線することで、脚が増えても
自動的に揃う形にした。

### 決定4: 🔴 「両方が実際に走ったか」を測る `postgres-regime-coverage` ジョブを足す

`postgres` ジョブ(matrix)が緑であることは、「両方の regime が実際に走った」ことを
意味しない——`SQL_ASCII` 脚が(container の起動落ちなどで)skip 相当の結果になっても、
`UTF8` 脚さえ通れば matrix 全体としては見かけ上「進んだ」ように見えうる。

`postgres-regime-coverage` ジョブは `needs: postgres` / `if: always()` で、
`postgres` ジョブの結果を問わず走る。まず `needs.postgres.result` が `skipped`
なら意図して落とす(skip を成功として読ませない)。次に、両脚が残した
`lexical-regime-*` artifact を全部ダウンロードし、
`scripts/lexical-regime-coverage.mjs`(純関数側は
`scripts/lexical-regime-coverage-lib.mjs`)へ渡す。このスクリプトは:

1. 期待する2脚(`UTF8`/`SQL_ASCII`)それぞれの artifact が存在するか
2. その中身が JSON として読めるか
3. artifact 名が主張する脚と、中身の `serverEncoding` が一致するか
4. **実際に測れた `serverEncoding` が2種類あるか**(4が無いと、両方の artifact が
   存在していても中身が同じ値(例: 両方 `UTF8`)ということがあり得て、それは
   「`POSTGRES_INITDB_ARGS` が効いていない」ことの見落としになる)

のどれかが崩れていれば非0で終わる。**値の良し悪しは判定しない**——ADR 0106 決定3
と同じ設計方針をここでも踏襲する。

期待する脚の集合(`EXPECTED_SERVER_ENCODINGS`)はスクリプト側に持たせた二重管理であり、
`scripts/__tests__/ci-yml-postgres-regime-coverage-wiring.test.mjs` がこれと
`postgres` ジョブの matrix の脚が一致することを固定している(ずれたら赤くなる)。

## 🔴🔴 SQL_ASCII で通るかは、誰も測っていない

**`SQL_ASCII` の regime で `packages/postgres` の全テストが通るかは、誰も一度も
測っていない。この PR の CI が初めての実行機会である。**

この ADR を書いている時点で、この器には本物の PostgreSQL が無い。手元で確かめられたのは
`typecheck` / `lint` / `format:check` / `build` / `pack:check` / `check:cjs-parse` と、
DB を要求しない単体テストだけであり、**`SQL_ASCII` の regime に対する `test:db` の
成否は一度も観測していない。**

### ADR 0106 負債4は、この matrix が唯一の実験である

ADR 0106 は「`POSTGRES_INITDB_ARGS` が実際に pgvector イメージへ効くこと自体、
この PR の CI が初めて確かめる」ことを負債として引き受け、答えの出ないまま残していた。
**この matrix が、その負債に答える唯一の実験である。** 起こりうる転び方は3通りあり、
**どれも「失敗」ではなく答えである**:

1. **`SQL_ASCII` 脚が `server_encoding=SQL_ASCII` を測る** — `POSTGRES_INITDB_ARGS`
   は効いている。この場合、次に問われるのは「`SQL_ASCII` の regime で
   `packages/postgres` の全テストが通るか」であり、それはこの CI 自体が初めて
   答える(上の節)。
2. **`SQL_ASCII` 脚が `server_encoding=UTF8` を測ってしまう** — `POSTGRES_INITDB_ARGS`
   が効いていない。`compareDeclaredEncoding`(宣言は `SQL_ASCII`、実測は `UTF8`)が
   食い違いとして落ちる。これは実装のバグではなく、CI の regime が動かせなかった
   ——つまり「効いていない」という答えである。
3. **`SQL_ASCII` 脚のコンテナ自体が起動ごと落ちる** — `initdb` が
   `--encoding=SQL_ASCII --locale=C` を拒否した、あるいは `SQL_ASCII` と組み合わせられる
   はずのロケール指定が pgvector イメージ側の何かと噛み合わなかった場合にありうる。
   **これも「`POSTGRES_INITDB_ARGS` が効いている」ことの証拠である**——効いていなければ
   イメージは既定(UTF8 系)のまま起動し、落ちる理由が無い。

⟹ **1〜3のどれが起きても、ADR 0106 負債4は解ける。** 落ちること自体を「この PR が
壊れた」と読まないこと——`SQL_ASCII` 側は測れるようになったこと自体が価値であり、
赤は測定結果である。

## 検討して採らなかった案

### 1. `postgres` 以外の5本も同時に matrix にする — 却下

Issue #155 が明示的に範囲外にしている。「まず1本で機序を確かめる」——`postgres`
ジョブだけが実際に regime を測定しており(ADR 0106「引き受けた負債」1)、他5本は
「同じ宣言を持つ」ことを歯で固定しているに過ぎない。1本の実験で `POSTGRES_INITDB_ARGS`
が効くかどうかの答えが出てから、他5本へ広げるかを判断するのが順序として正しい。

### 2. `LATIN1` も同時に matrix へ足す — 却下

オーナーへ別途確認中で未回答である。`LATIN1` では日本語をそもそも書き込めない境界が
あるかもしれず、そこは決まっていない。⛔ **この ADR は `LATIN1` について「サポートする」
とも「サポートしない」とも書かない。** 決まったら別途この ADR か新しい ADR へ追記する。

### 3. ロケールを `LANG`/`LC_*` の env や `--expect-locale` の門として ci.yml へ宣言する
— 却下(この PR ではやらない)

ADR 0106 決定2が見送った理由がそのまま当てはまる——ロケールが `nonAsciiIsIndexed` へ
効くかどうかは ADR 0103 の総当たりでも測っておらず、測っていない値を宣言するのは
Issue #148 が名指しで禁じた「順序を逆にしない」を破ることになる。決定2で足した
`--locale=C` は `initdb` の整合条件であり、この「宣言」とは別物である(決定2の注記)。

### 4. `postgres-regime-coverage` を門にせず、可視化だけにする — 却下

ADR 0106「検討して採らなかった案」3と同じ理由——可視化だけでは「両脚が実際に揃って
走ったか」の回帰を誰も検知できない。matrix の2脚のうちどちらかが静かに skip される
ようになっても、緑のまま気づかれない。

## 引き受けた負債

1. **`SQL_ASCII` の regime で `packages/postgres` の全テストが通るかは、誰も一度も
   測っていない。**(上の節で強調したとおり。)
2. **`postgres` 以外の5本は、依然として `UTF8` でしか走っていない。** この ADR は
   その5本を変えない(検討して採らなかった案1)。
3. **`LATIN1` の扱いは未決定のままである。** オーナーの回答を待つ。
4. **この PR の作業環境には本物の PostgreSQL が無く、`test:db` を一度も走らせていない。**
   `ci.yml` の YAML としての妥当性・`scripts/lexical-regime-coverage.mjs` の単体の
   ふるまいは手元で確かめたが、**matrix の2脚が実際に GitHub Actions 上で起動し、
   `SQL_ASCII` 脚が initdb を通過するかどうかは、この PR の CI が初めて確かめる。**
5. **`postgres-regime-coverage` ジョブの `download-artifact`/`upload-artifact` の
   実地の挙動(pattern マッチ・複数 artifact のダウンロード先ディレクトリ構造)は、
   この器では実行できず、GitHub Actions 側のドキュメントを元に組んだ。** 実際の
   ディレクトリ構造(`<path>/<artifact名>/<ファイル名>`)が想定と違えば、
   `lexical-regime-coverage.mjs` の探索パスがずれる可能性がある。
6. **branch protection の required status checks は、この PR の範囲外である。**
   [ADR 0072](./0072-anthropic-llm-provider.md)(2026年時点の実測)は
   `packages/postgres (本物の Postgres + pgvector)` という**完全一致の文字列**を
   required check として記録している。matrix 化によりジョブの表示名は
   `packages/postgres (本物の Postgres + pgvector, server_encoding=UTF8)` /
   `...server_encoding=SQL_ASCII)` の2本に分かれ、**この文字列と一致する required
   check はもう存在しなくなる。** branch protection の設定は GitHub 側の設定であり、
   このリポジトリのファイルではないため、この PR からは変更できない
   ——**オーナーが GitHub の設定を更新する必要がある**(このリポジトリのどのファイルを
   直しても解決しない)。

## これが覆るとしたら

- **`SQL_ASCII` 脚の CI が実際に走り、`packages/postgres` のテストが通らないと分かったとき。**
  そのときは、`SQL_ASCII` を「サポート対象」とした ADR 0106 の記述そのものへ戻り、
  オーナーが再度判断する材料になる——この ADR がその判断を代わりに下すことはない。
- **`postgres` 以外の5本を matrix にする Issue が立ったとき。** そのときは
  「検討して採らなかった案」1の判断を上書きし、この ADR の決定1の対象を拡張する形で
  追記する。
- **`LATIN1` の扱いがオーナーから回答されたとき。** そのときはこの ADR、または
  ADR 0106 の「オーナーの決定」節へ追記する。
- **branch protection の required status checks が更新されたとき。** そのときは
  「引き受けた負債」6が解け、ADR 0072 の記録は当時の記録のまま、branch protection の
  現在値を新しい ADR か文書で記録する。
