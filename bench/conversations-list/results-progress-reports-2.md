# `/progress` と `/reports` の測り 2: 本番に近い密度の別 DB（`alteroid_bench2`）

観測は 2026-10-25T07:22Z〜08:03Z（UTC）。`BENCH_WRAP=bus` は main **7476b801528a8ed291f513cc82d1a009a459de3c**（#5262 マージ済み。前回 `git merge origin/main` で取り込み、`--filter "@alteroid/daemon..." build` 済み。この測りの間に取り込み直していない）。`legacy` は #5262 の前の `createJournalBus` の再現（6 つの口だけ）。
PG は `postgres://postgres@127.0.0.1:55931/alteroid_bench2`（`alteroid_bench` から `create database … template alteroid_bench` で写した。元の `alteroid_bench` は触っていない）。生の出力は `out/`（`b2-*` = 索引なし、`b2idx-*` = `journal_type_seq_idx` あり。ファイル名に口・包み・時刻）。
計器の注意: 器は共有・PG と測りは同じ器の中（ネットワークの往復はほぼ 0）。2026-10-25T08:01Z に PG が止まっているのを `cold` の最初の run が起こした（`pg_ctl: PID file … does not exist … trying to start anyway`。再起動の測りなので影響は無い）。

## 1. データ（`BENCH_STEP=density` の生の出力。2026-10-25T07:22:44Z）

```
daily_report before {"n":"7495","d":"117"}
daily_report deleted=7373 after {"n":"122","d":"117"}
PROBE github_observation {"repo":"takecchi/alteroid","limit":500,"query":"is:open","result":{"ci":{"pulls":3,"checks":"ci: 2 success / 1 failure","failure":1,"pending":0,"success":2},"status":"ok","openPulls":3,"truncated":false,"openIssues":12},"observedBy":"clone"}
github_observation rows=300 readable=300
生きている人間との会話 1200（未了の台帳の会話 id は新しい 120 から取る）
commitments entries=1500 unreadable=0 open=60
jobs entries=3000 unreadable=0 running=5
```

`BENCH_STEP=rows`（07:23:08Z、VACUUM ANALYZE の後）: `{"daily_report":122,"daily_report_distinct_dates":117,"github_observation":300,"commitments":1500,"commitments_open":60,"jobs":3000,"journal_total":493227}`

| 項目                   | 行数（alteroid_bench2）             | 元（alteroid_bench） |
| ---------------------- | ----------------------------------- | -------------------- |
| `daily_report`         | 122（117 日。5 日だけ 2 行）        | 7,495                |
| `github_observation`   | 300（成功 95%・失敗 5%、repo 2 種） | 0                    |
| commitments            | 1,500（未了 60）                    | 0                    |
| jobs                   | 3,000（running 5・waiting_human 1） | 0                    |
| journal 全体           | 493,227                             | 500,300              |
| conversation_deleted   | 300                                 | 300                  |
| exchange（with=human） | 19,715（元のまま）                  | 19,715               |

- `github_observation` は、消した `daily_report` の `seq`・`at` の穴 300 個に入れてある。日誌の中で時刻順・`seq` 順に散らばる（末尾に固まらない）。形は本物の `append` の保存形（上の PROBE）に合わせ、`journalEntrySchema` で 300 行とも読めることを確かめた（`readable=300`）。
- 台帳・jobs は本物のストアの口（`commitments.open` / `close`・`jobs.putJob`）で書き、読み戻しで `unreadable=0`。未了 60 の `source`（会話 id）は、日誌に実在し墓標で消されていない人間との会話のうち、最終発言が新しい 120 会話から取った。
- 大きさ: journal の表（heap + TOAST）649MB、索引合計 129MB（`journal_type_seq_idx` 19MB を含む。索引なしは約 110MB）。

## 2. 温まった（`/progress`・`/reports`、3 回の助走の後の 21 回、直列。単位 ms）

「/」は中央値 / p90 / 最大。DB 本数は `Server-Timing` の `DB n queries`（内訳の SQL 本数と一致）。

| 口                 | legacy（索引なし）           | DB  | bus（索引なし）             | DB  | bus + `journal_type_seq_idx` | DB  |
| ------------------ | ---------------------------- | --- | --------------------------- | --- | ---------------------------- | --- |
| `/progress`        | **498.89 / 581.82 / 652.55** | 8   | **83.99 / 102.22 / 113.27** | 8   | **59.06 / 67.23 / 69.34**    | 8   |
| `/reports?limit=1` | 5.85 / 7.71 / 9.20           | 2   | 6.54 / 11.07 / 17.43        | 2   | 5.98 / 7.19 / 9.20           | 2   |
| `/reports?limit=7` | 5.91 / 7.62 / 9.91           | 2   | 5.90 / 7.89 / 9.91          | 2   | 7.99 / 14.56 / 21.76         | 2   |

出所: `b2-route-{progress,reports,reports7}-{legacy,bus}-…` と `b2idx-route-{progress,reports,reports7}-bus-…`。`/reports?limit=7` の応答は 29,200 バイト、`limit=1` は 7,962、`/progress` は 1,984。

### `/progress` の SQL の内訳（温まった 1 回、client 側の ms）

| 文                                                                                   | legacy 本数 / ms                                                      | bus 本数 / ms                             | bus + 索引 本数 / ms |
| ------------------------------------------------------------------------------------ | --------------------------------------------------------------------- | ----------------------------------------- | -------------------- |
| 人間との往復を本文ごと全部（`with=human`、上限なし。`readConversationWindow`）       | **1 本、合計 338.87 ms（下の github 観測の頁と合わせた 2 本の合計）** | 無い（`humanReplies` の覚えに置き換わる） | 無い                 |
| `humanReplies`（`select "seq","at","entry"->>'conversationId' …`。覚えへの足し読み） | 無い（口が無い）                                                      | 1 本 / 2.45                               | 1 本 / 1.49          |
| `github_observation` の頁（502 行）                                                  | 上に含む                                                              | 1 本 / 3.08                               | 1 本 / 2.73          |
| jobs 全件（`select "id", xmin::text, "updated_at" from "jobs"`）                     | 2 本 / 11.30                                                          | 2 本 / 11.03                              | 2 本 / 10.65         |
| commitments（未了 / 閉じた行の判定）                                                 | 2 本 / 10.11                                                          | 2 本 / 6.67                               | 2 本 / 10.92         |
| 墓標の印（`count(*)`）                                                               | 2 本 / 3.56                                                           | 2 本 / 3.31                               | 2 本 / 2.05          |
| client 側の SQL 合計 / JS 側（合計 − SQL）                                           | 363.83 ms / ≈ 116.9 ms                                                | 25.53 ms / ≈ 36.1 ms                      | 27.84 ms / ≈ 30.7 ms |

legacy の「人間との往復を本文ごと」の 1 本は、`journal.humanReplies` が無いので 16,191 行（`with=human`、墓標で外れた行を除く）の本文ごと（`entry` 丸ごと）を読み、JS 側で解析する（JS ≈ 117 ms の主因）。bus は同じことを `humanReplies`（会話 id と時刻だけを覚えて足し読み）で済ませる。
legacy の `github_observation` の頁と上の本文ごとの 1 本は、出力の集計行（`x2 338.87 ms`）では同じ指紋に畳まれるため、2 本の合計しか出ない（`out/b2-route-progress-legacy-…` の `SQL warm call`）。個別の時間は下の EXPLAIN（本文ごとの 1 本のサーバ側 134 ms、`github_observation` の頁 0.5 ms）。

`/reports` の SQL（legacy・bus とも同じ 2 本、client 側の合計 3.6〜4.0 ms）: 墓標の印と、`daily_report` の窓（`limit + 33` 行、`order by seq desc`）。

## 3. 冷え（PG 再起動直後の最初の 1 回。単位 ms）

再起動のみは、`shared_buffers` 空・OS キャッシュ温かい。OS 落としは、日誌の関係ファイル（索引あり: 14 本・なし: 13 本）の OS キャッシュも `dd iflag=nocache count=0` で落とした版。call#2〜#5 は 2 回目以降。

| 口 / 条件                             | 再起動のみ call#1 | #2 / #3 / #4 / #5     | OS 落とし call#1 | #2 / #3 / #4 / #5         |
| ------------------------------------- | ----------------- | --------------------- | ---------------- | ------------------------- |
| `/progress` legacy（索引なし）        | 924.95            | 424 / 434 / 480 / 493 | **7,270.03**     | 523 / 471 / 448 / 405     |
| `/progress` bus（索引なし）           | 688.22            | 75 / 65 / 62 / 67     | **5,202.89**     | 82 / 170 / 208 / 104      |
| `/progress` bus + 索引                | 848.20            | 147 / 67 / 74 / 76    | **4,712.42**     | 80 / 74 / 93 / 69         |
| `/reports?limit=1` legacy（索引なし） | 173.89            | 8.6 / 7.7 / 6.1 / 6.3 | 231.80           | 6.6 / 7.0 / 5.8 / 6.6     |
| `/reports?limit=1` bus（索引なし）    | 83.98             | 7.4 / 7.3 / 8.3 / 7.5 | 434.08           | 14.8 / 18.1 / 11.2 / 10.4 |
| `/reports?limit=1` bus + 索引         | 90.31             | 6.3 / 6.0 / 5.5 / 5.7 | 186.18           | 7.3 / 5.3 / 5.7 / 5.2     |

出所: `b2-cold-{progress,reports}-{legacy,bus}[-evict]-…`、`b2idx-cold-{progress,reports}-bus[-evict]-…`。1 回ずつの測りなので、`/reports` の 90〜430 ms の差（特に OS 落としの bus 索引なし 434 ms）は揺れを含み、差とは読まない。`/progress` の call#1 は、legacy・bus ともに「会話・日誌の大きな読みの最初の 1 回」を含む。

## 4. 最長の文の EXPLAIN（`EXPLAIN (ANALYZE, BUFFERS)`。ページ数は shared hit / read、時間はサーバ側）

全文は `out/b2-explain-progress-legacy-…`・`b2-explain-progress-bus-…`・`b2-explain-reports-{legacy,bus}-…`・`b2idx-explain-progress-bus-…`・`b2idx-explain-reports-bus-…`。

### 4.1 `/progress`

| 文                                                                                                            | 条件                                                       | 温まった                            | PG 再起動のみ                       | OS 落とし                                        |
| ------------------------------------------------------------------------------------------------------------- | ---------------------------------------------------------- | ----------------------------------- | ----------------------------------- | ------------------------------------------------ |
| 人間との往復を本文ごと全部（legacy のみ。16,191 行、`journal_human_exchange_seq_idx` の Index Scan Backward） | 索引なし                                                   | hit 32,911 + read 18,924 / 134.1 ms | hit 30,715 + read 21,143 / 230.7 ms | read 21,143 / **6,611 ms**（read 待ち 6,343 ms） |
| **`github_observation` の頁**（`type='github_observation'`、502 行、300 行返る）                              | 索引なし（`journal_type_at_idx` の Index Scan + Sort）     | hit 289 / 0.51 ms                   | hit 257 + read 35 / 1.06 ms         | read 35 / 10.5 ms                                |
| **`github_observation` の頁**                                                                                 | `journal_type_seq_idx` あり（Index Scan Backward + Limit） | hit 292 / 0.28 ms                   | hit 257 + read 35 / 0.63 ms         | read 35 / 9.4 ms                                 |
| 墓標の印（`count(*)` と最大 `seq`、300 行）                                                                   | 索引なし（`journal_type_at_idx` の Bitmap Heap Scan）      | hit 303 / 0.32〜0.43 ms             | read 303 / 3.1〜4.5 ms              | read 303 / **86.9〜89.3 ms**                     |
| 墓標の印                                                                                                      | `journal_type_seq_idx` あり（Index Only Scan）             | hit 6 / 0.08 ms                     | read 6 / 0.28 ms                    | read 6 / **1.04 ms**                             |
| `humanReplies` の足し読み（bus。`seq > 499181`）                                                              | 索引なし / あり                                            | hit 217 / 0.21〜0.30 ms             | hit 202 + read 38 / 0.6 ms          | read 38 / 12.2〜13.1 ms                          |
| jobs 全件（Seq Scan、3,000 行）                                                                               | 同じ                                                       | hit 382 / 2.1〜4.0 ms               | read 382 / 4.8〜7.7 ms              | read 382 / 9.9〜11.8 ms                          |
| commitments 閉じた行（Seq Scan、1,440 行）                                                                    | 同じ                                                       | hit 374 / 1.6〜2.2 ms               | read 374 / 3.9〜5.3 ms              | read 374 / 3.9〜6.6 ms                           |

**`github_observation` の頁の計画（確かめるよう依頼された点）**: `github_observation` が 300 行（501 未満）でも、日誌の主キーを全部辿る計画には**なっていない**。索引なしでは `journal_type_at_idx` の `type = 'github_observation'` の範囲を引き、300 行を `seq` で Sort して Limit する計画で、触るのは 289 ページ（heap の 300 行ぶん）・0.5 ms。VACUUM ANALYZE の後は、`type` の分布の統計（`github_observation` は 0.06%）が効くためと考える（**推論**。`VACUUM ANALYZE` の前の計画は取っていない）。`(type, seq)` の索引を足すと Sort が消えて Index Scan Backward + Limit になるが、触るページは 292 でほぼ同じ（行の本文を読む heap のページが主）。
生の要所（索引なし、温まった）:

```
Limit  (cost=1144.43..1145.03 rows=240 width=615) (actual time=0.435..0.473 rows=300 loops=1)  Buffers: shared hit=289
  ->  Sort  Sort Key: seq DESC  Sort Method: quicksort  Memory: 177kB
        ->  Index Scan using journal_type_at_idx on journal  (cost=1.61..1134.95 rows=240 width=615) (actual time=0.030..0.234 rows=300 loops=1)
              Index Cond: (type = 'github_observation'::text)
```

索引あり（温まった）:

```
Limit  (cost=1.61..1132.15 rows=240 width=609) (actual time=0.032..0.236 rows=300 loops=1)  Buffers: shared hit=292
  ->  Index Scan Backward using journal_type_seq_idx on journal  (cost=1.61..1132.15 rows=240 width=609) (actual time=0.031..0.202 rows=300 loops=1)
```

### 4.2 `/reports?limit=1`

| 文                                                | 条件                                                                                  | 温まった                     | PG 再起動のみ                | OS 落とし                         |
| ------------------------------------------------- | ------------------------------------------------------------------------------------- | ---------------------------- | ---------------------------- | --------------------------------- |
| `daily_report` の窓（34 行、`order by seq desc`） | 索引なし（`journal_type_at_idx` の Index Scan → Sort → Limit。実際 122 行から 34 行） | hit 191 / 0.22 ms            | read 191 / 2.19 ms           | read 191 / **68.7 ms**            |
| `daily_report` の窓                               | `journal_type_seq_idx` あり（Index Scan Backward → Limit）                            | hit 37 / 0.075 ms            | read 37 / 0.31 ms            | read 37 / **11.0 ms**             |
| 墓標の印                                          | 索引なし → あり                                                                       | hit 303 → 6 / 0.35 → 0.09 ms | read 303 → 6 / 3.3 → 0.20 ms | read 303 → 6 / 90.8 → **1.01 ms** |

## 5. 索引 `journal_type_seq_idx on journal (type, seq)`

- 作成: `create index concurrently journal_type_seq_idx on journal (type, seq)`（2026-10-25T07:27Z。数秒）→ `VACUUM ANALYZE journal`。
- 大きさ: `pg_relation_size('journal_type_seq_idx')` = **20,062,208 バイト（19 MB）**。journal の索引合計は 129MB（索引なしは約 110MB）。表（heap + TOAST）は 649MB。
- 測りの後に `drop index concurrently journal_type_seq_idx` で落とした（`pg_indexes` に 0 行を確認）。

## 6. 見立て（実測と分けて）

**実測で言えること（この DB の上で）**

- `/progress` は、legacy 499 ms・8 本、bus 84 ms・8 本、bus + 索引 59 ms・8 本（中央値）。**legacy が重い原因は、`journal.humanReplies` が無いため人間との往復 16,191 行を本文ごと全部読む 1 本**（サーバ側 134 ms・51,835 ページ。client 側は転送と JS の解析を含めて約 340 ms + JS 約 117 ms）。bus はそれを `humanReplies`（会話 id と時刻だけの覚え）に置き換えるので、足し読みは 217 ページ・0.2 ms で済む。
- 冷え（OS 落とし）の `/progress` の 1 回目は、legacy 7.3 秒・bus 5.2 秒・bus + 索引 4.7 秒。legacy の本文ごとの 1 本は 21,143 ページを read して 6.6 秒。bus の 1 回目は、覚えが空のとき `humanReplies` が全返答 9,491 行を読む最初の 1 回（`conversation_outbound_latest` など別の読みも含む）で、2 回目以降は約 70〜200 ms に落ちる。
- `/reports?limit=1` は legacy・bus・索引の有無で温まった 6 ms 前後のまま変わらない（日報 122 行・密度 0.025% でも、統計が効いて `journal_type_at_idx` の Index Scan + Sort を選び、191 ページで済む）。**前回の密度の偽データ（日報が 1.5%）で懸念した「日誌の主キーを全部辿る」計画は、この密度でも出なかった**（`ANALYZE` の後）。
- `(type, seq)` の索引を足すと: 日報の窓は 191 → 37 ページ（OS 落としで 68.7 → 11.0 ms）、墓標の印は 303 → 6 ページ（OS 落としで 90.8 → 1.0 ms）。`github_observation` の頁は 289 → 292 ページでほぼ変わらない（行の本文を読むため）。`/progress` の温まった中央値は 84 → 59 ms（墓標の印 2 本・commitments などの揺れも含み、差のうち索引の分は分けて測っていない）。

**見立て（推論。測っていない）**

- 本番の `/progress` の遅さの主因は、`createJournalBus` の包みが `humanReplies` を落とし、人間との往復を本文ごと全部読むことだと考える（この枝の legacy で再現した形）。本番は人間との往復の総数がここより多いほど（ここは 16,191 行・51,835 ページ）読むページ数がそれに比例して増える。
- `(type, seq)` の索引は、墓標の印（日誌を読むたびに 1 本、`/conversations` の頁送りでは何十本も流れる）と日報の窓の冷えた read を減らすが、`/progress` の主因（本文ごとの全件読み）には効かない。効果は、冷えた read のページ数の減（303 → 6 など）が本番の遅いディスクでどれだけ時間になるかに依る（この器の OS 落としでは 1 ページ約 0.3 ms）。
- `github_observation` を 501 行未満にしても、`ANALYZE` 済みなら主キー全走査の計画にはなっていない。ただし統計が古い・無いとき（`VACUUM ANALYZE` の前、新しく足した直後）の計画は取っていない。

## 7. 確認していないこと

- 本番の台帳・jobs・`github_observation`・日報の本物の分布。密度は依頼の数に合わせたが、本物の `github_observation` の 1 行の大きさ・`commitments.body` の長さは推定。
- 統計の無い状態（`ANALYZE` の前）の計画。
- 索引ありで legacy・none の測り（依頼は bus のみ）。
- 全体のテスト・`scripts/*.test.ts` が `bench/` に反応しないか。

## 8. 実行したコマンド（時刻は UTC）

`<cmd>` = `pnpm -C /tmp/mgr-bd7bd1b3-bench exec vitest run --config bench/conversations-list/vitest.config.ts bench/conversations-list/run.bench.ts --silent`（`BENCH_PG_URL=postgres://postgres@127.0.0.1:55931/alteroid_bench2 BENCH_QUIET=1` を付けた）

```
07:22Z  create database alteroid_bench2 template alteroid_bench
07:22Z  env BENCH_STEP=density … density.bench.ts / VACUUM ANALYZE journal, commitments, jobs / BENCH_STEP=rows
07:23Z〜07:24Z  env BENCH_STEP=route BENCH_ROUTE={progress,reports,reports7} BENCH_WRAP={legacy,bus} BENCH_TAG=b2 <cmd>
07:24Z〜07:25Z  env BENCH_STEP=cold BENCH_ROUTE={progress,reports} BENCH_WRAP={legacy,bus} [BENCH_EVICT=1] BENCH_TAG=b2 <cmd>
07:25Z〜07:27Z  env BENCH_STEP=explain BENCH_ROUTE={progress(BENCH_TOP=8),reports(BENCH_TOP=3)} BENCH_WRAP={legacy,bus} BENCH_TAG=b2 <cmd>
07:27Z  create index concurrently journal_type_seq_idx on journal (type, seq) / VACUUM ANALYZE journal / pg_relation_size
07:27Z〜07:28Z  env BENCH_STEP=route BENCH_ROUTE={progress,reports,reports7} BENCH_WRAP=bus BENCH_TAG=b2idx <cmd>
08:01Z〜08:02Z  env BENCH_STEP=cold BENCH_ROUTE={progress,reports} BENCH_WRAP=bus [BENCH_EVICT=1] BENCH_TAG=b2idx <cmd>（PG が止まっていたのを起こした）
08:02Z  env BENCH_STEP=explain BENCH_ROUTE={progress(BENCH_TOP=8),reports(BENCH_TOP=3)} BENCH_WRAP=bus BENCH_TAG=b2idx <cmd> / BENCH_STEP=env
08:03Z  drop index concurrently journal_type_seq_idx
```
