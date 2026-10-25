# 会話一覧の測り — 直した後（PR #5262）

- 観測: 2026-10-25T04:42Z〜04:43Z（UTC）
- 条件: `results-before.md` と同じ DB（PG 17、ポート 55931、`alteroid_bench`、日誌 500,300 行・表 648MB・人間との往復 19,715 行・会話 1,500・墓標 300・取り下げの印 60）、同じ道具、同じ設定（`shared_buffers=128MB`・`work_mem=4MB`・`jit=on`）
- コード: この枝に `perf/journal-wrappers-keep-fast-ports`（#5262、`6c34b6e4`）を取り込み、core をビルドし直したもの。`BENCH_WRAP=bus`（本番と同じく `createJournalBus` で包む）
- 生の出力: `out/warm-bus-2026-10-25T044239.911Z.txt`・`out/cold-bus-2026-10-25T044255.205Z.txt`・`out/cold-bus-2026-10-25T044303.316Z.txt`

## 前後（どちらも包みあり＝本番と同じ形）

| 測ったもの | 前（main 390ce1dd） | 後（#5262） |
| --- | --- | --- |
| `GET /conversations?limit=30` 温まった 21 回の中央値 / p90 / 最大 | 196.70 / 211.96 / 222.86 ms | **43.89 / 49.28 / 50.96 ms** |
| 同 1 回の DB 本数 | 35 | **13** |
| 2 頁目（`nextCursor`）21 回の中央値 / p90 / 最大 | 204.81 / 229.68 / 240.95 ms | **57.67 / 68.40 / 83.83 ms** |
| 2 頁目の DB 本数 | 41 | **22** |
| `/conversations` PG 再起動直後の 1 回目 | 365.43 ms | **138.25 ms** |
| `/conversations` PG 再起動＋OS キャッシュ落としの 1 回目 | 1785.89 ms | **980.46 ms**（うち窓の文 777.99 ms） |
| `/conversations/unread-count` 最初の 1 回（プロセス起動直後） | 586.37 ms・102 本 | **293.86 ms・11 本** |
| `/conversations/unread-count` 温まった 21 回の中央値 / p90 / 最大 | 21.52 / 24.70 / 33.13 ms | 30.54 / 124.79 / 177.85 ms |

## 読み方
- `/conversations` の SQL は、取り下げの印の頁送り（前: 10 本・88 ms）が `withdrawnClientMessageIds` の1本（0.94 ms）になり、窓は本文を運ばない `conversationWindowHeads`（11.95 ms）になった。
- 冷えた1回目に残るのは窓の文の read（約 2,600 ページ）。これは包みを外した (B) の値（1002.96 ms）と同じ水準で、包みの直しでは消えない残り。
- `unread-count` の温まった値は、前より中央値が 9 ms 増え、p90 以降が 120〜178 ms に跳ねた。跳ねは 21 回の後半 7 回に固まっており、SQL の内訳（1 回 11 本・15.4 ms）からは説明がつかない。原因は測っていない（器の他の負荷の可能性があるが、確かめていない）。包みを外した (B) の前の値も 30.29 ms で、`humanReplies` の口を通る形の値としては前の (B) と揃っている。
