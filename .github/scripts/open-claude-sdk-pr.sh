#!/usr/bin/env bash
#
# `update-claude-sdk.sh` が上げた版を1本のブランチへ積み直し、PR を出す（既にあれば
# 書き換える）。**マージはしない** — するのは人間である。
#
# ## なぜブランチを固定するのか
#
# 日次で回るので、版ごとに新しいブランチを作ると読まれない PR が毎日1本増える。
# 開いている PR は常に高々1本にし、そこへ積み直す。
#
# ## force push について
#
# このブランチはこの経路だけが書く前提なので上書きしてよい（`reflect-release-prod.sh`
# の `release/prod` と同じ性質）。**ただし「前提」を宣言で終わらせない** — 人間が
# レビュー中に修正を積んでいたら、翌朝の実行がそれを黙って消す。push の前に
# 「このブランチにある `$base` 以外のコミットが、全部この bot のものか」を見て、
# 違うものが1つでもあれば止める。**他のブランチへ force しないこと。**
#
# ## draft で出す条件
#
# 検証（build / typecheck / lint / format:check / test）が落ちたら draft にする。
# 失敗した cron の実行としてログの中に埋もれるより、赤い PR として見えるほうが届く。
# 「draft ＝ まだ人間が読む状態ではない」という意味は AGENTS.md と揃えてある。
#
# ## この経路が持っていない状態
#
# **「人間がこの更新を断った」を表す場所は無い。** PR を close しても、次に版が
# 上がった日に新しい PR が出る（`--state open` で探すので closed は拾わない）。
# 断りを覚えさせたくなったら、それは別の状態を足す変更であり、ここではない。
#
# ## CI が起動しない回の扱い（#867）
#
# `SDK_CI_TRIGGERED`（`ALTEROID_PR_TOKEN` が secret に置かれているかの真偽。
# 秘密の値そのものはここへは渡らない）が `'true'` でないとき、この PR には
# CI が付かない（`GITHUB_TOKEN` 制約。上の「PR を出す」ステップのコメント参照）。
# その回だけ、(1) PR タイトルに `[CI未起動] ` を接頭し、(2) 本文の**先頭**に
# 警告を差し込み、(3) `::warning::` を1本出す。**ラベルは採らない** — この
# repo にはカスタムラベルが無く、新規作成には `issues: write` が要る
# （オーナーの手番に触れる）。**ワークフローを赤で終わらせることもしない** —
# SDK 更新自体は成功しているのに失敗として届き、しかも毎晩赤くなるので、また
# 無視される側に回る。`SDK_CI_TRIGGERED` が空/未設定のときは「起きない」側へ
# 倒す（`SDK_VERIFY_OK` と同じ規約）。

set -euo pipefail

# **どの経路を通っても必ず1行出す。**
#
# **`${VAR:?…}` を使わないこと。** EXIT trap があると `:?` の失敗が exit 0 に化ける
# （実測。`update-claude-sdk.sh` の同じ注記を見ること）。必須の検査は明示で書く。
outcome='PR の作成に到達せずに終わった（この行が出たらこのスクリプトの欠陥である）'
trap 'printf "=== PR: %s ===\n" "$outcome"' EXIT

# テストから差し替える口。既定は素の `gh`。
GH="${GH:-gh}"
branch="${SDK_BRANCH:-}"
version="${SDK_VERSION:-}"
version_before="${SDK_VERSION_BEFORE:-}"
body_file="${SDK_PR_BODY:-}"
base="${SDK_PR_BASE:-main}"
# **空なら false 側へ倒す。** 検証ステップが落ちて出力が空になった場合、
# 「緑だった」ではなく「確かめられていない」が正しい。
verify_ok="${SDK_VERIFY_OK:-}"
# **同じ規約を `SDK_CI_TRIGGERED` にも適用する（#867）。** 空/未設定のときは
# 「起きる」ではなく「起きない」側へ倒す —— 上の `verify_ok` と同じ理由で、
# 「確かめられていない」を楽観側（起きる）に倒すと、CI が付かないまま静かに
# ready 扱いになりかねない。ワークフロー側は必ず 'true' か 'false' の文字列を
# 渡すが、渡し忘れ・古い呼び出し元（テストなど）は空になりうるので、ここで
# 明示的に false 側へ倒しておく。
ci_triggered="${SDK_CI_TRIGGERED:-}"
if [ "$ci_triggered" = 'true' ]; then
  ci_missing=''
else
  ci_missing='true'
fi
bot_email="${GIT_AUTHOR_EMAIL:-41898282+github-actions[bot]@users.noreply.github.com}"
bot_name="${GIT_AUTHOR_NAME:-github-actions[bot]}"

require_env() {
  if [ -z "$2" ]; then
    outcome="必須の環境変数 $1 が無いので何もしなかった"
    echo "::error::$1 が要る" >&2
    exit 1
  fi
}
require_env SDK_BRANCH "$branch"
require_env SDK_VERSION "$version"
require_env SDK_PR_BODY "$body_file"

# **版が動いていない回にタイトルで嘘をつかない。** `changed` の判定は差分で行う
# ので、catalog が据え置きのまま lockfile（プラットフォーム別パッケージ・推移依存）
# だけが動くことがある。その回に「0.3.237 へ上げる」と書くと、いま入っているのと
# 同じ版を指してしまう。
if [ -n "$version_before" ] && [ "$version_before" = "$version" ]; then
  title="chore: @anthropic-ai/claude-agent-sdk 周辺の lockfile を更新する（版は $version のまま）"
else
  title="chore: @anthropic-ai/claude-agent-sdk を $version へ上げる"
fi

# **CI が起きない回だけ、タイトルへ接頭を付ける（#867）。** 上の版の出し分けとは
# 別の軸なので、二重に書かず後段でここへ付け足す。`gh pr list` / PR 一覧 /
# 通知メールの件名として、開く前に読める場所へ出すのがこの接頭の役目。
# **タイトルは毎回この2ブロックだけからゼロ組み立てされる**ので、前夜に付いた
# 接頭が残ることはない（CI が回復した回は素通りしてこの if に入らない）。
if [ -n "$ci_missing" ]; then
  title="[CI未起動] $title"
fi

# **出所の刻印（`<!-- alteroid-origin: automation -->`）を本文の先頭へ
# 必ず差し込む（Issue #893 / #930）。**
#
# ## なぜ .yml のヒアドキュメントではなくここに置くか
#
# このリポジトリの出所の刻印は `packages/core/src/origin-marker.ts` /
# `scripts/check-pr-origin-core.mjs` が正本で、書く側は `prompt.ts`
# （マネージャー・クローン・作業者向け）と、この自動化（bot として走る
# `update-claude-sdk.yml`）の2箇所に分かれている。**`update-claude-sdk.yml`
# のヒアドキュメントへ直書きする案もあったが、採らなかった** —— このスクリプト
# は `.github/scripts/update-claude-sdk.test.ts` の
# `describe('open-claude-sdk-pr.sh')` が gh シム経由で**実際に走らせ**、
# 実行後の `$body_file` の中身を読み返して確かめている唯一の場所である。
# `.github/workflows/**` の中身（`.yml` のヒアドキュメント）を守る歯は
# 1本も無い——書けば「動くのに嘘をつく」側の穴を自分で作ることになる
# （`AGENTS.md`「作業者へ切り出す」の同じ注意）。しかもここに置けば、
# 新規作成の経路（`create_pr`）と既存 PR の書き換え（`gh pr edit
# --body-file`、下）の**両方**が必ずこの `$body_file` を通るので、1箇所で
# 両方の歯が立つ。
#
# ## なぜ値を直書きするか
#
# このシェルは TypeScript の `ORIGIN_AUTOMATION`（`origin-marker.ts`）を
# import できないので、値 `automation` はここでは**写し**である（この
# ファイル自身がそう名乗る）。`check-pr-origin-core.mjs` が `CLONE_VALUE` /
# `HUMAN_VALUE` を文字列として複製しているのと同じ形の重複であり、
# `scripts/check-pr-origin.test.ts` の「写しの突き合わせ」の歯が、この行の
# 文字列と `formatOriginMarker(ORIGIN_AUTOMATION)` の一致を見張っている
# ——値を変えるならその歯を通して両方直すこと。
#
# ## 並び順（CI が起きない回の警告より前に置く）
#
# 下の「CI が起きない回だけ、本文の先頭へ警告を差し込む」ブロックは
# `$body_file` の**現在の中身**の前に警告を継ぎ足す。刻印をこのブロックより
# 前に置くことで、最終的な並びは
# `[CI 警告（在る回だけ）] → [刻印] → [本文]` になり、`WARNING_MARK` で
# 本文が始まることを確かめる既存テストを壊さない。
marker_file="$(mktemp)"
{
  echo '<!-- alteroid-origin: automation -->'
  cat "$body_file"
} >"$marker_file"
mv "$marker_file" "$body_file"

# **CI が起きない回だけ、本文の先頭へ警告を差し込む（#867）。**
#
# ## なぜここに書くか（Issue #867 の誤りの訂正）
# Issue は「理由は Job Summary に書いているが誰も読まない」と書いていたが、
# 実際には `GITHUB_STEP_SUMMARY` への書き込みはこのワークフロー・スクリプトの
# どこにも無かった（grep で確認、ヒット0）。理由は実際には **PR 本文の末尾**
# （このスクリプトを呼ぶ `update-claude-sdk.yml` のヒアドキュメントの最後の3行）
# に書かれていて、しかも**無条件**だった（CI が付いている回にも同じ文が出る
# ＝ 常に在る文字列は情報を持たない）。それを4晩分マージまで運用しても
# 「開かない PR が積む」問題は直らなかった —— 場所（本文の最後）と条件
# （常に出る）の両方が外れていたからである。だからここでは
# **条件付き（CI が本当に起きないときだけ）・本文の先頭**に出す。
#
# ## 誰が・いつ・どうやって見るか
# PR 本文の先頭は、オーナーが朝この PR を開いてマージしようとした瞬間に
# 読む場所である（過去の同枝 PR はすべて人間が開いてマージしている＝実績の
# ある視線の通り道）。タイトルの接頭（上）は `gh pr list` / PR 一覧 / 通知
# メールの件名として、開く前に読める場所である。
if [ -n "$ci_missing" ]; then
  warning_file="$(mktemp)"
  {
    echo '> [!WARNING]'
    echo '> **この PR には CI が付かない。** `GITHUB_TOKEN` で作った PR は `pull_request`'
    echo '> のワークフローを起こさない（GitHub の仕様。無限ループ防止）。required の'
    echo '> `ci` / `image` はこの PR には永久に現れないので、放っておくと'
    echo '> `BLOCKED` のまま動かない。'
    echo '>'
    echo '> **恒久的に直すには:** `ALTEROID_PR_TOKEN`（fine-grained PAT。'
    echo '> `Contents: Read and write` / `Pull requests: Read and write`）を'
    echo '> secret に置く。それが無いあいだは、Actions 画面でこの PR を作った run を'
    echo '> 開き「Approve and run」を押す必要がある。'
    echo '>'
    echo '> 詳細: #867'
    echo ''
    cat "$body_file"
  } >"$warning_file"
  mv "$warning_file" "$body_file"
  echo '::warning::この PR には CI が付かない（GITHUB_TOKEN 制約。ALTEROID_PR_TOKEN を secret に置くと解消する。詳細は本文と #867）' >&2
fi

git config user.name "$bot_name"
git config user.email "$bot_email"

# 既にリモートにこのブランチがあるなら、人間の手が入っていないかを見る。
# **無ければ何もしない**（初回）。
if git ls-remote --exit-code --heads origin "$branch" >/dev/null 2>&1; then
  git fetch --quiet origin "+refs/heads/$branch:refs/remotes/origin/$branch"
  # `$base` に含まれないコミットだけを見る（`$base` 側は人間のもので当然である）。
  foreign="$(git log --format='%ae' "refs/remotes/origin/$branch" --not "origin/$base" |
    grep -v -x -F "$bot_email" || true)"
  if [ -n "$foreign" ]; then
    outcome='リモートのブランチに bot 以外のコミットがあるので force push せずに止めた'
    {
      echo "::error::$branch に $bot_email 以外が積んだコミットがある。"
      echo '上書きすると人間の作業が消えるので止める。中身を人間が回収してから、'
      echo 'ブランチを消すか、このコミットを取り込むこと。作者:'
      printf '%s\n' "$foreign" | sort -u
    } >&2
    exit 1
  fi
fi

git checkout -B "$branch"

# **`git add -A` を使わない**（AGENTS.md「リポジトリの約束」）。触ってよいのはこの3つ
# だけである。`apps/daemon/openapi.json` を含めるのは `pnpm build` が毎回書き直す
# ためで、SDK 由来で spec が動いた場合に置いていくと CI の一致検査が落ちる。
git add pnpm-workspace.yaml pnpm-lock.yaml apps/daemon/openapi.json

# **未追跡は数えない（`--untracked-files=no`）。** `pnpm build` が作る
# `packages/*/src/generated/` `apps/web/.react-router/` は .gitignore に入っている
# ので素の checkout では出てこないが、ここで見たいのは**追跡下のファイルが他にも
# 動いていないか**である。commit するのは上の3つだけなので、未追跡が増えていても
# 混入はしない。
#
# **`git status` 自身の失敗を `|| true` に吸わせない。** 吸わせると「落ちて何も
# 出力しなかった」が「想定外の差分なし」として素通りし、`git add -A` を使わない
# ことの唯一の歯が黙って消える（AGENTS.md「`grep -c` が返す 0 は2つの意味を持つ」）。
if ! status_out="$(git status --porcelain --untracked-files=no)"; then
  outcome='git status が失敗したので判定せずに止めた'
  echo '::error::git status が失敗した。判定できないので止める' >&2
  exit 1
fi
unexpected="$(printf '%s\n' "$status_out" |
  grep -v -E '^(M  (pnpm-workspace\.yaml|pnpm-lock\.yaml|apps/daemon/openapi\.json))?$' || true)"
if [ -n "$unexpected" ]; then
  outcome='想定していない差分があったので何もせずに止めた'
  echo '::error::想定していない差分がある。中身:' >&2
  printf '%s\n' "$unexpected" >&2
  exit 1
fi

git commit -m "$title"
git push --force origin "$branch"

# **`--state open` を明示する。** 既定は open だけだが、閉じられた PR を拾って
# `gh pr edit` に渡すと「閉じた PR を書き換えて誰も見ない」経路ができる。
number="$($GH pr list --head "$branch" --state open --json number --jq '.[0].number // empty')"

# PR を作れなかったときに、原因が読める形で落とす。**既定の `GITHUB_TOKEN` では
# 作れない設定がある** — Settings → Actions → General →「Allow GitHub Actions to
# create and approve pull requests」が off だと 403 になる（API では
# `gh api repos/<owner>/<repo>/actions/permissions/workflow` の
# `can_approve_pull_request_reviews`）。PAT を置く場合に要るのは fine-grained の
# `Contents: Read and write` と `Pull requests: Read and write` だけである。
create_pr() {
  if ! $GH pr create "$@"; then
    outcome='gh pr create が失敗した'
    {
      echo '::error::PR を作れなかった。GITHUB_TOKEN で作る構成なら Settings → Actions'
      echo '→ General →「Allow GitHub Actions to create and approve pull requests」が'
      echo '必要である（off だと 403）。または ALTEROID_PR_TOKEN（fine-grained PAT。'
      echo 'Contents: RW / Pull requests: RW）を置くこと。'
    } >&2
    exit 1
  fi
}

# **outcome にも CI 起動可否を載せる（#867）。** trap の1行がこのスクリプトの
# 唯一の必ず出る合図なので、そこにも状態を残す。
if [ -n "$ci_missing" ]; then
  ci_note='、CI未起動'
else
  ci_note=''
fi

if [ -z "$number" ]; then
  if [ "$verify_ok" = 'true' ]; then
    create_pr --base "$base" --head "$branch" --title "$title" --body-file "$body_file"
    outcome="PR を新規に作成した（ready${ci_note}）: $title"
  else
    create_pr --draft --base "$base" --head "$branch" --title "$title" --body-file "$body_file"
    outcome="PR を新規に作成した（draft ＝ 検証が緑ではない${ci_note}）: $title"
  fi
else
  $GH pr edit "$number" --title "$title" --body-file "$body_file"
  # `gh pr ready --undo`（draft へ戻す）はプランに依存する。使えない構成では
  # ここが非0で落ちる ＝ **一番中身を知りたい回に落ちる**ので、落ちても PR 自体は
  # 残っていることが分かるように outcome を先に置いておく。
  if [ "$verify_ok" = 'true' ]; then
    outcome="既存の PR #$number を書き換えた（ready にする${ci_note}）"
    $GH pr ready "$number"
    outcome="既存の PR #$number を書き換えた（ready${ci_note}）"
  else
    outcome="既存の PR #$number を書き換えた（draft へ戻す${ci_note}）"
    $GH pr ready --undo "$number"
    outcome="既存の PR #$number を書き換えた（draft へ戻した ＝ 検証が緑ではない${ci_note}）"
  fi
fi
