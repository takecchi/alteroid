---
name: pr-green
description: PR が本当に緑かを判定するとき、CI の完了を待つループを書くときに読む。statusCheckRollup がどの sha の結果か返さないこと、draft の skipped を緑と数えない、同じ sha に failure と success が同居しうる、gh pr ready が run を起こさず mergeStateStatus: CLEAN になる形、check-runs の started_at / id / completed_at のどれも世代の順序を決められないこと（run 側から降りる手順と scripts/check-pr-green.mjs）、created_at が同秒で並ぶとき id が tiebreak であること、cancelled が最新世代とは限らないこと、run 全体の conclusion が success にも failure にも化けること、BLOCKED と UNSTABLE の違い、ready 直後の 0 本を「起きていない」と読まないこと。
---

# PR が緑かを判定する（`check-runs` と run の世代）

<!-- AGENTS.md から移設（2026-09-17）。本文は1文字も変えていない。パスはリポジトリの根からの相対である。 -->

- **`gh pr view --json statusCheckRollup` は「どの sha の結果か」を返さない。force-push の直後は、古い head の結果を green として返す。** 実測（2026-08-23T06:34:13Z 観測、PR #292）: rebase して force-push（`7814d58` → `7b26a58`）した直後に CI 待ちのポーリングを始めたところ、**1回目で即座に `ci:COMPLETED:SUCCESS image:COMPLETED:SUCCESS` が返った。** 同じ時刻に sha を明示して引き直すと、実際の head はまだ走っていた:

  ```
  $ gh api repos/takecchi/alteroid/commits/7b26a58…/check-runs \
      --jq '.check_runs[] | "\(.name)=\(.status) @\(.head_sha)"'
  image=in_progress @7b26a58e…
  ci=in_progress    @7b26a58e…
  ```

  **その green は `7814d58`（1つ前の head）のものである。** rollup の各要素に `head_sha` は載っておらず、**出力だけを見て古いか新しいかを判別する手段が無い。** 対策: **CI を待つポーリングは `gh api repos/…/commits/<自分が push した sha>/check-runs` で sha を明示して回す。`statusCheckRollup` を待ちの判定に使わない**
  - **これで「CI が green」の罠は3つになり、3つとも同じ言葉に化ける。** 最初の2つは**その green が何を意味するか**の話、3つ目は**その green が誰のものか**の話である:

    | 罠                               | 何が古い／違うか                       | 在り処                                                               |
    | -------------------------------- | -------------------------------------- | -------------------------------------------------------------------- |
    | CI は `refs/pull/N/merge` を見る | **ブランチ先端そのものは測っていない** | `.github/workflows/ci.yml`（`actions/checkout@v4` に `ref:` が無い） |
    | ブランチ保護が `strict: false`   | **base 側が動いても再実行されない**    | `gh api repos/…/branches/main/protection`                            |
    | **`statusCheckRollup`**          | **ブランチ側の結果が古い head のもの** | この項目                                                             |

  - **⚠️ 3つ目は「`head_sha` は出所を分けて突き合わせる」（上の「依頼者の見立てを検証する」）を*別立てで*持っていれば塞げるが、rollup を待ちの判定に使う形にしていると塞げない。** 実際この一件は、その突き合わせを別立てで取っていたから気づいた側である —— 手順が「rollup が green を返したら次へ進む」だったら、**走行中の CI を green と読んで stale なままマージしていた。** 「たまたま踏まなかった」ではなく「別の歯が在ったから捕まった」側である

- **`success` や `mergeStateStatus: CLEAN` が「在る」ことは、それだけでは緑の証拠にならない。正しい sha の `check-runs` を引いた後でも、3つの形で化ける**（2026-09-15 観測、#983。関連 PR #969・#975・#979・#980）。**根はどれも同じ — `CLEAN` や `success` が「在る」ことを緑と読むことである。** 直上の「これで『CI が green』の罠は3つになり」は**どの sha を見ているか**の話だったが、こちらは**正しい sha を指定した後でも**起きる。

  1. **draft PR の `skipped` を緑と数えない。** draft のあいだ `ci` / `image` / `base-overlap` は `if:` の条件で `skipped` になり `completed` を返す。`ready_for_review` 後に本物の run が走ると、**同じ sha の `check-runs` に新旧2世代が並ぶ**（PR #969・#975 で観測）:

     ```
     ci            completed  success   started 23:26   ← 本物
     image         completed  success   started 23:26
     base-overlap  completed  success   started 23:26
     image         completed  skipped   started 23:18   ← draft 由来の古い行
     ci            completed  skipped   started 23:18
     base-overlap  completed  skipped   started 23:18
     ```

     `completed` が6本並ぶので緩く読むと緑に見えるが、**`skipped` は「通った」ではなく「走っていない」。**

  2. **同じ sha に `failure` と `success` が両方在りうる。`success` が在るかではなく、古い世代に引きずられていないか・全部揃っているかで見る。** PR #979（sha `13425e12`）で観測: 00:15 の run は結論が `failure` だが**ジョブを1本も実行していない**、00:45 の run は3ジョブ・16ステップを実行して `success`。**ジョブ0本の run は checkout もテストもしていないので、コードについて何も言っていない。** ⟹ `failure` が在ることだけでは赤と言えないし、`success` が在ることだけでは緑と言えない。実際に走ったかは `gh api repos/…/actions/runs/<id>/jobs` の `total_count` と実行時間で見る。

  3. **⭐ `gh pr ready` が run を起こさないことがあり、そのとき GitHub は `mergeStateStatus: CLEAN` と言う（いちばん危ない）。** PR #980 で観測: push（`synchronize`。この時点ではまだ draft）に続けて同じコマンドの中で `gh pr ready` を打ったところ、`ready` は run を1本も作らず、`ci` / `image` / `base-overlap` が draft 由来の `skipped` のまま `mergeStateStatus: CLEAN` になった。**機構は分かっている** — required contexts（`base-overlap` は意図的に外してある。逐語は `grep -Fn -- '入れていない' .github/workflows/ci.yml`。⚠️ **`contexts` の中身をここに数え上げない —— 増えるたびに腐る。** ここには「`ci` / `image` のみ」と書いてあったが、実測 2026-09-17T02:12Z で `["ci","image","no-attribution-trailers","pr-title-type"]` の4本だった。**持ち主は `.github/required-status-checks.json` と `pnpm check:required-status-checks`（protection と突き合わせる）である**）について、GitHub は **`skipped` を「満たした」として扱う**（同じファイルの逐語は `grep -Fn -- '満たしたものとして扱われる' .github/workflows/ci.yml`）。**draft の間だけ節約する `if:` の設計そのものが、`ready` が run を起こし損ねた瞬間に「required が全部 skipped のまま CLEAN」という牙になる。** `.github/workflows/ci.yml` の `pull_request.types` が `ready_for_review` を明示で足しているのはまさにこの事故を防ぐためだが、**それでも push と `ready` が近すぎると取りこぼされる。**

  **⟹ 判定の手順（実際に使ったもの）:**

  - `head_sha` を明示して `check-runs` を引く（`gh pr view --json statusCheckRollup` は sha を返さない。上の項目）
  - `conclusion == "success"` の行だけを数える。**`skipped` は「走っていない」**
  - 必要なチェックが**すべて** `success` であること（`ci` / `image` は required。`base-overlap` は required ではないが、見ないと同じ穴を踏む）
  - **同じ sha に複数の世代が在るときは、新しいほうを見る。⚠️ ただし「新しいほう」を `check-runs` の応答の中だけで決めないこと。** `check-runs` の各要素には世代の順序を決める信頼できるキーが無い（実測 2026-09-13〜15、#933。sha `1e619f43858160fb5d9a6b1895d236e35d4771cf`、PR #932）:
    - **`started_at` は run をまたぐと逆転する。** 古い run（draft、06:44:48作成）の `base-overlap` の `skipped` が `started_at=06:44:57` を持ち、新しい run（ready、06:44:54作成）の `success` の `started_at=06:44:56` より**1秒あとに始まっている**。⟹ `group_by(.name) | map(sort_by(.started_at) | last)` は `skipped` を選ぶ（今回は安全側の誤りだったが、鏡像は「古い世代の `success` が新しい世代の `failure` を追い越し、赤を見落とす」）
    - **check-run の `id` も同じ向きに逆転する。** `id` は「run が作られた順」ではなく「その check-run（＝ job）が作られた順」に振られるため、`if:` の評価が後段で遅れた job だけ id でも後ろへ回る。同じ標本で `base-overlap` は古い run の check-run の方が `id` も大きい。⟹ `group_by(.name) | map(max_by(.id))` も同じく `skipped` を選ぶ —— **`started_at` を `id` に替えても直らない**
    - **逆転はジョブ（門）ごとに起こる。** 同じ標本の8件中、逆転したのは `base-overlap` の1門だけで、`ci` / `image` / `pr-origin` は `started_at` でも `id` でも正しく新しい世代を選ぶ。⟹ 一部の門で「この数え方は正しい」と検証しても、他の門で赤を見落としうる
    - **`completed_at` も順序のキーにならない —— 「`started_at` が駄目なら `completed_at` を使う」という逃げ道も塞がっている。** 1つの check-run の**中で** `completed_at` が `started_at` より前になる例が在る（実測 2026-09-15、#933 コメント。PR #997、sha `5de558f6b2ca5e89ed2efac7b8d677f56cabb879`）: draft 世代（run `34929697970`）の `image` は `started_at=04:40:04` に対し `completed_at=04:39:57` で、**7秒前に完了したことになっている。** ⟹ 世代をまたぐ逆転（`started_at`/`id`）だけでなく、**1件の中の2つの時刻の前後関係すら壊れる**
    - **クローンと委譲先が、この誤り（`started_at` で世代を選ぶ）を独立に同時に犯した**（#933）。読み手の不注意ではなく、方法そのものが順序を保証していない
    - **対策: `check-runs` の一覧を世代選びに使わず、run の側から降りる。** `gh api "repos/<repo>/actions/runs?head_sha=<sha>&per_page=100"` で実際の run 一覧を取り、`workflow_runs` の `created_at`（run 自身が作られた実測時刻。job の `started_at` ではない）で **workflow 名ごとに**最新の run を選び（複数 workflow が同じ sha に在っても名前ごとに独立に選べば、走行中の別 workflow を丸ごと落とさない。#933 コメントの実測）、選んだ run の `gh api repos/<repo>/actions/runs/<id>/jobs` を読む。実測（2026-09-15 観測、上記 sha）: この手順は `image` / `base-overlap` / `ci` / `pr-origin` すべて `success` という正しい答えを返した。**`check-runs` の `check_suite.id` もこの標本では run の作成順と一致したが、複数 workflow・`rerun` で3世代目が生える場合は未検証**（#933 のコメント）なので根拠にしない
    - `scripts/check-pr-green.mjs`（`pnpm check:pr-green -- <sha>`）はこの手順をそのまま実装したもの
    - **⚠️ `created_at` が同じ秒で並ぶ標本が実在する。そのとき順序を決めているのは `id` の tiebreak である。** 実測（2026-09-17T02:12Z 観測、head `94e35f55…`。⚠️ この sha は既にマージ済みの PR #1126 のものなので、引き直せば同じものが出る）:

      ```
      $ gh api "repos/takecchi/alteroid/actions/runs?head_sha=94e35f55725c4764794f57770d1ec83f1401ce64&per_page=100" \
          --jq '.workflow_runs[] | "\(.id)\t\(.name)\tcreated=\(.created_at)\tconclusion=\(.conclusion)"' | sort -k2
      35152357266	No attribution trailers	created=2026-09-16T21:26:04Z	conclusion=cancelled
      35152358088	No attribution trailers	created=2026-09-16T21:26:04Z	conclusion=success
      35152357318	PR title	created=2026-09-16T21:26:04Z	conclusion=cancelled
      35152358166	PR title	created=2026-09-16T21:26:04Z	conclusion=success
      ```

      **`created_at` だけでは決まらない。** 決めているのは `id` の大小である（逐語は `grep -Fn -- 'return a.id > b.id ? a : b;' scripts/check-pr-green-core.mjs`）。`check-runs` 側の `started_at` も同じ向きを指す（`cancelled` が `21:26:04Z`、`success` が `21:26:08Z`）。

    - **⟹ `check-runs` の一覧に見える `conclusion=cancelled` の行は、最新世代とは限らない。** 上の2世代は `cancel-in-progress: true` が作ったもので（`.github/workflows/` のうち `CI` / `No attribution trailers` / `PR title` / `PR closing keywords` の4本が持つ。逐語は `grep -Fn -- 'cancel-in-progress: true' .github/workflows/ci.yml`）、**同じ枝へ短い間に2つのイベントが飛ぶと、push が無くても同じ sha の上に世代が2つ生まれて先の世代が切られる。**
      - **実際に1人が誤読した**（2026-09-16 観測）。`check-runs` の `cancelled` の行を見て「required の門が `cancelled` の世代を持っている」と読み、**最新世代は `success` だった。** ⚠️ **誤りの向きは赤の側なので、この回は実害が出ていない。鏡像（古い世代の `success` を最新と読んで赤を見落とす）は、上の `started_at` / `id` の逆転の項が扱っている。**
      - **⚠️ 「最新世代が `cancelled`」という状態自体は実在する**（実測 2026-09-17T02:20Z、直近1000 run の窓で **33件**。全部 `CI` の run で、`ci` と `image` は required である）。**ただしそのとき GitHub が required を満たしたと見なすかは測れていない** —— 経緯と、測るのに要る費用は #1155 に在る
  - **その run が実際にジョブを実行したか**を見る（`actions/runs/<id>/jobs` の `total_count` が0でないこと。実行時間も見る）
  - **`mergeStateStatus` を緑の根拠にしない**
    - **⚠️ とはいえ `mergeStateStatus` は required を満たしたかどうかを見分けている。`BLOCKED` と `UNSTABLE` は別の値である。** 実測（2026-09-17T02:57Z 観測、PR #1154。**required の4本が全部 `success` で、required に入っていない `base-overlap` だけが `failure`** の状態）:

      ```
      $ gh api repos/takecchi/alteroid/commits/457429037910998f0106ccb913479e772134c66b/check-runs \
          --jq '.check_runs[] | "\(.name)\t\(.conclusion)"'
      pr-closing-keywords	success
      no-attribution-trailers	success
      pr-title-type	success
      image	success
      ci	success
      base-overlap	failure
      $ gh pr view 1154 --json mergeable,mergeStateStatus
      mergeable=MERGEABLE mergeStateStatus=UNSTABLE
      ```

      ⟹ **`BLOCKED`＝required が満たされていない / `UNSTABLE`＝required は満たしたが、ほかに赤が在る。** **緑の根拠にはならないが、「required を満たしたか」を読む用には使える** —— 直上の「緑の根拠にしない」と矛盾しない（あれが言っているのは**満たしたことを緑と読むな**であって、値が何も見分けていないという意味ではない）。

    - **⚠️ そして run 全体の `conclusion` は、逆向きにも当てにならない。** 同じ標本で **`CI` の run の `conclusion` は `failure`** だが、**その run の中の required なジョブ（`ci` / `image`）は2本とも `success`** である（落ちているのは required ではない `base-overlap` 1本）。

      ```
      $ gh api repos/takecchi/alteroid/actions/runs/35175534722 --jq '"conclusion=\(.conclusion)"'
      conclusion=failure
      $ gh api repos/takecchi/alteroid/actions/runs/35175534722/jobs --jq '.jobs[] | "\(.name)\t\(.conclusion)"'
      base-overlap	failure
      ci	success
      image	success
      ```

      ⟹ **上の項が持つ「`run.conclusion == "success"` は緑の根拠にならない」には鏡像が在る —— `run.conclusion == "failure"` も「マージが止まる」の根拠にならない。** どちらの向きでも、**ジョブの内訳まで降りないと required の状態は読めない。**
  - `gh pr ready` の後は**本物の run が作られたことを確かめる**。作られないなら `gh pr close` → `gh pr reopen` で起こす（**枝を1バイトも触らない**ので安全。空コミットでもよい）
    - **⚠️ ただし「作られていない」を、早すぎる問い合わせで自分から作らないこと。** 実測（2026-09-17、PR #1154）: `gh pr ready` と**同じ1呼びの中で** `gh api "repos/…/actions/runs?head_sha=<sha>"` を打つと、**新しい run は1本も返らない。** timeline の `ready_for_review` は `02:44:06Z`、run 4本の `created_at` は `02:44:08Z` で、**22秒後（`02:44:28Z`）に引き直したら4本とも見えた。** ⟹ **0本は「起きていない」ではなく「まだ見えていない」ことがある。**
      - **⚠️ そしてここで `close` → `reopen` を打つと、同じ concurrency group に2世代目が生まれて1世代目が切られる**（`cancel-in-progress: true`）。**この帰結そのものは測っていない —— 機構からの推論である。** 言えるのは「間を置いてもう一度引いてから判断すること」までである

  **⚠️ 待つループの書き方にも同じ根が出る。** 「すべての `check-runs` が `completed` になったら抜ける」というループは、**本物の run がまだ作られていない瞬間に即座に抜ける**（draft 由来の `skipped` は既に `completed` なので）。**「`skipped` 以外が必要な本数揃うまで」を条件にすること。**

- **draft の run が `conclusion: success` を名乗るようになった —— draft でも走る門が1本増えたせいで、run 全体の結論が緑に見える。** `.github/workflows/ci.yml` の `no-attribution-trailers` ジョブは、`ci` / `image` / `base-overlap` と違って draft の間も skip しない（`if: github.event_name == 'pull_request'` のみで、他の3ジョブが持つ draft 判定を持たない）。⟹ **この1本が `success` を返すだけで、`ci` / `image` / `base-overlap` が全部 `skipped` のままでも run 全体の `conclusion` は `success` になる。** 実測（2026-09-15 観測、PR #1021 の draft 中の run `34970519704`。自分で取り直した）:

  ```
  $ gh api repos/takecchi/alteroid/actions/runs/34970519704 --jq '{conclusion, status}'
  {"conclusion":"success","status":"completed"}
  $ gh api repos/takecchi/alteroid/actions/runs/34970519704/jobs --jq '.total_count, (.jobs[] | "\(.name) \(.conclusion) steps=\(.steps|length)")'
  4
  no-attribution-trailers success steps=6
  base-overlap skipped steps=0
  image skipped steps=0
  ci skipped steps=0
  ```

  ⟹ **`run.conclusion == "success"` は、これまで以上に緑の根拠にならない。** 直上の「その run が実際にジョブを実行したか」（`total_count` が0でないこと）だけでは足りない——**今回は `total_count` が4で「実行した」を通過したあとにも化ける形**である。⛔ **ジョブの内訳（`actions/runs/<id>/jobs`）まで降り、必要な各ジョブ（`ci` / `image`）の `conclusion` を個別に見ること。**

  **⭐ この形は #1108（PR #1115、2026-09-16T21:15:17Z マージ）で解消した。ただし上の結論は1文字も変わらない。** `no-attribution-trailers` は `ci.yml` から独立した workflow（`.github/workflows/no-attribution-trailers.yml`）へ出たので、**`CI` の run の中に draft でも走るジョブはもう無い。** ⟹ draft のあいだ `CI` の run 自身の `conclusion` は `skipped` に戻った。実測（2026-09-17T02:14Z 観測、自分で取り直した。**#1108 のマージより後に作られた run 3本**）:

  ```
  $ for r in 35151392371 35151922022 35152153308; do
      gh api repos/takecchi/alteroid/actions/runs/$r --jq '"name=\(.name) head_sha=\(.head_sha) created=\(.created_at) status=\(.status) conclusion=\(.conclusion)"'
      gh api repos/takecchi/alteroid/actions/runs/$r/jobs --jq '"total_count=\(.total_count)", (.jobs[] | "  \(.name)\t\(.conclusion)\tsteps=\(.steps|length)")'
    done
  name=CI head_sha=2f50b7630b3f16e9cd724398994388fcc2176193 created=2026-09-16T21:15:54Z status=completed conclusion=skipped
  total_count=3
    image	skipped	steps=0
    ci	skipped	steps=0
    base-overlap	skipped	steps=0
  name=CI head_sha=94e35f55725c4764794f57770d1ec83f1401ce64 created=2026-09-16T21:21:27Z status=completed conclusion=skipped
  total_count=3
    base-overlap	skipped	steps=0
    image	skipped	steps=0
    ci	skipped	steps=0
  name=CI head_sha=16b5d284d74b9f0495a174fa6c56a647529983c0 created=2026-09-16T21:23:54Z status=completed conclusion=skipped
  total_count=3
    ci	skipped	steps=0
    image	skipped	steps=0
    base-overlap	skipped	steps=0
  ```

  **3/3。** ⚠ **「その3本が draft だった」は現在の `isDraft` からは取れない**（3本とも後から ready になっている）。**見るのは timeline である** —— PR #1116 の `ready_for_review` は `2026-09-16T21:34:13Z` で、run の作成（`21:15:54Z`）の **18分19秒後**である。

  **⟹ 変わったのは結論ではなく、見るべき run の本数である。** 同じ draft の PR（head `2f50b763`）で run は3本に分かれ、**`CI` 以外の2本は draft でも `success` を返す**（同じ観測）:

  ```
  $ gh api "repos/takecchi/alteroid/actions/runs?head_sha=2f50b7630b3f16e9cd724398994388fcc2176193&per_page=100" \
      --jq '.workflow_runs[] | "\(.id)\t\(.name)\tcreated=\(.created_at)\tconclusion=\(.conclusion)"'
  35151392371	CI	created=2026-09-16T21:15:54Z	conclusion=skipped
  35151392373	No attribution trailers	created=2026-09-16T21:15:54Z	conclusion=success
  35151392383	PR title	created=2026-09-16T21:15:54Z	conclusion=success
  ```

  この2本が draft でも skip しないのは**意図である**（逐語は `grep -Fn -- 'draft のあいだも毎回走らせ' .github/workflows/no-attribution-trailers.yml` と `grep -Fn -- '同じく draft でも skip しない' .github/workflows/pr-title.yml`）。⟹ ⭐ **「緑の run が在る」は `ci` が走ったことを意味しない、はそのまま効く。** 化け方が「1本の run の中で `conclusion` が緑になる」から「**緑の run が別に在る**」へ移っただけである。**ジョブの内訳まで降りろ**も変わらない —— `scripts/check-pr-green.mjs` は workflow 名ごとに最新の run を選ぶので、3本に分かれても正しく答える（#1108 で実測）。
