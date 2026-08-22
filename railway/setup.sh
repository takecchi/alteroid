#!/usr/bin/env bash
# Railway に alteroid の Service（app / runner × N / PostgreSQL）を1発で用意する。
#
#   ./railway/setup.sh              runner 1台（既定）
#   ./railway/setup.sh -c 3         runner 3台（`runner` / `runner-2` / `runner-3`）
#
# **既存のプロジェクトへ runner を足すのはこれではない**（毎回新しく作る）。
# 既に動いているものを増やすなら `railway/scale-runners.sh` である。
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
# 6. **`ALTEROID_RUNNER_ID` は台ごとに違う値を配る。** 同じ値が2台に載ると、台帳の
#    `manager_id → runner_id` を引く `RunnerRegistry#get` が線形一致で**先に見つかった方を
#    黙って返す**ので、`manager_send` が別の器へ届く（症状は「たまに噛み合わない」だけ）。
#    ここでは番号から一意な id を作るので、人間が名前を考える経路そのものが無い
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

# **置き方は scale-runners.sh と同じものを使う**（railway/lib.sh）。変数の投入・
# Config as Code の指し方・デプロイの待ち方を2つのスクリプトが別々に持つと、片方だけが
# 古びる。ずれても動作は正常に見えるので、気づく場所が他に無い。
# shellcheck source=railway/lib.sh
source "$(dirname "${BASH_SOURCE[0]}")/lib.sh"

# --- 引数 -------------------------------------------------------------------

PROJECT_NAME=''
WORKSPACE=''
GIT_REPO=''
GIT_BRANCH=''
RUNNER_COUNT=''

usage() {
  cat <<'EOS'
Railway に alteroid の Service（app / runner × N / PostgreSQL）を用意する。

  ./railway/setup.sh [オプション]

  -n, --name <名前>       プロジェクト名（既定: alteroid）
  -w, --workspace <名前>  Workspace（複数持っているときだけ要る）
  -r, --repo <owner/repo> GitHub 連携する対象（既定: origin から拾う）
  -b, --branch <ブランチ> 追いかけるブランチ（既定: release/prod）
  -c, --runners <台数>    runner の台数（既定: 1。.env の ALTEROID_RUNNER_COUNT も見る）
  -y, --yes               尋ねない（値は .env と既定値から取る）
  -h, --help              これ

人間が埋めるものは compose と同じ .env に集まる。無いものは尋ね、
合鍵は作って書き留める。既存のプロジェクトには触らず、毎回新しく作る。

**既存のプロジェクトへ runner を足すのはこれではない** → ./railway/scale-runners.sh
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
    -c | --runners)
      RUNNER_COUNT="${2:-}"
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
  # **既定は release/prod で、origin の既定ブランチ（＝main）ではない。**
  # Railway に main を見せると、マージした瞬間にデプロイが走って走行中のマネージャーと
  # 作業者が畳まれる。それを切り離すために release/prod を置いてある
  # （.github/workflows/release-prod.yml が夜に2回 main を写す）。
  # **ここを main へ戻すと、その形へ戻る**（railway/README.md「デプロイは走行中の
  # 仕事を畳む操作である」1）。とくに M5 で runner を2台目足すとき、片方だけが main を
  # 見ていると**そこだけがマージのたびに畳まれる**ので、既定を弱いほうへ倒さないこと。
  GIT_BRANCH='release/prod'
  if ! git -C "$REPO_ROOT" ls-remote --exit-code --heads origin "$GIT_BRANCH" >/dev/null 2>&1; then
    # まだ一度も反映が走っていないリポジトリ。**main へ落とすが黙らない** — この形は
    # マージした瞬間に落ちるので、気づかないまま常駐させたくない（黙って倒すと、
    # あとで「なぜマージで死ぬのか」を Railway 側に探しに行くことになる）。
    GIT_BRANCH="$(git -C "$REPO_ROOT" symbolic-ref --short refs/remotes/origin/HEAD 2>/dev/null || true)"
    GIT_BRANCH="${GIT_BRANCH#origin/}"
    : "${GIT_BRANCH:=main}"
    warn "origin に release/prod が無いので $GIT_BRANCH に繋ぐ。**マージした瞬間にデプロイが走る形**である"
    warn "  → Actions の「release/prod へ反映」を一度起こしてから、Settings → Source を release/prod へ向け直すこと"
  fi
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
# 層とモデル帯の対応（クローン Fable / マネージャー Opus / 作業者 Sonnet）の差し替え。
# **これは設定ではなく、人間の承認の置き場である**（変更には人間の承認が要る。
# AGENTS.md 地雷5）。だから尋ねない — 在れば運ぶだけで、無ければ既定のまま置かない
CLONE_MODEL="$(env_file_get ALTEROID_CLONE_MODEL)"
MANAGER_MODEL="$(env_file_get ALTEROID_MANAGER_MODEL)"
WORKER_MODEL="$(env_file_get ALTEROID_WORKER_MODEL)"
# 1台目の runner_id の上書き（`.env`）。**以前からある能力なので落とさない。**
# 2台目以降は Service 名と揃えるので、ここで選べるのは1台目だけである
RUNNER_ID_FROM_ENV="$(env_file_get ALTEROID_RUNNER_ID)"
if [ -n "$RUNNER_ID_FROM_ENV" ]; then
  FIRST_RUNNER_ID="$RUNNER_ID_FROM_ENV"
fi

# runner の台数。**既定は1のままにしてある** — 台数は費用でもあるので、増やすのは
# 人間が言ったときだけである（`-c` か `.env`）。**台数を増やしても能力の上限は動かない**
# （配置は実行環境の資源で決まる。人工の `maxManagers` は置かない。M5 の地雷）。
[ -n "$RUNNER_COUNT" ] || RUNNER_COUNT="$(env_file_get ALTEROID_RUNNER_COUNT)"
: "${RUNNER_COUNT:=1}"
case "$RUNNER_COUNT" in
  '' | *[!0-9]*) die "--runners は正の整数で指定する（受け取ったのは: ${RUNNER_COUNT}）" ;;
esac
[ "$RUNNER_COUNT" -ge 1 ] || die "--runners は1以上で指定する（受け取ったのは: ${RUNNER_COUNT}）"

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
for i in $(seq 1 "$RUNNER_COUNT"); do
  info "                $(runner_service_name "$i")（${RUNNER_CONFIG} / ALTEROID_RUNNER_ID=$(runner_id_for "$i")）"
done
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

# --- 5. Service（app と runner × N）----------------------------------------
#
# **順番に意味がある。** repo を繋いだ瞬間にデプロイが走りうるので、変数と
# Config as Code を先に置く。でないと初回が必ず失敗し、ログが赤で埋まる

step "Service を作る（$APP_SERVICE / runner × ${RUNNER_COUNT}）"
# `--service` を必ず明示する。`add` は作った Service を手元のリンクに結ぶので、
# 省くと後の操作が「最後に作ったもの」へ黙って向く
railway add --service "$APP_SERVICE" >/dev/null
APP_ID="$(service_id "$APP_SERVICE")"
[ -n "$APP_ID" ] || die "$APP_SERVICE の id が取れない"
ok "$APP_SERVICE ($APP_ID)"

# **runner は名前と id を並べて持つ。** 番号で数える形にすると、あとから
# `railway service list` と突き合わせるときに番号→名前の変換が散る
RUNNER_NAMES=()
RUNNER_IDS=()
RUNNER_SVC_IDS=()
for i in $(seq 1 "$RUNNER_COUNT"); do
  name="$(runner_service_name "$i")"
  railway add --service "$name" >/dev/null
  svc_id="$(service_id "$name")"
  [ -n "$svc_id" ] || die "$name の id が取れない"
  RUNNER_NAMES+=("$name")
  RUNNER_IDS+=("$(runner_id_for "$i")")
  RUNNER_SVC_IDS+=("$svc_id")
  ok "$name ($svc_id)"
done

step 'Config as Code を指す'
set_config_file "$APP_ID" "$APP_CONFIG"
ok "$APP_SERVICE → $APP_CONFIG"
for idx in "${!RUNNER_NAMES[@]}"; do
  set_config_file "${RUNNER_SVC_IDS[$idx]}" "$RUNNER_CONFIG"
  ok "${RUNNER_NAMES[$idx]} → $RUNNER_CONFIG"
done

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

# そのホストが本当にこの Service へ繋がっているか。
#
# **部分一致で見ない。** `grep -F` で JSON を素通しに探すと、`alteroid.example` を
# 探しているのに `my-alteroid.example` や `alteroid.example.invalid` に当たる。
# 当たった瞬間、**届かない口を「在る」と誤認して**公開 URL と Google の鍵と
# 待ち受けを置き、0 で終わる（頼まれた構成と違うのに成功する、の再発である）。
#
# 応答の形は Railway 側の都合で変わるので、`domain` / `host` の値と配列の中の
# 素の文字列を深さに関係なく集め、**正規化して完全一致**で突き合わせる。
# 読めない応答は「繋がっていない」に倒す（開ける側の判断は安全側へ）。
domain_attached() { # <JSON> <ホスト>
  node -e '
    const normalize = (v) =>
      String(v)
        .trim()
        .toLowerCase()
        .replace(/^[a-z][a-z0-9+.-]*:\/\//, "") // scheme
        .replace(/[:/?#].*$/, "")               // port / path / query
        .replace(/\.$/, "");                    // 末尾のドット（FQDN 表記）

    const found = new Set();
    const walk = (value, key) => {
      if (value == null) return;
      if (typeof value === "string") {
        // ドメインを表す鍵の値か、配列に並んだ素の文字列だけを見る
        if (key === null || key === "domain" || key === "host") found.add(normalize(value));
        return;
      }
      if (Array.isArray(value)) {
        for (const item of value) walk(item, null);
        return;
      }
      if (typeof value === "object") {
        for (const [k, v] of Object.entries(value)) walk(v, k);
      }
    };

    try {
      walk(JSON.parse(process.argv[1]), null);
    } catch {
      process.exit(1);
    }
    process.exit(found.has(normalize(process.argv[2])) ? 0 : 1);
  ' -- "${1:-}" "$2"
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
    if domain_attached \
      "$(railway domain list --service "$APP_SERVICE" --json 2>/dev/null || true)" "$wanted_host"; then
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

# 両方が持つもの。**使う / 使わないは役が決める**ので、片方が読まない変数が並んでも害は無い。
#
# **ここに `ALTEROID_RUNNER_ID` は入らない。** 台ごとに違う値であり、`runner_id` は
# 台帳の `manager_id → runner_id` を引く鍵である。同じ値が2台に載ると
# `RunnerRegistry#get` は線形一致で**先に見つかった方を黙って返す**ので
# （`packages/core/src/runner-protocol.ts` の `get`。`select({runnerId})` だけは
# 「一意でない」と拒むが、`manager_send` / `abort` / `transcript` / `restore` が
# 通るのは `get` である）、**マネージャーへの指示が別の器へ届く。** 名簿は重複を
# 検出しないので、症状は「たまに応答が噛み合わない」だけになる。
# 一意性はここで**構造として**作る（`runner_id_for`）。確かめるのは `verify.sh`。
#
# **委譲の宛先（`ALTEROID_RUNNER_URL` / `_URLS`）も入らない。** これは app が読む
# ものであり、runner 自身は読まない。台数が2以上のとき「どの1台か」を書けない。
shared_pairs=(
  ALTEROID_RUNNER_TOKEN "$RUNNER_TOKEN"
  CLAUDE_CODE_OAUTH_TOKEN "$CLAUDE_TOKEN"
  ALTEROID_RUNNER_BIND '::'
  ALTEROID_RUNNER_PORT "$RUNNER_PORT"
  TZ "$TZ_VALUE"
)
if [ -n "$DAILY_REPORT_AT" ]; then
  shared_pairs+=(ALTEROID_DAILY_REPORT_AT "$DAILY_REPORT_AT")
fi
if [ -n "$INITIATIVE_EVERY" ]; then
  shared_pairs+=(ALTEROID_INITIATIVE_EVERY "$INITIATIVE_EVERY")
fi

# モデル帯の差し替えは**両方へ置くのが正しい**。SDK へ `model:` を渡すのは runner で、
# そこが正本である。app も同じ値を読むが、使うのは自己認識に載せる**宣言**のためだけ
# なので、片方にだけ置くと「Opus に委譲している」と宣言しながら別の帯が走る。
# 置かれていなければ変数そのものを作らない（器は空を「未設定」として読むので害は
# 無いが、ダッシュボードに承認が置かれているように見える行を残さない）
if [ -n "$CLONE_MODEL" ]; then
  shared_pairs+=(ALTEROID_CLONE_MODEL "$CLONE_MODEL")
fi
if [ -n "$MANAGER_MODEL" ]; then
  shared_pairs+=(ALTEROID_MANAGER_MODEL "$MANAGER_MODEL")
fi
if [ -n "$WORKER_MODEL" ]; then
  shared_pairs+=(ALTEROID_WORKER_MODEL "$WORKER_MODEL")
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

# 委譲の宛先。**1台なら単数形のまま置く** — 既に動いている構成と同じ形にしておく
# （デーモンは両方読み、空白と重複を落とす。`parseRunnerUrls`）。2台以上のときだけ
# カンマ区切りの複数形にして、単数形は置かない（同じことを言う変数を2つ作らない）。
if [ "$RUNNER_COUNT" = 1 ]; then
  app_pairs+=(ALTEROID_RUNNER_URL "$(runner_url_for 1)")
else
  runner_urls=''
  for i in $(seq 1 "$RUNNER_COUNT"); do
    runner_urls="${runner_urls:+$runner_urls,}$(runner_url_for "$i")"
  done
  app_pairs+=(ALTEROID_RUNNER_URLS "$runner_urls")
fi
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

put_variables "$APP_ID" "${app_pairs[@]}"
ok "$APP_SERVICE: $((${#app_pairs[@]} / 2)) 個（記憶ストアの鍵はここだけ）"

# runner にだけ置くもの。子プロセスを uid 1001 へ降ろすのに特権が要る。
# `ALTEROID_RUNNER_ID` は台ごとに違う（上の理由）
for idx in "${!RUNNER_NAMES[@]}"; do
  runner_pairs=(
    "${shared_pairs[@]}"
    RAILWAY_RUN_UID 0
    ALTEROID_RUNNER_ID "${RUNNER_IDS[$idx]}"
  )
  put_variables "${RUNNER_SVC_IDS[$idx]}" "${runner_pairs[@]}"
  ok "${RUNNER_NAMES[$idx]}: $((${#runner_pairs[@]} / 2)) 個（記憶ストアの鍵は無い / id=${RUNNER_IDS[$idx]}）"
done

# --- 8. デプロイ（runner を先に）--------------------------------------------

deploy_failed=0

if [ -n "$GIT_REPO" ]; then
  step "GitHub を繋ぐ（$GIT_REPO / ${GIT_BRANCH}）"
  dim 'runner を先に上げる。daemon は起動時に runner の /health へ名乗りを聞きに行く'

  # **runner は全台、app より先に繋ぐ。** 1台でも後回しにすると、デーモンが
  # 起きたときにその宛先だけ不在で、名簿が背景で挑み直す状態から始まる
  # （収束はするが、その間その器へは委譲が置かれない）
  runners_connected=1
  for name in "${RUNNER_NAMES[@]}"; do
    if railway service source connect --repo "$GIT_REPO" --branch "$GIT_BRANCH" --service "$name" >/dev/null 2>&1; then
      ok "$name ← $GIT_REPO"
      ensure_deploy "$name" || deploy_failed=1
      wait_for_deploy "$name" || deploy_failed=1
    else
      runners_connected=0
      break
    fi
  done

  if [ "$runners_connected" = 1 ]; then
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
    for name in "${RUNNER_NAMES[@]}"; do
      info "  railway up --service $name --detach"
    done
    info "  railway up --service $APP_SERVICE --detach"
    GIT_REPO=''
  fi
fi

if [ -z "$GIT_REPO" ]; then
  step 'ローカルから上げる'
  dim 'GitHub 連携が無いので、push では自動デプロイされない（watchPatterns も効かない）'
  if ask_yes_no "いま上げますか？（runner × ${RUNNER_COUNT} → $APP_SERVICE の順）" yes; then
    for name in "${RUNNER_NAMES[@]}"; do
      railway up --service "$name" --detach >/dev/null || deploy_failed=1
      wait_for_deploy "$name" || deploy_failed=1
    done
    railway up --service "$APP_SERVICE" --detach >/dev/null || deploy_failed=1
    wait_for_deploy "$APP_SERVICE" || deploy_failed=1
  else
    info '後で（runner を先に。app は最後）:'
    for name in "${RUNNER_NAMES[@]}"; do
      info "  railway up --service $name --detach"
    done
    info "  railway up --service $APP_SERVICE --detach"
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
  for name in "${RUNNER_NAMES[@]}"; do
    info "  railway logs --service $name"
  done
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
      > alteroid リポジトリの M5 を実装して PR を出して。AGENTS.md と docs/architecture.md を先に読んで。

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
