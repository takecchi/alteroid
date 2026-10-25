# `/progress` と `/reports` の測り（#5264）

観測は 2026-10-25T07:13Z〜07:20Z（UTC）。worktree は枝 `bench/conversations-list-5140`。`BENCH_WRAP=bus` の値は、今の main **7476b801528a8ed291f513cc82d1a009a459de3c**（#5262 マージ済み）を `git merge origin/main` で取り込み、`pnpm --filter "@alteroid/daemon..." build` し直した後に取り直したもの（取り込み前の bus の値は out/ に残し、本文の表は取り直した値）。PG は同じ `alteroid_bench`（ポート 55931）。生の出力は全部 `out/`（ファイル名に口・包み・時刻）。

**先に結論: この偽データでは `/progress` も `/reports` も 5〜7 ms で、(legacy) と (bus) に差が出なかった。ただしこのデータは両方の口の重い部分を踏んでいない（下の「データの限界」）。本番の遅さの再現にはなっていない。**

## 測りの道具に足したもの

- `BENCH_WRAP=legacy`: #5262 の前の `createJournalBus` の再現。`append`（購読者への通知つき）/ `list` / `listPage` / `get` / `oldestAt` / `clear` の6つだけを並べたオブジェクトを、`run.bench.ts` の `legacyJournalBus` に書き写した。`bus` は今の `createJournalBus`（`wrapJournalStore` で残りの口を中身へ通す）、`none` は包まない。
- `BENCH_ROUTE`: `conversations`（既定）/ `progress`（`GET /progress`。Web の `useProgress()` の既定＝`windowHours` を渡さない）/ `reports`（`GET /reports?limit=1`）/ `reports7`（`GET /reports?limit=7`）。
  - Web の `/reports` の limit: `packages/swr/src/hooks/queries.ts` の `useReports(limit = 7)` が既定 7。実際の呼び元は `apps/web/app/routes/dashboard-report.tsx` の `useReports(1)`（limit=1）。そこで limit=1 を主、limit=7 を参考に測った。
- 段 `route`（温まった 21 回・SQL の内訳）・`rows`（行数）。`cold` と `explain` は `BENCH_ROUTE` を渡すとその口を測る（`explain` は client 側で長かった文から `BENCH_TOP` 本、既定 3）。

## データの行数（`out/rows-bus-2026-10-25T071345.453Z.txt`、2026-10-25T07:13:45Z）

```
{"daily_report":7495,"daily_report_distinct_dates":117,"github_observation":0,"commitments":0,"commitments_open":0,"jobs":0,"journal_total":500300}
```

**足りない（足していない。増やすなら相談とのことなので、そのまま測った）:**

- `github_observation` 0 行（`/progress` の `github` 欄の読みが空振りする）。
- 台帳（`commitments`）0 行・`jobs` 0 行（`/progress` の積み上がり・実施中・片付いた速度の集計が空）。
- `daily_report` は 7,495 行・日付 117 日（1 日平均 64 行）。本物は 1 日 1〜数行（約 117 行）のはずで、偽データは 60 倍ほど多い。日報の窓の読み（`journal_pkey` を `seq` の降順に辿り `type` で絞る計画）は、種別の密度が高いほど早く 34 行に届く。本物のように稀（全体の 0.02%）だと、同じ計画が `journal` の大半を辿る可能性がある（**推論。測っていない**）。

## 1. 温まった（3 回の助走の後の 21 回、直列）

単位 ms。「/」は中央値 / p90 / 最大。DB 本数は `Server-Timing` の `DB n queries`（`warm call (内訳)` の SQL の本数と一致）。

**bus は今の main（7476b801528a8ed291f513cc82d1a009a459de3c。#5262 取り込み済み）を取り込んで `--filter "@alteroid/daemon..." build` し直した後の値**（2026-10-25T07:18Z）。legacy は取り込み前（07:13Z）と、bus と同じ負荷の時間帯に取り直した値（07:18Z）の 2 つを出す（器が共有で、07:18Z 台は全体に 1〜3 ms 遅く揺れていたため、同じ時間帯どうしで比べる）。

| 口                 | legacy 07:18Z 中央値 / p90 / 最大 | DB 本数 | bus（main 7476b801）中央値 / p90 / 最大 | DB 本数 | （参考）legacy 07:13Z 中央値 / p90 / 最大 |
| ------------------ | --------------------------------- | ------- | --------------------------------------- | ------- | ----------------------------------------- |
| `/progress`        | 10.01 / 14.89 / 19.69             | 6       | 8.48 / 15.01 / 20.17                    | 6       | 7.12 / 11.30 / 18.55                      |
| `/reports?limit=1` | 7.24 / 10.27 / 14.27              | 2       | 8.01 / 13.48 / 19.77                    | 2       | 6.20 / 7.76 / 8.73                        |
| `/reports?limit=7` | 7.50 / 10.09 / 11.76              | 2       | 7.57 / 10.90 / 15.19                    | 2       | 6.35 / 8.51 / 11.20                       |

出所（out/）: legacy 07:18Z は `route-{progress,reports,reports7}-legacy-2026-10-25T0718…`、bus は `route-{progress,reports,reports7}-bus-2026-10-25T0718…`、legacy 07:13Z は `route-…-legacy-2026-10-25T0713…`〜`0714…`。取り込み前の bus（07:14Z。`-bus-…0714…`）の値は `/progress` 6.39 / 7.66 / 8.05、`/reports?limit=1` 6.91 / 8.77 / 12.32、`limit=7` 5.85 / 7.01 / 9.01 で、同じく legacy との差は無い。

最初の 1 回（プロセス起動直後・PG は温。起動の裏の問い合わせ約 14 本を含む。本数は 11〜20）: bus 07:18Z は `/progress` 254.80 / `/reports?limit=1` 181.79 / `limit=7` 87.81、legacy 07:18Z は 99.65 / 71.01 / 68.26（最初の 1 回はキャッシュの状態でばらつきが大きく、差とは読まない）。応答の大きさ: `/progress` 1,106 バイト、`/reports?limit=1` 7,962、`/reports?limit=7` 34,748。

### SQL の内訳（温まった 1 回、client 側の ms。legacy と bus で文も本数も同じ）

`/progress`（6 本、合計 3.43 ms〈legacy〉/ 4.16 ms〈bus〉、JS 側 ≈ 1.6〜2.1 ms）:

| 文（先頭）                                                                                                      | 本数 | ms（legacy） |
| --------------------------------------------------------------------------------------------------------------- | ---- | ------------ |
| `select "id","at","type","entry" from "journal" where (… type = 'github_observation' …)`（頁 502 行）           | 1    | 0.98         |
| `select "id","at","commitment" from "commitments" where "closed_at" is null order by …`                         | 1    | 0.88         |
| `select count(*)::text \|\| ':' \|\| coalesce(max("seq"),0)::text from "journal" where "type" = $1`（墓標の印） | 1    | 0.81         |
| `select "id", xmin::text, "updated_at" from "jobs" order by "created_at"`                                       | 2    | 0.44         |
| `select "id", xmin::text \|\| '/' \|\| ctid::text from "commitments" where "closed_at" is not null or …`        | 1    | 0.32         |

`/reports?limit=1` と `limit=7`（2 本、合計 4.9 ms / 4.8 ms、JS 側 ≈ 1.8 ms）: 墓標の印 1 本（1.3〜1.5 ms）と、`select "id","at","type","entry" from "journal" where (… type = 'daily_report') order by seq desc limit 34`（limit=1 のとき 34 = limit + 窓の余裕 33。limit=7 は 40。3.2〜3.5 ms）。

## 2. 冷え（PG 再起動直後の最初の 1 回。新しいプロセスで 5 回）

(i) 再起動のみ（`shared_buffers` 空・OS キャッシュ温）、(ii) 再起動 + 日誌の関係ファイル 13 本の OS キャッシュ落とし（`BENCH_EVICT=1`。best effort）。単位 ms。call#2 以降は全て 7〜22 ms で、冷えの影響は 1 回目だけ。

| 口 / 包み                               | (i) call#1 | (i) #2 / #3 / #4 / #5       | (ii) call#1 | (ii) #2 / #3 / #4 / #5        | 出所（out/）                                  |
| --------------------------------------- | ---------- | --------------------------- | ----------- | ----------------------------- | --------------------------------------------- |
| `/progress` legacy                      | 109.85     | 10.06 / 10.78 / 8.66 / 9.63 | 220.05      | 12.52 / 14.86 / 12.55 / 12.62 | cold-progress-legacy-…071446 / -evict-…071505 |
| `/progress` bus（main 7476b801）        | 86.02      | 8.38 / 7.64 / 6.65 / 8.47   | 183.22      | 7.28 / 7.88 / 6.82 / 8.37     | cold-progress-bus-…071911 / -evict-…071918    |
| `/reports?limit=1` legacy               | 131.50     | 8.44 / 7.32 / 7.74 / 22.43  | 222.12      | 8.23 / 6.79 / 7.76 / 7.66     | cold-reports-legacy-…071524 / -evict-…071545  |
| `/reports?limit=1` bus（main 7476b801） | 130.50     | 10.49 / 7.44 / 6.33 / 6.25  | 226.91      | 10.11 / 6.29 / 6.01 / 7.03    | cold-reports-bus-…071930 / -evict-…071936     |

legacy の冷えは取り込み前（07:14Z〜07:15Z）の値、bus の冷えは取り込み後（07:19Z）の値。取り込み前の bus の冷え（`/progress` 80.00 / 196.10、`/reports?limit=1` 72.65 / 220.54。`cold-*-bus-…0714…`〜`0715…`）は out/ に残してある。

call#1 の中身（client 側。起動の裏の問い合わせを除く）: OS キャッシュを落とすと、墓標の印 `count(*) … where type = 'conversation_deleted'`（303 ページ）が 97〜134 ms、`/reports` の日報の窓の select が 68〜70 ms。(i) の再起動のみでは、その 2 本は 18〜24 ms（印）・5.8〜70 ms（窓。legacy の 1 回は 70 ms、bus の 1 回は 5.8 ms でばらつく。1 回ずつの測りなので、差とは読まない）。

## 3. 最長の文の EXPLAIN（`BENCH_TOP=3`。legacy で取った。bus でも文は同じ）

全文は `out/explain-reports-legacy-2026-10-25T071603.617Z.txt` と `out/explain-progress-legacy-2026-10-25T071616.984Z.txt`。ページ数は shared hit / read（8KB）、時間はサーバ側の Execution Time。

| 口       | 文                                                                                | 温まった          | PG 再起動のみ               | OS キャッシュ落とし             |
| -------- | --------------------------------------------------------------------------------- | ----------------- | --------------------------- | ------------------------------- |
| reports  | 日報の窓（`journal_pkey` の Index Scan Backward、`type = 'daily_report'`、34 行） | hit 248 / 0.55 ms | hit 84 + read 164 / 1.89 ms | hit 84 + read 164 / **44.6 ms** |
| reports  | 墓標の印（`count(*)`、Bitmap Heap Scan on `journal_type_at_idx`）                 | hit 303 / 0.42 ms | read 303 / 3.36 ms          | read 303 / **79.9 ms**          |
| progress | 墓標の印（同上）                                                                  | hit 303 / 0.35 ms | read 303 / 4.55 ms          | read 303 / **107.2 ms**         |
| progress | `github_observation` の頁（`type = 'github_observation'`、502 行。0 行）          | hit 3 / 0.04 ms   | hit 3 + read 3 / 0.14 ms    | read 3 / 1.1 ms                 |
| progress | `commitments`（`closed_at is null`、0 行）                                        | hit 1 / 0.01 ms   | hit 10 / 0.14 ms            | hit 10 / 0.05 ms                |

日報の窓の計画（温まった。生の要所）: `Limit (actual rows=34)` → `Index Scan Backward using journal_pkey on journal (cost=1.61..63191.92 rows=5908) (actual rows=34)`、`Buffers: shared hit=248`。見積もり 5,908 行に対し実際は 34 行で止まる（日報が密なので）。

## 4. 見立て（実測と分けて）

**実測で言えること**

- この偽データでは、`/progress` は 6 本・約 6〜7 ms、`/reports` は 2 本・約 6 ms で、legacy と bus に差は無い（どちらも `append/list/listPage/get` しか使わず、今の bus も同じ口を通すため）。**この 2 口は #5262 の包みの差を受けない**（文が同じ）。差が出るとすれば `humanReplies` など細い口を使う口で、`/progress` の中の返答済みの判定（`stores.journal.humanReplies` があれば使う、無ければ人間との往復を本文ごと読む。`packages/core/src/progress-read.ts`）は、台帳が 0 行のためこの測りでは**流れていない**（`/progress` の SQL に `with=human` の文が無い）。
- 冷え（OS キャッシュ落とし）の 1 回目 約 200〜220 ms は、墓標の印（303 ページ、100 ms 前後）と日報の窓（約 250 ページ、45〜70 ms）などの read の合計。2 回目以降は 7〜15 ms。
- 日報の窓は limit=1 で 34 行、limit=7 で 40 行を、本文ごと（`entry` 丸ごと）読む。応答は limit=1 で 8KB、limit=7 で 35KB。

**見立て（推論。測っていない）**

- 本番の `/progress`・`/reports` の遅さは、この測りには出ていない部分（台帳・jobs の行数、`github_observation` の頁送り、本物の稀な日報密度での日報の窓の計画、`/progress` の返答済みの判定）にある可能性が高い。特に日報は、本物では `daily_report` が日誌の 0.02% 前後しか無いので、`journal_pkey` を `seq` の降順に辿って `type` で絞る今の計画は、34 行に届くまで日誌の大半を辿りうる。
- 確かめるには、データの `daily_report` を本物の密度（1 日 1〜数行）に、`github_observation`・`commitments`・`jobs` を本番に近い行数にする必要がある。**足していない。増やすなら相談してください**（`load.sql` は日報の割合 1.5% を変えるだけで作り直せる。作り直しは約 4 分、`/conversations` の前の測りと同じ DB を作り替えることになるので、別 DB（`alteroid_bench2` など）を切る案もある）。

## 5. 実行したコマンド（時刻は UTC）

`<cmd>` = `pnpm -C /tmp/mgr-bd7bd1b3-bench exec vitest run --config bench/conversations-list/vitest.config.ts`

```
2026-10-25T07:13Z  pg_ctl … start（止まっていたので README の手順で起こした）
2026-10-25T07:13Z  env BENCH_STEP=rows <cmd>
2026-10-25T07:13Z〜07:14Z  env BENCH_STEP=route BENCH_ROUTE={progress,reports,reports7} BENCH_WRAP={legacy,bus} <cmd>（6 回）
2026-10-25T07:14Z〜07:15Z  env BENCH_STEP=cold BENCH_ROUTE={progress,reports} BENCH_WRAP={legacy,bus} [BENCH_EVICT=1] <cmd>（8 回）
2026-10-25T07:17Z  git fetch origin / git merge origin/main（7476b801。衝突なし）/ pnpm --filter "@alteroid/daemon..." build
2026-10-25T07:18Z〜07:19Z  bus の route（3 口）・cold（2 口 × 再起動のみ/EVICT）と、同じ時間帯の legacy の route（3 口）を取り直し
2026-10-25T07:16Z  env BENCH_STEP=explain BENCH_ROUTE={reports,progress} BENCH_WRAP=legacy BENCH_TOP=3 <cmd>（bus は文が同じなので取っていない）
```

## 6. 確認していないこと

- 本物の台帳・jobs・github_observation・日報の密度（上記）。`/progress` の返答済みの判定の SQL は流れていない。
- `BENCH_WRAP=bus` の `explain` は取っていない（`route` の内訳で、文が legacy と同じことは確認した）。
- `/progress` の `windowHours` を変えた呼び（Web の進捗画面 `progress.tsx` は変えられる）は測っていない。
- `serverlog`（サーバ側の duration）はこの 2 口では取っていない。
