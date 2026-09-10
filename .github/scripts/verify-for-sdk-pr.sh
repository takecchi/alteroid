#!/usr/bin/env bash
#
# `update-claude-sdk.yml` の「上がった版で一式を通す」ステップの中身。**判断は
# `.github/scripts/` に置く**というワークフロー自身の規則（同ファイル16-19行、
# `update-claude-sdk.sh` / `open-claude-sdk-pr.sh` と同じ理由）に、`run:` の生 bash
# だけが従っていなかった。ここへ切り出すことで vitest から本物の git と偽の
# `pnpm` で回せるようになる（`verify-for-sdk-pr.test.ts`）。
#
# **ここで回す本数は `scripts/verify-core.mjs` の `STEPS` と同じ名前・同じ順序。**
# 元々ここは `build` / `typecheck` / `lint` / `format:check` / `test` の5本しか
# 回していなかった（このスクリプトへ切り出した最初のコミット）。`pnpm verify` の
# 一式は9本あり、`web-bundle-node-traces` / `web-bundle-size` / `openapi` /
# `sdk-quotes` の4本が抜けていた。**`GITHUB_TOKEN` で作った PR には `pull_request`
# の CI が付かない**（GitHub の仕様）ので、この一式が唯一の検証記録になる回がある
# — 5本しか回していないと、その回の PR は「4本を検査していないのに検査済みに
# 見える」状態で人間に届く。
#
# **`STEPS` をそのまま import しない。** あちらは Node（`spawnSync` で子プロセスを
# 起こす）で、ここは GitHub Actions の `run:` から来た素の bash である。
# 二重に持つ形になるが、**歯（`verify-for-sdk-pr.test.ts`）が `STEPS.map(s => s.name)`
# と、このスクリプトを実際に走らせて `verify.md` から抜いた名前の並びを突き合わせる**
# ので、名前や順序がずれれば歯が落ちる。
#
# **`sdk-quotes` はここでも `pnpm test` 経由でも走る（二重の1回目）。**
# `scripts/check-sdk-quotes.test.ts` の「実物の検査」describe が、同じ core を
# 実物の SDK と実物の repo に当てて `pnpm test` の中でも検査しているため。この PR を
# 出すステップ側の本文にも同じ注記を書くこと（`open-claude-sdk-pr.sh` を呼ぶ
# ワークフロー側のコメントを見ること）。
#
# **落ちても止めない。** 1本落ちても残りの gate は走らせる — このスクリプトの
# 目的は「どこまで通ったか」を人間に見せることで、CI のように最初の失敗で打ち切る
# 目的ではない（`scripts/verify.mjs` の `STEPS` ループは最初の失敗で止まるが、
# あちらとこちらは目的が違う。あちらは「速く教える」、こちらは「全部見せる」）。

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

# 門の名前と、実際に走らせるコマンド（1件ずつ対応する2つの配列）。
# **`openapi` だけ `pnpm` ではなく `git`** なので、`for cmd in …; do pnpm "$cmd"`
# の形は使えない（`scripts/verify-core.mjs` の `STEPS` と同じ理由・同じ例外）。
# 名前・順序は `STEPS.map(s => s.name)` と一致させること（`verify-for-sdk-pr.test.ts`
# が突き合わせて測る）。
GATE_NAMES=(
  build
  web-bundle-node-traces
  web-bundle-size
  web-css-comment-classnames
  openapi
  sdk-quotes
  typecheck
  lint
  'format:check'
  test
)
GATE_COMMANDS=(
  'pnpm build'
  'pnpm check:web-bundle-node-traces'
  'pnpm check:web-bundle-size'
  'pnpm check:web-css-comment-classnames'
  'git diff --exit-code HEAD -- apps/daemon/openapi.json'
  'pnpm check:sdk-quotes'
  'pnpm typecheck'
  'pnpm lint'
  'pnpm format:check'
  'pnpm test'
)

# **落ちた門は名前と終了コードで残す。** `ok=false` という1つの値だけだと、PR が draft で
# 届いたときに「どれかが本当に落ちた」と「`openapi.json` が変わっただけ」が区別
# できない（`open-claude-sdk-pr.sh` は `SDK_VERIFY_OK != 'true'` で draft にする）。
# **数ではなく名前で書く** — 「1本落ちた」では、また種類が潰れる。
ok=true
failed_list=''
: >"$dir/verify-body.md"
for i in "${!GATE_NAMES[@]}"; do
  name="${GATE_NAMES[$i]}"
  cmdline="${GATE_COMMANDS[$i]}"
  # このリストのコマンドはどれも引数にスペースを含まないので、単純な単語分割でよい。
  read -ra words <<<"$cmdline"
  log="$dir/verify-${name/:/-}.log"
  if "${words[@]}" 2>&1 | tee "$log"; then
    status='OK'
    lines=10
  else
    # 門自身の終了コードを取る。
    #
    # ⚠️ **`$?` でも同じ値になる。** `pipefail` が効いているので、`tee` が 0 を返しても
    # パイプライン全体の終了コードは門自身のものになる。**変異試験で確かめた** — ここを
    # `code="$?"` に変えても歯は1件も噛まなかった（2026-09-09）。**だからこの行は
    # 「`$?` では取れない」を根拠にしていない。** `PIPESTATUS[0]` を使うのは
    # `set -o pipefail` が外れたときに `tee` の 0 を拾わないためだけであり、
    # **その保険自体は歯になっていない**（このスクリプトが自分で `pipefail` を立てるので、
    # テストの側から外せない）。⟹ 主張はここまでに留める。
    #
    # `if` の条件のパイプラインの `PIPESTATUS` は else の最初のコマンドまで生きているので、
    # ここで先に読む。
    code="${PIPESTATUS[0]}"
    ok=false
    # **配列と `${arr[*]}` で繋がない** — bash が区切りに使うのは IFS の**先頭1文字**
    # だけで、` / ` のような複数文字の区切りは黙って空白1文字に化ける。
    if [ -z "$failed_list" ]; then
      failed_list="\`$name\`（exit $code）"
    else
      failed_list="$failed_list / \`$name\`（exit $code）"
    fi
    status="**失敗**（exit $code）"
    lines=40
  fi
  # **成功した回も生の出力を載せる。** 「OK」の1行だけにすると、
  # *何本走ったか*が人間の読む唯一の記録から消える。`pnpm` は script を
  # 持たないパッケージを黙って飛ばして exit 0 を返すので、「OK」は
  # 「走った」を意味しない（AGENTS.md 変異試験の歯7と同じ理由）。
  #
  # **見出しは門の名前だけを機械可読な形（バッククォート囲み）で出す。** 実際に
  # 走らせたコマンドは見出しの直後に別行で残す — 見出しに埋め込むと `openapi` の
  # `git diff …` のように長さが門ごとにばらつき、名前の切り出しが崩れる
  # （`verify-for-sdk-pr.test.ts` がこの見出しから名前を抜いて数える）。
  #
  # コードブロックは ``` ではなく字下げで作る — ログ自身が ``` を
  # 含むとフェンスが破れる。
  {
    echo "### \`$name\` — $status"
    echo ''
    echo "実行: \`$cmdline\`"
    echo ''
    echo "（末尾 $lines 行。先頭側は落としてある。全文は実行ログにある）"
    echo ''
    tail -"$lines" "$log" | sed 's/^/    /'
    echo ''
  } >>"$dir/verify-body.md"
done

# **要約を先頭に置く。** 本文は上から読まれるので、落ちた門の名前が全本ぶんのログより
# 後ろに在ると、読む人はそれを探しに行くことになる。
{
  if [ "$ok" = 'true' ]; then
    printf '**%d本すべて通った。**\n' "${#GATE_NAMES[@]}"
  else
    printf '**落ちた門: %s**\n' "$failed_list"
  fi
  echo ''
  cat "$dir/verify-body.md"
} >"$dir/verify.md"

echo "ok=$ok" >>"$output_file"
cat "$dir/verify.md"
