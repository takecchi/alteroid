# ADR 0104: 索引の歯は「プランナが選んだ」ではなく「この述語に使える」を測る — 落ちたのは実装ではなく、同じ部分述語の索引が1本増えたからだった

- **状態**: 採用 (2026-09)
- **日付**: 2026-09-12

**⚠ 各主張の出所を分ける**（[ADR 0103](./0103-negative-tooth-declares-its-precondition.md) の体裁を踏む）。

- **【現物】** — この repo のコード・文書・CI のログを書き手が読んで確かめた。
- **【実測】** — この書き手が自分の手で動かした PostgreSQL に対して走らせた。
  ⚠ **この器に本物の PostgreSQL は無い。**【実測】と書いたものは**すべて PGlite 0.5.8
  （PostgreSQL 18.3 相当、WASM、単一プロセス）**での計測であり、**CI（`pgvector/pgvector:pg17`）
  でも本物のサーバーでも走らせていない。**傍証であって証拠ではない。
- **【受】** — 報告として受け取り、再導出していない。

---

## 問い

[Issue #150](https://github.com/takecchi/mnemora/issues/150)。
`packages/postgres/src/__tests__/recall-gate-index.test.ts` の歯が

```ts
expect(plan).toContain("idx_memories_recall_gate");
```

で落ちた。**2回とも同じコスト値**（`cost=239.51..239.64`）で、ランダムな揺れではない。

**⟹ 問いは2つある。**

1. **なぜ別の計画が選ばれたのか。**索引が壊れているのか、プランナの都合なのか。
2. **この歯は、そもそも何を測るべきだったのか。**

## 文脈

### 1. 🔴【現物】落ちた計画は Seq Scan ではなかった——**別の索引**だった

run `34454868730`（`main`、2026-09-10T08:23Z、ジョブ `root-gate-db-stage`）の
ログに計画の全文が残っていた（Issue #150 の時点では失敗メッセージが先頭40文字で
切れていて読めていなかった部分である）:

```
Limit  (cost=239.51..239.64 rows=50 width=33)
  ->  Sort  (cost=239.51..243.51 rows=1600 width=33)
        Sort Key: decay_floor_at
        ->  Bitmap Heap Scan on memories  (cost=16.36..186.36 rows=1600 width=33)
              Recheck Cond: ((tenant_id = 'recall-gate-tenant'::text) AND (status = ANY ('{active,contested}'::text[])))
              Filter: (decay_floor_at > (now() - '1000 days'::interval))
              ->  Bitmap Index Scan on idx_memories_lexical  (cost=0.00..15.96 rows=1600 width=0)
                    Index Cond: (tenant_id = 'recall-gate-tenant'::text)
```

**プランナは索引を捨てていない。**`idx_memories_lexical` を選んだだけである。

### 2. 🔴【現物】選ばれた索引の部分述語は、`idx_memories_recall_gate` と**同一**である

`migrations/0008_memories_lexical_index.sql`:

```sql
CREATE INDEX idx_memories_lexical
  ON memories USING gin (tenant_id, to_tsvector('simple', mnemora_lexical_normalize(content)))
  WHERE status IN ('active', 'contested');
```

`migrations/0001_init.sql`:

```sql
CREATE INDEX idx_memories_recall_gate
  ON memories (tenant_id, status, decay_floor_at)
  WHERE status IN ('active', 'contested');
```

⟹ 🔑 **落ちた計画は、この歯が守りたかったことを1つも壊していない。**
候補集合には `contested` が入っており（部分述語が同じなのだから当然である）、
段1は `memories` を全走査してもいない。**壊れたのは歯の書き方であって、実装でも索引でもない。**

### 3. 🔴【現物】時刻が合う——歯が落ち始めたのは、その索引が着地した日である

| 時刻 (UTC)         | 何が起きたか                                                                   |
| ------------------ | ------------------------------------------------------------------------------ |
| 2026-09-10T00:02Z  | `0a71a57`（PR #115、ADR 0084）が `idx_memories_lexical` を足して `main` へ着地 |
| 2026-09-10T08:23Z  | run `34454868730` でこの歯が初めて落ちる（上の計画）                           |
| 2026-09-10（同日） | PR #141 の CI でも**同じコスト値**で落ちる【受】                               |

⟹ **この歯は、自分の変更と無関係な PR によって落とされた。**
しかもその PR は**何も壊していない**——同じ述語の索引を1本足しただけである。
🔑 **`toContain(索引名)` という書き方は、「将来この repo に足される索引」に対して開いている。**
コスト見積りは統計・行数・行幅・版のコスト定数だけでなく、**他にどんな索引が在るか**にも依存する。

### 4.【現物】頻度は `main` 直近40 run 中1件

`gh run list --branch main --limit 40` の failure は2件、うちこの歯が原因は1件（もう1件は
`corepack` の `ECONNRESET`、無関係）。⟹ **毎回落ちるわけではない。**
⚠ **なぜ毎回ではないのかを、この ADR は特定していない**（下の「確かめていないこと」）。
見立ては在る: 競合する `idx_memories_lexical` は GIN であり、GIN のコスト見積りは
pending list の状態を含む。**`ANALYZE` は pending list を片付けない**（それは `VACUUM` /
`gin_clean_pending_list` の仕事である）ので、**同じコード・同じ seed でも run ごとに
コストが動きうる。**⛔ **これは見立てであって、測っていない。**

### 5. ⛔【現物】原因ではないと分かったもの

- **並行実行ではない。**`packages/postgres/vitest.config.mts` は `fileParallelism: false` を
  明示し、`scripts/run-db-tests.mjs` はパッケージを1つずつ直列に起動する。
  **同じ DB に対して2本が同時に走る経路は、現状の配線には無い。**
- **CI ジョブ間の PostgreSQL の版差ではない。**`ci.yml` の DB を要求する6ジョブは
  **全部 `pgvector/pgvector:pg17`** である。
- **統計の欠落ではない。**seed は `ANALYZE memories` を打っている。

### 6.【実測】この seed では、索引は I/O を1ページも節約していない

PGlite 0.5.8（PG18.3 相当）で seed を再現し（1テナント・4000行・`status` 5値の巡回・
`decay_floor_at` は全行同値）、`EXPLAIN (ANALYZE, BUFFERS)` を取った:

| 経路                                            | コスト          | ヒープに触ったページ                                  |
| ----------------------------------------------- | --------------- | ----------------------------------------------------- |
| `Bitmap Heap Scan` ← `idx_memories_recall_gate` | `41.23..202.23` | `Heap Blocks: exact=125`（`Buffers: shared hit=134`） |
| `Seq Scan`                                      | `0.00..255.00`  | `Buffers: shared hit=125`                             |

**テーブル全体が125ページである。**候補は全行の40%（5 status のうち2つ）で、
散らばって当たるので**索引を使ってもヒープのページは全部読む。**
⟹ 🔑 **この形では、索引が選ばれるかどうかは性能について何も言っていない。**
差は約1.2倍しかなく、行幅・版のコスト定数・統計が少し動けば順位が入れ替わる。
**入れ替わっても実装は壊れていない。**

### 7.【現物】この歯が `EXPLAIN` していたクエリを、本番のコードは打っていない

`packages/postgres/src` に段1の関門クエリを組み立てる関数は無い
（`grep -rn "^export function build.*Select" packages/postgres/src` で出るのは
`buildRequeueEmbedTargetSelect` と `buildLexicalSearchSelect` の2本のみ、2026-09-12）。
⟹ **歯が測っていたのは、テストファイルの中にだけ在る SQL である。**
`docs/memory-model.md` §10 から起こした形ではあるが、**本体の述語を直しても、この歯は
それを追わない。**（`memories-requeue-embed-index.test.ts` が本体から `SELECT` を
切り出して共有しているのは、まさにこれを避けるためである。）

## 決定

### 決定1: 🔴 歯を**性質の側**へ割る。プランナの選択を assert しない

`recall-gate-index.test.ts` を3本に割る。

| 歯                    | 何を測るか                                                                                           | 何に依存するか                                                 |
| --------------------- | ---------------------------------------------------------------------------------------------------- | -------------------------------------------------------------- |
| **歯1（形）**         | `pg_index` から列順・`indnatts`・部分述語を読む                                                      | **プランナを通さない。**行数にも統計にも他の索引にも依存しない |
| **歯2（適用可能性）** | seq scan と bitmap scan を外したとき、この索引が選ばれること＝関門の述語が部分述語を**含意する**こと | btree 経路の中でのプランナの選択                               |
| **歯3（同値）**       | 自然・btree強制・全走査強制の3経路が**同じ行**を返すこと                                             | しない（全走査が基準）                                         |

**歯1が、誤り1（述語を `status = 'active'` に戻す）を殺す本体である。**
歯2は同じ誤りを**意味の側から**殺す——含意が成り立たなければ、どれだけコストを歪めても
その索引は選ばれない。

### 決定2: 自然な計画は **assert せず、全文をログに残す**

Issue #150 の案「落ちたときに計画全文を出す」を、**落ちる前に**やる。
`console.log` で `EXPLAIN` の全文を CI ログへ出す（`contested-with-index.test.ts` /
`lexical-store-index.test.ts` と同じ作法）。次にこの索引の周りで何かが動いたとき、
**計画は最初から読める。**

### 決定3: 🔴 強制では `enable_bitmapscan` **も**外す

`enable_seqscan = off` **だけでは足りない。**落ちた計画が示すとおり、プランナは
seq scan ではなく GIN の bitmap 経路を選んでいた——seq scan を外しても何も変わらない。
GIN は bitmap 経由でしか使えないので、`enable_bitmapscan = off` が
`idx_memories_lexical` を構造ごと候補から外す。

### 決定4: 🔴 **歯自身に「もう保証しない」と名乗らせる**

強制を入れた以上、**この歯は「本番でこの索引が選ばれる」を測っていない。**
それをファイル冒頭に明記し、**代わりにどの歯がそれを測っているか**を指す
（`vector-search-provenance.test.ts` の歯B——`memories` 本体に `Seq Scan` が現れないこと、
選択性に依存しない不変だけを assert する形）。
⛔ **黙って強制を入れて緑にすることはしない。**それは「測るのをやめた」と同じである。

### 決定5: 関門クエリの `ORDER BY` を**全順序**にする

`buildNewMemoryFixture` は `recordedAt` を固定値で返すので、**seed した4000行の
`decay_floor_at` は全部同じ値**になる。⟹ `ORDER BY decay_floor_at LIMIT 50` が返す50行は
計画ごとに変わりうる。歯3が3経路の行集合を突き合わせる以上、順序は全順序でなければならない
（`ORDER BY decay_floor_at, id`。`buildRequeueEmbedTargetSelect` が
`ORDER BY updated_at ASC, id ASC` と書くのと同じ理由）。

## 検討して採らなかった案

### 1. `SET enable_seqscan = off` だけ入れて緑にする——却下（そもそも効かない）

Issue #150 の案(a)。**この案は動かない。**落ちた計画は seq scan ではなく GIN の bitmap
経路であり、seq scan を外しても同じ計画が選ばれ続ける。
⟹ **「強制すれば緑になる」という直感そのものが、計画全文を読む前の推測だった。**

### 2. 十分な行数を投入する——却下

Issue #150 の案(c)。**行数では解けない。**候補は全行の40%で、選択性は行数を増やしても
変わらない（文脈6）。むしろ `idx_memories_lexical` の GIN 側も一緒に大きくなる。
⟹ **何行でも足りない可能性が高い。**テストが重くなるだけである。

### 3. seed を多テナントにして `tenant_id` を選択的にする——却下（この PR では）

40%選択性という knife-edge を、`tenant_id` が効く分布（例: 20テナント×200行）へ移せば、
索引が**大差で**勝つ形にはできる。⟹ しかしそれは「**この索引が効く条件を、歯のために
作る**」ことであり、依然として**プランナの選択**を測っている。同じ述語の索引がもう1本
足されれば、また落ちる。⭐ **多テナントの分布そのものは本番に近く、別途価値が在る**
（`vector-search-subject.test.ts` の歯Bが選択性に依って主張を立てているのと同じ形）。
**この ADR では取らない**——Issue #150 は「歯が何を測るか」の問いであり、
seed の分布を変える判断はそれとは別に立てるべきである。

### 4. 何もしない（再実行で通す）——却下

Issue #150 の案(e)。**「見なくてよい赤」を作る。**この repo が繰り返し嫌っている形であり、
起票者自身がそう書いている。

### 5. `idx_memories_recall_gate` か `idx_memories_lexical` のどちらかを消す——却下（提起にとどめる）

2本は**いま同じ部分述語を持っている。**この関門クエリに対しては交換可能である。
⟹ しかし `idx_memories_recall_gate` は Phase 2 の `WHERE decay_floor_at > now()` の
ためにこそ3列目を持っており（`docs/memory-model.md` §10）、GIN はその範囲条件を引けない。
**索引を消す判断は、この歯の書き方とは別の、スキーマの判断である。**
⛔ **勝手に消さない。**⭐ ただし「**同じ部分述語の索引が2本在る**」という事実は、
次にどちらかを触る人が知っているべきなので、ここに記録する。

### 6. `pg_index.indisvalid` を一時的に落として他の索引を無効化する——却下

トランザクションの中で `UPDATE pg_index SET indisvalid = false` すれば、
「この索引だけが在る世界」で計画を取れる（`ROLLBACK` で戻せる）。
⟹ **catalog を直接書くテストは、測れるものの割に代償が大きい**（superuser を要求し、
失敗したときに何が残るかの説明が難しい）。**決定3の `enable_*` で足りる。**

### 7. ADR を書かずにコメントだけ直す——却下

`AGENTS.md` は「重大な設計判断は ADR に残す」と決めている。
**「歯が何を測るか」を変えるのは設計判断である**——しかも、この歯は
**当たる ADR を持っていなかった**（テストファイル自身が「見直す合図: 当たる ADR は無い」と
書いており、`grep -rn "recall_gate" docs/decisions/` でもこの索引を主題にした ADR は出ない）。
⟹ **その空白がこの事故の一因である。**次に崩れたとき、見直す先がこの ADR になる。

### 8. catalog の述語をそのまま評価して「1行も落ちない」ことを測る——保留（却下ではない）

`pg_get_expr(indpred)` が返す式を**そのまま問い合わせへ差し込み**、
`SELECT count(*) FROM memories WHERE <関門の述語> AND NOT (<索引の述語>)` が 0 であることを
見れば、**プランナにも字面の表記にも依らずに**「索引の述語は関門が欲しい行を1行も落とさない」
を測れる。⭐ 誤り1（`status = 'active'`）はこれでも死ぬ。

⟹ **この PR では採らない。**理由は2つ:
(1) **同じ変異を殺す歯が既に2本在る**（歯1の述語リテラル集合・歯2の含意）。
(2) **catalog から取った式を文字列として問い合わせへ差し込む**形は、それ自体の安全性
（何が差し込まれうるか）を説明する必要が在り、この ADR の主題からずれる。
⭐ **次にこの歯を触る人へ残す。**歯1の「リテラルの集合で見る」が版の表記の変化で
壊れたときの、置き換え先の候補である。

## 引き受ける負債

- 🔴 **本番の計画選択は、この歯ではもう守られない。**守っているのは
  `vector-search-provenance.test.ts` の歯Bだけであり、それは**この索引の名前を見ていない**
  （`Seq Scan` が出ないことしか見ていない）。⟹ **`idx_memories_recall_gate` が本番の段1で
  実際に使われているかを名指しで測る歯は、この repo に1本も無くなる。**
  ⭐ それが要るなら、**Phase 2 で本体が関門を打ち始めるとき**に、本体の `SELECT` を
  切り出して `EXPLAIN` する形で立てるのが筋である（文脈7）。
- **歯2は依然としてプランナの選択を含む。**btree の中でこの索引が選ばれることに依存している。
  ⟹ **同じ部分述語を持つ btree が将来足されたら、歯2も落ちうる。**そのときは
  「実装が壊れた」ではなく「**この歯がまた代理を測り始めた**」と読むこと。歯1は落ちない。
- **歯3は緑のまま動かない歯になりうる。**PostgreSQL は述語が含意されない索引を使わないので、
  「索引経路だけ行が落ちる」は本来起こらない。⭐ **陰性対照として承知で置いている。**
- **関門クエリはまだテストファイルの中に在る。**本体と共有していない（文脈7）。
  **Phase 2 で本体が打ち始めたら移すこと**という注意書きを歯に書いたが、
  **注意書きは検査されない。**これは借りである。

- **seed が2回走るようになった。**歯2（計画の観測）と歯3（同値）はどちらも行を要るので、
  4000行の投入が**このファイルで2回**起きる（PR #3 では1回だった）。⟹ DB 段の所要時間が
  その分だけ増える。**行数を減らせば戻せる**（歯1・歯2・歯3 はいずれも行数に依存しない、と
  歯のコメントに書いた）が、**この PR では減らさない**——変異試験を当て終わった形を、
  時間のためだけに動かしたくないからである。⭐ 減らす判断は、次にこのファイルを触る人へ。

## 測ったこと

⚠ **ここに書いた実行は、すべて PGlite 0.5.8（PostgreSQL 18.3 相当、WASM）に対するものである。**
CI（`pgvector/pgvector:pg17`）でも本物のサーバーでも走らせていない。

### 1. 歯を**実際に走らせた**（テストファイルは無改変）【実測】

この器に PostgreSQL は無いが、PGlite を `@electric-sql/pglite-socket` の
`PGLiteSocketServer` で TCP に公開すると、**node-postgres からそのまま繋がる**。
`vector` / `btree_gin` / `pgcrypto` は contrib を `new PGlite({ extensions: { ... } })` に
渡すことで有効になる（素の `CREATE EXTENSION` は `is not available` で失敗する）。
⟹ `runMigrations` が 0001〜0009 を全部通り、

```
DATABASE_URL=postgresql://postgres:postgres@127.0.0.1:<port>/postgres \
  pnpm --filter @mnemora/postgres exec vitest run src/__tests__/recall-gate-index.test.ts
```

が **4 passed** で通った。**歯を書き写した代用品ではなく、この PR のテストファイルそのものを
走らせている。**

### 2. 変異試験——**手で当てた**（この repo に変異のハーネスは無い）【実測】

`migrations/0001_init.sql` の `idx_memories_recall_gate` の定義に1本ずつ変異を当て、
**当てる前後で md5 を取って、当たったことを確かめてから**結果を読んだ。
原文の md5 は `a5c86391ce1ba3c255e774f066952d89`（各変異の後、復元も md5 で確認）。

| 変異   | 何を変えたか                                               | 赤くなった歯 | 逐語（抜粋）                                                                                                                                                                               |
| ------ | ---------------------------------------------------------- | ------------ | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| **M1** | 述語を `WHERE status = 'active'` に戻す（＝誤り1そのもの） | **歯1・歯2** | 歯1: `expected [ 'active' ] to deeply equal [ 'active', 'contested' ]`／歯2: `expected 'Limit ...Index Scan using idx_memories_period_ann_stage...' to contain 'idx_memories_recall_gate'` |
| **M2** | 列順を `(tenant_id, decay_floor_at, status)` に            | **歯1**      | `expected [ 'tenant_id', 'decay_floor_at', …(1) ] to deeply equal [ 'tenant_id', 'status', …(1) ]`                                                                                         |
| **M3** | 部分述語を丸ごと落とす（無条件索引）                       | **歯1**      | `expected false to be true`（`indpred IS NOT NULL`）                                                                                                                                       |
| **M4** | 3列目を落として `(tenant_id, status)` に                   | **歯1**      | `expected [ 'tenant_id', 'status', null ] to deeply equal [ 'tenant_id', 'status', …(1) ]`                                                                                                 |

🔑 **M1 では歯2が、プランナが別の btree（`idx_memories_period_ann_stage`）へ逃げる形で赤くなった**
——`enable_seqscan = off` が seq scan を*禁止*しないことの現れであり、
歯2が「seq scan が出ないこと」だけでなく**索引の名前**も見ている理由がこれである。

⭐ **緑のままだった歯と、その理由**（陰性対照は「何を見ていないか」も示す）:

- **M2 / M3 / M4 で歯2が緑**: いずれも部分述語 `status IN ('active','contested')` を
  変えていないので、**含意は成り立ったまま**であり、プランナはこの索引を引ける。
  ⟹ **歯2は「形」を見ていない。**形は歯1の仕事である、という分担がそのまま出た。
- **M1〜M4 で歯3・歯4 が緑**: 歯3は3経路の一致を、歯4は `decay_floor_at` の計算を見ており、
  索引の形はどちらにも影響しない。⟹ **歯3は索引の壊れ方を検出しない**
  （「引受ける負債」に書いたとおり、承知で置いている陰性対照である）。

### 3. 🟢 **赤くなってはいけない変異**（陰性対照）【実測】

| 変異   | 何を変えたか                                                                                       | 結果                 |
| ------ | -------------------------------------------------------------------------------------------------- | -------------------- |
| **N1** | 述語を `WHERE status = ANY (ARRAY['contested','active'])` に（**意味は同一**、字面と順序だけ違う） | **生存（4 passed）** |
| **N2** | `CREATE INDEX` に SQL コメントと改行を足す（ふるまい不変）                                         | **生存（4 passed）** |
| **N3** | テストファイルの**コメント文言だけ**を1行変える                                                    | **生存（4 passed）** |

🔑 **N1 が要点である。**歯1は `pg_get_expr` の文字列を**全体一致では見ず**、現れるリテラルの
集合で見ている。⟹ **同じ意味を別の字面で書いても赤くならない**＝この歯は**式ではなく性質**を
測っている。**N1 が赤くなる歯は、索引の意味ではなく DDL の書き方を測っている。**

### 4. 🔴 段A: CI で起きた「GIN が勝つ」は、PGlite では**再現できなかった**【実測】

0001 と 0008 の索引を**1バイトも変えずに**両方作り、歯と同じ seed（4000行・`content` は
全行同一・`decay_floor_at` も全行同一）を入れて `ANALYZE` した上で自然な計画を取ると、
PGlite は `Bitmap Index Scan on idx_memories_recall_gate (cost=0.00..32.28)` を選ぶ
——**`idx_memories_lexical` は現れない。**

**さらに、GIN を勝たせようとして13通りのコスト定数・`enable_*` の組み合わせを振った**
（`enable_indexscan` / `enable_sort` / `random_page_cost` 0.001〜20 / `seq_page_cost` 10・100 /
`cpu_tuple_cost` / `cpu_index_tuple_cost` / `cpu_operator_cost` / `effective_cache_size`、
およびその組み合わせ）。⟹ **`idx_memories_recall_gate` が在る限り、GIN が勝つ組み合わせは
1つも見つからなかった。**勝者は常に「recall gate の索引走査」か「Seq Scan」のどちらかで、
GIN はその間に入ってこない。

|                                 | GIN の Bitmap Index Scan 単体コスト | recall gate の Bitmap Index Scan 単体コスト |
| ------------------------------- | ----------------------------------- | ------------------------------------------- |
| **CI（pg17、run 34454868730）** | **`0.00..15.96`**                   | （選ばれなかったので計画に出ていない）      |
| **PGlite（PG18.3 相当）**       | `0.00..75.49`                       | `0.00..32.28`                               |

🔑 **同じ DDL・同じ seed で、GIN の見積りが CI と PGlite で4倍以上ずれている。**
⟹ **CI で GIN が勝った理由は、PGlite では再現できない何か**（GIN のコスト式の版差・
pending list の状態・行幅）に在る。⛔ **特定していない。**

recall gate の索引を落として GIN を勝たせた状態（人工的な条件）で
`SET enable_bitmapscan = off` を足すと、GIN は計画から**構造ごと消えた**（`Seq Scan` に落ちた
——その世界には recall gate の索引が無いので、戻る先が無い）。
⟹ **確かめられたのは「bitmap を外すと GIN は候補から消える」までである**（GIN が bitmap 経由で
しか走査できないという、版に依らない性質の現れ）。**「GIN が自然に勝っている状態から
recall gate の索引へ落ちる」ところは測れていない**——その状態を作れなかったからである。

### 5. 前後の対照: **この書き直しが他の DB テストを壊していないこと**【実測】

`packages/postgres` のスイート全体（34ファイル）を、**同じ手順・フレッシュな PGlite** で
2つの状態について走らせて突き合わせた。

| 状態                                             | tests                  | 落ちたファイル            |
| ------------------------------------------------ | ---------------------- | ------------------------- |
| (a) `origin/main` の `recall-gate-index.test.ts` | 344 passed / 18 failed | 6                         |
| (b) この枝（書き直し後）                         | 346 passed / 18 failed | 6（**(a) と同一の集合**） |

（PGlite では元々6ファイルが落ちる——`migrate-concurrency` / `vector-space-concurrency` /
`dedicated-schema` / `extension-mode` / `migrate-ledger-handover` / `temp-database`。
advisory lock の同時実行・専用ロール・DB ごとの排他など、**PGlite が持っていない機能**に
当たっているもので、**CI の緑とは無関係**である。）

⚠ **途中で1度だけ、`conformance.postgres.test.ts` が3件落ちた実行が在った。**
⟹ **私の変更が原因ではなかった**——`recall-gate-index.test.ts` を**読み込まない単独実行**でも
同じ3件が落ちることを確かめた（＝ PGlite 上でのこのファイル自体の非決定性）。
⭐ **ただしこの1回が、本物の欠陥を1つ釣り上げた**（下）。

### 6. 🔴 対照が釣り上げた欠陥: `finally` の中で `release()` が飛びうる【現物】

上の (b) を疑ったときに、自分の書いた `withForcing` の後始末がこうなっていた:

```ts
} finally {
  await client.query("ROLLBACK");
  client.release();   // ⚠ ROLLBACK が投げたら、ここへ来ない
}
```

`count-over-query` 系の既存の歯（`count-over-window.test.ts`）と同じ形だが、
**`ROLLBACK` が投げると接続がプールへ戻らない。**プールは共有なので、
**詰まったときに落ちるのはこのファイルではなく後続のテストである。**
⟹ `try { await client.query("ROLLBACK"); } finally { client.release(); }` へ直した。
直した後で歯を走らせ直し（**4 passed**）、**M1 をもう一度当てて歯1・歯2が赤くなること**も
確かめてある（＝修正で歯が鈍っていない）。
⚠ **同じ形は `count-over-window.test.ts` にも在るが、この PR では直していない**
——ADR に書いていない変更を混ぜないため（`docs/autonomy.md` §2）。**住所として残す。**

## 確かめていないこと

- 🔴 **CI でも本物の PostgreSQL でも、この歯を1度も走らせていない。**この器には
  `docker` / `initdb` / `psql` / `pg_ctl` が無く（`command -v` で確認、uid 1001・`sudo` 無し・
  `apt` は権限で失敗）、`DATABASE_URL` を立てられない。
  ⟹ **次の CI 実行が唯一の実測経路である。**
- **PGlite は本物の PG17 ではない。**PG18.3 相当・WASM・単一プロセスで、`shared_buffers`
  128MB / `effective_cache_size` 4GB / `max_parallel_workers_per_gather` 0 は PGlite の既定値であり、
  CI のコンテナと一致する保証は無い。**コストの絶対値を CI へ持ち込まないこと。**
- 🔴 **「なぜ毎回は落ちないのか」を特定していない。**GIN の pending list という見立てを
  文脈4に書いたが、**測っていない。**⟹ これを測るには、`idx_memories_lexical` の
  `pgstatginindex` を run ごとに読むか、`VACUUM` の有無で計画が動くかを見る必要が在る。
- 🔴 **決定3（`enable_bitmapscan = off`）が、CI が実際に居た状態で効くことを測れていない。**
  この器では「recall gate の索引が在るのに GIN が自然に勝つ」状態を作れなかった（測ったこと4）。
  ⟹ 効くと考える根拠は**構造**である（GIN は bitmap 経由でしか走査できないので、bitmap を
  外せば候補から消える）——**コストの実測ではない。**
  ⚠ 残る穴は「bitmap を外した世界で、**recall gate 以外の btree** が勝つことが在りうるか」で、
  実際 M1（述語を壊した変異）では `idx_memories_period_ann_stage` が勝った。
  **CI でそれが起きれば歯2は赤くなる。**そのときは実装ではなく歯を疑うこと（負債の項）。
- **`main` の現在の HEAD でこの歯が落ちるのかどうかを知らない。**直近40 run では1件しか
  落ちておらず、**いま緑であること自体が、この問題が消えたことを意味しない。**

## これが覆るとしたら

- **本体が段1の関門クエリを打ち始めたとき。**そのとき歯はテスト内の SQL ではなく
  本体の `SELECT` を `EXPLAIN` すべきで、この ADR の決定1は書き直しになる（負債の項）。
- **`idx_memories_lexical` か `idx_memories_recall_gate` のどちらかが消えたとき。**
  決定3（`enable_bitmapscan = off`）の理由が消える。**理由が消えた強制は外すこと**
  ——強制は、要らなくなったら残してはいけない。
- **`decay_floor_at > now()` が Phase 2 で有効になったとき。**候補の選択性が 40% から
  大きく下がり、**索引が本当に効く形**になる。そのとき初めて「プランナが選ぶ」を
  assert する意味が出てくる（文脈6が覆る）。
- **この索引の3列目を使う計画が、どの版でも出ないと分かったとき。**
  `status = ANY(...)`（ScalarArrayOp）が2列目に来る限り `decay_floor_at` は
  索引の並び順として使えない可能性が在る。⟹ そうと分かれば、3列目を持つ意味そのものが
  `docs/memory-model.md` §10 ごと問い直しになる。⛔ **これは測っていない。**
