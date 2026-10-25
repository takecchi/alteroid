# 会話一覧の測り: main 390ce1dd（#5140）の「前」の値

観測は 2026-10-25T03:19Z〜03:27Z（UTC）。器は共有（48 コア）・測りの node も PG も同じ器の中（ネットワークの往復はほぼ 0）。
生の出力は全部 `out/` に置いてある（ファイル名の時刻が観測時刻）。この文書の値はそこからの転記で、**測った値の列**と**自分の見立ての列**を分けて書く。

## 0. 環境（`out/env-bus-2026-10-25T032343.720Z.txt`、2026-10-25T03:23:43Z）

```
SHOW shared_buffers = 128MB / work_mem = 4MB / jit = on / random_page_cost = 4 / effective_cache_size = 4GB
SHOW track_io_timing = off（explain だけトランザクション内で on） / max_parallel_workers_per_gather = 2
server_version 17.11 (Debian 17.11-0+deb13u1)、locale C.utf8（本番の照合順は未確認）
journal 全体 {"table_incl_toast":"648 MB","heap":"313 MB","indexes":"110 MB","total":"759 MB","reltuples":"500249","relpages":40107}
  r journal 313 MB   t pg_toast_16398 330 MB（索引 4656 kB）
  i journal_id_key 37MB / journal_type_at_idx 34MB / journal_exchange_with_seq_idx 15MB / journal_at_idx 11MB / journal_pkey 11MB
  i journal_conversation_seq_idx 2400kB / journal_human_exchange_seq_idx 448kB / journal_human_replies_idx 224kB / journal_conversation_deleted_idx 40kB / journal_withdrawals_idx 16kB
索引はすべて indisvalid = true（起動後に作る 4 本も `built` で有効。`BENCH_STEP=indexes` の出力: 作成 0.4〜1.5 秒）
行数 合計 500,300: tool_use 249,982（49.97%）/ exchange manager 59,717（11.94%）/ self 40,046（8.0%）/ human 19,715（3.94%）
  decision 30,214 / memory_update 30,190 / turn_timing 30,175 / http_timing 24,990 / daily_report 7,495 / escalation 7,476 / conversation_deleted 300
with=human: 会話 1,500・inbound 10,224・outbound 9,491・clientMessageId 2,964・supersedes 174・turnFailure 218・outbound 平均 2,009 字（200〜5,999）
取り下げの印 60・conversation_read 730 行（会話の約半分）・2,000 バイト超の行 84,757
```

偽データの限界（確認していない点）: 本文は md5 の16進を空白で区切った擬似文章（実本文より圧縮されにくい）。TOAST 330MB・heap 313MB の比は本番と違うかもしれない。`verify` で、種別ごとに新しい側・古い側の 5,000 行（墓標が外す行を除く）が `journalEntrySchema` で全部読めることは確かめた（`BENCH_STEP=verify` の出力が全種別 OK）。

## 1. 口の時間

`GET /conversations?limit=30`（scan 既定 2000）。応答はどれも `conversations=30 scanned=2000 reachedStart=false hiddenByLimit=157 nextCursor=あり bytes=8993`。
(A) = 本番と同じ（日誌を `createJournalBus` で包む）。(B) = 包まない。いずれも 21 回・3 回の助走の後・直列。

| 測ったもの                                  | (A) 包む = 前 中央値 / p90 / 最大 (ms)    | DB 本数 (A) | (B) 包まない 中央値 / p90 / 最大 (ms) | DB 本数 (B) | 出所（out/）                               |
| ------------------------------------------- | ----------------------------------------- | ----------- | ------------------------------------- | ----------- | ------------------------------------------ |
| `/conversations?limit=30` 温まった 21 回    | **196.70 / 211.96 / 222.86**（最小 166.7） | 35          | 46.72 / 54.69 / 56.54（最小 38.5）    | 13          | warm-bus-…032351.889Z / warm-none-…032427.026Z |
| 2 頁目（`nextCursor`）21 回                 | **204.81 / 229.68 / 240.95**              | 41          | 57.33 / 65.57 / 70.86                 | 22          | 同上                                       |
| `/conversations/unread-count` 温まった 21 回 | 21.52 / 24.70 / 33.13                     | 11          | 30.29 / 34.21 / 38.25                 | 11          | 同上                                       |
| `/conversations/unread-count` 最初の 1 回（プロセス起動直後・返答の覚え空） | 586.37（count=99, capped） | 102         | 182.83                                | 11          | 同上                                       |
| `/conversations` 最初の 1 回（プロセスは冷え・PG は温）      | 353.12                      | 35 + 起動の裏 14 | 141.13                          | 13 + 起動の裏 14 | 同上                                       |
| `/conversations` と `unread-count` を同時に 1 回 | 211.78 + 27.96（全体 211.89）          | —           | 59.53 + 38.18（全体 59.66）           | —           | 同上                                       |

### 冷え（PG 再起動直後の最初の 1 回）

`pg_ctl restart` の直後に新しいプロセスで 5 回。**OS のページキャッシュは通常は落とせない**ので、(i) PG の再起動だけ（shared_buffers は空・OS キャッシュは温かい）と、(ii) 再起動 + 日誌の関係ファイル 13 本の OS キャッシュを `dd iflag=nocache count=0` で落とした版（best effort。1 回目が約 5 倍になったので効いている）を両方出す。本番の物理ディスク・ネットワークストレージの遅さは再現できない。

| 条件                     | call#1 (ms) | #2    | #3     | #4     | #5     | 出所（out/）           |
| ------------------------ | ----------- | ----- | ------ | ------ | ------ | ---------------------- |
| (A) 包む・PG 再起動のみ  | **365.43**  | 211.5 | 186.46 | 182.02 | 175.73 | cold-bus-…032441.291Z  |
| (A) 包む・再起動 + OS 落とし | **1785.89** | 208.52 | 174.19 | 182.73 | 187.48 | cold-bus-…032451.478Z  |
| (B) 包まない・PG 再起動のみ | 149.87      | 55.85 | 48.03  | 55.96  | 65.06  | cold-none-…032514.368Z |
| (B) 包まない・再起動 + OS 落とし | 1002.96 | 49.68 | 60.16  | 43.90  | 43.34  | cold-none-…032504.717Z |

## 2. 内訳（(A) の温まった 1 回、`out/warm-bus-2026-10-25T032351.889Z.txt` の `SQL warm call`）

`/conversations?limit=30` 1 回: total 188.23 ms、`Server-Timing: db;dur=128.0;desc="DB 35 queries", app;dur=60.4`。SQL 35 本の client 側の合計 137.86 ms、**JS 側（total − SQL）≈ 50 ms**。サーバ側の duration の合計は 122.32 ms（`serverlog`、parse/bind/execute の 103 行の和）。

| 文（先頭）                                                                               | 本数 | client 側 合計 (ms) | 備考                                                    |
| ---------------------------------------------------------------------------------------- | ---- | ------------------- | ------------------------------------------------------- |
| `select "id","at","type","entry" from "journal" where ("at" >= $1 and (...) ...`（取り下げの印を頁で読む。`with=self` を 501 行ずつ） | 10 | 88.46 | 20.6 → 13.3 → 10.6 → 9.5 → 8.0 → 7.7 → 6.7 → 5.3 → 4.6 → 2.2 ms と頁ごとに減る |
| `select "id","at","type","entry" from "journal" where (("type" <> 'exchange' OR ...` 先頭（窓: `with=human` を 2001 行、本文ごと） | 1  | 22.31 | JS 側で 2000 行ぶんの zod 解析が別に付く                |
| `select count(*)::text \|\| ':' \|\| coalesce(max("seq"),0)::text from "journal" where "type" = $1`（墓標の印） | 11 | 12.80 | 日誌を読む口ごとに 1 本（頁ごとにも 1 本）             |
| `select "seq" from "journal" where ("id" = $1 and "at" = $2) limit $3`（頁の錨の引き直し） | 9  | 10.52 | 取り下げの頁送りが 1 頁ごとに 1 本                      |
| 既読（`conversation_read` 全件・基準時刻 x2・基準時刻の insert）                           | 4  | 3.77                |                                                         |

JS 側の段（同じ run、21 回の中央値。`phase …` の行）:

| 段                                                       | (A) 中央値 / p90 / 最大 (ms) | (B) 中央値 / p90 / 最大 (ms) |
| -------------------------------------------------------- | ---------------------------- | ---------------------------- |
| `loadConversationReadView`（既読 730 行）                | 5.55 / 6.76 / 7.70           | 5.86 / 7.15 / 7.69           |
| `readConversationPage`（SQL を含む。JS の解析・畳みを含む） | 182.27 / 192.17 / 208.87   | 37.74 / 42.71 / 60.12        |
| 整形（`map` + `JSON.stringify`）                         | 0.08 / 0.14 / 0.17           | 0.09 / 0.19 / 0.28           |

(B) の SQL（13 本）: `conversationWindowHeads` 14.1 ms・`exchangeTextHeads` 6.13 ms・取り下げの印 `withdrawnClientMessageIds` 1.2 ms（`jit=off` のトランザクション）・墓標の印 3 本 3.46 ms・既読 4 本 2.7 ms ほか。client 側の合計 30.44 ms、JS ≈ 11.7 ms。
(A) の `/conversations/unread-count` 最初の 1 回の 102 本の中身: 人間との往復を 500 行ずつ `since` から古い順に読む頁送り（`journal.humanReplies` が無いので）。1 頁あたり 墓標の印・本文ごとの select・錨の select の 3 本。上限 40 チャンクのうち 約 33 頁で `capped: true`（count=99）。

## 3. 主な SQL の実行計画（`EXPLAIN (ANALYZE, BUFFERS, SETTINGS)`。全文は `out/explain-bus-2026-10-25T032523.222Z.txt` と `out/explain-none-2026-10-25T032612.064Z.txt`）

shared hit / read は**ページ数**（8KB）。「OS 落とし」は PG 再起動 + 日誌の OS キャッシュ落とし。時間はサーバ側の Execution Time（往復・JS の解析を含まない）。

### (A) 包む（本番の形）

| 文                                                                         | 温まった: ページ / ms | PG 再起動のみ: read ページ / ms | OS 落とし: read ページ / ms（I/O 待ち） |
| -------------------------------------------------------------------------- | --------------------- | ------------------------------- | --------------------------------------- |
| S4 窓（`with=human` 2001 行・本文ごと。`journal_human_exchange_seq_idx` の Index Scan Backward、Filter で除外 435 行） | hit 6,455 / 7.3       | hit 3,856 + read 2,622 / 32.0   | read 2,622 / **768.2**（read 738.3）    |
| S5 取り下げの印 1 頁目（`type=exchange and with=self and at >= $1`、501 行）  | hit 3,434 / 13.5      | read 3,434 / 41.0               | read 3,434 / **975.4**（read 900.3）    |
| S7 取り下げの印 2 頁目（`seq > $after` 付き）                              | hit 2,936 / 12.2      | read 2,936 / 35.6               | read 2,936 / **882.5**                  |
| S10 unread-count の頁（`with=human`、`since` から古い順 501 行）             | hit 6,476 / 6.8       | hit 3,869 + read 2,630 / 31.3   | read 2,630 / **851.9**                  |
| S3 墓標の印（`count(*) ... where type = 'conversation_deleted'`）          | hit 303 / 0.32        | read 303 / 3.1                  | read 303 / 88.8（read 83.0）            |
| 錨の引き直し・既読・基準時刻                                                | hit 2〜11 / <0.2      | read 2〜11 / <0.3               | read 2〜11 / <0.3                       |

S5 の計画（温まった。生の要所）:

```
Limit  (actual time=13.259..13.401 rows=501) Buffers: shared hit=3434
  ->  Sort  Sort Key: seq  Sort Method: top-N heapsort  Memory: 455kB
        ->  Bitmap Heap Scan on journal  (actual time=5.541..11.124 rows=4582 loops=1)
              Recheck Cond: ((type = 'exchange') AND (at >= ...) AND ((entry ->> 'with') = 'self'))
              Filter: ((id <> ALL ('{...300 件...}')) AND (id <> ALL ('{...175 件...}')) ...)  Rows Removed by Filter: 420
              Heap Blocks: exact=3147   Buffers: shared hit=3434
              ->  BitmapAnd  Buffers: shared hit=287
                    ->  Bitmap Index Scan on journal_type_at_idx  (rows=14588)  Buffers: shared hit=131
                    ->  Bitmap Index Scan on journal_exchange_with_seq_idx  (rows=40106)  Buffers: shared hit=156
```

### (B) 包まない（pg の細い口）

| 文                                                                             | 温まった: ページ / ms | PG 再起動のみ: read / ms      | OS 落とし: read / ms                       |
| ------------------------------------------------------------------------------ | --------------------- | ----------------------------- | ------------------------------------------ |
| S4 `conversationWindowHeads`（`jsonb_to_record`、本文を運ばない）               | hit 8,282 / 14.5      | hit 5,683 + read 2,622 / 38.3 | read 2,622 / **941.8**（read 880.0）       |
| S5 `withdrawnClientMessageIds`（`journal_withdrawals_idx`、`jit=off`）          | hit 6 / 0.08          | read 5 / 0.13                 | read 5 / 1.3                               |
| S6 `exchangeTextHeads`                                                          | hit 228 / 5.7         | read 142 / 7.2                | read 142 / 33.0                            |
| S10 2 頁目の窓                                                                  | hit 8,306 / 17.4      | read 2,630 / 37.4             | read 2,630 / **799.1**                     |
| S13 `humanReplies` の最初の 1 回（覚えが空。`journal_human_replies_idx`・全返答 9,491 行を読む） | hit 94,942 / 78.0 | hit 80,907 + read 14,058 / 197.0 | read 14,058 / **4,078**（read 3,831）  |

## 4. 見立て（実測と分けて書く）

**実測（上の表）で言えること**

- 本番と同じ包み（A）では `/conversations` は温まって 197 ms（35 本）、包まない（B）では 47 ms（13 本）。差 150 ms のうち、SQL の client 側の差は 107 ms（137.9 → 30.4）、JS 側の差は 38 ms（50.4 → 11.7）。
- (A) の SQL の時間の大半（137.9 ms のうち 88.5 ms）は、取り下げの印を `listPage` で 501 行ずつ頁送りしている 10 本。窓の先頭（22.3 ms・2001 行を本文ごと）が次。
- 頁送りの 1 本ごとの計画は、`with=self` で `since` 以降の行を Bitmap Heap Scan で全部（4,582 行・heap 3,147 ページ）読んでから `seq` で Top-N する。2 頁目以降も `seq > $after` を足しても同じ範囲の bitmap を作るので触るページ数は 3,434 → 2,936 …と大きくは減らない（S5・S7）。
- 冷え（OS キャッシュ落とし）の 1 回目は (A) 1,786 ms、(B) 1,003 ms。1 文ごとの冷えの実行時間は、触る read ページ数にほぼ比例（2,622 ページ → 768〜942 ms、3,434 → 975 ms、2,936 → 883 ms、14,058 → 4,078 ms で、約 0.28〜0.34 ms/ページ）。
- (A) の `/conversations/unread-count` は、最初の 1 回だけ 102 本・586 ms。以後は 11 本・約 22 ms（印を覚えて新しい分だけ足すため）。(B) の最初の 1 回は 183 ms（`humanReplies` 78 ms の計画 + 全返答 9,491 行の転送）。

**見立て（推論。測っていない）**

- 本番の 6〜13 秒・163〜178 本は、この枝の (A) と同じ形（窓 1 本 + 取り下げの頁送りが 約 50 頁 × 3 本）で、頁数が自分のデータの 10 頁より大きい（窓の最古の発言以降の `with=self` の行数が多い。5 万行近い self が 窓の期間に在れば 100 頁近い）のだと考える。頁数 ∝ 窓の期間の self の行数で、1 頁ごとに同じ範囲を読み直すので、触るページ数は頁数の 2 乗に近く増える。
- 本番の時間を決めるのは、冷えた read のページ数 + 本数 × ネットワークの往復だと考える。この枝は同じ器の中なので往復を含まない（163 本 × 1〜5 ms なら 0.2〜0.8 秒が上乗せされうる）。
- 包み（`createJournalBus`）を通さない（B）か、包みが細い口を渡すようになれば、同じデータで温まった 197 → 47 ms・13 本・触るページ数は取り下げ 6 ページ / 窓 8.3k ページになる（実測）。ただし (B) でも窓は 8,282 ページを触り、OS 冷えでは 940 ms かかる（窓そのものの費用は残る）。`humanReplies` の最初の 1 回は 9.5 万ページ（冷え 4 秒）で、デーモンの起動直後の最初の `unread-count` に載る。

## 5. 実行したコマンド（時刻は UTC）

```
2026-10-25T03:14Z  psql … -v n=20000 -f load.sql（試走）→ truncate → 03:14Z 以降 psql -q … -v n=500000 -v bodyMu=6.4 -f load.sql（最初の本走は `at` のマイクロ秒で頁送りが落ちたので、ミリ秒丸めを足して 03:19Z〜03:23Z に流し直した）
2026-10-25T03:23Z  BENCH_STEP=indexes / VACUUM ANALYZE journal / BENCH_STEP=verify / BENCH_STEP=env
2026-10-25T03:23Z  env BENCH_STEP=warm BENCH_WRAP=bus  … vitest run --config bench/conversations-list/vitest.config.ts
2026-10-25T03:24Z  env BENCH_STEP=warm BENCH_WRAP=none …
2026-10-25T03:24Z  env BENCH_STEP=cold BENCH_WRAP=bus（EVICT 無し → BENCH_EVICT=1）、BENCH_WRAP=none（EVICT=1 → 無し）
2026-10-25T03:25Z  env BENCH_STEP=explain BENCH_WRAP=bus、03:26Z BENCH_WRAP=none
2026-10-25T03:27Z  env BENCH_STEP=serverlog BENCH_WRAP=bus
```

（上の `vitest run …` の前の `pnpm -C <worktree> exec` は省略した。詳細は README.md。）

## 6. 確認していないこと

- 本番の照合順・`shared_buffers`・ディスクの種類・本番の日誌の self 行数と窓の期間（頁数の見積もりは推論）。
- 本物の日誌の本文の長さの分布・TOAST の圧縮率。
- (B) の「包まない」は、`createJournalBus` を直した後の姿そのものではない（包みが細い口を転送する実装は測っていない）。
- ネットワークの往復・同時に走る他の要求（本番はプールを共有する）。
- `unread-count` の冷え（PG 再起動直後）は測っていない（`/conversations` だけ）。
- 全体のテスト・`scripts/*.test.ts` が `bench/` に反応しないか。
