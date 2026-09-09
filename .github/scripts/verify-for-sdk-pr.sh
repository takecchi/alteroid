#!/usr/bin/env bash
#
# `update-claude-sdk.yml` の「上がった版で一式を通す」ステップの中身。**判断は
# `.github/scripts/` に置く**というワークフロー自身の規則（同ファイル16-19行、
# `update-claude-sdk.sh` / `open-claude-sdk-pr.sh` と同じ理由）に、`run:` の生 bash
# だけが従っていなかった。ここへ切り出すことで vitest から本物の git と偽の
# `pnpm` で回せるようになる（`verify-for-sdk-pr.test.ts`）。
#
# **この切り出しは振る舞いを変えていない。** 本数・順序・`verify.md` の形は
# ワークフロー側にあったときのままである（9本への拡張は別コミットで行った）。
#
# **落ちても止めない。** 上がった版で `build` / `typecheck` / `lint` /
# `format:check` / `test` を順に通し、結果を `$RUNNER_TEMP/verify.md` へ積む。
# 呼び手（ワークフロー）が `continue-on-error: true` を持っているので、ここが
# 非0で終わっても構わない — が、`ok=` は必ず `$GITHUB_OUTPUT` へ出す。

set -uo pipefail
# **errexit を明示で切る。** `run:` の既定 shell は `bash -e {0}` で、
# `set -uo pipefail` はオプションを足すだけなので `-e` は残る。残したままだと
# 集計の途中（`tail | sed`）で落ちた瞬間に `ok=` を書かずに死に、
# `continue-on-error` のせいでジョブは緑のまま「検証が薄かった」ように見える。
set +e

# 書き出し先。GitHub Actions では `$GITHUB_OUTPUT` が入っている
# （`update-claude-sdk.sh` / `open-claude-sdk-pr.sh` と同じ受け方）。
output_file="${GITHUB_OUTPUT:-/dev/null}"

# **作業ツリーの外へ書く。** ここで作るのは検証の記録であって成果物では
# ないので、リポジトリの中に落とさない。
dir="${RUNNER_TEMP:-/tmp}"
ok=true
: >"$dir/verify.md"
for cmd in build typecheck lint format:check test; do
  log="$dir/verify-${cmd/:/-}.log"
  if pnpm "$cmd" 2>&1 | tee "$log"; then
    status='OK'
    lines=10
  else
    ok=false
    status='**失敗**'
    lines=40
  fi
  # **成功した回も生の出力を載せる。** 「OK」の1行だけにすると、
  # *何本走ったか*が人間の読む唯一の記録から消える。`pnpm` は script を
  # 持たないパッケージを黙って飛ばして exit 0 を返すので、「OK」は
  # 「走った」を意味しない（AGENTS.md 変異試験の歯7と同じ理由）。
  #
  # コードブロックは ``` ではなく字下げで作る — ログ自身が ``` を
  # 含むとフェンスが破れる。
  {
    echo "### \`pnpm $cmd\` — $status"
    echo ''
    echo "（末尾 $lines 行。先頭側は落としてある。全文は実行ログにある）"
    echo ''
    tail -"$lines" "$log" | sed 's/^/    /'
    echo ''
  } >>"$dir/verify.md"
done
echo "ok=$ok" >>"$output_file"
cat "$dir/verify.md"
