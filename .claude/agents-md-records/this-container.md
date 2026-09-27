# AGENTS.md「自分が走っている器」の実例と実測

#1192 の再編で AGENTS.md から逐語で移したもの。要約・短縮はしていない。規則そのものは AGENTS.md の同じ節に在る。規則を疑うとき・同じ形を踏んだかもしれないときに読む。

## 実測（2026-08-22T15:36Z）: 根の CLAUDE.md は未 push のブランチだった

`/workspace` の根が誰かのチェックアウトになっている器では、`cwd` の直下に `CLAUDE.md` が在るので**開始時に載る** — 載るのはその人の版であって、自分がこれから clone する版ではない（実測 2026-08-22T15:36Z: 根の `CLAUDE.md` は `AGENTS.md` への symlink で、その HEAD は `main` ではなく未 push のブランチだった）

## 掃除のつもりの走査が別の作業者の vitest を落とした

実際に、掃除のつもりの走査が別の作業者の vitest を落とした。**しかも汚染は静かで**、落とされた側からは「バックグラウンドで待っている」ように見える（39分そう読んだ）

## 3体の作業者の ID がすべて同一だった実例

** マネージャー（依頼者）が3体の作業者へ「`/workspace/<自分のID>/` へ clone せよ」と指示したところ、**3体の ID がすべて `worker-1aa8c87d` で同一**だったため、3体が `/workspace/worker-1aa8c87d/repo` という同一の `.git` を共有した。**これは上の worktree の話（プロセス空間の共有）とは別の軸で、今回はファイルすら分かれていなかった。** 作業者の1体が報告した生の経緯 — clone 直後の `git status` は clean だった。`AGENTS.md` を編集した直後に取った `git status` には、自分が触っていない `apps/daemon/src/schedule.ts` に26行の未コミット差分が既にあった（別の作業者の作業）。`git checkout -b docs/cd-fg-bg-cwd-lifetime` の数十秒後には `.env.example` / `compose.yaml` / `railway/README.md` にも未コミット差分が出現していた。**`git commit` を実行したところ、出力が `[fix/initiative-tick-default-55 4421d5b] …` になった** — 自分が作ったブランチではなく、別の作業者のブランチへコミットされていた（`checkout -b` の後に別プロセスが HEAD を奪っていた）。**⭐ 最後に、他プロセスへブランチを返すつもりで `git checkout fix/initiative-tick-default-55` を試みたところ、git 自身が「`AGENTS.md` の未コミットのローカル変更が上書きされる」として checkout を拒否し、この拒否のおかげでデータが失われなかった。これは仕組みで塞げているのではなく、たまたま git のこの挙動に助けられた形である。

## 実例（2026-08-22）: 読み取り専用の作業者へ指示しながら同じツリーを編集していた

** 実例（2026-08-22）: 読み取り専用の作業者へ「最後に `git status --short` が空であることを報告せよ」と指示しながら、**指示した側が同じツリーの別ファイルを編集していた。** 作業者は `Edit` / `Write` を一度も呼んでいないのに差分が在ることから「別プロセスが書いている」と正しく導き、範囲外として報告した — **判断は正しく、原因は依頼文を書いた側にある。

## 実測: draft PR が長時間放置された（PR #79 / #88 / #92 / #83）

実測（`gh api repos/takecchi/alteroid/issues/<n>/timeline`、観測 2026-08-20T07:53Z）— PR #79: created 2026-08-19T01:10:56Z / ready_for_review 2026-08-20T06:21:18Z(takecchi) / merged 06:27:26Z(takecchi)。PR #88: created 2026-08-19T16:14:40Z / CI green は作成25分後の16:39 / ready_for_review 2026-08-20T05:49:29Z(takecchi) / merged 05:49:33Z(takecchi) — **ready からマージまで4秒**。CI green から ready までは13時間空いており、**空いていたのはレビューの時間ではなく人間が気づくまでの時間**。PR #92: created 2026-08-20T02:30:43Z / ready 06:09:11Z(takecchi) / merged 06:27:38Z(takecchi)。PR #83: created 2026-08-19T09:47:21Z / ready 2026-08-19T14:20:56Z(takecchi) / merged 14:32:03Z(takecchi)。**確認できた全件で ready_for_review の actor は `takecchi` で、自動で ready にする経路もコード上に無い**（`.github/workflows/*.yml` に該当行なし）。**⚠️ ただしこの数え上げは actor しか見ていない。** actor は層を判別しないので（上の「リポジトリの約束」）、**ここで言えるのは「人間のトークンで打たれた」までで、「人間がやった」ではない** — クローンの操作が人間として数えられている可能性がある。人間から「alteroidが作ったPR、#88 #92 #79 が長時間放置されています」という苦情が実際に出ている。**ロスを防ぐために入れたこの「最初の1回で push して draft PR を開く」が、そのまま長時間の放置に繋がっている**
