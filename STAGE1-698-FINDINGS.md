# Issue #698 段1（測る・数える）の結果

**この文書は一時的な保全用である。**段2の設計が通ったら削除するか PR 本文へ写す。
実装は1行も入っていない。観測時刻はすべて UTC。

## 0. 前提の引き直し（依頼文の数字は現物と食い違う）

依頼文と Issue 本文の「DB の 95%・日に数 GB」は 2026-09-08T02:42Z の起票時の本番実測である。
**同じ Issue のコメント（2026-09-08T06:15Z、起票者自身）が、その3時間半後にこれを引き下げている。**

- 476 MB/時 → 4.4 MB/時（約100分の1）
- 空き 41 GB は約390日ぶん
- 優先度を下げる。先に #696 を片付ける

**#696 は 2026-09-08T07:44:04Z に CLOSED**（`gh issue view 696 --json state,closedAt` で確認）。
⟹ 起票者が指定した順序上の先行条件は解消している。

**引き下げ後も消えていない事実**（これが段2の対象）:
1. `TranscriptArchive` に消す口が無い（`archive` / `list` / `read` の3本のみ）
2. 上限が無い（TTL・保持期間・件数上限のいずれも0件）
3. 既存の約 4.4 GB は肥大期の残骸である

## 1. いまの実数 — **本番は測れなかった**

**測れない。理由は到達経路が存在しないことである（「触らなかった」ではない）。**

- `railway` CLI が入っていない（`command -v railway` → exit 1）
- `ALTEROID_DATABASE_URL` がこの器に存在しない（`printenv` → exit 1）
- これは `apps/daemon/src/storage.ts` の「記憶ストアへ到達するのに自分が使った鍵を、
  そのまま子へ配らない」という非対称な可視性の設計が効いている結果である

⟹ Issue の 4,439 MB / 95% / 日ごとの表 / 390日は、**起票者 takecchi が
`railway ssh --service Postgres` 経由の `psql` で取得した一次情報**であり、
こちらで再現・検証する手段は無い。

### 測れた実数（使い捨ての PostgreSQL 18.3 = PGlite 0.5.4、リポジトリ自身がテストで使う手段）

本物の postgres サーバは立てられない（`postgres`/`initdb`/`pg_ctl`/`docker` すべて不在、
`apt-get` は非 root で書けず `sudo` も無い）。**リポジトリのテストが「偽の DB で代用しない」
と明記して使っている PGlite（WASM の実 PostgreSQL）で測った。**

`migrate.ts` の DDL を逐語で投入したうえでの実測:

| 合成データ | 生バイト | text+TOAST後 | 現状の圧縮率 | gzip+bytea | gzip の圧縮率 | TOASTからの追加分 |
| --- | --- | --- | --- | --- | --- | --- |
| 1 MB   | 1,048,578   | 229,890    | 4.56x | 126,056    | 8.32x | 1.82x |
| 10 MB  | 10,485,949  | 2,288,688  | 4.58x | 1,252,696  | 8.37x | 1.83x |
| 100 MB | 104,857,963 | 22,818,660 | 4.59x | 12,490,974 | 8.39x | 1.83x |

- `body` は `attstorage='x'`（EXTENDED = `text` の既定）⟹ **TOAST(pglz) が既に効いている**
- 120 MB の1行は問題なく入る（約2.85秒、TOAST後 27.4 MB）。エンジン側にもアプリ側にも上限は無い
- 索引は主キー(`id`)の btree だけ。`at` にも `session_id` にも無い（`pg_indexes` で裏取り）

**⟹ Issue の「gzip して bytea」案の効き目は 1.83x であって、ゼロからの圧縮ではない。**
4,439 MB は既に 4.6x 圧縮された後の値なので、gzip 化しても約 2,400 MB が残る。
**圧縮は消す口の代わりにならない。**

### 消す問い合わせの費用（実測、2000行の合成データで EXPLAIN）

- `at` で切る → **Seq Scan**（索引なし）
- `session_id` で切る → **Seq Scan**（索引なし）
- `id` の前方一致 LIKE → **Bitmap Index Scan**（`id` は `sanitize(sessionId)-{stamp}.jsonl` で
  セッション名が先頭にあるため、主キー btree がレンジ条件に変換できる）
- ただし **`body` に触れない走査は極めて軽い**（shared hit=1 / 0.25ms）。
  `length(body)` を足すと桁で重くなる（shared hit=156 / 304ms）。
  ⟹ 危ないのは索引の不在ではなく「消す対象の確認で `body` まで取得する」運用のほうである

## 2. 生ログを読む経路 — **6つ。`manager_transcript` は1つにすぎない**

TypeScript Compiler API による型解決で `TranscriptArchive` の呼び出しを全数取得（25件、
うち非テスト7件）。**grep は30件で、差の5件は「コメント3件の過検出」＋
「型解決が意図的に除外した実在の呼び出し2件」だった。後者2件は読んで見つけた。**

| 入口 | 到達先 | 読む範囲 |
| --- | --- | --- |
| クローンの MCP `manager_transcript` | `Manager#transcript()` | 全文取得 → 8,000字ずつページング |
| 人間の CLI `/manager <id>` | 同上（`GET /managers/:id/transcript`） | 無加工の全文 |
| Web UI のセッションログ表示 | 同上 | 無加工の全文 |
| HTTP `GET /archive` / `GET /archive/:id` | `stores.archive.list()` / `.read()` 直呼び | 無加工の全文。**job を経由せず任意の id を読める唯一の口** |
| 人間の CLI `/archive` / `/archive <id>` | 上と同じ口（hono RPC クライアント経由） | 無加工の全文 |
| 内部 `#pickUpTranscriptGrave` | `archive.read()` | 全文取得 → 末尾60,000字のみ使用 |

`Manager#transcript()` は3段フォールバック（走行中 runner のディスク → **archive** →
預かったセッション）で、archive はその最終段である。

## 3. 「消えた」と「最初から無かった」は現在区別できない

- `PgTranscriptArchive.read()` → `rows[0]?.body ?? null`
- `FsTranscriptArchive.read()` → ENOENT を捕まえて `null`
- **どちらも「一度も無かった」と「あったが消された」を戻り値で区別しない**

コード自身が既に畳んでいることを認めている（`#pickUpTranscriptGrave` のコメントが
「器を作り直した／人が消した」を同じ `null` 分岐に押し込んでいる）。
⟹ **これは消す口を足すときに新設すべき制約ではなく、いま既に在る欠陥である。**

## 4. archive の id を保持している側（消すと宙に浮く）

| 保持側 | 個数 | 削除経路 |
| --- | --- | --- |
| `TranscriptGrave.archiveId` | 高々1つ | なし |
| `Job.archiveIds` | **無制限に増える**（追記のみ） | **0件** |

どちらにも FK 制約は無い。

## 5. 「終わったから消してよい」の根拠に使える状態は**存在しない**

`JobStatus` は `running` / `waiting_human` / `done` / `failed` / `lost` / `stopped` の6種。

**`done` は2つの経路から付き、コード自身が区別できないと明言している**（`manager.ts` 逐語）:

> `'done'` は `#finish('done', ...)`（＝畳まれた）と、`#finish` を通らずに `#status`
> だけを `'done'` にして `#sessions` に生き残る経路（＝1ターン終えて次の指示を待っている）の
> **両方**から付く。この一覧（`RunnerManagerState`）はどちらの `done` かを区別する材料を持たない

⟹ 依頼文の「`done` はプロセスが終わったを意味しない」は**正しい**。
そして `stopped`（唯一プロセス消滅を確認済み）でも「今後読まれない」は意味しない。
**保持期間・既読・最終アクセス時刻のような材料は archive にも Job にも無い。**

## 6. 同一セッションの退避が前方一致（prefix）かどうか

- **`#salvageTranscript` / `#recycleForContextWindow` 経路**: `setCloneSessionId(null)` を打つので
  次のセッションは必ず別 id・別ファイル。⟹ **この経路の行は「そのセッション唯一の退避」**で、
  prefix 関係の議論の対象外
- **`#onPreCompact` 経路**: SDK の `forkSession` を alteroid は一度も設定しておらず（0件）、
  型定義は「`forkSession` が真でない限り resume は同じセッションの継続」と明言。
  transcript_path は session_id の関数に見え、`truncate`/`rewrite` 相当の文字列は0件、
  `O_APPEND` は12件
- **⚠️ ただし prefix 関係そのものは実測していない。** compaction を1回も起こしていない
  （資格情報が無く、本物のトークンで試すことは規約でも禁じられている）。
  上記の (ii)(iii) はコンパイル済みバイナリの印字可能文字列であって制御フローの追跡ではない

**⟹「同じセッションの古い退避を新しいもので置き換えてよいか」は、まだ確定していない。**

## 7. `session_id` 列には2種類の id が混在する

| 経路 | 入る値 |
| --- | --- |
| `#onPreCompact`（クローン） | SDK のセッション id（`?? 'clone'`） |
| `#salvageTranscript`（クローン） | 同上 |
| `case 'archive':`（マネージャー） | **`event.managerId`** |

`managerId` は既定で `mgr-${randomUUID()}` の固定形式。UUID は 16進のみなので `m`/`g`/`r` を
含みえない ⟹ **`mgr-` 前置で機械的に判別できる**（これは論理的な判定であって、
本番データへ問い合わせて確かめたものではない）。
