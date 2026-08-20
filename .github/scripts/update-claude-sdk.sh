#!/usr/bin/env bash
#
# Claude 本体（`@anthropic-ai/claude-agent-sdk`）を最新へ上げ、上がったかどうかを
# 呼び手へ返す。**ワークフローの中に直接書かない**のは、そこに書いた bash は
# 走らせてみるまで確かめられないからである（`reflect-release-prod.sh` と同じ理由。
# こちらの検証は `update-claude-sdk.test.ts`）。
#
# ## なぜ機械に上げさせるのか
#
# この SDK はクローン・マネージャー・作業者が実際に走る実行系そのもので、
# エイリアス（`fable` / `opus` / `sonnet`）から具体のモデル id への対応表も
# バンドルの中に焼かれている。**版を止めるとモデルの版も止まる。** lockfile で
# 固定するのは再現性のために正しいが、上げに行く経路が無ければそれは
# 「人間の手元の Claude Code より古いものを配る」ことであり、デグレードである
# （north_star 禁止1。Dockerfile で `gh` を固定しないのと同じ理由）。
#
# ## 何を出力するか
#
# `$GITHUB_OUTPUT` へ `changed` / `before` / `after` の3つ。**判定は版の文字列では
# なく実際の差分で行う** — catalog が動かなくても lockfile 側（プラットフォーム別
# パッケージ・推移依存）が動くことがある。そのため `before == after` でも
# `changed=true` はありうる（呼び手はその場合の表示を変えること）。

set -euo pipefail

# **どの経路を通っても必ず1行出す。** 何も出さずに終わったログを見たときに
# 「上がっていなかった」と「壊れて何もしなかった」が区別できなくなる。
#
# **`${VAR:?…}` をこのスクリプトで使わないこと。** EXIT trap があると、`:?` で
# 落ちたときの終了コードが trap の中の最後のコマンドのもの（＝0）に化ける
# （実測: `bash -c 'set -euo pipefail; trap "printf x" EXIT; : "${M:?req}"'` は
# exit 0。trap の中で `$?` を保存し直しても 0 のままである）。必須の検査は
# `if [ -z … ]; then … exit 1; fi` で書く。
outcome='判定に到達せずに終わった（この行が出たらこのスクリプトの欠陥である）'
trap 'printf "=== SDK 更新: %s ===\n" "$outcome"' EXIT

# テストから差し替える口。**既定は素の pnpm** で、CI は既定のまま走る。
PNPM="${PNPM:-pnpm}"
# 書き出し先。GitHub Actions では `$GITHUB_OUTPUT` が入っている。
output_file="${GITHUB_OUTPUT:-/dev/null}"

readonly SDK='@anthropic-ai/claude-agent-sdk'

# catalog の1行が正本（各パッケージは `catalog:` で参照している）。
# **見つからなければ落とす** — 空文字を返すと「上がっていない」と区別が付かず、
# 静かに何もしない日が続く。
read_version() {
  node -e '
    const fs = require("fs");
    const src = fs.readFileSync("pnpm-workspace.yaml", "utf8");
    const m = src.match(/^\s*.@anthropic-ai\/claude-agent-sdk.:\s*\^?([0-9][^\s#]*)/m);
    if (!m) {
      console.error("pnpm-workspace.yaml の catalog に @anthropic-ai/claude-agent-sdk が無い");
      process.exit(1);
    }
    process.stdout.write(m[1]);
  '
}

# `minimumReleaseAgeExclude` の中身を1行1件で返す。
#
# **なぜ見張るのか。** pnpm 11 の既定は loose mode（`minimumReleaseAgeStrict` を
# 明示していないとき）で、公開24時間以内のパッケージを引くと **pnpm が自分で
# `minimumReleaseAgeExclude` へその名前を書き足して install を通す**（同梱の
# CHANGELOG: "Loose mode … auto-adds the immature picks to minimumReleaseAgeExclude
# in pnpm-workspace.yaml"）。ここを見張らないと、SDK を上げる PR に「別の依存の
# 24時間待ちを外す」変更が黙って混ざり、`pnpm-workspace.yaml` が自分で書いている
# 方針（除外は SDK のためのものであって、一般の依存を素通しする場所ではない）が
# 機械の手で崩れる。
read_excludes() {
  node -e '
    const fs = require("fs");
    const lines = fs.readFileSync("pnpm-workspace.yaml", "utf8").split("\n");
    const start = lines.findIndex((l) => /^minimumReleaseAgeExclude:/.test(l));
    if (start < 0) { process.stdout.write(""); process.exit(0); }
    const out = [];
    for (let i = start + 1; i < lines.length; i++) {
      if (!/^\s+-\s/.test(lines[i])) break;
      out.push(lines[i].trim());
    }
    process.stdout.write(out.join("\n"));
  '
}

# **上げる前に作業ツリーが clean であることを確かめる。** この後の判定は「HEAD との
# 差分」なので、最初から差分があると「上がった」と読める。checkout 直後なので通常は
# clean であり、そうでないなら何かが起きている＝**判定できない状態**である。
# 黙ってどちらかへ倒さず落とす。
if ! git diff --quiet; then
  outcome='作業ツリーが最初から汚れていたので判定せずに止めた'
  echo "::error::update の前から追跡下のファイルに差分がある。判定できないので止める" >&2
  git status --porcelain --untracked-files=no >&2
  exit 1
fi

before="$(read_version)"
excludes_before="$(read_excludes)"

"$PNPM" update --latest --recursive "$SDK"

after="$(read_version)"
excludes_after="$(read_excludes)"

if [ "$excludes_before" != "$excludes_after" ]; then
  outcome='pnpm が minimumReleaseAgeExclude を書き換えたので止めた'
  {
    echo "::error::minimumReleaseAgeExclude が更新で変わった。SDK 以外の依存の"
    echo "24時間待ちが外れている可能性がある（pnpm の loose mode は公開直後の依存を"
    echo "自分でここへ書き足す）。人間が中身を見るまで PR にしない。"
    echo '--- 前:'
    printf '%s\n' "$excludes_before"
    echo '--- 後:'
    printf '%s\n' "$excludes_after"
  } >&2
  exit 1
fi

{
  echo "before=$before"
  echo "after=$after"
} >>"$output_file"

if git diff --quiet -- pnpm-workspace.yaml pnpm-lock.yaml; then
  changed=false
else
  changed=true
fi
echo "changed=$changed" >>"$output_file"

# **「差分が無かった」と「上げに行けていなかった」を分ける。** 差分が出ない日は
# 毎日来るので、その1行だけでは「壊れていても緑」と見分けが付かない。レジストリの
# 最新と突き合わせて、3つ目の状態（判定できない）も持つ。
latest="$("$PNPM" view "$SDK" version 2>/dev/null | tr -d '[:space:]')" || latest=''

if [ -z "$latest" ]; then
  echo "::warning::レジストリの最新版を取れなかったので、$after が最新かどうかは確かめていない" >&2
  outcome="changed=$changed（$before → $after。レジストリとの突き合わせは未実施）"
elif [ "$latest" = "$after" ]; then
  outcome="changed=$changed（$before → $after。レジストリ最新と一致）"
elif [ "$changed" = 'false' ]; then
  # 上げに行ったのに差分が出ず、しかも最新でもない ＝ update が効いていない。
  outcome="レジストリ最新は $latest なのに $after のまま差分が出なかった"
  echo "::error::$outcome。pnpm update が効いていない可能性がある" >&2
  exit 1
else
  echo "::warning::レジストリ最新は $latest だが $after までしか上がらなかった" >&2
  outcome="changed=true（$before → $after。レジストリ最新 $latest には届いていない）"
fi
