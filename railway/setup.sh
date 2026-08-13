#!/usr/bin/env bash
# Railway に alteroid の3 Service（app / runner / PostgreSQL）を1発で用意する。
#
#   ./railway/setup.sh
#
# **人間が埋めるものは compose と同じ `.env` に集めてある。** 在るものは読み、
# 無いものだけ対話で尋ね、作れるもの（合鍵）は作って `.env` へ書き戻す。だから
# 「compose では動くのに Railway では埋め直し」が起きない。
#
# ## このスクリプトが機械で守っていること
#
# ダッシュボードを手で触ると必ず忘れる（あるいは空白を混ぜる）ものを、ここで固定する。
# どれも railway/README.md に理由が書いてある。**変えるときは README も直すこと。**
#
# 1. **記憶ストアの鍵は app にだけ置く。** `ALTEROID_DATABASE_URL` を runner へ配ると、
#    その中の子プロセス（＝マネージャー）が `/proc/1/environ` から鍵を取れる状態に戻り、
#    3コンテナに割った意味が消える。ここでは runner の変数一覧に載る経路が無い
#    （Shared Variables を使わず、役ごとに書き分けている。後述）
# 2. **`RAILWAY_RUN_UID=0` は runner にだけ置く。** runner は子プロセスを uid 1001 へ
#    降ろすのに特権が要る。app は root で起きても自分で `node` へ降りる（`docker/alteroidd`）
#    ので、渡す理由が無い
# 3. **runner を先に上げる。** daemon は起動時に runner の `/health` へ名乗りを聞きに行く
# 4. **待ち受けは 127.0.0.1 のまま、ドメインも生成しない。** Google ログインを有効に
#    したときだけ開ける（＝手前に境界が立ってから開ける）
# 5. **変数名を人間に打たせない。** ダッシュボードへ貼ると前後の空白が混ざり、Railway は
#    `RAILWAY_RUN_UID` と ` RAILWAY_RUN_UID` を別物として保存する（後者は誰も読まない）
#
# ## なぜ Shared Variables を使わないのか
#
# README は「1か所に書いて両方へ配る」ための置き場として Shared Variables を案内して
# いるが、それは**人間が手で置く**ときの都合である。スクリプトが置くなら、役ごとに
# 書き分けるほうが1と2を構造として守れる（runner の変数一覧に記憶ストアの鍵が載る経路
# が存在しなくなる）。人間が埋める1か所は `.env` のままなので、二重管理も増えない。
#
# ## 作らないもの
#
# ボリュームは1つも作らない。記憶・日誌・ジョブ・生ログは PostgreSQL にあり、
# `/workspace` は Git 再構築で運用する（railway/README.md「先に読む」3）。
#
# ## Infrastructure as Code（`.railway/railway.ts`）を使わない理由
#
# Railway には宣言的な IaC があるが、(1) experimental で Priority Boarding が要る、
# (2) 別の npm パッケージ（`railway`）が無いと `apply` が動かない、(3) Shared Variables を
# 定義できない、(4) **`railway/*.json` と二重の真実になる**（Config as Code のほうが
# デプロイ時に勝つのに、IaC はダッシュボード側の値を書く）。4がいちばん重い。
set -euo pipefail

REPO_ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
readonly REPO_ROOT
readonly ENV_FILE="${ALTEROID_ENV_FILE:-$REPO_ROOT/.env}"

# 役の既定。README の表と1対1で対応する
readonly APP_SERVICE="${ALTEROID_APP_SERVICE:-app}"
readonly RUNNER_SERVICE="${ALTEROID_RUNNER_SERVICE:-runner}"
readonly APP_CONFIG='/railway/daemon.json'
readonly RUNNER_CONFIG='/railway/runner.json'
readonly RUNNER_PORT='4518'
readonly DAEMON_PORT='4517'

ASSUME_YES=0

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

# --- 引数 -------------------------------------------------------------------

PROJECT_NAME=''
WORKSPACE=''
GIT_REPO=''
GIT_BRANCH=''

usage() {
  cat <<'EOS'
Railway に alteroid の3 Service（app / runner / PostgreSQL）を用意する。

  ./railway/setup.sh [オプション]

  -n, --name <名前>       プロジェクト名（既定: alteroid）
  -w, --workspace <名前>  Workspace（複数持っているときだけ要る）
  -r, --repo <owner/repo> GitHub 連携する対象（既定: origin から拾う）
  -b, --branch <ブランチ> 追いかけるブランチ（既定: origin の既定ブランチ）
  -y, --yes               尋ねない（値は .env と既定値から取る）
  -h, --help              これ

人間が埋めるものは compose と同じ .env に集まる。無いものは尋ね、
合鍵は作って書き留める。既存のプロジェクトには触らず、毎回新しく作る。
EOS
}

while [ $# -gt 0 ]; do
  case "$1" in
    -n | --name)
      PROJECT_NAME="${2:-}"
      shift 2
      ;;
    -w | --workspace)
      WORKSPACE="${2:-}"
      shift 2
      ;;
    -r | --repo)
      GIT_REPO="${2:-}"
      shift 2
      ;;
    -b | --branch)
      GIT_BRANCH="${2:-}"
      shift 2
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
  die '端末が無い。値を .env に置いて --yes で回すこと'
fi

# --- 0. 道具と資格 ----------------------------------------------------------

step '道具を確かめる'

for cmd in railway node git; do
  command -v "$cmd" >/dev/null 2>&1 ||
    die "$cmd が無い。railway は 'npm i -g @railway/cli'、node と git は mise install で入る"
done
ok "$(railway --version 2>/dev/null | head -n1)"

if ! railway whoami >/dev/null 2>&1; then
  info 'Railway にログインしていない。ブラウザを開く'
  railway login || die 'railway login に失敗した'
fi
ok "$(railway whoami 2>/dev/null | head -n1)"

if [ -z "$GIT_REPO" ]; then
  origin="$(git -C "$REPO_ROOT" remote get-url origin 2>/dev/null || true)"
  case "$origin" in
    git@github.com:*) GIT_REPO="${origin#git@github.com:}" ;;
    https://github.com/*) GIT_REPO="${origin#https://github.com/}" ;;
  esac
  GIT_REPO="${GIT_REPO%.git}"
fi
if [ -z "$GIT_BRANCH" ]; then
  GIT_BRANCH="$(git -C "$REPO_ROOT" symbolic-ref --short refs/remotes/origin/HEAD 2>/dev/null || true)"
  GIT_BRANCH="${GIT_BRANCH#origin/}"
  : "${GIT_BRANCH:=main}"
fi

# --- 1. 人間が埋めるもの ----------------------------------------------------

step "埋めるものを集める（${ENV_FILE}）"

if [ -f "$ENV_FILE" ]; then
  dim "$(basename "$ENV_FILE") が在る。在る値は読み、無い値だけ尋ねる"
else
  dim "$(basename "$ENV_FILE") が無い。尋ねた値は書き留める"
fi

CLAUDE_TOKEN="$(resolve CLAUDE_CODE_OAUTH_TOKEN 'クローンとマネージャーの認証。claude setup-token で取る' secret)"
[ -n "$CLAUDE_TOKEN" ] || die 'CLAUDE_CODE_OAUTH_TOKEN が無いと、クローンもマネージャーも動かない'
persist_env CLAUDE_CODE_OAUTH_TOKEN "$CLAUDE_TOKEN"

RUNNER_TOKEN="$(printenv ALTEROID_RUNNER_TOKEN 2>/dev/null || true)"
[ -n "$RUNNER_TOKEN" ] || RUNNER_TOKEN="$(env_file_get ALTEROID_RUNNER_TOKEN)"
if [ -z "$RUNNER_TOKEN" ]; then
  # **人間に作らせない。** 作れるものを尋ねると、弱い値か使い回しが入る
  if command -v openssl >/dev/null 2>&1; then
    RUNNER_TOKEN="$(openssl rand -hex 32)"
  else
    RUNNER_TOKEN="$(node -e 'process.stdout.write(require("crypto").randomBytes(32).toString("hex"))')"
  fi
  dim 'ALTEROID_RUNNER_TOKEN: 生成した（app と runner に同じ値を置く）'
  persist_env ALTEROID_RUNNER_TOKEN "$RUNNER_TOKEN"
else
  dim 'ALTEROID_RUNNER_TOKEN: 在るものを使う'
fi

TZ_VALUE="$(env_file_get TZ)"
: "${TZ_VALUE:=Asia/Tokyo}"
DAILY_REPORT_AT="$(env_file_get ALTEROID_DAILY_REPORT_AT)"
INITIATIVE_EVERY="$(env_file_get ALTEROID_INITIATIVE_EVERY)"
ALTEROID_RUNNER_ID_VALUE="$(env_file_get ALTEROID_RUNNER_ID)"
: "${ALTEROID_RUNNER_ID_VALUE:=runner-primary}"

# --- 2. 任意の連携を尋ねる --------------------------------------------------

step '任意の連携'

GH_TOKEN_VALUE=''
GIT_AUTHOR_NAME_VALUE=''
GIT_AUTHOR_EMAIL_VALUE=''
GIT_COMMITTER_NAME_VALUE=''
GIT_COMMITTER_EMAIL_VALUE=''

GH_TOKEN_VALUE="$(printenv GH_TOKEN 2>/dev/null || true)"
[ -n "$GH_TOKEN_VALUE" ] || GH_TOKEN_VALUE="$(env_file_get GH_TOKEN)"

if [ -n "$GH_TOKEN_VALUE" ]; then
  dim 'GH_TOKEN: 在るものを使う（マネージャーが PR を出せる）'
elif ask_yes_no 'マネージャーに GitHub を渡しますか？（clone / push / gh pr create）' yes; then
  info 'fine-grained PAT: Contents = Read and write / Pull requests = Read and write'
  dim 'https://github.com/settings/personal-access-tokens/new'
  GH_TOKEN_VALUE="$(ask_secret 'GH_TOKEN を貼る（表示されない。空なら公開リポジトリの clone だけ）')"
  [ -n "$GH_TOKEN_VALUE" ] && persist_env GH_TOKEN "$GH_TOKEN_VALUE"
fi

if [ -n "$GH_TOKEN_VALUE" ]; then
  GIT_AUTHOR_NAME_VALUE="$(env_file_get GIT_AUTHOR_NAME)"
  [ -n "$GIT_AUTHOR_NAME_VALUE" ] ||
    GIT_AUTHOR_NAME_VALUE="$(ask 'コミットの名前 (GIT_AUTHOR_NAME)' "$(git config user.name 2>/dev/null || true)")"
  GIT_AUTHOR_EMAIL_VALUE="$(env_file_get GIT_AUTHOR_EMAIL)"
  [ -n "$GIT_AUTHOR_EMAIL_VALUE" ] ||
    GIT_AUTHOR_EMAIL_VALUE="$(ask 'コミットのメール (GIT_AUTHOR_EMAIL)' "$(git config user.email 2>/dev/null || true)")"
  GIT_COMMITTER_NAME_VALUE="$(env_file_get GIT_COMMITTER_NAME)"
  : "${GIT_COMMITTER_NAME_VALUE:=$GIT_AUTHOR_NAME_VALUE}"
  GIT_COMMITTER_EMAIL_VALUE="$(env_file_get GIT_COMMITTER_EMAIL)"
  : "${GIT_COMMITTER_EMAIL_VALUE:=$GIT_AUTHOR_EMAIL_VALUE}"

  # **空文字で置くのは未設定より悪い。** git は `empty ident name` で即死する
  if [ -z "$GIT_AUTHOR_NAME_VALUE" ] || [ -z "$GIT_AUTHOR_EMAIL_VALUE" ]; then
    warn '身元が空なので GIT_* は置かない（空文字は未設定より悪い）。commit が要るなら後で足すこと'
    GIT_AUTHOR_NAME_VALUE=''
    GIT_AUTHOR_EMAIL_VALUE=''
    GIT_COMMITTER_NAME_VALUE=''
    GIT_COMMITTER_EMAIL_VALUE=''
  else
    persist_env GIT_AUTHOR_NAME "$GIT_AUTHOR_NAME_VALUE"
    persist_env GIT_AUTHOR_EMAIL "$GIT_AUTHOR_EMAIL_VALUE"
    persist_env GIT_COMMITTER_NAME "$GIT_COMMITTER_NAME_VALUE"
    persist_env GIT_COMMITTER_EMAIL "$GIT_COMMITTER_EMAIL_VALUE"
  fi
fi

GOOGLE_CLIENT_ID="$(env_file_get ALTEROID_GOOGLE_CLIENT_ID)"
GOOGLE_CLIENT_SECRET="$(env_file_get ALTEROID_GOOGLE_CLIENT_SECRET)"
EXPOSE_PUBLIC=0

if [ -n "$GOOGLE_CLIENT_ID" ] && [ -n "$GOOGLE_CLIENT_SECRET" ]; then
  dim 'ALTEROID_GOOGLE_*: 在るものを使う（外から HTTP API を叩ける）'
  EXPOSE_PUBLIC=1
elif ask_yes_no '外から HTTP API を叩きますか？（Google ログインを有効にしてドメインを生成する）' no; then
  info 'Redirect URI は <生成するドメイン>/auth/google/callback の1本。ドメインは後で表示する'
  GOOGLE_CLIENT_ID="$(ask 'ALTEROID_GOOGLE_CLIENT_ID')"
  GOOGLE_CLIENT_SECRET="$(ask_secret 'ALTEROID_GOOGLE_CLIENT_SECRET（表示されない）')"
  if [ -n "$GOOGLE_CLIENT_ID" ] && [ -n "$GOOGLE_CLIENT_SECRET" ]; then
    EXPOSE_PUBLIC=1
    persist_env ALTEROID_GOOGLE_CLIENT_ID "$GOOGLE_CLIENT_ID"
    persist_env ALTEROID_GOOGLE_CLIENT_SECRET "$GOOGLE_CLIENT_SECRET"
  else
    # **叩けばクローンのターンが起きる口を、無認証で外に出さない**
    warn '鍵が揃わないのでドメインは生成しない（127.0.0.1 のままにする）'
    GOOGLE_CLIENT_ID=''
    GOOGLE_CLIENT_SECRET=''
  fi
fi

# --- 3. 確かめてから作る ----------------------------------------------------

step '作るもの'

[ -n "$PROJECT_NAME" ] || PROJECT_NAME="$(ask 'プロジェクト名' alteroid)"

info "プロジェクト    ${PROJECT_NAME}（新しく作る。既存には触らない）"
info "Service         ${APP_SERVICE}（${APP_CONFIG}）"
info "                ${RUNNER_SERVICE}（${RUNNER_CONFIG}）"
info "                PostgreSQL"
info "GitHub          ${GIT_REPO:-（連携しない。ローカルから上げる）}${GIT_REPO:+ / $GIT_BRANCH}"
if [ -n "$GH_TOKEN_VALUE" ]; then
  info 'GH_TOKEN        置く（マネージャーが PR を出せる）'
else
  info 'GH_TOKEN        置かない（公開リポジトリの clone だけ）'
fi
if [ "$EXPOSE_PUBLIC" = 1 ]; then
  info 'Google ログイン 有効（ドメインを生成する）'
else
  info 'Google ログイン 無効（待ち受けは 127.0.0.1 のまま）'
fi
info 'ボリューム      作らない（記憶は PostgreSQL、workspace は Git 再構築）'

if [ "$ASSUME_YES" != 1 ] && ! ask_yes_no 'この内容で作りますか？' yes; then
  die 'やめた'
fi

# --- 4. プロジェクトと PostgreSQL -------------------------------------------

step "プロジェクトを作る（${PROJECT_NAME}）"

if [ -n "$WORKSPACE" ]; then
  railway init --name "$PROJECT_NAME" --workspace "$WORKSPACE" >/dev/null
else
  railway init --name "$PROJECT_NAME" >/dev/null
fi

PROJECT_ID="$(json_get "$(railway status --json 2>/dev/null || true)" 'd.id')"
[ -n "$PROJECT_ID" ] || die 'プロジェクト id が取れない。railway status を見る'
ENVIRONMENT_ID="$(json_get "$(railway environment list --json 2>/dev/null || true)" \
  '((d.environments || []).find(e => e.isLinked) || (d.environments || [])[0] || {}).id')"
[ -n "$ENVIRONMENT_ID" ] || die '環境 id が取れない。railway environment list を見る'
ok "$PROJECT_NAME ($PROJECT_ID)"

step 'PostgreSQL を足す'
railway add --database postgres >/dev/null
PG_NAME="$(postgres_service_name)"
[ -n "$PG_NAME" ] || die 'PostgreSQL の Service 名が取れない。railway service list を見る'
ok "$PG_NAME"

# --- 5. 2つの Service ------------------------------------------------------
#
# **順番に意味がある。** repo を繋いだ瞬間にデプロイが走りうるので、変数と
# Config as Code を先に置く。でないと初回が必ず失敗し、ログが赤で埋まる

step "Service を作る（$APP_SERVICE / ${RUNNER_SERVICE}）"
# `--service` を必ず明示する。`add` は作った Service を手元のリンクに結ぶので、
# 省くと後の操作が「最後に作ったもの」へ黙って向く
railway add --service "$APP_SERVICE" >/dev/null
railway add --service "$RUNNER_SERVICE" >/dev/null

APP_ID="$(service_id "$APP_SERVICE")"
RUNNER_SVC_ID="$(service_id "$RUNNER_SERVICE")"
[ -n "$APP_ID" ] || die "$APP_SERVICE の id が取れない"
[ -n "$RUNNER_SVC_ID" ] || die "$RUNNER_SERVICE の id が取れない"
ok "$APP_SERVICE ($APP_ID)"
ok "$RUNNER_SERVICE ($RUNNER_SVC_ID)"

step 'Config as Code を指す'
set_config_file "$APP_ID" "$APP_CONFIG"
set_config_file "$RUNNER_SVC_ID" "$RUNNER_CONFIG"
ok "$APP_SERVICE → $APP_CONFIG"
ok "$RUNNER_SERVICE → $RUNNER_CONFIG"

# --- 6. ドメイン（Google ログインを有効にしたときだけ）----------------------

# **頼まれたものと違うものを作ったなら、そう名乗る。** デプロイの失敗とは別に数える
# （器は上がっているので `deploy_failed` では言い表せない）
setup_failed=0

# Railway が生成したドメインか（人間が持ち込んだドメインと扱いが違う）
is_railway_host() {
  case "$1" in
    *.railway.app) return 0 ;;
    *) return 1 ;;
  esac
}

PUBLIC_URL=''
if [ "$EXPOSE_PUBLIC" = 1 ]; then
  step "ドメインを用意する（${APP_SERVICE}）"

  # **`.env` の値をそのまま信じない。** このスクリプトは毎回新しいプロジェクトを作るので、
  # 前回の実行で書き留めた生成ドメインは**別の器のもの**である。信じて置くと、
  # 死んだドメインを指す `ALTEROID_PUBLIC_URL` と、そこへ向いた Redirect URI ができる
  # （外から叩けないのに設定は完了しているように見える）
  wanted="$(env_file_get ALTEROID_PUBLIC_URL)"
  wanted_host="${wanted#http://}"
  wanted_host="${wanted_host#https://}"
  wanted_host="${wanted_host%%/*}"

  if [ -n "$wanted_host" ] && ! is_railway_host "$wanted_host"; then
    # 人間が持ち込んだドメイン。**新しい器に繋がっているかは別の話**なので確かめる。
    # 繋ぐのとDNSを向けるのは人間の作業なので、ここでは代行せず、足りないことを言う
    if railway domain list --service "$APP_SERVICE" --json 2>/dev/null | grep -qF "$wanted_host"; then
      PUBLIC_URL="https://$wanted_host"
    else
      setup_failed=1
      warn "$wanted_host は新しい ${APP_SERVICE} に繋がっていないので、外から叩ける口は作っていない"
      warn "繋ぐ: railway domain $wanted_host --port $DAEMON_PORT --service ${APP_SERVICE}（DNS も向ける）"
    fi
  else
    if [ -n "$wanted_host" ]; then
      dim "$(basename "$ENV_FILE") の $wanted_host は前の器のものなので作り直す"
    fi
    domain_json="$(railway domain --service "$APP_SERVICE" --port "$DAEMON_PORT" --json 2>/dev/null || true)"
    domain="$(json_get "$domain_json" \
      'd.domain || (d.domains && d.domains[0] && (d.domains[0].domain || d.domains[0])) || ""')"
    if [ -n "$domain" ]; then
      PUBLIC_URL="https://${domain#https://}"
      replace_env ALTEROID_PUBLIC_URL "$PUBLIC_URL"
    else
      # ここで Google の鍵と `ALTEROID_BIND` を置かないのは正しい（境界の無い口を
      # 外に出さない）。**正しいがゆえに、頼まれた構成とは別物になる** —
      # 「外から叩く」を選んだのに 127.0.0.1・認証なしで上がる。黙ると、人間は
      # 叩けない理由を Google 側の設定に探しに行く
      setup_failed=1
      warn 'ドメインを生成できなかったので、外から叩ける口は作っていない'
      warn '（境界の無い口を外に出さないため、Google の鍵も待ち受けも置いていない）'
    fi
  fi
  [ -n "$PUBLIC_URL" ] && ok "$PUBLIC_URL"
fi

# --- 7. 変数（役ごとに書き分ける）------------------------------------------

step '変数を置く'

# 両方が持つもの。**使う / 使わないは役が決める**ので、片方が読まない変数が並んでも害は無い
shared_pairs=(
  ALTEROID_RUNNER_TOKEN "$RUNNER_TOKEN"
  CLAUDE_CODE_OAUTH_TOKEN "$CLAUDE_TOKEN"
  ALTEROID_RUNNER_URL "http://\${{$RUNNER_SERVICE.RAILWAY_PRIVATE_DOMAIN}}:$RUNNER_PORT"
  ALTEROID_RUNNER_BIND '::'
  ALTEROID_RUNNER_PORT "$RUNNER_PORT"
  ALTEROID_RUNNER_ID "$ALTEROID_RUNNER_ID_VALUE"
  TZ "$TZ_VALUE"
)
if [ -n "$DAILY_REPORT_AT" ]; then
  shared_pairs+=(ALTEROID_DAILY_REPORT_AT "$DAILY_REPORT_AT")
fi
if [ -n "$INITIATIVE_EVERY" ]; then
  shared_pairs+=(ALTEROID_INITIATIVE_EVERY "$INITIATIVE_EVERY")
fi

# 下＝外の世界へ手を伸ばす鍵。**伏せるのは上＝記憶へ到達する鍵だけ**なので、
# これは両方へ渡すのが正しい（伏せると、人間が Claude Code でできることが
# 層を下りた瞬間に消える＝デグレード）
if [ -n "$GH_TOKEN_VALUE" ]; then
  shared_pairs+=(GH_TOKEN "$GH_TOKEN_VALUE")
  if [ -n "$GIT_AUTHOR_NAME_VALUE" ]; then
    shared_pairs+=(
      GIT_AUTHOR_NAME "$GIT_AUTHOR_NAME_VALUE"
      GIT_AUTHOR_EMAIL "$GIT_AUTHOR_EMAIL_VALUE"
      GIT_COMMITTER_NAME "$GIT_COMMITTER_NAME_VALUE"
      GIT_COMMITTER_EMAIL "$GIT_COMMITTER_EMAIL_VALUE"
    )
  fi
fi

# app にだけ置くもの。**記憶ストアの鍵はここから外へ出さない**
app_pairs=("${shared_pairs[@]}" ALTEROID_DATABASE_URL "\${{$PG_NAME.DATABASE_URL}}")
if [ "$EXPOSE_PUBLIC" = 1 ] && [ -n "$PUBLIC_URL" ]; then
  # 外から届かせるので待ち受けを開ける。**手前に境界（ログイン）が立ってから**開ける。
  # 鍵が2つ揃うと認証は自動で有効になる
  app_pairs+=(
    ALTEROID_GOOGLE_CLIENT_ID "$GOOGLE_CLIENT_ID"
    ALTEROID_GOOGLE_CLIENT_SECRET "$GOOGLE_CLIENT_SECRET"
    ALTEROID_PUBLIC_URL "$PUBLIC_URL"
    ALTEROID_BIND '::'
    ALTEROID_PORT "$DAEMON_PORT"
  )
fi

# runner にだけ置くもの。子プロセスを uid 1001 へ降ろすのに特権が要る
runner_pairs=("${shared_pairs[@]}" RAILWAY_RUN_UID 0)

put_variables "$APP_ID" "${app_pairs[@]}"
ok "$APP_SERVICE: $((${#app_pairs[@]} / 2)) 個（記憶ストアの鍵はここだけ）"
put_variables "$RUNNER_SVC_ID" "${runner_pairs[@]}"
ok "$RUNNER_SERVICE: $((${#runner_pairs[@]} / 2)) 個（記憶ストアの鍵は無い）"

# --- 8. デプロイ（runner を先に）--------------------------------------------

deploy_failed=0

if [ -n "$GIT_REPO" ]; then
  step "GitHub を繋ぐ（$GIT_REPO / ${GIT_BRANCH}）"
  dim 'runner を先に上げる。daemon は起動時に runner の /health へ名乗りを聞きに行く'

  if railway service source connect --repo "$GIT_REPO" --branch "$GIT_BRANCH" --service "$RUNNER_SERVICE" >/dev/null 2>&1; then
    ok "$RUNNER_SERVICE ← $GIT_REPO"
    ensure_deploy "$RUNNER_SERVICE" || deploy_failed=1
    wait_for_deploy "$RUNNER_SERVICE" || deploy_failed=1

    if railway service source connect --repo "$GIT_REPO" --branch "$GIT_BRANCH" --service "$APP_SERVICE" >/dev/null 2>&1; then
      ok "$APP_SERVICE ← $GIT_REPO"
      ensure_deploy "$APP_SERVICE" || deploy_failed=1
      wait_for_deploy "$APP_SERVICE" || deploy_failed=1
    else
      warn "$APP_SERVICE の GitHub 連携に失敗した"
      deploy_failed=1
    fi
  else
    warn "GitHub 連携に失敗した（Railway の GitHub App が $GIT_REPO を見えていない）"
    info 'ダッシュボード → 各 Service → Settings → Source で繋ぐか、ローカルから上げる:'
    info "  railway up --service $RUNNER_SERVICE --detach"
    info "  railway up --service $APP_SERVICE --detach"
    GIT_REPO=''
  fi
fi

if [ -z "$GIT_REPO" ]; then
  step 'ローカルから上げる'
  dim 'GitHub 連携が無いので、push では自動デプロイされない（watchPatterns も効かない）'
  if ask_yes_no "いま上げますか？（$RUNNER_SERVICE → $APP_SERVICE の順）" yes; then
    railway up --service "$RUNNER_SERVICE" --detach >/dev/null || deploy_failed=1
    wait_for_deploy "$RUNNER_SERVICE" || deploy_failed=1
    railway up --service "$APP_SERVICE" --detach >/dev/null || deploy_failed=1
    wait_for_deploy "$APP_SERVICE" || deploy_failed=1
  else
    info "後で: railway up --service $RUNNER_SERVICE --detach && railway up --service $APP_SERVICE --detach"
  fi
fi

# --- 9. これから -------------------------------------------------------------

if [ "$deploy_failed" = 1 ] || [ "$setup_failed" = 1 ]; then
  step '途中まで作った'
else
  step 'できた'
fi

if [ "$deploy_failed" = 1 ]; then
  warn 'デプロイのどれかが終わっていない。まずログを見る'
  info "  railway logs --service $RUNNER_SERVICE"
  info "  railway logs --service $APP_SERVICE"
  info '症状から引く表は railway/README.md にある'
fi

if [ "$setup_failed" = 1 ]; then
  warn '「外から HTTP API を叩く」を選んだが、その構成にはなっていない'
  info '  待ち受けは 127.0.0.1 のままで、Google ログインは有効になっていない'
  info '  残りを手でやる（ドメインを作ってから鍵を置く。順番を逆にしない）:'
  info "    railway domain --service $APP_SERVICE --port $DAEMON_PORT"
  info "    railway variable set ALTEROID_PUBLIC_URL=https://<生成されたドメイン> --service $APP_SERVICE"
  info "    railway variable set ALTEROID_BIND=:: ALTEROID_PORT=$DAEMON_PORT --service $APP_SERVICE"
  info "    railway variable set ALTEROID_GOOGLE_CLIENT_ID=... ALTEROID_GOOGLE_CLIENT_SECRET=... --service $APP_SERVICE"
  info '  Redirect URI は <ドメイン>/auth/google/callback の1本'
fi

cat >&2 <<EOS

    使う（CLI はデーモンを 127.0.0.1 に見に行くので、同じ器の中から）:

      railway ssh --service $APP_SERVICE
      alteroid chat

    境界と能力を確かめる（境界を入れた側が示す義務）:

      ./railway/verify.sh
EOS

if [ "$EXPOSE_PUBLIC" = 1 ] && [ -n "$PUBLIC_URL" ]; then
  cat >&2 <<EOS

    Google 側に登録する Redirect URI は1本だけ:

      $PUBLIC_URL/auth/google/callback

    **ログインしただけでは使えない。** 許可は人間が与える（高々1つ）:

      railway ssh --service $APP_SERVICE
      alteroid access list
      alteroid access grant <アカウント id>
EOS
fi

if [ -n "$GH_TOKEN_VALUE" ]; then
  cat >&2 <<'EOS'

    マネージャーに頼む:

      alteroid chat
      > alteroid リポジトリの M5 を実装して PR を出して。AGENTS.md と docs/roadmap.md を先に読んで。

    鍵の差し替えは変数を置き直すだけでは走行中のマネージャーに届かない。
    railway/README.md「鍵を回す（走行中でも）」を見る。
EOS
fi

printf '\n' >&2

# **上がっていない / 頼まれたものと違うなら、そう名乗る。** 器と変数だけ作って
# 「できた」と 0 を返すと、呼んだ側（CI や別のスクリプト）はできたと読む。
# **境界を作れなかったことも 0 で隠さない** — 隠すと、外から叩けない理由を
# 人間が Google 側の設定に探しに行く（実際に一番時間を食う探し方である）
if [ "$deploy_failed" = 1 ] || [ "$setup_failed" = 1 ]; then
  exit 1
fi
exit 0
