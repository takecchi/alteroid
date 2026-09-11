# ADR 0103: 否定を主張する歯は、その否定が依存している前提を自分で測って名乗る — 揺れていたのは版でもビルドでもロケールでもなく `server_encoding` だった

- **状態**: 採用 (2026-09)
- **日付**: 2026-09-11

**⚠ 各主張の出所を分ける**（[ADR 0102](./0102-bench-keeps-partial-measurements-on-abort.md) の体裁を踏む）。

- **【現物】** — この repo のコード・文書を書き手が読んで確かめた。
- **【実測】** — この書き手が自分の手で建てた PostgreSQL に対して走らせた。
- **【受】** — 報告として受け取り、再導出していない。

---

## 問い

[Issue #145](https://github.com/takecchi/mnemora/issues/145)。
`packages/postgres/src/__tests__/lexical-store-identifier.test.ts` の1本が、
**「素の `to_tsvector` では `PROJ-1234` を引けない」という否定**を主張している。
その否定が環境をまたいで安定せず、報告者の手元で赤くなった。

**⟹ 問いは2つある。**

1. **どの軸が効いているのか。**版か、ビルドか、ロケールか、それ以外か。
2. **否定を主張する歯は、どう書かれているべきか。**

## 文脈

### 1. 🔴 【現物】この歯は、性質の違う2つの主張を1本でやっていた

```ts
it("正規化を通さない素の to_tsvector では PROJ-1234 を引けない（この索引/クエリが要る理由そのものの実測）", async () => {
  // (a) 素の経路では引けない        --> expect(...).toBe(false)
  // (b) 正規化を通した経路なら引ける --> expect(...).toBe(true)
});
```

**(a) は「`mnemora_lexical_normalize` が*要る理由*」を守っている。**
**(b) は「実装が動いていること」を守っている。**
この2つは**壊れたときに疑う先が違う**——(a) が赤いとき疑うのは素の parser であり、
(b) が赤いとき疑うのは実装である。**1本に混ぜると、赤が何を意味するか読めない。**

### 2. 🔴 【現物】しかも (b) は、本番経路をもう通っていなかった

歯が書いていたクエリ式は `websearch_to_tsquery('simple', mnemora_lexical_normalize($2))`。
これは [ADR 0084](./0084-lexical-recall-channel.md)（`migrations/0008`）当時の式である。
[ADR 0092](./0092-lexical-or-coverage.md)（`migrations/0009`）でクエリ側は
`mnemora_lexical_query_or($2)` に変わっており、`lexical-store.ts` の
`buildLexicalSearchSelect` はそちらを打つ。

**⟹ 歯が式を手で書き写したせいで、実装が動いていることを主張しているつもりの半分が、
実装の外側で緑になっていた。**`migrations/0008` 自身が「なぜ SQL 関数として切り出すか」で
警告していた失敗（式を2箇所に書き写すとずれる）を、**歯のほうで踏んでいた。**

### 3. 🔴 【実測】軸を総当たりで割った — 効いていたのは `server_encoding` だけ

この環境には docker も sudo も psql も無かったため、PostgreSQL を非 root で2系統建てた。

- **PGDG**（apt.postgresql.org の Debian ビルド。CI の `pgvector/pgvector:pg17` と同系統）
  17.11 / 18.6 — `.deb` を `dpkg-deb -x` で展開
- **conda-forge**（Issue #145 報告者の環境と同系統）17.11 / 18.6 — micromamba

`initdb` のロケールは、`locales` パッケージを展開して `localedef` で生成し、
`LOCPATH` を postmaster に渡して解決させた。

**⟹ 2ビルド × 2版 × {libc `C` / libc `C.UTF-8` / libc `en_US.UTF-8` / libc `ja_JP.UTF-8` /
builtin `C.UTF-8` / ICU `en-US`} × {UTF8 / SQL_ASCII / LATIN1} を当てた。**

同じ本文 `四半期レビューでPROJ-1234の納期が来週まで延びました` に対して:

| `server_encoding` | `to_tsvector('simple', 本文)` | 素の `@@ websearch_to_tsquery('PROJ-1234')` |
|---|---|---|
| **UTF8**（6通りのロケール/プロバイダすべて、17.11 と 18.6、PGDG と conda-forge すべて） | `'1234の納期が来週まで延びました':3 '四半期レビューでproj':2 '四半期レビューでproj-1234の納期が来週まで延びました':1` | **f** |
| **SQL_ASCII** / **LATIN1** | `'-1234':2 'proj':1` | **t** |

`ts_debug` で見ると、割れているのはトークナイズの段である:

```
-- UTF8
     alias     |                        token
---------------+-----------------------------------------------------
 numhword      | 四半期レビューでPROJ-1234の納期が来週まで延びました
 hword_part    | 四半期レビューでPROJ
 blank         | -
 hword_numpart | 1234の納期が来週まで延びました

-- SQL_ASCII
   alias   |                  token
-----------+-----------------------------------------
 blank     | 四半期レビューで
 asciiword | PROJ
 int       | -1234
 blank     | の納期が来週まで延びました
```

**⛔ 版ではない。**PGDG の **18.6** でも UTF8 なら `f`（歯は緑）。
**⛔ ビルドではない。**conda-forge の **17.11** でも UTF8 なら `f`、
PGDG の **18.6** でも SQL_ASCII なら `t`。
**⛔ ロケールでもプロバイダでもない。**UTF8 の6通りは**出力が1文字も違わなかった**。

### 4. 【実測】報告者の環境が SQL_ASCII になった理由

`LANG` / `LC_ALL` を持たないシェルで `initdb` を打つと、逐語でこう出る:

```
The database cluster will be initialized with locale "C".
The default database encoding has accordingly been set to "SQL_ASCII".
```

**⟹ 「conda-forge だから」ではなく「`LANG` の無いシェルで `initdb` したから」である。**
ロケール `C` が encoding を `SQL_ASCII` に引きずり込む。
**この1本の線が、版の差に見えていた。**

### 5. 【実測】本番経路は、8通りすべてで同じ結論を出していた

`to_tsvector('simple', mnemora_lexical_normalize(content)) @@ mnemora_lexical_query_or(q)`
を、2ビルド × 2版 × 2エンコーディングの8通りで当てた:

| 主張 | UTF8 | SQL_ASCII |
|---|---|---|
| `PROJ-1234` で引ける | **t** | **t** |
| 日本語の自然文（`PROJ-1234について前に何か言ってたっけ？`）で引ける | **t** | **t** |
| 本文に無い `PROJ-5678` は一致しない | **f** | **f** |

**⟹ 揺れていたのは実装ではなく、歯の主張のほうだった。**

### 6. 【実測】[Issue #139](https://github.com/takecchi/mnemora/issues/139) と、根は**一部**同じ

| | UTF8 | SQL_ASCII |
|---|---|---|
| `to_tsvector('simple','田中太郎がレビューしました')` | `'田中太郎がレビューしました':1`（文ごと1語） | 空（1語も残らない） |
| 素の経路で日本語の語『レビュー』を引けるか | **f** | **f** |
| 本番経路で『田中』を引けるか | **f** | **f** |

**共通の根**: `simple` の既定 parser には**日本語の語の切り出しが無い。**
`server_encoding` が決めているのは、その非ASCIIを
**「隣の ASCII ごと1語に癒着させる」か「まるごと捨てる」か**だけである。
⟹ **どちらでも日本語の語は引けない。**これが #139 の根であり、
#145 の否定が反転する機序でもある。

**⛔ ただし「同じ Issue」ではない。**#139 は
「**どの環境でも**日本語の語を引けない」という**環境に依らない欠陥**である。
#145 は「**その欠陥の現れ方**が環境で変わるせいで、否定を主張する歯が揺れる」という
**歯の書き方の問題**である。**前者は直っていないし、この ADR では直さない。**

**⚠ #139 の本文は機序を「C ロケールのクラスタでは」と書いている【受】が、
この ADR の実測では、`to_tsvector` の分岐を決めていたのは `server_encoding` であり、
ロケール `C` は（`initdb` 経由で encoding を決めるという形で）その**上流**にあった。**
⟹ **ロケールを名指しすると、UTF8 + ロケール `C` の環境を取り逃がす。**

### 7. 【現物】CI は encoding もロケールも宣言していない

`.github/workflows/ci.yml` の6つのジョブはいずれも `pgvector/pgvector:pg17` を
service として立てるだけで、`POSTGRES_INITDB_ARGS` / `LANG` / `LC_ALL` の指定が無い。
**⟹ CI の緑は、イメージの初期化時の既定に依存している。**repo 側は何も主張していない。

## 決定

### 決定1: 🔴 歯を**2本に割る**。混ぜない

- **実装の歯** —「本番の索引式とクエリ式なら引ける」。**`server_encoding` に依らない。**
  ⟹ **赤くなったら疑うのは実装。**
- **理由の歯** —「素の経路で引けるかは `server_encoding` で反転する」。
  ⟹ **赤くなったら疑うのは前提。**

### 決定2: 実装の歯は、式を**書き写さない**

`mnemora_lexical_normalize` と `mnemora_lexical_query_or` を、
`buildLexicalSearchSelect` が打つのと同じ組で呼ぶ。文脈2 の穴を閉じる。

### 決定3: 🔴 理由の歯は、**自分の前提を先に測って名乗る**

```sql
length(to_tsvector('simple', '日本語')) > 0 AS "nonAsciiIsIndexed"
```

**⚠ `server_encoding` の値そのものでは分岐しない。**分岐させるのは
**parser の振る舞い**のほうである——encoding は今日その振る舞いを決めている軸だが、
明日もそうである保証は測っていない。**名乗れる以上の精度を主張しない**
（ADR [0034](./0034-vector-store-filter-conformance.md) /
[0065](./0065-vector-store-space-separation-conformance.md) の族）。

### 決定4: 🔴 分岐の**両側で主張する**。skip しない

前提が破れている環境では、歯は**反対側の結論**（素の経路でも引ける）を主張する。
**⛔ `it.skip` にも、`if` で囲んで黙って通すことにもしない。**
どちらの環境でも、歯は**何かを測っている**。

### 決定5: 失敗メッセージに、**赤の意味と実測値**を書く

```
⚠ ここで疑うのは mnemora_lexical_normalize の実装ではなく、この歯が置いている前提のほうである。
【この環境の実測】server_version=… / server_encoding=… / 非ASCIIが語彙として残るか=… /
to_tsvector('simple', 本文)=…
```

**⟹ 次に赤を見た人が、この ADR を読まずに一次診断できる。**

### 決定6: **regime に依らない錨**を1本置く

どちらの分岐でも `to_tsvector('simple', 本文) @@ websearch_to_tsquery('simple','レビュー')`
は `f` である（文脈6）。**⟹ 分岐が両方とも壊れたことに気づける。**
これが赤くなったなら、素の parser の日本語の扱いそのものが動いている。

## 検討して採らなかった案

### 1. 歯を消す——却下

**消すと `mnemora_lexical_normalize` が要る理由そのものが repo から消える。**
「環境依存だから消す」は最後の手である。

### 2. `server_encoding` を見て `it.skip` する——却下

**skip は緑と見分けがつかない。**この repo が
「名乗れる以上の精度を主張する」族（ADR 0011/0025/0027/0028/0034/0042/0045/0047/0065）で
繰り返し踏んできた形そのものである——**検査できなかった環境と、検査して通った環境が、
同じ色になる。**

### 3. CI の `POSTGRES_INITDB_ARGS` / `LANG` で encoding をピン留めする——却下（この PR では）

**環境を固定しても、歯が前提を名乗っていないことは直らない。**
固定は「手元で走らせたときに何が起きるか」を何も変えない——
**報告者の手元はピン留めの外側にある。**
⚠ ただし**これは筋の良い別の変更である**（CI が何に依存しているかを宣言する）。
6ジョブすべてに触るので、別の PR にする。

### 4. `migrations/0008` のコメントを書き換えて前提を追記する——却下

`migrations/` は適用済みの記録である。**当時そう測ったこと自体は事実**であり、
遡って書き換えると「何がいつ分かったか」が読めなくなる。訂正はこの ADR が持つ。

### 5. 「`server_encoding` が UTF8 でないなら実行時に警告する」を実装に足す——却下（この PR では）

これは**製品の判断**である（mnemora が SQL_ASCII のクラスタを支えるのかどうか）。
`docs/autonomy.md` §3.1 の見分け方に当てると §5 行きである。
⚠ **`docs/roadmap.md` §5 への追記はこの委譲の禁止線（`docs/` を単独で書き換えない）に
当たるため、行っていない。**⟹ PR 本文で提起する。

## 引き受ける負債

1. **理由の歯は、環境によって違う主張を検査する。**同じ歯が、環境によって
   違うものを守る。**これは弱さである**——ただし、
   **弱さを歯の中で名乗っているぶん、黙って緑になるよりは強い。**
2. **`nonAsciiIsIndexed` という probe は、`日本語` という1つの入力でしか測っていない。**
   非ASCIIの扱いが文字種ごとに割れる parser では、この probe は粗すぎる。
   **そういう parser を実測していない。**
3. **Issue #139 は開いたままである。**この ADR は根を名指ししたが、直していない。
4. **CI が何の encoding で走っているかは、依然として repo のどこにも書かれていない。**
   採らなかった案3 のとおり、別の PR に残した。

## 測ったこと

**⚠ 実行環境には docker も sudo も psql も無い。**PostgreSQL は非 root で建てたものである
（PGDG の `.deb` を `dpkg-deb -x`、および micromamba の conda-forge パッケージ）。
**CI の `pgvector/pgvector:pg17` イメージそのものでは走らせていない。**

### 段0: 軸を割った【実測】

2ビルド（PGDG / conda-forge）× 2版（17.11 / 18.6）×
6ロケール/プロバイダ（libc `C` / `C.UTF-8` / `en_US.UTF-8` / `ja_JP.UTF-8` / builtin `C.UTF-8` / ICU `en-US`）
× 3エンコーディング（UTF8 / SQL_ASCII / LATIN1）。**分岐したのは `server_encoding` だけだった**
（表と逐語の出力は文脈3 と PR 本文）。

⚠ **最初に受け取った「12通りすべて同一」という報告には、どの DB に繋いでいたかを示す出力が
1つも無かった。**「全部同じだった」と「全部同じ DB に繋いでいた」は見分けが付かないので、
`pg_database.datname / datctype / datlocprovider / datlocale` を毎回添えて引き直した。
**結果は正しかった。**

### 歯の数【実測】

`lexical-store-identifier.test.ts`: **4本 → 5本**（1本を2本に割った）。

| | 旧い歯 | 新しい歯 |
|---|---|---|
| UTF8 / ctype `en_US.UTF-8`（CI 相当） | 4 passed / exit 0 | **5 passed / exit 0** |
| SQL_ASCII / ctype `C`（報告者の環境相当） | **1 failed / exit 1** | **5 passed / exit 0** |

旧い歯が SQL_ASCII で出していた失敗メッセージは `expected true to be false` だけであり、
**なぜ赤いのかを1文字も語っていなかった。**

### 変異試験【実測】

退避コピーを取り、そこから戻した（`git checkout <file>` を使わない。`docs/autonomy.md` §4）。

| 変異 | 期待 | 結果 |
|---|---|---|
| **M1** `mnemora_lexical_normalize` を恒等関数にする | 実装の歯が赤 | **exit 1** — 実装の歯が意図したメッセージで赤。**理由の歯は緑のまま**（＝分離できている） |
| **M2** 隣接を捨てる（`websearch_to_tsquery` → `plainto_tsquery`） | 実装の歯の誤爆側が赤 | **exit 1** — 意図したメッセージで赤 |
| **M3** `mnemora_lexical_coverage` を常に 0 にする（新しい2本が見ていない関数） | **緑のまま** | **exit 0**（対象ファイル5本すべて緑）。変異が当たっている証拠として `lexical-store-reporter-questions.test.ts` が 2 failed / exit 1 |
| **M4** 理由の歯の**前提判定そのもの**を壊す（probe を `'日本語'` → `'abc'`） | SQL_ASCII で赤 | **exit 1** — 失敗メッセージに `server_encoding=SQL_ASCII` と素の tsvector が印字された。UTF8 側は緑（前提判定が壊れても結論が偶然一致するため） |

⚠ **M2 は1回目、当たっていなかった**（`sed` の区切り文字が SQL の `||` と衝突して置換されず「緑」が返った）。
⚠ **M3 も1回目は証拠が取れていなかった**（存在しないテストファイル名を指定して `No test files found`）。
**どちらも「変異が効いていない可能性を潰せていない緑」なので捨て、撃ち直した。**
⚠ **歯Aの誤爆側は、最初は単一の識別子しか無い本文で測っており、`plainto` に落としても
自明に成り立って何も測らなかった。**識別子を2つ含む本文に差し替えて、初めて噛むようになった。

### 門【実測】

すべてこの環境で走らせた。⛔ `>/dev/null` も `| tail` も使っていない。

| 門 | コマンド | 終了コード |
|---|---|---|
| typecheck | `pnpm run typecheck` | **0** |
| lint | `pnpm run lint` | **0** |
| format:check | `pnpm run format:check` | **0** |
| build | `pnpm run build`（`rm -rf packages/*/dist` の後。`docs/autonomy.md` §4） | **0** |
| pack:check | `pnpm run pack:check` | **0** |
| test | `pnpm run test`（`DATABASE_URL` 有り ⟹ DB 段も実行） | **0** |

`test` の内訳: root 21 files / 425 tests、`@mnemora/postgres` **34 files / 362 tests**、
`@mnemora/example-chat` 32 files / 228 tests。出力に
「✔ DB テストも実行し、通りました。」が出ていることを確認した（ADR 0015）。

### ⚠ 使い回した DB では6本落ちた——原因は蓄積した状態であり、この変更ではない【実測】

何度も走らせた後の DB に対して `pnpm run test` を打つと、
`recall.postgres.test.ts` の EXPLAIN の歯など**6本**が落ちた。
**同じ DB で origin/main を走らせても同じ形で落ちる**ことを確かめるため、
**作りたての DB で main と枝を並べた**:

| | Test Files | Tests | 終了コード |
|---|---|---|---|
| `origin/main`（この変更なし）× 作りたての DB | 34 passed | **361** passed | **0** |
| この枝 × 作りたての DB | 34 passed | **362** passed（歯が1本増えた） | **0** |

⟹ **落ちていたのは蓄積した統計・肥大の側である。**
⚠ ただし**「どの状態で落ちるか」までは特定していない。**
この repo の EXPLAIN の歯には既に「プランナの選択であり統計・行数・メジャー版に依存する」
という留保が付いている（`migrations/0008` / `recall-gate-index.test.ts` 等）。**それ以上は追っていない。**

## 確かめていないこと

- **`pgvector/pgvector:pg17` イメージそのものでは走らせていない。**この環境に docker が
  無いため、CI と「同系統の PGDG ビルド」までしか再現していない。**CI が実際に何の
  encoding で初期化されているかは、この ADR の書き手は測っていない**（CI の緑から
  UTF8 側であろうと推測しているだけである）。
- **報告者の手元の conda-forge 18.6 そのものは触っていない。**同じ conda-forge チャネルの
  18.6 を自分で建てて再現したが、**報告者の環境の `server_encoding` を直接見てはいない**
  【受】。SQL_ASCII であろうという推定は、報告された tsvector が SQL_ASCII の出力と
  一致することと、`LANG` 無しの `initdb` が SQL_ASCII を選ぶことからの逆算である。
- **`EUC_JP` / `SJIS` など他のマルチバイト encoding は測っていない。**
- **`pg_bigm` / `pgroonga` は測っていない**（Issue #139 の選択肢）。

## これが覆るとしたら

- **PostgreSQL の既定 parser が CJK の語を切り出すようになったとき。**
  そのとき錨（決定6）が赤くなり、**Issue #139 の前提ごと変わる。**
- **`server_encoding` 以外の軸が `nonAsciiIsIndexed` を動かすと分かったとき。**
  決定3 は encoding ではなく振る舞いで分岐しているので歯は壊れないが、
  この ADR の表（文脈3）の「encoding だけが効く」という書き方は狭すぎたことになる。
- **mnemora が SQL_ASCII のクラスタを支えないと決めたとき。**そのときは理由の歯の
  分岐そのものが要らなくなり、代わりに起動時の検査（採らなかった案5）が入る。
