# 会話一覧（`GET /conversations?limit=30`）の測り（#5140）

本番に近い偽の日誌（約 50 万行・表 648MB）を手元の PostgreSQL 17 に入れ、デーモンの HTTP の口（Hono の `app.request`）を本物の pg ストアで叩いて、時間・SQL の内訳・実行計画を取る道具。
この枝は測り専用で、main へは入れない前提。結果は `results-before.md`、各回の生の出力は `out/`。

## 置き場所がリポジトリの検査に掛からないか

- 掛かる: `eslint .`（`bench/` は ignores に無い）と `prettier --check .`（`.prettierignore` に無い）。両方とも `bench/conversations-list` に対して通してある（`pnpm exec eslint bench/conversations-list` / `pnpm exec prettier --check bench`）。
- 掛からない: `tsc`（`bench/` は どの `tsconfig*.json` の include にも無い）、root の `vitest.config.ts`（`include` に `bench/` が無い）。測りは `*.bench.ts` と専用の `vitest.config.ts` で走らせ、`pnpm test` には入らない。
- 確認していない: `scripts/*.test.ts` のうち、リポジトリの直下のディレクトリを数え上げるものが `bench/` を想定していないか（全体のテストは走らせていない）。

## 前提

```
pnpm -C <worktree> install --frozen-lockfile
pnpm -C <worktree> --filter @alteroid/core --filter @alteroid/storage-pg --filter @alteroid/storage-fs --filter @alteroid/runner build
```

`vitest.config.ts` の別名で、storage-pg は `src`（この枝の現物）、core は build 済みの `dist` を読む。**core を変えたら build し直すこと。**

## PostgreSQL（この枝を測った環境）

```
export PATH=/usr/lib/postgresql/17/bin:$PATH
initdb -D /tmp/mgr-bd7bd1b3-pg/data --auth=trust -U postgres --locale=C.utf8 -E UTF8
pg_ctl -D /tmp/mgr-bd7bd1b3-pg/data -l /tmp/mgr-bd7bd1b3-pg/pg.log -o "-k /tmp/mgr-bd7bd1b3-pg/sock -h 127.0.0.1 -p 55931" -w start
psql -h 127.0.0.1 -p 55931 -U postgres -c "create database alteroid_bench"
```

接続先は既定で `postgres://postgres@127.0.0.1:55931/alteroid_bench`（`BENCH_PG_URL` で変える）。PG の場所は `BENCH_PG_BIN` / `BENCH_PG_DATA` / `BENCH_PG_LOG` / `BENCH_PG_SOCK` / `BENCH_PG_PORT`（`cold` と `explain` が `pg_ctl restart` を自分で打つ）。設定は既定のまま（`shared_buffers=128MB`・`work_mem=4MB`・`jit=on`・`random_page_cost=4`）。

## データを入れる（同じ条件で作り直す）

実行は `env BENCH_STEP=<段> pnpm -C <worktree> exec vitest run --config bench/conversations-list/vitest.config.ts`。

1. `BENCH_STEP=migrate` — 表を作る（`createPgStores` の migrate）。
2. `BENCH_STEP=probe` — 本物の `append` で各種別を1行ずつ書いて、保存された `entry` の形を出し、読み戻せることを確かめ、`journal` を空にして起動後の索引を落とす。
3. `psql -q -h 127.0.0.1 -p 55931 -U postgres -d alteroid_bench -v ON_ERROR_STOP=1 -v n=500000 -v bodyMu=6.4 -f bench/conversations-list/load.sql`（約 4 分。`setseed` 済みなので同じ行が出る）
   - 種別: tool_use 50%・exchange(manager) 12%・exchange(self) 8%・exchange(human) 約 2 万行（会話 1,500・inbound/outbound 交互・outbound は 200〜6,000 字・clientMessageId / supersedes / turnFailure / 添付を一部に）・decision・memory_update・turn_timing・http_timing・daily_report・escalation・conversation_deleted 300・取り下げの印 60。**`digest` という種別は `journalEntrySchema` に無いので、daily_report / decision / escalation で代えた。**
   - **`at` をミリ秒に丸めている。** 丸めないと（マイクロ秒が残ると）`at = $2` の錨の引き直し（`#anchorSeq`）が当たらず、頁送りが `JournalAnchorNotFoundError` で落ちる（最初に実際に踏んだ）。本物の行は JS の Date（ミリ秒）で書かれる。
   - 既読の記録: 人間との往復がある会話の半分（730 行）に `conversation_read`、基準時刻は期間の頭の 10 日後。
4. `BENCH_STEP=indexes` — 起動の後に作る索引（`journal_human_exchange_seq_idx` `journal_human_replies_idx` `journal_withdrawals_idx` `journal_conversation_seq_idx`）を作り終えるまで待つ。
5. `psql … -c "VACUUM ANALYZE journal" -c "VACUUM ANALYZE conversation_read"`
6. `BENCH_STEP=verify` — 種別ごとに新しい側・古い側の最大 5,000 行を本物のストアで読み、SQL の行数（墓標が外す行は引く）と一致するか（= `journalEntrySchema` に合わない行が捨てられていないか）を確かめる。
7. `BENCH_STEP=env` — 環境（SHOW・大きさ・索引の有効性・種別ごとの行数）。

## 測る

`BENCH_WRAP` で包みの有無を切り替える（**必ず両方測る**）:

- `BENCH_WRAP=bus`（既定）: 本番のデーモン（`apps/daemon/src/index.ts`）と同じく日誌のストアを `createJournalBus`（`apps/daemon/src/journal-bus.ts`）で包んで app に渡す。この包みは `append/list/listPage/get/oldestAt/clear` しか渡さないので、pg の細い口（`conversationWindowHeads` など）が落ちて本文ごと読む道に倒れる。**「前」の値はこちら。**
- `BENCH_WRAP=none`: 包まず pg のストアをそのまま渡す。

| 段                                                      | 中身                                                                                                                                                                                                                                                      |
| ------------------------------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `BENCH_STEP=warm`                                       | 最初の 1 回（プロセスは冷え・PG は温まっている）・3 回の助走の後の 21 回（`/conversations?limit=30`）の中央値/p90/最大・SQL の全部（client 側の時間つき）・JS 側の段・2 頁目（`nextCursor`）21 回・`/conversations/unread-count` 21 回・同時に叩いた 1 回 |
| `BENCH_STEP=cold` / `BENCH_EVICT=1` を足す              | `pg_ctl restart` の直後の最初の 1 回と、その後 5 回の曲線。`BENCH_EVICT=1` は日誌の関係ファイルの OS キャッシュも落とす（`dd iflag=nocache count=0`。root 不要。落ちたことは 1 回目が 1 桁遅くなることで確かめた）                                        |
| `BENCH_STEP=serverlog`                                  | `log_min_duration_statement = 0` を一時的に入れて 1 回ぶんのサーバ側の duration を出し、元へ戻す                                                                                                                                                          |
| `BENCH_STEP=explain`（`BENCH_ONLY=<番号>` で 1 文だけ） | 1・2 頁目・unread-count で流れる select の `EXPLAIN (ANALYZE, BUFFERS, SETTINGS)`。文ごとに 温まった（3 回目）・PG 再起動直後・PG 再起動 + OS キャッシュ落とし の 3 通り（`track_io_timing` はそのトランザクションだけ on）                               |

出力は stdout と `out/<段>-<wrap>-<時刻>.txt`。`BENCH_REPEAT`（既定 21）・`BENCH_LIMIT`（既定 30）で変えられる。

直した後に同じ道具で測り直すときは、直したコードを `apps/daemon` / `packages/*` へ入れ（core は build）、`BENCH_WRAP=bus` で `warm` → `cold`（`BENCH_EVICT=0/1`）→ `explain` → `serverlog` を回す。

## 読むときの注意

- 先頭の「SQL first call / cold call#1」の本数には、`createClone` の起動の裏の問い合わせ（`inbox_events` の更新・`approvals`・`daemon_state`）が混ざる。`warm call (内訳)` の本数が `/conversations` だけの本数（`Server-Timing` の `DB n queries` と一致する）。
- client 側の ms は往復込みで、測りと PG が同じ器の中なので、ネットワークの往復はほぼ 0。本番は本数 × 往復が足される。
- `pg_stat_database` の `blks_read` は再起動をまたいで累計されるので、再起動後の値としては使えない（`cold` が出す行は参考にならない）。
- 「起動後の索引を作れなかった（Client was closed）」の警告は、`openStoresNoWait` をすぐ閉じたときの索引の確かめが閉じた接続に当たっただけ（索引は有効。`env` の「索引の有効性」で確かめる）。`common.ts` の `openStoresNoWait` は、この確かめが済むまで最大 5 秒待つ形に直したので、以後は出ない。

## `/progress`・`/reports` の測りと、別 DB（`alteroid_bench2`）の作り方

- `BENCH_WRAP=legacy`（#5262 の前の `createJournalBus` の再現。6 つの口だけ）・`bus`（今の main）・`none`。`BENCH_ROUTE=progress|reports|reports7|conversations`。段 `route`（温まった 21 回と SQL の内訳）・`rows`（`daily_report` / `github_observation` / 台帳 / jobs の行数）。`explain` は口が `conversations` 以外のとき、client 側で長かった文から `BENCH_TOP` 本（既定 3）を取る。
- `BENCH_PG_URL`（接続先 DB）・`BENCH_TAG`（出力ファイル名の頭）・`BENCH_QUIET=1`（画面へ出さず `out/` だけ）。
- 本番に近い密度の別 DB:
  1. 測りのプロセスが無いときに `create database alteroid_bench2 template alteroid_bench`（接続が残っていると作れない）。
  2. `env BENCH_STEP=density BENCH_PG_URL=postgres://postgres@127.0.0.1:55931/alteroid_bench2 pnpm -C <worktree> exec vitest run --config bench/conversations-list/vitest.config.ts bench/conversations-list/density.bench.ts`（元の `alteroid_bench` を指すと断る）。`daily_report` を日付ごとの最新 1 行（5 日だけ 2 行）にし、消した行の `seq` と `at` の穴に `github_observation` を 300 行入れ（日誌の中の時刻順を保つため。形は本物の `append` で確かめる）、台帳 1,500 行（未了 60）と jobs 3,000 行（running 5）を `stores.commitments.open/close`・`stores.jobs.putJob` で書く。乱数は固定（同じ行が出る）。
  3. `psql -d alteroid_bench2 -c "VACUUM ANALYZE journal" -c "VACUUM ANALYZE commitments" -c "VACUUM ANALYZE jobs"`
- 索引を足す測り: `psql -d alteroid_bench2 -c "create index concurrently journal_type_seq_idx on journal (type, seq)"` → `VACUUM ANALYZE journal` → `BENCH_TAG=b2idx` で同じ測り → `drop index concurrently journal_type_seq_idx`。
