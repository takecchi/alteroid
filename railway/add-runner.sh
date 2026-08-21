#!/usr/bin/env bash
# 既存の Railway プロジェクトへ **runner を1台足す**。
#
#   railway link                # 先に対象のプロジェクトへ紐づく
#   ./railway/add-runner.sh     # 名前も runner_id も既存から決める
#
# `setup.sh` は毎回新しいプロジェクトを作る（既存には触らない）ので、**動いている
# 環境の台数を増やす道具がこれである**。roadmap M5「Railway の複数 Service …で runner
# 数を増減できるデプロイ定義」の増やす側。
#
# ## このスクリプトが機械で守っていること
#
# どれも「間違えても動いて見える」形の間違いで、気づく場所が他に無い。
#
# 1. **`runner_id` を重複させない。** 台帳の `manager_id → runner_id` を引く鍵であり、
#    `RunnerRegistry#get` は線形一致なので、同じ id を名乗る2台が並ぶと**先に見つかった
#    方**が返る（docs/roadmap.md M5、#106 の申し送り）。委譲先とは別の器へ `manager_send`
#    が届き、しかも届いているように見える。だから既存の id を全部読んで突き合わせ、
#    ぶつかったら**足さずに止まる**
# 2. **記憶ストアの鍵と入口の認証の鍵を写さない。** 写し元の runner にそれが在ったら、
#    境界は既に壊れている。**黙って落とさずに止まる** — 落とすと、壊れている事実が
#    出力から消えて2台目だけが健全に見える
# 3. **それ以外は全部写す。** 落とすのは Railway が注入するもの（`RAILWAY_*`。ただし
#    `RAILWAY_RUN_UID` は我々が置いている値なので残す）だけである。allowlist にすると、
#    人間が後から足した変数（`GH_TOKEN` の類）が**2台目にだけ無い**状態になり、
#    「同じ仕事を頼んだのに、当たった runner によってできることが違う」が生まれる
#    （能力の削除。north_star 禁止1）
# 4. **繋ぐ枝は写し元と同じにする。** ローカルの git や既定値から決めない。1台だけ
#    `main` を見ていると、**そこだけがマージのたびに畳まれる**（railway/README.md
#    「デプロイは走行中の仕事を畳む操作である」1）
# 5. **役は Config as Code で引く。** 名前の付け方で数え上げると、人間がダッシュボードで
#    名前を変えた瞬間に名簿から落ちる
#
# ## 減らす側をここに入れていない理由
#
# **Service を消す操作は無人化しない。** 走行中の仕事がその器の中に居るかどうかは
# Railway 側からは判らず、移送（M5 PR5）はまだ無いので、消した瞬間に消えるものがある。
# 手順は railway/README.md「runner を減らす」に書いてある（人間が `/managers` を見て、
# 空になってから消す）。
set -euo pipefail

REPO_ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
readonly REPO_ROOT

# shellcheck source=railway/lib.sh
. "$REPO_ROOT/railway/lib.sh"

# 写し元・写し先・宛先。**既定は「既存から決める」**（既に在るものが持ち主である）
APP_SERVICE=''
FROM_SERVICE=''
NEW_SERVICE=''
NEW_RUNNER_ID=''
REDEPLOY_APP=''
ASSUME_YES=0

# 写してはいけないもの。**在ったら止まる**（黙って落とすと、境界が壊れている事実が消える）
readonly FORBIDDEN_KEYS='ALTEROID_DATABASE_URL ALTEROID_GOOGLE_CLIENT_SECRET'

usage() {
  cat <<'EOS'
既存の Railway プロジェクトへ runner を1台足す。

  ./railway/add-runner.sh [オプション]

  -f, --from <名前>     写し元の runner Service（既定: 既存の runner の1台目）
  -s, --name <名前>     作る Service 名（既定: <写し元>-2, -3 … の空いている番号）
  -i, --id <runner_id>  台帳が引く識別子（既定: Service 名と同じ）
  -a, --app <名前>      daemon の Service（既定: Config as Code から引く）
      --redeploy-app    app を再デプロイする（新しい宛先はこれで初めて効く）
      --no-redeploy-app 再デプロイしない（次のデプロイまで委譲先として見えない）
  -y, --yes             尋ねない（--redeploy-app を選んだものとして進む）
  -h, --help            これ

値は .env ではなく**写し元の runner から**写す（人間に二重管理をさせない）。
先に railway link でプロジェクトへ紐づいていること。
EOS
}

while [ $# -gt 0 ]; do
  case "$1" in
    -f | --from)
      FROM_SERVICE="${2:-}"
      shift 2
      ;;
    -s | --name)
      NEW_SERVICE="${2:-}"
      shift 2
      ;;
    -i | --id)
      NEW_RUNNER_ID="${2:-}"
      shift 2
      ;;
    -a | --app)
      APP_SERVICE="${2:-}"
      shift 2
      ;;
    --redeploy-app)
      REDEPLOY_APP=yes
      shift
      ;;
    --no-redeploy-app)
      REDEPLOY_APP=no
      shift
      ;;
    -y | --yes)
      ASSUME_YES=1
      shift
      ;;
    -h | --help)
      usage
      exit 0
      ;;
    *) die "知らないオプション: $1（--help）" ;;
  esac
done

if [ "$ASSUME_YES" != 1 ] && [ ! -e /dev/tty ]; then
  die '端末が無い。--yes で回すこと（そのとき app は再デプロイされる）'
fi
# `-y` は「尋ねない」であって「安全側に倒す」ではない。**足したのに委譲先として
# 見えていない状態で 0 を返さない**ために、再デプロイまで含めて進む
if [ "$ASSUME_YES" = 1 ] && [ -z "$REDEPLOY_APP" ]; then
  REDEPLOY_APP=yes
fi

# --- 0. 道具と資格 ----------------------------------------------------------

step '道具を確かめる'

for cmd in railway node; do
  command -v "$cmd" >/dev/null 2>&1 ||
    die "$cmd が無い。railway は 'npm i -g @railway/cli'、node は mise install で入る"
done
ok "$(railway --version 2>/dev/null | head -n1)"

railway whoami >/dev/null 2>&1 || die 'Railway にログインしていない（railway login）'
ok "$(railway whoami 2>/dev/null | head -n1)"

resolve_project ||
  die 'プロジェクトに紐づいていない。railway link で対象を選ぶこと（ここでは作らない）'
ok "$(json_get "$(railway status --json 2>/dev/null || true)" 'd.name') ($PROJECT_ID)"

# --- 1. 名簿を引く（役は Config as Code が持つ）------------------------------

step '名簿を引く'

RUNNERS=()
while IFS= read -r name; do
  [ -n "$name" ] && RUNNERS+=("$name")
done <<EOF
$(services_with_config "$RUNNER_CONFIG")
EOF

[ "${#RUNNERS[@]}" -gt 0 ] || die \
  "Config as Code が ${RUNNER_CONFIG} を指す Service が無い。ここは既存の環境へ足す道具である（新しく建てるなら setup.sh）"

if [ -z "$APP_SERVICE" ]; then
  APPS=()
  while IFS= read -r name; do
    [ -n "$name" ] && APPS+=("$name")
  done <<EOF
$(services_with_config "$APP_CONFIG")
EOF
  case "${#APPS[@]}" in
    1) APP_SERVICE="${APPS[0]}" ;;
    0) die "Config as Code が ${APP_CONFIG} を指す Service が無い。--app で名前を渡すこと" ;;
    *) die "${APP_CONFIG} を指す Service が ${#APPS[@]} 個ある。--app でどれかを選ぶこと" ;;
  esac
fi

if [ -z "$FROM_SERVICE" ]; then
  FROM_SERVICE="${RUNNERS[0]}"
else
  found=0
  for name in "${RUNNERS[@]}"; do
    [ "$name" = "$FROM_SERVICE" ] && found=1
  done
  [ "$found" = 1 ] ||
    die "${FROM_SERVICE} は runner ではない（${RUNNER_CONFIG} を指していない）。いま runner なのは: ${RUNNERS[*]}"
fi

ok "daemon   $APP_SERVICE"
ok "runner   ${RUNNERS[*]}（写し元: ${FROM_SERVICE}）"

# --- 2. 名前と runner_id を決める -------------------------------------------

# 既に在る Service 名（runner でないものも含む。名前は環境の中で1つである）
existing_names="$(railway service list --json 2>/dev/null |
  node -e '
    let s = ""; process.stdin.on("data", (c) => (s += c)).on("end", () => {
      try { process.stdout.write(JSON.parse(s).map((x) => x.name).join("\n")); } catch {}
    });
  ' || true)"

name_taken() { # <名前>
  printf '%s\n' "$existing_names" | grep -qxF "$1"
}

if [ -z "$NEW_SERVICE" ]; then
  # 写し元の名前から連番を作る（`runner` → `runner-2`。`runner-2` → `runner-3`）
  base="${FROM_SERVICE%%-[0-9]}"
  base="${base%%-[0-9][0-9]}"
  n=2
  while [ "$n" -lt 100 ]; do
    if ! name_taken "${base}-${n}"; then
      NEW_SERVICE="${base}-${n}"
      break
    fi
    n=$((n + 1))
  done
  [ -n "$NEW_SERVICE" ] || die '空いている名前が見つからない。--name で渡すこと'
elif name_taken "$NEW_SERVICE"; then
  die "${NEW_SERVICE} は既に在る。--name で別の名前を渡すこと"
fi

: "${NEW_RUNNER_ID:=$NEW_SERVICE}"

# **既存の runner_id を全部読んで突き合わせる。** ぶつかったら足さない（上の1）
step 'runner_id がぶつからないことを確かめる'
for name in "${RUNNERS[@]}"; do
  existing_id="$(railway variable list --service "$name" --json 2>/dev/null |
    node -e '
      let s = ""; process.stdin.on("data", (c) => (s += c)).on("end", () => {
        try { process.stdout.write(String(JSON.parse(s).ALTEROID_RUNNER_ID ?? "")); } catch {}
      });
    ' || true)"
  if [ -z "$existing_id" ]; then
    # 既定は器の側に焼いてある（`runnerIdOf`）。**「未設定」は「無い」ではない**
    warn "${name}: ALTEROID_RUNNER_ID が変数に無い（器の既定 runner-primary を名乗る）"
    existing_id='runner-primary'
  else
    dim "${name}: ${existing_id}"
  fi
  [ "$existing_id" != "$NEW_RUNNER_ID" ] ||
    die "runner_id ${NEW_RUNNER_ID} は ${name} が既に名乗っている。--id で別の値を渡すこと（同じ id が2台並ぶと、委譲した先とは別の器へ命令が届く）"
done
ok "$NEW_RUNNER_ID は空いている"

# --- 3. 写し元の変数を読む ---------------------------------------------------

step "変数を写す（${FROM_SERVICE} → ${NEW_SERVICE}）"

src_file="$(tmp_file)"
railway variable list --service "$FROM_SERVICE" --json >"$src_file" 2>/dev/null ||
  die "${FROM_SERVICE} の変数が読めない"

# 名前だけを出す（値は出さない）。**在ってはいけないものが在ったら止まる**
src_keys="$(node -e '
  const d = JSON.parse(require("fs").readFileSync(process.argv[1], "utf8"));
  process.stdout.write(Object.keys(d).join("\n"));
' -- "$src_file")"

# shellcheck disable=SC2086 # 空白区切りの一覧を語に割るのが目的
for key in $FORBIDDEN_KEYS; do
  if printf '%s\n' "$src_keys" | grep -qxF "$key"; then
    die "写し元 ${FROM_SERVICE} に $key がある。**足す前に、そこを直すこと** — 写せば2台目にも広がる（railway/verify.sh が「!!」を出す状態である）"
  fi
done

printf '%s\n' "$src_keys" | grep -qxF ALTEROID_RUNNER_TOKEN ||
  die "写し元 ${FROM_SERVICE} に ALTEROID_RUNNER_TOKEN が無い。鍵の無い制御面は runner の中のマネージャーからも叩ける"

# `RAILWAY_*` は Railway が注入するので写さない（`RAILWAY_RUN_UID` だけは我々が
# 置いている値なので残す）。それ以外は**全部写す** — allowlist にすると、後から
# 足された変数が2台目にだけ無い状態になる（当たった runner でできることが変わる）
new_pairs=()
while IFS= read -r -d '' key && IFS= read -r -d '' value; do
  new_pairs+=("$key" "$value")
done < <(node -e '
  const d = JSON.parse(require("fs").readFileSync(process.argv[1], "utf8"));
  const out = [];
  for (const [k, v] of Object.entries(d)) {
    if (k.startsWith("RAILWAY_") && k !== "RAILWAY_RUN_UID") continue;
    out.push(k, String(v));
  }
  process.stdout.write(out.map((s) => s + "\0").join(""));
' -- "$src_file")

[ "${#new_pairs[@]}" -gt 0 ] || die "${FROM_SERVICE} から写せる変数が1つも無い"

# 台ごとに違うもの・自分を指すものは上書きする
override() { # <KEY> <VALUE>
  local i=0 replaced=0
  while [ "$i" -lt "${#new_pairs[@]}" ]; do
    if [ "${new_pairs[$i]}" = "$1" ]; then
      new_pairs[$((i + 1))]="$2"
      replaced=1
    fi
    i=$((i + 2))
  done
  [ "$replaced" = 1 ] || new_pairs+=("$1" "$2")
}

runner_port="$(node -e '
  const d = JSON.parse(require("fs").readFileSync(process.argv[1], "utf8"));
  process.stdout.write(String(d.ALTEROID_RUNNER_PORT ?? ""));
' -- "$src_file")"
: "${runner_port:=$RUNNER_PORT_DEFAULT}"

# 名簿は「既存の全台 ＋ いま足す1台」。**参照のまま置く**（固定 URL を埋めない）
runner_urls=''
for name in "${RUNNERS[@]}" "$NEW_SERVICE"; do
  [ -z "$runner_urls" ] || runner_urls="${runner_urls},"
  runner_urls="${runner_urls}$(runner_url_for "$name" "$runner_port")"
done

override ALTEROID_RUNNER_ID "$NEW_RUNNER_ID"
override ALTEROID_RUNNER_URL "$(runner_url_for "$NEW_SERVICE" "$runner_port")"
override ALTEROID_RUNNER_URLS "$runner_urls"
override ALTEROID_RUNNER_BIND '::'
override ALTEROID_RUNNER_PORT "$runner_port"
# 子プロセスを uid 1001 へ降ろすのに特権が要る。無いと runner は**起動を拒む**
override RAILWAY_RUN_UID 0

dim "写す変数（値は出さない）: $(printf '%s\n' "$src_keys" | grep -v '^RAILWAY_' | tr '\n' ' ')"

# --- 4. 繋ぐ枝は写し元と同じ -------------------------------------------------

# **ローカルの git からも既定値からも決めない。** 1台だけ違う枝を見ていると、そこだけが
# マージのたびに畳まれる（railway/README.md「デプロイは走行中の仕事を畳む操作である」1）。
# 読めなければ空を返す — 「分からない」を `main` のような弱い側へ倒さない
source_of() { # <Service名> → "repo<TAB>branch"（取れなければ空）
  local id file
  id="$(service_id "$1")"
  [ -n "$id" ] || return 0
  file="$(tmp_file)"
  # shellcheck disable=SC2016 # GraphQL の変数はシェルに展開させない
  railway api 'query($id: String!) {
                 service(id: $id) { repoTriggers { edges { node { repository branch environmentId } } } }
               }' --raw-var "id=$id" --compact >"$file" 2>/dev/null || return 0
  node -e '
    const fs = require("fs");
    let d;
    try { d = JSON.parse(fs.readFileSync(process.argv[1], "utf8")); } catch { process.exit(0); }
    const nodes = ((((d.data || {}).service || {}).repoTriggers || { edges: [] }).edges || [])
      .map((e) => e && e.node)
      .filter(Boolean);
    // この環境の trigger を優先する（環境ごとに別の枝を見ていることがある）
    const t = nodes.find((n) => n.environmentId === process.argv[2]) || nodes[0];
    if (!t || !t.repository || !t.branch) process.exit(0);
    process.stdout.write(t.repository + "\t" + t.branch);
  ' -- "$file" "$ENVIRONMENT_ID"
}

from_source="$(source_of "$FROM_SERVICE")"
GIT_REPO=''
GIT_BRANCH=''
if [ -n "$from_source" ]; then
  GIT_REPO="${from_source%%$'\t'*}"
  GIT_BRANCH="${from_source##*$'\t'}"
fi

app_source="$(source_of "$APP_SERVICE")"
app_branch="${app_source##*$'\t'}"
if [ -n "$GIT_BRANCH" ] && [ -n "$app_branch" ] && [ "$GIT_BRANCH" != "$app_branch" ]; then
  warn "写し元は ${GIT_BRANCH}、${APP_SERVICE} は ${app_branch} を見ている（既にずれている）"
fi

# --- 5. 確かめてから作る ----------------------------------------------------

step '作るもの'
info "Service      ${NEW_SERVICE}（${RUNNER_CONFIG}）"
info "runner_id    ${NEW_RUNNER_ID}"
info "待ち受け     :: / ${runner_port}"
info "GitHub       ${GIT_REPO:-（写し元に連携が無い。ローカルから上げる）}${GIT_BRANCH:+ / $GIT_BRANCH}"
info "変数         ${FROM_SERVICE} から $((${#new_pairs[@]} / 2)) 個（RAILWAY_* は写さない）"
info "${APP_SERVICE} の ALTEROID_RUNNER_URLS を $((${#RUNNERS[@]} + 1)) 台に置き直す"
if [ "$REDEPLOY_APP" = no ]; then
  info "${APP_SERVICE}     再デプロイしない（次のデプロイまで委譲先として見えない）"
else
  info "${APP_SERVICE}     再デプロイする（クローンのターンが数十秒止まる。走行中のマネージャーは runner の中なので畳まれない）"
fi

if [ "$ASSUME_YES" != 1 ] && ! ask_yes_no 'この内容で足しますか？' yes; then
  die 'やめた'
fi

add_failed=0

# --- 6. Service を作って変数と役を置く --------------------------------------

step "Service を作る（${NEW_SERVICE}）"
railway add --service "$NEW_SERVICE" >/dev/null
NEW_ID="$(service_id "$NEW_SERVICE")"
[ -n "$NEW_ID" ] || die "${NEW_SERVICE} の id が取れない"
ok "$NEW_SERVICE ($NEW_ID)"

# **変数と Config as Code を source より先に置く。** 繋いだ瞬間にデプロイが走りうるので、
# 後から置くと初回が必ず失敗する（役が決まらないので `startCommand` が無い）
set_config_file "$NEW_ID" "$RUNNER_CONFIG"
ok "$NEW_SERVICE → $RUNNER_CONFIG"
put_variables "$NEW_ID" "${new_pairs[@]}"
ok "$NEW_SERVICE: $((${#new_pairs[@]} / 2)) 個（記憶ストアの鍵は無い / runner_id=${NEW_RUNNER_ID}）"

# --- 7. 上げる ---------------------------------------------------------------

if [ -n "$GIT_REPO" ] && [ -n "$GIT_BRANCH" ]; then
  step "GitHub を繋ぐ（$GIT_REPO / ${GIT_BRANCH}）"
  if railway service source connect --repo "$GIT_REPO" --branch "$GIT_BRANCH" --service "$NEW_SERVICE" >/dev/null 2>&1; then
    ok "$NEW_SERVICE ← $GIT_REPO"
    ensure_deploy "$NEW_SERVICE" || add_failed=1
    wait_for_deploy "$NEW_SERVICE" || add_failed=1
  else
    warn "GitHub 連携に失敗した（Railway の GitHub App が $GIT_REPO を見えていない）"
    info "  railway up --service $NEW_SERVICE --detach"
    add_failed=1
  fi
else
  step 'ローカルから上げる'
  dim '写し元に GitHub 連携が無いので、push では自動デプロイされない（watchPatterns も効かない）'
  if ask_yes_no "いま上げますか？（${NEW_SERVICE}）" yes; then
    railway up --service "$NEW_SERVICE" --detach >/dev/null || add_failed=1
    wait_for_deploy "$NEW_SERVICE" || add_failed=1
  else
    info "後で: railway up --service $NEW_SERVICE --detach"
    add_failed=1
  fi
fi

# --- 8. app の名簿を置き直す -------------------------------------------------

step "委譲の宛先を置き直す（${APP_SERVICE}）"
APP_ID="$(service_id "$APP_SERVICE")"
[ -n "$APP_ID" ] || die "${APP_SERVICE} の id が取れない"
put_variables "$APP_ID" ALTEROID_RUNNER_URLS "$runner_urls"
ok "ALTEROID_RUNNER_URLS: $((${#RUNNERS[@]} + 1)) 台"
dim "$runner_urls"

# **変数を置いただけでは走っているデーモンに届かない。** 器の環境変数は起動時に
# 決まるので、再デプロイするまで名簿は増えない（`railway variable set` でも同じ）。
# ここを黙って飛ばすと、「足したのに委譲先が増えない」を Railway 側に探しに行く
if [ -z "$REDEPLOY_APP" ]; then
  if ask_yes_no "${APP_SERVICE} を再デプロイしますか？（これで初めて新しい runner が委譲先になる）" yes; then
    REDEPLOY_APP=yes
  else
    REDEPLOY_APP=no
  fi
fi

if [ "$REDEPLOY_APP" = yes ]; then
  step "${APP_SERVICE} を再デプロイする"
  dim 'クローンのターンは数十秒止まる。走行中のマネージャーは runner の中なので畳まれない'
  if railway service redeploy --service "$APP_SERVICE" --yes >/dev/null 2>&1 ||
    railway redeploy --service "$APP_SERVICE" --yes >/dev/null 2>&1; then
    wait_for_deploy "$APP_SERVICE" || add_failed=1
  else
    warn "再デプロイを起こせなかった: railway service redeploy --service $APP_SERVICE --yes"
    add_failed=1
  fi
fi

# --- 9. これから -------------------------------------------------------------

if [ "$add_failed" = 1 ]; then
  step '途中まで足した'
  warn '終わっていないものがある。まずログを見る'
  info "  railway logs --service $NEW_SERVICE"
  info "  railway logs --service $APP_SERVICE"
  info '症状から引く表は railway/README.md にある'
else
  step '足した'
fi

if [ "$REDEPLOY_APP" = no ]; then
  warn "${APP_SERVICE} は再デプロイしていないので、${NEW_SERVICE} はまだ委譲先ではない"
  info "  railway service redeploy --service $APP_SERVICE --yes"
fi

cat >&2 <<EOS

    境界と能力を確かめる（新しい1台も名簿から引かれる）:

      ./railway/verify.sh

    2台に届いているかは中から見る:

      railway ssh --service $APP_SERVICE
      curl -s http://127.0.0.1:\$ALTEROID_PORT/runners | jq
EOS

printf '\n' >&2

# **頼まれたものと違うものができたなら、そう名乗る**（器と変数だけ作って「できた」と
# 0 を返すと、呼んだ側はできたと読む）
[ "$add_failed" = 0 ] || exit 1
exit 0
