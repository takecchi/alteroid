# ADR 0062: `memories.contested_with_id` の自己参照 FK に索引を足す — `tenant_id` 先頭の複合索引は RI チェックを効率良く供給できないこと・索引名は中身を保証しないこと

- **状態**: 採用 (2026-09)

- **文脈**:

  `memories.contested_with_id`（`packages/postgres/migrations/0001_init.sql:73`、
  `memories(id)` への自己参照 FK。`NULL` 許容）を先頭列に置いた索引が一本も
  無かった。既存の索引を読むと一見紛らわしい:

  ```sql
  -- 係争中の Memory の一括検出・companion 取得
  CREATE INDEX idx_memories_contested
    ON memories (tenant_id, status)
    WHERE status = 'contested';
  ```

  **`idx_memories_contested` という名前だけを見ると `contested_with_id` の索引だと
  誤読しうるが、これは `(tenant_id, status) WHERE status = 'contested'` という
  `status` の索引であり、`contested_with_id` は列にすら含まれていない。**
  （本 PR の作業者が `packages/postgres/migrations/0001_init.sql:124-126` を読んで確認。）

  親側（`memories`）の行を `DELETE` するたびに、PostgreSQL の参照整合性トリガーは
  次の形のクエリを発行し、「この行を `contested_with_id` として指している行が無いか」
  を確かめる（本 PR の作業者が CI の実測ログ ——
  `packages/postgres/src/__tests__/contested-with-index.test.ts` の `EXPLAIN` 出力 ——
  で確認した、逐語）:

  ```sql
  SELECT 1 FROM ONLY "public"."memories" x
    WHERE $1 OPERATOR(pg_catalog.=) "contested_with_id" FOR KEY SHARE OF x
  ```

  **この `WHERE` に `tenant_id` は一切現れない。** 索引が無い、あるいは既存の索引が
  `contested_with_id` を列としてまったく含んでいない場合、この問い合わせのたびに
  `memories` 全体の `Seq Scan` が走る——`idx_memories_contested`
  （`tenant_id, status`）も `idx_memories_recall_gate`（`tenant_id, status,
  decay_floor_at`）も `idx_memories_by_subject`（`tenant_id, subject_id,
  status`）も、**`contested_with_id` という列自体をどこにも持たない**ため、
  この RI チェックに対しては「索引が無い」のと同じである。CI の実測
  （`contested-with-index.test.ts`）で実際に `Seq Scan` になることを確認済み。
  （⚠ これは「先頭列が `tenant_id` だから使えない」という話とは別である——
  `tenant_id` を先頭に置きつつ `contested_with_id` を列に含む索引が使えるかどうかは
  下記 (a) で扱う。そちらは実測で「使える（ただし非効率）」と判明した。）

- **決定**:

  1. `packages/postgres/migrations/0004_contested_with_index.sql`
     （命名の経緯は「マイグレーション番号について」参照）に、部分索引を1本追加する:

     ```sql
     CREATE INDEX idx_memories_contested_with
       ON memories (contested_with_id)
       WHERE contested_with_id IS NOT NULL;
     ```

  2. **`idx_memories_superseded_by`（`(tenant_id, superseded_by_id) WHERE
     superseded_by_id IS NOT NULL`）と同じ形（`tenant_id` を先頭に置く）には
     しない。** 理由は下記 (a)。
  3. **既存の索引は一切変更しない。** `DROP` も列の並べ替えもせず、追加のみ。
  4. `INCLUDE` 等の追加列は持たせない——RI クエリは `FOR KEY SHARE OF x` で行ロックを
     取るため常にヒープへのアクセスが要り、`Index Only Scan` にはならない。加えて
     `grep` で確認した限り、アプリケーション側（`memory-store.ts`・`mapping.ts`）は
     `contested_with_id` を `INSERT` の列挙・`SELECT` の行マッピングに使うのみで
     `WHERE`/`JOIN` の絞り込みには使っていない。
  5. `CREATE INDEX CONCURRENTLY` は使わない。理由は下記 (c)。

- **(a) 一般則: 先頭列が `tenant_id` の複合索引は、RI（外部キー）チェックを
  効率良くは供給できない（供給できない、ではない）**

  **⚠ この節は当初「供給できない」と断定していたが、この PR の期間中に実測して
  みたところ誤りだったので訂正する。以下は訂正後の版であり、実測に合わせて
  読むこと。**

  RI チェックの `WHERE` 句は、参照整合性トリガーが自動生成するものであり、
  常に FK 列（ここでは `contested_with_id`）の等値条件だけを持つ。`tenant_id` は
  原理的にそこへ現れない（`memories` は単一テーブルの自己参照 FK であり、
  PostgreSQL の RI トリガーはテナントという概念を知らない）。ここまでは変わらない。

  **変わったのは、その先の帰結である。** `tenant_id` が先頭にある複合索引
  （例: `(tenant_id, contested_with_id)`）に対し、実際に `EXPLAIN` で RI チェックの
  クエリ（`tenant_id` を一切含まない、`contested_with_id = $1` のみ）を当てて
  比較した:

  | 索引の形 | プラン | cost |
  |---|---|---|
  | 索引なし | `Seq Scan on memories x` | 0.00..**5254.00** |
  | `(tenant_id, contested_with_id) WHERE contested_with_id IS NOT NULL` | `Index Scan`、`Index Cond: (contested_with_id = ...)` | 0.28..**104.06** |
  | `(contested_with_id) WHERE contested_with_id IS NOT NULL`（本 PR が実際に採用した形） | `Index Scan` | 0.28..**8.29** |

  **`tenant_id` 先頭の複合索引は、実際には `Index Scan` として使われた。** プランナは
  `tenant_id` が先頭にあっても、非先頭列の `contested_with_id` を `Index Cond`
  として適用し、事実上その部分索引全体を走査する形で候補を絞る——**この部分索引が
  全体の約2%しか行を持たないため、それでも `Seq Scan` より大幅に安い。**
  ⟹ **「先頭列で絞れない索引は RI チェックを供給できない」という当初の書き方は
  誤りである。** 正しくは: **先頭列（`tenant_id`）による絞り込みは使えない
  （`tenant_id` がその RI チェックの `WHERE` に現れない以上、そこを起点に
  スキャン範囲を狭めることはできない）ため、実質的に索引全体を舐める形になる
  ——それでも部分索引が小さい限り `Seq Scan` よりは安いが、`contested_with_id`
  自身を先頭に置いた専用の索引と比べると約12倍重い（104.06 対 8.29）。**
  「使えない」ではなく「使えるが専用の索引より非効率」というのが実測の結論である。

  **今後このリポジトリで `tenant_id` 先頭の複合索引を見たとき、「テナントで絞る
  クエリ」を供給する索引だと読むのは正しいが、「テナント内のある列を指す外部キーの
  DELETE 時 RI チェックも効率良く供給する」と拡大解釈しないこと。** 使われは
  するが、専用の索引に比べて約12倍のコストを払う形になる。

  `idx_memories_superseded_by`（`(tenant_id, superseded_by_id) WHERE
  superseded_by_id IS NOT NULL`）について本 PR が同じ形を真似なかった理由と、
  その索引が実際に `superseded_by_id` 自身の RI チェックにどう使われているかは
  下の「(f) `superseded_by_id`」にまとめて記録する（結論だけ言えば、あの索引は
  実際に使われている——ただし理由は `tenant_id` が先頭にあることではない）。

  **⚠ この節はここまで「部分索引が育つほどこの差は開く」を未測定の外挿として
  扱ってきた。この PR の期間中に実測したので、以下に置き換える。**

  **測定方法**: 使い捨ての PostgreSQL 17.11 / pgvector 0.8.6、DB `slope_contested`、
  実際の `memories` スキーマ（マイグレーション `0001`〜`0003`）を使用。行数は
  常に 100,000 に固定し、`contested_with_id` が非 NULL な行の割合だけを
  2% / 10% / 30% / 60% / 90% と動かした。対象テーブルは
  `autovacuum_enabled = false`（測定終了時点でもまだ有効であることを確認済み）。
  各割合ごとに `ANALYZE` を先に実行し、索引3状態（**なし**／
  **A** = `(contested_with_id) WHERE contested_with_id IS NOT NULL`
  ——本 PR が実際に採る形／**B** = `(tenant_id, contested_with_id)
  WHERE contested_with_id IS NOT NULL`——先頭列を誤った形、変異試験の
  M1、`idx_memories_superseded_by` と同じ形）を**その都度、実行時にのみ**
  作成・削除した（ファイル上のマイグレーションは一切変更していない）。RI
  クエリに対して `EXPLAIN (ANALYZE, BUFFERS)` を各セル5回ずつ実行した。

  | 非NULL割合 | 非NULL行数 | A cost | B cost | **B/A** | Seq Scan cost | A索引サイズ | B索引サイズ | B `Buffers: read=` |
  |---|---|---|---|---|---|---|---|---|
  | 2% | 2,000 | 8.30 | 95.09 | **11.5倍** | 5254.00 | 80 kB | 152 kB | 16 |
  | 10% | 10,000 | 8.30 | 416.97 | **50.2倍** | 5267.00 | 328 kB | 672 kB | 83 |
  | 30% | 30,000 | 8.30 | 1234.04 | **148.7倍** | 5300.00 | 936 kB | 2008 kB | 248 |
  | 60% | 60,000 | 8.43 | 2456.68 | **291.5倍** | 5350.00 | 1872 kB | 4000 kB | 494 |
  | 90% | 90,000 | 8.44 | 3671.38 | **435.0倍** | 5400.00 | 2792 kB | 5984 kB | 740 |

  実行時間の中央値（ms、5回中）: **A** は全割合を通じて **0.062〜0.088** で
  ほとんど動かない。**B** は **0.125 → 0.588 → 2.268 → 2.755 → 3.745** と
  単調に伸びる。Seq Scan は **23.2 → 24.6 → 27.8 → 25.4 → 26.7**。見積もり
  行数・実際行数は**全セルで 1** ——つまりこの表に現れる差は行数見積もりの
  誤りに由来するものではなく、cost・buffers・実行時間そのものに現れている。

  **B が実際に「索引全体を舐めている」ことの裏付け**: B の `Buffers: read=`
  は自分自身のページ数とほぼ一致する（16≈152kB/8kB、83≈672kB/8kB、
  248≈2008kB/8kB、494≈4000kB/8kB、740≈5984kB/8kB）——先頭列で本当に絞れて
  いれば、こうはならない。対する A は索引サイズが伸びても **2〜3 buffer
  read** から動かない——こちらが本物の絞り込みである。

  **線形性**: 隣接する2点間の「非NULL行1件あたりのcost増分」は
  0.0402 / 0.0409 / 0.0408 / 0.0405 ——4通りの独立な推定が互いに約1%以内で
  一致しており、`cost ≈ 0.0405 × 非NULL行数 + 14` という当てはめは90%地点の
  実測値を0.3%以内で予測する。

  ⟹ **🔴 確認されたこと（この節の主眼はここである）**: B は全割合で索引全体を
  舐めており、専用索引（A）に対する cost の比は**ほぼ線形に、頭打ちなく**
  開いていく（測定範囲内で 11.5倍 → 435倍）。**⟹ 「索引が存在し、プランナが
  それを使っている」ことだけを検査するテストは、`contested_with_id` が
  非NULLな行数がまだ少ない段階では緑のまま通り続ける一方、専用索引との
  実コストの差は行数が増えるにつれて2桁も開いていく——テストは緑のまま、
  本番は静かに劣化する。** 下の一般則が実務上支える根拠はここにある。

  🔴 **反証されたこと（埋めずに明記する）**: より強い、より恐ろしい主張——
  「B はいずれ動作しなくなる（索引なしより悪くなる、あるいはプランナに
  見捨てられる）」——は**観測されなかった**。

  - プランナは全割合で一貫して B の Index Scan を選び、一度も Seq Scan に
    フォールバックしなかった。
  - B は全割合で Seq Scan より安いままだった: B/Seq = 0.018 → 0.079 →
    0.233 → 0.459 → 90%時点で **0.680**（1に近づくが、到達はしない）。
  - ⚠ **ここから先は推測であり、測定ではない**: 当てはめた直線を100%
    （上限）まで外挿すると B ≈ 4,064 対 Seq Scan ≈ 5,400 ——依然として
    下回る。つまり**この表の範囲（100,000行、このスキーマの行幅）では、
    上限においてすら交差が無いように見える**。ただし100%そのものは実際
    には播種していない。
  - ⚠ **これも推測であり、測定ではない**: 考えられる機構は、`memories` の
    ヒープ行が広い（text・jsonb・array・複数のタイムスタンプを持つ）ため、
    Seq Scan の1行あたりコストが uuid 単体の索引タプルを舐めるコストより
    はるかに高いから、というものである——**これはこのスキーマの行幅という
    性質であって、一般法則ではない。** ヒープ行がもっと狭いテーブルなら
    交差しうる。他のスキーマでは検証していない。

  **旧い表（cost 0.28..104.06 の行）との数値の食い違いについて**: 上の表の
  2%地点は **95.09** であり、この節冒頭の3行の表にある **104.06** とは
  異なる。**これは黙って一致させない。** 104.06 は元々別の播種・別の実行で
  測った1点（このADR冒頭の表）であり、95.09 は本節のために独立に播種し直
  した5点シリーズの1点である。**どちらも同じ索引の形
  （B = `(tenant_id, contested_with_id)`）を指しており、桁は一致する**
  （どちらも「A の約12〜15倍」のオーダー）——ただし播種のシード・統計
  サンプリング・実行環境が別なら数ポイントのブレは普通に起こる。両方の
  数字をここに残し、どちらか一方を「正しい」としてもう一方を書き換える
  ことはしない。

  **今後このリポジトリで `tenant_id` 先頭の複合索引を見たとき、「テナントで
  絞るクエリ」を供給する索引だと読むのは正しいが、「テナント内のある列を
  指す外部キーの DELETE 時 RI チェックも効率良く供給する」と拡大解釈しない
  こと。** 11.5倍から435倍という実測の差が、この読み方を裏付ける。

- **(b) 一般則: 索引の名前は、その索引が何を供給するかを保証しない**

  `idx_memories_contested` という名前は、素直に読めば「`contested_with_id` の索引」
  に見える。**実体は `(tenant_id, status) WHERE status = 'contested'` であり、
  `contested_with_id` という列は式にも `WHERE` にも一切現れない。** 名前が指すのは
  「係争中 (`contested`) の Memory を引く」という用途であって、`contested_with_id`
  という列名ではない——**名前の類似は偶然であり、保証ではない。**

  **今後このリポジトリで「名前から中身を類推する」ことをしないこと。** 索引が
  実際に何を供給するかを知りたければ、`\d memories`（または移行ファイルの
  `CREATE INDEX` 文そのもの）を読み、列の並びと `WHERE` 述語を確認する。本 PR は
  この読み違いが実際に起こりうることを、`idx_memories_contested` という実例で
  示した——**「`contested` という名前の索引があるから `contested_with_id` は
  もう塞がれている」と誤読した結果として、この穴が長期間見つからずに残っていた
  可能性がある**（本 PR 以前にこの索引が「足りている」と判断された経緯は
  確かめていない。あくまで、この読み違いが起こりうる実例として記録する）。

- **(c) `CREATE INDEX CONCURRENTLY` が使えないことと、引き受ける負債**

  `packages/postgres/src/migrate.ts` は各マイグレーションファイルを丸ごと1つの
  トランザクションで実行する——本 PR の作業者が現物を読んで確認した
  （`migrate.ts:340` の `await client.query("BEGIN");` から `migrate.ts:349` の
  `await client.query("COMMIT");` まで。失敗時は `migrate.ts:352` で
  `ROLLBACK`）。**`CREATE INDEX CONCURRENTLY` はトランザクションブロックの内側
  では実行できない**（PostgreSQL 自体の制約であり、`migrate.ts` の設計を直しても
  この制約自体は消えない）。⟹ この実行系を使う限り、`CONCURRENTLY` という選択肢は
  そもそも存在しない。既存の `0002_outbox_claim_lease_index.sql`・
  `0003_period_ann_stage_index.sql` も同じ理由で素の `CREATE INDEX` を使っており、
  本マイグレーションはその先例と整合している。

  **引き受ける負債として明記する**:

  - **素の `CREATE INDEX` は `ACCESS EXCLUSIVE` ロックを取る。** その間、
    `memories` テーブルへの書き込み（`observe()` からの挿入・`reinforce`・
    `setEmbeddingStatus`・DELETE を含むすべて）が止まる。
  - **100万件級のテーブル（`docs/roadmap.md` がテナントあたりの想定規模として
    前提に置く数字）では、この停止時間が実運用上無視できない長さになりうる**
    ——具体的にどれだけ止まるかはこの PR では測っていない。
  - **⚠ 非トランザクションの移行経路（`CREATE INDEX CONCURRENTLY` を使える実行系）
    を別途作るかどうかは、本 ADR・本 PR の範囲を超える、もっと大きい判断である。**
    本 PR はこれを「そうすべきだ」とは決めない——決めるとしたら、既存の全
    マイグレーションの実行モデル（advisory lock によるプロセス間排他、ADR 0017）
    との整合を含めて再設計が要り、1本の索引追加のために決めることではない。
    **本 PR は意図的にこの手段へ踏み込まない。**

- **(d) 統計情報: 索引を足すだけでは終わらない——オーナーはこれを本 ADR の索引そのものより
  一般に価値があると見ている**:

  本 PR の当初の作業から `ANALYZE memories;`（`packages/postgres/migrations/0005_analyze_memories.sql`）
  が抜け落ちていたことが分かった（経緯は下の「履歴」参照）。それを機に、
  「索引を足すこと」と「その索引の統計をプランナに持たせること」が別の作業である
  ことを、このリポジトリの一般則として記録する。

  **(i) 索引を追加しても、その統計は自動的には生まれない——`ANALYZE` を、行が
  入った後に走らせて初めて生まれる。** 実測:

  | 状態 | `memories` の `pg_stats` 行数 | 式索引の統計行数 | `reltuples`\|`relpages` |
  |---|---|---|---|
  | 空テーブル、`ANALYZE` 実行済み | 0 | 0 | 0\|0 |
  | 100,000行、索引はあるが `ANALYZE` 未実行 | 0 | 0 | **-1**\|0 |
  | 100,000行、`ANALYZE` 実行後 | 27 | **1** | 100000\|3226 |

  `reltuples = -1`（PostgreSQL 14 以降の意味）は「一度も `ANALYZE` されていない」
  ことを表し、この状態では**プランナは行数の見積もりを一切持たない**。`ANALYZE`
  自体は空テーブルに対しても失敗せず成功し、`last_analyze` も更新されるが、
  **サンプルする行が無いので何も集めない。**

  **(ii) 新規インストールでは、その `ANALYZE` はノーオペになる。** マイグレーションは
  空のテーブルに対して順に適用されるため、新規インストールで `0005` が走る時点でも
  `memories` はまだ空である。実測（実際の `runMigrations()` を通した、ADR 0059
  の段1 ANN クエリでの計測）:

  - `0001`〜`0004` を適用（索引は空テーブルの上に作られる、実際のマイグレーションと
    同じ順序）→ 100,000行を投入 → **`ANALYZE` を一切走らせない**まま測定:
    プランナは誤った索引（`idx_memories_recall_gate` + 事後の `Filter`）を選び、
    `reltuples|relpages` は `-1|0`。**35.0 / 39.8 / 42.4 ms。**
  - 同じ状態から `0005`（`ANALYZE memories;`）を実際の migrate 経路で適用:
    プランナは `idx_memories_period_ann_stage` に切り替わり、見積もり **535** 行
    対 実際 **491** 行。**4.6 / 4.5 / 5.6 ms。**
  - 対して「新規インストール順」（`0001`〜`0005` を空テーブルに全部適用してから
    100,000行を投入し、**以降 `ANALYZE` を一切走らせない**）: **37.4 / 33.2 / 32.9 ms**
    ——**本 PR の修正が何も無い場合と統計的に同じ遅さ。**

  ⟹ **これがこの PR で再現できた、クリーンで再現可能なデモンストレーションである。**
  （狭い時間窓での 14.0ms/228.6ms/0.9-3.0ms という、別途配布されていた数字は
  **再現しなかった**——0.62%窓のはずが実際の行数は56,192件ではなく489件であり、
  数字自体が内部矛盾していた。「`ANALYZE` 前は見積もりが悪く、後で正確になる」
  という定性的な筋は変わらないが、具体的な数字はこちらの表で置き換える。）

  ⟹ **本 PR が出す結論**: `0005` を適用しただけでは、新規デプロイでは何も変わらない。
  データを投入した**後**に、運用側（デプロイの手順書・cron・オペレータ操作の
  いずれか）が改めて `ANALYZE` を走らせて初めて統計が生まれる。この運用手順の
  整備自体は本 PR の範囲外——ここでは「必要である」という事実だけを記録する。

- **(e) 履歴: `ANALYZE` はなぜ最初から無かったのか**:

  `ANALYZE memories;` は本来 PR #67（ADR 0059、`0003_period_ann_stage_index.sql`）の
  一部として書かれていた。**それが変異試験の後始末（`git checkout -- <広いパス>`
  でコミット前の作業を戻す操作）によって失われた**——PR #67 を引き継いで完成させた
  委譲者は、`ANALYZE` が欠けた木を受け取っており、それが欠けていること自体を
  知りようがなかった。**⟹ これは設計上の見落としではなく、事故による消失である。**
  `0005` がこの PR で独立したファイルとして存在する理由の一部は、この事故の
  埋め合わせでもある——次に同じことが起きたときの手がかりとして、ここに残す。

- **(f) `superseded_by_id`: 「同じ穴があるはず」という仮説は実測で反証された**:

  当初、`superseded_by_id` にも自己参照 FK があるなら `contested_with_id` と同じ穴
  （RI チェックが `Seq Scan` になる）が空いているはずだという仮説を「確かめていない」
  として残していた。**実測した——反証された。**

  `auto_explain`（`session_preload_libraries` で接続ごとに読み込む。`log_statement =
  'all'` では捕まらない——RI トリガーは SPI 経由で内部的にクエリを発行するため）で
  サーバログから捕まえた実際の RI クエリ:

  ```sql
  SELECT 1 FROM ONLY "public"."memories" x
    WHERE $1 OPERATOR(pg_catalog.=) "superseded_by_id" FOR KEY SHARE OF x
  ```

  `idx_memories_superseded_by`（`(tenant_id, superseded_by_id) WHERE
  superseded_by_id IS NOT NULL`）は**実際にこの RI チェックに使われている**:
  `Index Scan using idx_memories_superseded_by`、cost 0.28..**115.46**、
  中央値 **0.255 ms**（5回: 0.284/0.255/0.298/0.226/0.197）、見積もり=実際=1行。
  `Seq Scan` は一度も出なかった。相互に指し合うペアの `DELETE` を
  `EXPLAIN (ANALYZE)` した実測でも `Trigger for constraint
  memories_superseded_by_id_fkey: time=0.487 calls=2`。

  **使える理由は `tenant_id` が先頭にあることではない——この索引が部分索引であり
  （`superseded_by_id IS NOT NULL` で全体の約2,000/100,000行に絞られる）、先頭列
  `tenant_id` は単に使われていないだけである。** (a) で実測した
  `(tenant_id, contested_with_id)` の挙動と機構は同じ——先頭列は活きていないが、
  索引全体が小さいので舐めても安い。

  ⟹ **`superseded_by_id` には索引を追加する必要が無い。** 既存の
  `idx_memories_superseded_by` で十分。⛔ 追加しない。テストも書かない。

- **マイグレーション番号について**:

  本 ADR の対象の実装は当初 `packages/postgres/migrations/0003_contested_with_index.sql`
  として書かれた。その後 `main` に `0003_period_ann_stage_index.sql`（ADR 0059、PR #67）
  がマージされ、`0003_*` が2本になる状態を避けるため、本 PR の作業として
  `0004_contested_with_index.sql` へ改名した（`git mv` + ファイル先頭の自己参照コメント
  + テストファイル内の参照を追随。詳細はコミットメッセージ・PR 参照）。索引の定義・
  テストの assert・本 ADR が扱う3点の論旨には変更を加えていない。

  **⭐ この改名が `_mnemora_migrations` の台帳（ledger）とどう相互作用するかを実測した。**
  旧名 `0003_contested_with_index.sql` として一度適用済みのデータベースに対し、
  改名後の `0004_contested_with_index.sql` を適用しようとすると、台帳はこのファイルを
  「未適用」として扱うため再実行される。実測した失敗は逐語で:

  ```
  migration 0004_contested_with_index.sql failed: relation "idx_memories_contested_with" already exists
  ```

  （SQLSTATE `42P07`）。トランザクションはロールバックし、`0004` は台帳に入らず、
  以降のあらゆる `migrate` 呼び出しが同じ理由で同様に失敗し続ける。

  **`CREATE INDEX IF NOT EXISTS` にすればこの衝突は消える——が、その代償も実測した。**
  そのテーブル名の場所に無関係な別の索引（`ON memories (tenant_id)`、列も述語も違う）
  が既に存在する状態で `CREATE INDEX IF NOT EXISTS idx_memories_contested_with ...`
  を実行すると、**`migrate` はエラーも警告も出さずに成功したと報告し、台帳にも
  行を記録した——ただし実際に存在する索引の定義は、間違ったまま変わらない。**
  ⟹ **決定: `IF NOT EXISTS` は付けない。** エラーで止まる方が、統計も気付かず
  間違った索引が居座り続けるよりましである。

  ただし: **`main` にはこのファイルが旧名 `0003_contested_with_index.sql` として
  存在したことは一度も無い**（この問題はこの未マージのブランチだけで起きた自己完結
  した事象であり、旧名は `main` にマージされていない）。⟹ **通常のアップグレード
  経路でこの衝突が起きることはない**——開発環境・CI のサンドボックスでブランチを
  行き来する場合にだけ起こりうる、開発時限定の懸念として記録する。

- **採らなかった案**:

  - **`(tenant_id, contested_with_id)` の複合索引にする**（`idx_memories_superseded_by`
    と同じ形）。却下。上記 (a) の実測により、この形は **使えないわけではない**
    （`Index Scan`、cost 0.28..104.06——`Seq Scan` の 5254.00 よりずっと安い）。
    それでも `contested_with_id` 単独の専用索引（cost 0.28..8.29）と比べて約12倍
    重く、`tenant_id` を先頭に置く理由（テナントで絞る他のクエリを兼ねる）がこの
    索引には無い（RI チェックは `tenant_id` を使わない）ため、専用の索引を別に
    持つほうが安い。「使えないから却下」ではなく「使えるが専用の索引より高いから
    却下」に訂正する。
  - **無条件の単一列索引（`WHERE` 句なし）にする。** 部分索引（`WHERE
    contested_with_id IS NOT NULL`）と比較し、CI の `EXPLAIN` 実測でどちらが
    実際にプランナから選ばれるかで決めた。`$1 = contested_with_id` という
    strict な等号演算子は、一致する行の `contested_with_id` が `NULL` ではあり
    得ないことを含意し、プランナはこの含意を使って部分索引の述語を証明できる。
    実測でこの部分索引が実際に選ばれることを確認できたため、より小さい部分索引を
    採用した（`idx_memories_superseded_by`・`idx_memories_contested` と同じ
    「NULL が多数派の列は部分索引にする」という、このスキーマの既存の規約にも合う）。
  - **`CREATE INDEX CONCURRENTLY` を使える形に `migrate.ts` を書き換える。**
    マネージャーの指示によりこの PR の権限の外——(c) 参照。

- **⭐ 変異試験の結果（実測済み）**:

  `packages/postgres/src/__tests__/contested-with-index.test.ts` に列順の assert を
  足す前後で、3つの変異を実際の PostgreSQL に当てて赤/緑を確認した。

  - **列順の assert を足す前**: **M1**（索引を `(tenant_id, contested_with_id)` に
    変え、先頭列を破壊する）は **緑のまま生き残った**。**M2**（`WHERE` 述語を消す）
    も**緑のまま生き残った**。**M3**（索引の `CREATE INDEX` 文自体を削除する）だけが
    赤になった。
  - **列順の assert を足した後**（コミット `28c3d85`、本ブランチに既に載っている）:
    **M0**（対照、変異なし）は緑。**M1 は赤**
    （`AssertionError: expected 'tenant_id' to be 'contested_with_id'`）。
    **M2 は赤**（`expected false to be true`、`is_partial` を検査する assert 上で）。
    **M3 は赤**（3本とも失敗）。

  各変異は**まっさらなデータベースに対して**実行した——台帳（`_mnemora_migrations`）に
  既に記録されたマイグレーションは `migrate` から黙ってスキップされるため、使い回しの
  DB では変異を当てても「未適用のまま既存の索引が残っている」だけで緑になり、判定が
  意味を失う。実行ごとに2つの証拠（`_mnemora_migrations` に該当行があること、
  `pg_indexes.indexdef` が変異後の定義になっていること）で、変異が実際に適用された
  ことを確認した。

  **⚠ この歯がまだ捕まえていないもの**: **索引の形が正しく存在するのに、統計が
  無いためプランナがそれを選ばない**というケース。この歯は `CREATE INDEX` 文の
  形だけを検査しており、`ANALYZE` の有無をプランの選択として検査してはいない
  ——(d) の統計の話は、この歯の外側にある。

  **参考: `0004` は `ANALYZE` 前後で挙動が変わらない。** テスト自体が
  バルク INSERT 直後、両方の `it()` の前に `ANALYZE memories` を実行済み
  （`contested-with-index.test.ts:131`）。独立に再現: `Index Scan using
  idx_memories_contested_with`、cost 0.28..**8.29**、中央値 **0.085 ms**
  （5回: 0.087/0.082/0.085/0.097/0.097）、見積もり=実際=1行。**(a) の部分索引の
  見積もり過小の罠を受けない**——RI チェックは索引化された列そのものへの
  **点等値**であり、`=` の選択度は部分集合からの外挿ではなく厳密だから。⟹ `0004`
  を非部分索引にする必要は無い。

- **これが覆るとしたら**:

  - **`ACCESS EXCLUSIVE` ロックの停止時間が実運用で許容できない長さになると
    判明したら**、非トランザクションの移行経路を別途設計する、より大きな判断の
    引き金になる（(c) 参照）。
  - **CI の `EXPLAIN` 実測で `idx_memories_contested_with` が選ばれなかった場合**、
    索引の形（部分/無条件、列の追加）を見直す。
  - **(a) の「B は100%地点（上限）でも Seq Scan を上回らない」という外挿
    （当てはめた直線を延長しただけで、100%そのものは播種していない）が、
    実際に100%を播種して反証された場合**、(a) のその部分を実測値で差し替える。
  - **(a) の「Seq Scan が高いのは `memories` のヒープ行が広いからだ」という
    機構の説明（推測であり測定ではない）が、行幅の狭い別のスキーマで検証され、
    そちらでは挙動が異なる（あるいは同じ）ことが確かめられた場合**、この
    推測を一般法則へ格上げする、あるいは「このスキーマ固有」として確定させる。

- **確かめていないこと**:

  - **本 PR 以前にこの穴（`contested_with_id` の RI チェックが `Seq Scan` になる）が
    見つからなかった経緯・理由は確かめていない。** 「索引名から中身を誤読した」は
    ありうる説明として (b) に書いたが、実際の経緯（そもそも気づかれていなかったのか、
    気づいた上で後回しにされたのか）は調べていない。
  - **`ACCESS EXCLUSIVE` ロックの実際の停止時間**（100万件級のテーブルでどれだけ
    書き込みが止まるか）は測っていない。
  - **(a) の「B は100%地点（上限）でも Seq Scan を上回らない」という主張は、
    当てはめた直線を100%まで延長しただけの推測である。** 100%そのもの
    （非NULL行が全件）は実際には播種しておらず、実測していない。
  - **(a) の「Seq Scan が高いのは `memories` のヒープ行が広いからだ」という
    機構の説明は推測である。** 行幅の狭い別のスキーマでこの機構を検証しては
    いない——これがこのスキーマ固有の性質なのか、一般法則なのかは確かめていない。
  - **PR #67 で `ANALYZE` が失われた経緯**は、コミット履歴・変異試験の後始末の
    記録から推測したものであり、`git reflog` 等で当時の操作列そのものを追跡した
    わけではない——(e) の記述は伝えられた経緯の要約である。
