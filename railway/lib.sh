#!/usr/bin/env bash
# `railway/*.sh` が共有する道具。**単体では何もしない**（source される側）。
#
#   source "$(dirname "${BASH_SOURCE[0]}")/lib.sh"
#
# ## なぜ切り出したのか
#
# ここに入っているのは**器の不変条件を守る操作**である。`put_variables` の
# `replace: false` / `skipDeploys: true`、`set_config_file`（これが無いと役が決まらない）、
# `service_id` の完全一致（`app` と `app-2` を混同しない）— どれも「間違えても動いて
# 見える」形の間違いをする。**2本目のスクリプト（`add-runner.sh`）がこれを写して
# 持つと、片方だけ古びる**（そして古びた側は動いて見える）。
#
# **持ち主は1か所にする。** 変えるときはここだけを変え、`railway/README.md` の
# 対応する記述も直すこと。
#
# ## 中身を足すときの線
#
# ここへ置くのは「複数のスクリプトが同じ意味で使うもの」だけである。`.env` の
# 読み書き（`resolve` / `persist_env`）は `setup.sh` にしか要らないので置いていない
# （`add-runner.sh` は値を `.env` から取らない — 既存の runner から写す。人間に
# 二重管理をさせない、の同じ理由である）。

# **出力はすべて stderr へ。** 値を返す関数を `$(…)` で受けるので、進捗を stdout に
# 出すと値に混ざる。混ざったことは「変数が設定されているのに効かない」という形でしか
# 現れず、見つけるのに時間がかかる。だから最初から分けておく。
if [ -t 2 ]; then
  C_RESET=$'\033[0m' C_BOLD=$'\033[1m' C_DIM=$'\033[2m'
  C_RED=$'\033[31m' C_GREEN=$'\033[32m' C_YELLOW=$'\033[33m' C_BLUE=$'\033[34m'
else
  C_RESET='' C_BOLD='' C_DIM='' C_RED='' C_GREEN='' C_YELLOW='' C_BLUE=''
fi
readonly C_RESET C_BOLD C_DIM C_RED C_GREEN C_YELLOW C_BLUE

step() { printf '\n%s==>%s %s%s%s\n' "$C_BLUE" "$C_RESET" "$C_BOLD" "$*" "$C_RESET" >&2; }
info() { printf '    %s\n' "$*" >&2; }
dim() { printf '    %s%s%s\n' "$C_DIM" "$*" "$C_RESET" >&2; }
ok() { printf '    %s✓%s %s\n' "$C_GREEN" "$C_RESET" "$*" >&2; }
warn() { printf '    %s!%s %s\n' "$C_YELLOW" "$C_RESET" "$*" >&2; }
die() {
  printf '\n%serror%s %s\n' "$C_RED" "$C_RESET" "$*" >&2
  exit 1
}

# --- 秘密を含む一時ファイル ------------------------------------------------

# **最初に1つ作る。** 遅延生成にすると `$(tmp_file)` の中＝サブシェルで
# `TMP_DIR` を代入することになり、親には残らない。すると片付ける相手を親が
# 知らないまま終わり、**秘密を書いたファイルが消えずに残る**（実際に残った）。
TMP_DIR="$(umask 077 && mktemp -d "${TMPDIR:-/tmp}/alteroid-railway.XXXXXX")"
readonly TMP_DIR

# **必ず 0 で返す。** EXIT トラップの最後のコマンドの終了状態が、そのまま
# スクリプトの終了状態になる。片付けるものが無いだけで「失敗した」と名乗ると、
# 呼んだ側（CI や別のスクリプト）が成功を失敗と読む
# shellcheck disable=SC2329 # trap から呼ばれる
cleanup() {
  rm -rf "$TMP_DIR"
  return 0
}
trap cleanup EXIT INT TERM

tmp_file() { mktemp "$TMP_DIR/part.XXXXXX"; }

# --- JSON（node は本リポジトリの前提なので在る）-----------------------------

# KEY VALUE KEY VALUE … を JSON オブジェクトへ。値に何が入っていても argv 経由なので壊れない
json_object() {
  node -e '
    const a = process.argv.slice(1), o = {};
    for (let i = 0; i < a.length; i += 2) o[a[i]] = a[i + 1];
    process.stdout.write(JSON.stringify(o));
  ' -- "$@"
}

# JSON 文字列から式で1つ取り出す。**壊れた入力でも失敗しない**（空文字を返す）。
# ここで die すると、Railway 側の一時的な応答の乱れがそのまま中断になる
json_get() {
  node -e '
    try {
      const d = JSON.parse(process.argv[1]);
      const v = new Function("d", "return (" + process.argv[2] + ")")(d);
      process.stdout.write(v == null ? "" : String(v));
    } catch { process.stdout.write(""); }
  ' -- "${1:-}" "$2"
}

# --- 対話 -------------------------------------------------------------------

# `ASSUME_YES=1` なら尋ねない（呼ぶ側が設定する）
: "${ASSUME_YES:=0}"

ask() { # <質問> [既定値]
  local prompt="$1" default="${2:-}" answer=''
  if [ "$ASSUME_YES" = 1 ]; then
    printf '%s' "$default"
    return 0
  fi
  if [ -n "$default" ]; then
    read -r -p "    $prompt [$default]: " answer </dev/tty || true
  else
    read -r -p "    $prompt: " answer </dev/tty || true
  fi
  printf '%s' "${answer:-$default}"
}

ask_secret() { # <質問>
  local prompt="$1" answer=''
  read -r -s -p "    $prompt: " answer </dev/tty || true
  printf '\n' >&2
  printf '%s' "$answer"
}

ask_yes_no() { # <質問> <yes|no>
  local prompt="$1" default="${2:-no}" answer='' hint='[y/N]'
  if [ "$ASSUME_YES" = 1 ]; then
    [ "$default" = yes ]
    return
  fi
  [ "$default" = yes ] && hint='[Y/n]'
  read -r -p "    $prompt $hint: " answer </dev/tty || true
  answer="${answer:-$default}"
  case "$answer" in
    y | Y | yes | YES | Yes) return 0 ;;
    *) return 1 ;;
  esac
}

# --- railway CLI の薄い包み --------------------------------------------------
#
# **`put_variables` と `set_config_file` は `PROJECT_ID` / `ENVIRONMENT_ID` を読む。**
# 呼ぶ側が先に埋めること（`resolve_project` がそれをする）。

# 紐づいているプロジェクトと環境の id を `PROJECT_ID` / `ENVIRONMENT_ID` へ入れる
resolve_project() {
  PROJECT_ID="$(json_get "$(railway status --json 2>/dev/null || true)" 'd.id')"
  [ -n "$PROJECT_ID" ] || return 1
  ENVIRONMENT_ID="$(json_get "$(railway environment list --json 2>/dev/null || true)" \
    '((d.environments || []).find(e => e.isLinked) || (d.environments || [])[0] || {}).id')"
  [ -n "$ENVIRONMENT_ID" ] || return 1
  return 0
}

# 名前から Service id を引く。**部分一致で拾わない**（`app` と `app-2` を混同しない）
service_id() { # <名前>
  local list name_json
  list="$(railway service list --json 2>/dev/null || true)"
  name_json="$(node -e 'process.stdout.write(JSON.stringify(process.argv[1]))' -- "$1")"
  json_get "$list" "(d.find(s => s.name === $name_json) || {}).id"
}

# **役は Config as Code のパスで決まる。**（`railway/runner.json` を指している Service
# が runner である）。名前の付け方（`runner` / `runner-2`）で数え上げると、人間が
# ダッシュボードで名前を変えた瞬間に名簿から落ちる。**持ち主は Railway 側の設定である。**
#
# 応答が読めないときは空を返す（呼ぶ側が「判定できない」として扱えるように、
# 「0台」と区別できる形にはしない — 呼ぶ側は必ず既知の1台を渡して検算する）
services_with_config() { # <Config as Code のパス>
  local response path_json
  path_json="$(node -e 'process.stdout.write(JSON.stringify(process.argv[1]))' -- "$1")"
  # shellcheck disable=SC2016 # GraphQL の変数はシェルに展開させない
  response="$(railway api 'query($id: String!) {
                 environment(id: $id) {
                   serviceInstances { edges { node { serviceName railwayConfigFile } } }
                 }
               }' --raw-var "id=$ENVIRONMENT_ID" --compact 2>/dev/null || true)"
  json_get "$response" \
    "(((d.data || {}).environment || {}).serviceInstances || {edges: []}).edges
       .map(e => e.node)
       .filter(n => n && n.railwayConfigFile === $path_json)
       .map(n => n.serviceName)
       .join('\n')"
}

# 変数をまとめて置く。1回の mutation なので途中で半分だけ適用されない
put_variables() { # <serviceId> <KEY> <VALUE> …
  local service="$1"
  shift
  local vars payload file
  vars="$(json_object "$@")"
  payload="$(node -e '
    const [projectId, environmentId, serviceId, variables] = process.argv.slice(1);
    process.stdout.write(JSON.stringify({
      input: {
        projectId, environmentId, serviceId,
        variables: JSON.parse(variables),
        // 追記であって置き換えではない（Railway が注入する変数を消さない）
        replace: false,
        // 置いた瞬間にデプロイを走らせない。順番はこちらで決める
        skipDeploys: true,
      },
    }));
  ' -- "$PROJECT_ID" "$ENVIRONMENT_ID" "$service" "$vars")"
  # 秘密を引数で渡さない（プロセス一覧に出る）。ファイルは 0600 の一時ディレクトリの中
  file="$(tmp_file)"
  printf '%s' "$payload" >"$file"
  # shellcheck disable=SC2016 # GraphQL の $input はシェルに展開させない
  railway api 'mutation($input: VariableCollectionUpsertInput!) { variableCollectionUpsert(input: $input) }' \
    --variables "@$file" --compact >/dev/null
}

# Config as Code のパスを指す。**ダッシュボードで人間が選ぶ唯一の設定**がこれで、
# 忘れると `startCommand` が無いので役が決まらない（同じイメージから2役を出している）。
# CLI に口が無いので GraphQL を直に叩く
set_config_file() { # <serviceId> <パス>
  # shellcheck disable=SC2016 # GraphQL の変数はシェルに展開させない
  railway api 'mutation($serviceId: String!, $environmentId: String, $input: ServiceInstanceUpdateInput!) {
                 serviceInstanceUpdate(serviceId: $serviceId, environmentId: $environmentId, input: $input)
               }' \
    --raw-var "serviceId=$1" \
    --raw-var "environmentId=$ENVIRONMENT_ID" \
    --var "input=$(json_object railwayConfigFile "$2")" \
    --compact >/dev/null
}

deployment_status() { # <Service名>
  local list
  list="$(railway deployment list --service "$1" --limit 1 --json 2>/dev/null || true)"
  json_get "$list" '((Array.isArray(d) ? d[0] : (d.deployments || [])[0]) || {}).status'
}

# **source を繋いだだけでデプロイが始まるとは決めつけない。**
# Railway 側の挙動で、始まることも始まらないこともある。始まらないまま待ち続けると
# 「30分待ったのに何も起きない」になるので、現れなければこちらから起こす
ensure_deploy() { # <Service名>
  local service="$1" waited=0
  while [ "$waited" -lt 60 ]; do
    [ -n "$(deployment_status "$service")" ] && return 0
    sleep 5
    waited=$((waited + 5))
  done
  dim "$service: デプロイが自動で始まらなかったので、こちらから起こす"
  railway service redeploy --service "$service" --from-source --yes >/dev/null 2>&1 ||
    railway up --service "$service" --detach >/dev/null 2>&1 ||
    return 1
}

# 最新デプロイが終わるまで待つ。**回数では諦めない**が、無限には待たない
wait_for_deploy() { # <Service名> [制限秒]
  local service="$1" limit="${2:-1800}" waited=0 interval=10 status=''
  info "デプロイを待つ（${service}。ビルドから10分ほど）"
  while [ "$waited" -lt "$limit" ]; do
    status="$(deployment_status "$service")"
    case "$status" in
      SUCCESS)
        printf '\n' >&2
        ok "$service: 上がった"
        return 0
        ;;
      FAILED | CRASHED | REMOVED | SKIPPED)
        printf '\n' >&2
        warn "$service: ${status}。ログ: railway logs --service $service"
        return 1
        ;;
    esac
    sleep "$interval"
    waited=$((waited + interval))
    printf '    %s… %s (%ds)%s\r' "$C_DIM" "${status:-待機}" "$waited" "$C_RESET" >&2
  done
  printf '\n' >&2
  warn "$service: ${limit}秒では終わらなかった。railway logs --service $service を見る"
  return 1
}

# --- runner の名簿 -----------------------------------------------------------

readonly RUNNER_CONFIG='/railway/runner.json'
readonly APP_CONFIG='/railway/daemon.json'
readonly RUNNER_PORT_DEFAULT='4518'
readonly DAEMON_PORT_DEFAULT='4517'

# 委譲の宛先の literal。**固定 URL をコードにも変数にも埋めない** — Service 名を
# 参照にしておくと、Railway 側が private domain を決め直しても追いかける。
# private network は Wireguard で暗号化済みなので `http://` でよい
runner_url_for() { # <Service名> [ポート]
  printf 'http://${{%s.RAILWAY_PRIVATE_DOMAIN}}:%s' "$1" "${2:-$RUNNER_PORT_DEFAULT}"
}
