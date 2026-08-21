#!/usr/bin/env bash
# Railway に alteroid を置く2つのスクリプトが共有する部品。
#
#   railway/setup.sh          新しいプロジェクトを1発で作る（既存には触らない）
#   railway/scale-runners.sh  **既存の**プロジェクトに runner を足す
#
# **単体では動かない。** `source` される側であり、`set -euo pipefail` と引数の解釈は
# 呼ぶ側が持つ。
#
# ## なぜ分けてあるか
#
# 2つのスクリプトが「変数の置き方」「Config as Code の指し方」「デプロイの待ち方」を
# 別々に持つと、片方だけが古びる。とくに危ないのは次の3つで、どれも**ずれても動作は
# 正常に見える**:
#
#   - `put_variables` の `replace: false` / `skipDeploys: true`（置き換えると Railway が
#     注入する変数が消え、skipDeploys を外すと置いた瞬間に器が入れ替わる）
#   - `set_config_file`（忘れると `startCommand` が無く、役が決まらない）
#   - `service_id` の**完全一致**（部分一致で拾うと `runner` と `runner-2` を混同する）
#
# だから数え上げの持ち主をここ1か所にしてある。**ここを直すと両方のスクリプトの
# 振る舞いが変わる。** 固定しているのは `railway/setup.test.ts` と
# `railway/scale-runners.test.ts` である。

# 役の既定。railway/README.md の表と1対1で対応する
readonly APP_SERVICE="${ALTEROID_APP_SERVICE:-app}"
readonly RUNNER_SERVICE="${ALTEROID_RUNNER_SERVICE:-runner}"
readonly APP_CONFIG='/railway/daemon.json'
readonly RUNNER_CONFIG='/railway/runner.json'
readonly RUNNER_PORT='4518'
readonly DAEMON_PORT='4517'

# 1台目の runner_id。**既存の本番がこの名前で台帳に載っているので既定を変えない**
# （`manager_id → runner_id` が指しているのはこれである）。2台目以降は Service 名と
# 同じ（`runner-2` / `runner-3` …）。
#
# **readonly にしない。** `.env` の `ALTEROID_RUNNER_ID` で1台目の名前を選べるのは
# 以前からの能力なので、読み込んだ後に呼ぶ側が入れ直す（`setup.sh`）。
FIRST_RUNNER_ID='runner-primary'

REPO_ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
readonly REPO_ROOT
readonly ENV_FILE="${ALTEROID_ENV_FILE:-$REPO_ROOT/.env}"

# 尋ねないモード。呼ぶ側が `--yes` で 1 にする
ASSUME_YES=${ASSUME_YES:-0}

# --- runner の数え方 --------------------------------------------------------
#
# **1台目だけ名前が違う。** Service 名 `runner` と runner_id `runner-primary` は
# 既に本番で動いており、変えると台帳の `manager_id → runner_id` が迷子になる
# （sticky routing が引けなくなり、走行中のマネージャーへ `manager_send` が届かない）。
# 2台目以降は Service 名と runner_id を揃えてある — 揃えておけば、ダッシュボードで
# 見た名前と `GET /runners` に並ぶ id が一致する。

runner_service_name() { # <1始まりの番号>
  if [ "$1" = 1 ]; then printf '%s' "$RUNNER_SERVICE"; else printf '%s-%s' "$RUNNER_SERVICE" "$1"; fi
}

runner_id_for() { # <1始まりの番号>
  if [ "$1" = 1 ]; then printf '%s' "$FIRST_RUNNER_ID"; else runner_service_name "$1"; fi
}

# 委譲の宛先。**固定 URL をコードに埋めず、Railway の変数参照のまま置く**
# （`${{…}}` はシェルに展開させない。展開されると空文字になる）
runner_url_for() { # <1始まりの番号>
  printf 'http://${{%s.RAILWAY_PRIVATE_DOMAIN}}:%s' "$(runner_service_name "$1")" "$RUNNER_PORT"
}

# --- 出力（**すべて stderr へ**）--------------------------------------------
#
# 値を返す関数を `$(…)` で受けるので、進捗を stdout に出すと値に混ざる。
# 混ざったことは「変数が設定されているのに効かない」という形でしか現れず、
# 見つけるのに時間がかかる。だから最初から分けておく。

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

# --- .env -------------------------------------------------------------------

# `.env` から1つ読む（compose と同じファイルを、同じ気持ちで読む）。
# 最後の定義が勝つ。`export ` は無視し、引用符は剥がし、引用の無い値の行末コメントは落とす
env_file_get() {
  local key="$1" line value
  [ -f "$ENV_FILE" ] || return 0
  line="$(grep -E "^[[:space:]]*(export[[:space:]]+)?${key}=" "$ENV_FILE" 2>/dev/null | tail -n1 || true)"
  [ -n "$line" ] || return 0
  value="${line#*=}"
  case "$value" in
    \"*)
      value="${value#\"}"
      value="${value%%\"*}"
      ;;
    \'*)
      value="${value#\'}"
      value="${value%%\'*}"
      ;;
    *)
      value="${value%%[[:space:]]#*}"
      value="${value%"${value##*[![:space:]]}"}"
      ;;
  esac
  printf '%s' "$value"
}

# 環境変数 → `.env` → 対話、の順で値を決める
resolve() { # <KEY> <説明> <secret|plain> [既定値]
  local key="$1" label="$2" mode="${3:-plain}" default="${4:-}" value=''
  value="$(printenv "$key" 2>/dev/null || true)"
  if [ -n "$value" ]; then
    dim "$key: 環境変数から"
    printf '%s' "$value"
    return 0
  fi
  value="$(env_file_get "$key")"
  if [ -n "$value" ]; then
    dim "$key: $(basename "$ENV_FILE") から"
    printf '%s' "$value"
    return 0
  fi
  if [ "$ASSUME_YES" = 1 ]; then
    [ -n "$default" ] || die "$key が無い（--yes では尋ねない）。$ENV_FILE に置くこと — $label"
    printf '%s' "$default"
    return 0
  fi
  printf '    %s%s%s — %s\n' "$C_BOLD" "$key" "$C_RESET" "$label" >&2
  if [ "$mode" = secret ]; then
    value="$(ask_secret '値を貼る（表示されない）')"
  else
    value="$(ask '値' "$default")"
  fi
  printf '%s' "$value"
}

# 尋ねた値・作った値を `.env` へ書き留める。**次から尋ねないため**であり、
# compose 側でも同じ値が使えるようにするためである
persist_env() { # <KEY> <値>
  local key="$1" value="$2"
  [ -n "$value" ] || return 0
  if [ -f "$ENV_FILE" ] && grep -qE "^[[:space:]]*(export[[:space:]]+)?${key}=" "$ENV_FILE" 2>/dev/null; then
    return 0
  fi
  if [ ! -f "$ENV_FILE" ]; then
    if [ "$ASSUME_YES" != 1 ] && ! ask_yes_no "$ENV_FILE を作って書き留めますか？（次から尋ねません）" yes; then
      return 0
    fi
    (
      umask 077
      printf '# alteroid の環境変数（railway/setup.sh が書き足した）\n' >"$ENV_FILE"
    )
  fi
  printf '%s=%s\n' "$key" "$value" >>"$ENV_FILE"
  dim "$key を $(basename "$ENV_FILE") に書き留めた"
}

# `.env` の値を**置き換える**（`persist_env` は在るものに手を出さない）。
# 前の器の生成ドメインのように、古いと分かっている値を残さないために使う
replace_env() { # <KEY> <値>
  local key="$1" value="$2" tmp
  if [ ! -f "$ENV_FILE" ] ||
    ! grep -qE "^[[:space:]]*(export[[:space:]]+)?${key}=" "$ENV_FILE" 2>/dev/null; then
    persist_env "$key" "$value"
    return 0
  fi
  tmp="$(tmp_file)"
  grep -vE "^[[:space:]]*(export[[:space:]]+)?${key}=" "$ENV_FILE" >"$tmp" || true
  printf '%s=%s\n' "$key" "$value" >>"$tmp"
  # `mv` ではなく中身を流し込む（一時ファイルの 0600 を `.env` に持ち込まない）
  cat "$tmp" >"$ENV_FILE"
  dim "$key を $(basename "$ENV_FILE") で置き直した"
}

# --- railway CLI の薄い包み --------------------------------------------------

# 名前から Service id を引く。**部分一致で拾わない**（`app` と `app-2` を混同しない）
service_id() { # <名前>
  local list name_json
  list="$(railway service list --json 2>/dev/null || true)"
  name_json="$(node -e 'process.stdout.write(JSON.stringify(process.argv[1]))' -- "$1")"
  json_get "$list" "(d.find(s => s.name === $name_json) || {}).id"
}

# PostgreSQL の Service 名は Railway が決める（テンプレート由来。既定 `Postgres`）。
# **決め打ちにしない** — 変数参照 `\${{名前.DATABASE_URL}}` がその名前に依存する
postgres_service_name() {
  local list waited=0 name=''
  while [ "$waited" -lt 60 ]; do
    list="$(railway service list --json 2>/dev/null || true)"
    name="$(json_get "$list" '(d.find(s => ((s.source && s.source.image) || "").includes("postgres")) || {}).name')"
    [ -n "$name" ] && break
    sleep 3
    waited=$((waited + 3))
  done
  printf '%s' "$name"
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
