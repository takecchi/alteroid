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

if [ -z "$number" ]; then
  if [ "$verify_ok" = 'true' ]; then
    create_pr --base "$base" --head "$branch" --title "$title" --body-file "$body_file"
    outcome="PR を新規に作成した（ready）: $title"
  else
    create_pr --draft --base "$base" --head "$branch" --title "$title" --body-file "$body_file"
    outcome="PR を新規に作成した（draft ＝ 検証が緑ではない）: $title"
  fi
else
  $GH pr edit "$number" --title "$title" --body-file "$body_file"
  # `gh pr ready --undo`（draft へ戻す）はプランに依存する。使えない構成では
  # ここが非0で落ちる ＝ **一番中身を知りたい回に落ちる**ので、落ちても PR 自体は
  # 残っていることが分かるように outcome を先に置いておく。
  if [ "$verify_ok" = 'true' ]; then
    outcome="既存の PR #$number を書き換えた（ready にする）"
    $GH pr ready "$number"
    outcome="既存の PR #$number を書き換えた（ready）"
  else
    outcome="既存の PR #$number を書き換えた（draft へ戻す）"
    $GH pr ready --undo "$number"
    outcome="既存の PR #$number を書き換えた（draft へ戻した ＝ 検証が緑ではない）"
  fi
fi
