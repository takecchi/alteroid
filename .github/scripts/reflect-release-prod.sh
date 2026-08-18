#!/usr/bin/env bash
#
# main を release/prod へ反映する。**Railway が見るのは release/prod だけ**なので、
# デプロイが走る時刻を決めているのはこのスクリプトであって、マージした時刻ではない
# （railway/README.md「デプロイは走行中の仕事を畳む操作である」）。
#
# ## なぜ force で上書きするのか — `--force-with-lease` を消しに来ないこと
#
# `release/prod` は**デプロイ専用の枝で、正典は `main` である。** ここに固有の履歴は
# 無く、常に main のある1点の写しでしかないので、**上書きで壊れるものが無い。**
# 「force push は危険」という一般則は、履歴が正典である枝の話であって、ここには
# 当たらない。**次に読む者が危険だと思って直しに来ないように、そう書いておく。**
#
# そのうえで素の `--force` ではなく `--force-with-lease` にしてある。実測で確かめた
# こと（git 2.39.5、ローカルの bare リポジトリで3通り走らせた）:
#
#   - **平常時は force は要らない。** main は squash merge で伸びるだけで（branch
#     protection の `allow_force_pushes` が false、squash 以外のマージは無効）、
#     release/prod をここ以外が書かない限り常に main の祖先になる。通常の push で通る。
#   - **要るのは release/prod が main から分岐したときだけである。** release/prod に
#     branch protection は無いので、人間が本番へ直接1本置く（hotfix・巻き戻し）ことが
#     ありうる。そうなると通常の push は non-fast-forward で**以後ずっと失敗し、
#     デプロイが静かに止まる。** force はこの1点を自力で直すために要る。
#   - **読み取った SHA を明示で渡してある。** 読んだ直後に release/prod が動いていたら
#     push は「stale info」で断られる（実測）。素の `--force` はこの一手を捨てるだけで、
#     代わりに得るものが無い。
#
# ## 何を見て push を決めるか
#
# **SHA が違えば push する。それだけである。** どの変更でどの Service が落ちるかの判定
# （`watchPatterns`）は Railway 側が持っている。こちらに写しを置くと、片方だけ直されて
# 食い違う。`docs/` だけの差分で push しても、Railway が反応しないだけで害は無い。

set -euo pipefail

# **どちらの経路を通っても必ず1行出す。** 何も出さずに終わったログを見たとき、
# 「差分が無かった」と「壊れて何もしなかった」が区別できなくなる。判定の手前で
# 落ちても push でこけても、この trap が最後の1行を置く。
outcome='判定に到達せずに終わった（この行が出たらこのスクリプトの欠陥である）'
trap 'printf "=== 反映結果: %s ===\n" "$outcome"; printf "%s\n" "$outcome" >>"${GITHUB_STEP_SUMMARY:-/dev/null}"' EXIT

main_sha=$(git rev-parse HEAD)
# 相手側は**毎回 remote から読み直す。** checkout した写しに残っている値と比べると、
# 別の実行と競ったときに古い判定で push しに行く。ref が無ければ空文字が返る。
prod_sha=$(git ls-remote origin refs/heads/release/prod | cut -f1)

printf 'main         : %s\n' "$main_sha"
printf 'release/prod : %s\n' "${prod_sha:-（まだ無い）}"

if [ "$main_sha" = "$prod_sha" ]; then
  outcome="差分なし。release/prod は既に $main_sha を指しているので push しない"
  exit 0
fi

# 空の `<expect>` は「その ref がまだ無いこと」を要求する。初回はこれで作られる。
if git push --force-with-lease="refs/heads/release/prod:$prod_sha" \
  origin "$main_sha:refs/heads/release/prod"; then
  outcome="反映した。release/prod ${prod_sha:-（まだ無い）} → $main_sha"
else
  outcome="push が通らなかった。読み取った直後に release/prod が動いた可能性がある（次の実行で追いつく）"
  exit 1
fi
