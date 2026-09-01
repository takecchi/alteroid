#!/usr/bin/env bash
# **既に動いている** Railway のプロジェクトに runner を足す。
#
#   ./railway/scale-runners.sh -n 3      runner を計3台にする（足りないぶんだけ作る）
#   ./railway/scale-runners.sh -n 3 -d   何をするかだけ出して、何も作らない
#
# `setup.sh` は毎回新しいプロジェクトを作る（既存には触らない）。**こちらは逆で、
# いま走っているものだけを触る。** だから守る約束が1つ増える:
#
#   **走行中のマネージャーを畳まない。** 既存の `runner` の変数には1文字も触らない
#   （触れば器が入れ替わり、その中で手を動かしているマネージャーと作業者が死ぬ）。
#   触るのは「新しく作る runner」と「app の委譲の宛先」だけである。
#
# ## それでも app は1度入れ替わる
#
# デーモンは runner の宛先を**起動時に env から1回だけ**読む（`apps/daemon/src/index.ts`
# の `runnerSeeds`）。実行中に名簿へ足す口は無い（`POST /runners` は無く、
# `RunnerRegistry#register` を呼ぶのはデーモンの起動経路だけである）。だから
# `ALTEROID_RUNNER_URLS` を置いたら app を上げ直すしかない。
#
# **これは runner の入れ替えとは重さが違う。** マネージャーは runner の中で走っている
# ので畳まれず、落ちるのはクローンのターン1本と chat の接続である（数十秒）。デーモンは
# 起き直したときに runner へ名乗りを聞き、走っていた仕事を引き取る。
#
# ## 減らすほうはやらない
#
# `-n` に今より小さい数を渡したら**断る**（非0で終わる）。台数を減らすには、その器を
# 空ける（drain する）ことが要る。移送そのものは入っている（roadmap M5 PR5）
# ——runner が黙れば、走っていた委譲は別の器へ移る。いまは意図して空ける口も在る
# （#485。`POST /runners/vacate`）——ただし**このスクリプトはまだそれを呼ばない**。
# どの器を空けるかの判断はクローンの仕事であって、このスクリプトが黙って選ぶもの
# ではない。**「落ちた」は観測の欠落であって停止の証明ではない**ので、drain も
# せずに減らすと同じセッションが2か所で走りうる。
# 手で消すなら、その器に仕事が無いことを `GET /runners` と `/managers` で確かめてから。
set -euo pipefail

# **置き方は setup.sh と同じものを使う**（railway/lib.sh）。変数の投入・Config as Code の
# 指し方・デプロイの待ち方が2つに分かれると、片方だけが古びる
# shellcheck source=railway/lib.sh
source "$(dirname "${BASH_SOURCE[0]}")/lib.sh"

# --- 引数 -------------------------------------------------------------------

TOTAL=''
GIT_REPO=''
GIT_BRANCH=''
DRY_RUN=0

usage() {
  cat <<'EOS'
既に動いている Railway のプロジェクトに runner を足す（減らさない）。

  ./railway/scale-runners.sh -n <台数> [オプション]

  -n, --total <台数>      runner を最終的に何台にするか（既存を含む）
  -r, --repo <owner/repo> GitHub 連携する対象（既定: 既存 runner と同じ / origin）
  -b, --branch <ブランチ> 追いかけるブランチ（既定: release/prod）
  -d, --dry-run           何をするかだけ出して、何も作らない
  -y, --yes               尋ねない
  -h, --help              これ

既存の runner の変数には触らない（触ると走行中のマネージャーが畳まれる）。
新しい runner の鍵は**いま走っている runner から写す** — .env は見ない。
最後に app の ALTEROID_RUNNER_URLS を置き直して app だけ上げ直す。
EOS
}

while [ $# -gt 0 ]; do
  case "$1" in
    -n | --total)
      TOTAL="${2:-}"
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
    -d | --dry-run)
      DRY_RUN=1
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

[ -n "$TOTAL" ] || die '--total <台数> が要る（--help）'
case "$TOTAL" in
  '' | *[!0-9]*) die "--total は正の整数で指定する（受け取ったのは: ${TOTAL}）" ;;
esac
[ "$TOTAL" -ge 1 ] || die "--total は1以上で指定する（受け取ったのは: ${TOTAL}）"

if [ "$ASSUME_YES" != 1 ] && [ "$DRY_RUN" != 1 ] && [ ! -e /dev/tty ]; then
  die '端末が無い。--yes か --dry-run で回すこと'
fi

# --- 0. 道具と、いまのプロジェクト -------------------------------------------

step '道具を確かめる'

for cmd in railway node git; do
  command -v "$cmd" >/dev/null 2>&1 ||
    die "$cmd が無い。railway は 'npm i -g @railway/cli'、node と git は mise install で入る"
done
ok "$(railway --version 2>/dev/null | head -n1)"
railway whoami >/dev/null 2>&1 || die 'railway login していない（このスクリプトは勝手にログインしない）'
ok "$(railway whoami 2>/dev/null | head -n1)"

# **リンク済みのプロジェクトだけを触る。** 名前で探して当てに行くと、似た名前の別の
# プロジェクトを掴む。`railway link` は人間の操作である
PROJECT_ID="$(json_get "$(railway status --json 2>/dev/null || true)" 'd.id')"
[ -n "$PROJECT_ID" ] || die 'プロジェクトにリンクしていない。railway link で選んでから回すこと'
PROJECT_NAME="$(json_get "$(railway status --json 2>/dev/null || true)" 'd.name')"
ENVIRONMENT_ID="$(json_get "$(railway environment list --json 2>/dev/null || true)" \
  '((d.environments || []).find(e => e.isLinked) || (d.environments || [])[0] || {}).id')"
[ -n "$ENVIRONMENT_ID" ] || die '環境 id が取れない。railway environment list を見る'
ok "${PROJECT_NAME:-$PROJECT_ID} ($PROJECT_ID)"

# --- 1. いま何台居るか ------------------------------------------------------
#
# **数え上げの持ち主は Railway 側である。** `.env` の台数や前回の実行を覚えておく形に
# すると、ダッシュボードで足した1台と食い違い、その食い違いは「同じ名前の Service を
# 作ろうとして失敗する」まで出てこない

step 'いまの runner を数える'

SERVICE_LIST="$(railway service list --json 2>/dev/null || true)"
[ -n "$SERVICE_LIST" ] || die 'railway service list が読めない'

# `runner` / `runner-2` / `runner-3` … だけを拾う。**前方一致で拾わない**
# （`runner-old` のような手作りの Service を数に入れると、番号が飛んで宛先がずれる）
EXISTING="$(node -e '
  const list = JSON.parse(process.argv[1] || "[]");
  const base = process.argv[2];
  const names = new Set(list.map((s) => s.name));
  const found = [];
  for (let i = 1; ; i += 1) {
    const name = i === 1 ? base : `${base}-${i}`;
    if (!names.has(name)) break;
    found.push(name);
  }
  process.stdout.write(found.join("\n"));
' -- "$SERVICE_LIST" "$RUNNER_SERVICE" || true)"

CURRENT=0
if [ -n "$EXISTING" ]; then
  CURRENT="$(printf '%s\n' "$EXISTING" | wc -l | tr -d ' ')"
fi
[ "$CURRENT" -ge 1 ] || die "$RUNNER_SERVICE Service が無い。まだ何も建っていないなら setup.sh を使う"

APP_ID="$(service_id "$APP_SERVICE")"
[ -n "$APP_ID" ] || die "$APP_SERVICE の id が取れない（Service 名が違う？ ALTEROID_APP_SERVICE で指定できる）"

info "$APP_SERVICE ($APP_ID)"
for name in $EXISTING; do
  info "$name"
done
ok "runner は今 ${CURRENT} 台"

if [ "$TOTAL" -lt "$CURRENT" ]; then
  # **黙って何もしないのでも、勝手に消すのでもない。** できないと言う
  die "$CURRENT 台から ${TOTAL} 台へは減らせない（このスクリプトは増やすだけ）。
    台数を減らすには、その器を空ける（drain する）ことが要る。
    移送そのものは入っている（M5 PR5）——runner が黙れば、走っていた委譲は別の器へ移る。
    いまは意図して空ける口も在る（#485）⟹ POST /runners/vacate に { runnerId } を渡す
    （runner.stop() で確かめた停止を経て、貸し出し期限を待たずに委譲を移す）。
    いま手で減らすなら、その器に仕事が無いことを先に確かめること:
      railway ssh --service $APP_SERVICE
      curl -s http://127.0.0.1:\$ALTEROID_PORT/runners | jq
      curl -s http://127.0.0.1:\$ALTEROID_PORT/managers | jq"
fi

# --- 2. 何をするか（作る前に出す）-------------------------------------------

step '作るもの'

NEW_NAMES=()
NEW_IDS=()
if [ "$TOTAL" -gt "$CURRENT" ]; then
  for i in $(seq $((CURRENT + 1)) "$TOTAL"); do
    NEW_NAMES+=("$(runner_service_name "$i")")
    NEW_IDS+=("$(runner_id_for "$i")")
  done
fi

# 宛先は**全台ぶん**を並べ直す（既存も含む）。既存の app には単数形の
# `ALTEROID_RUNNER_URL` が残っているが、デーモンは単数形と複数形の両方を読み、
# 空白と重複を落とすので害は無い（`parseRunnerUrls`）。**消しに行かない** —
# 消す操作は app の変数一覧を触る回数を増やすだけで、何も強くしない
RUNNER_URLS=''
for i in $(seq 1 "$TOTAL"); do
  RUNNER_URLS="${RUNNER_URLS:+$RUNNER_URLS,}$(runner_url_for "$i")"
done

if [ "${#NEW_NAMES[@]}" -eq 0 ]; then
  info "runner は既に ${TOTAL} 台ある。新しく作るものは無い"
else
  for idx in "${!NEW_NAMES[@]}"; do
    info "新しい runner   ${NEW_NAMES[$idx]}（${RUNNER_CONFIG} / ALTEROID_RUNNER_ID=${NEW_IDS[$idx]}）"
  done
fi
info "$APP_SERVICE の委譲先  ALTEROID_RUNNER_URLS=$RUNNER_URLS"
info "触らないもの    ${EXISTING//$'\n'/ }（既存の runner の変数は1文字も触らない）"
warn "$APP_SERVICE は最後に1度上げ直す（クローンのターン1本と chat が数十秒切れる。走行中のマネージャーは畳まれない）"

if [ "$DRY_RUN" = 1 ]; then
  step '--dry-run なので何もしない'
  exit 0
fi

if [ "$ASSUME_YES" != 1 ] && ! ask_yes_no 'この内容で進めますか？' yes; then
  die 'やめた'
fi

# --- 3. 新しい runner に渡すもの（いま走っている runner から写す）-----------
#
# **`.env` から作り直さない。** 合鍵（`ALTEROID_RUNNER_TOKEN`）が1文字でも食い違うと
# デーモンは 401 を受けて `unusable` にする（待っても直らない誤りなので挑み直さない）。
# 正本は「いま走っている器が持っているもの」であって、手元のファイルではない。
#
# **写さないものが3種類ある:**
#
#   1. `RAILWAY_*` — Railway が器ごとに注入する（`RAILWAY_SERVICE_ID` などを写すと嘘になる）。
#      ただし `RAILWAY_RUN_UID` は人間が置く設定なので、下で明示的に置き直す
#   2. `ALTEROID_RUNNER_ID` — 台ごとに違う。**ここが写ると sticky routing が黙って壊れる**
#   3. `ALTEROID_DATABASE_URL` — runner には無いはずのもの。**在ったら実装のバグ**なので、
#      写さないだけでなく止まる（3コンテナに割った意味が消えている状態である）

step "$RUNNER_SERVICE の変数を写す"

SOURCE_VARS="$(railway variable list --service "$RUNNER_SERVICE" --json 2>/dev/null || true)"
[ -n "$SOURCE_VARS" ] || die "$RUNNER_SERVICE の変数が読めない"

if node -e '
  const vars = JSON.parse(process.argv[1] || "{}");
  process.exit(Object.keys(vars).some((k) => k.trim() === "ALTEROID_DATABASE_URL") ? 0 : 1);
' -- "$SOURCE_VARS"; then
  die "$RUNNER_SERVICE に ALTEROID_DATABASE_URL がある。**運用の間違いではなく実装のバグ**として扱うこと
    （記憶ストアの鍵が runner に居ると、その中のマネージャーが /proc/1/environ から取れる）。
    写すのをここで止める。railway/README.md「先に読む」2 を見る"
fi

# **名前の前後の空白を落とさない — 落とすと、誰も読まない変数がもう1つ増えるだけである。**
# 空白付きの名前を見つけたら写さずに言う（Railway は ` X` と `X` を別物として保存する）
COPY_PAIRS_FILE="$(tmp_file)"
node -e '
  const vars = JSON.parse(process.argv[1] || "{}");
  const skipped = [];
  const pairs = [];
  for (const [key, value] of Object.entries(vars)) {
    if (key !== key.trim()) {
      skipped.push(`名前に空白: ${JSON.stringify(key)}`);
      continue;
    }
    // Railway が器ごとに注入するもの。写すと嘘になる
    if (key.startsWith("RAILWAY_")) continue;
    // 台ごとに違うもの（呼ぶ側が置き直す）
    if (key === "ALTEROID_RUNNER_ID") continue;
    // 委譲の宛先は app が読むもので、runner 自身は読まない
    if (key === "ALTEROID_RUNNER_URL" || key === "ALTEROID_RUNNER_URLS") continue;
    if (typeof value !== "string" || value.length === 0) continue;
    pairs.push(key, value);
  }
  process.stdout.write(JSON.stringify({ pairs, skipped }));
' -- "$SOURCE_VARS" >"$COPY_PAIRS_FILE"

COPY_NAMES="$(json_get "$(cat "$COPY_PAIRS_FILE")" 'd.pairs.filter((_, i) => i % 2 === 0).join(" ")')"
COPY_SKIPPED="$(json_get "$(cat "$COPY_PAIRS_FILE")" 'd.skipped.join(" / ")')"
[ -z "$COPY_SKIPPED" ] || warn "写さなかったもの: $COPY_SKIPPED"
dim "写す: $COPY_NAMES"

# 値を argv へ載せずに配列へ戻す（**秘密を引数に置かない**のは `put_variables` の中でも
# 同じで、そちらは一時ファイル経由で GraphQL へ渡す）
COPY_PAIRS=()
# **`|| [ -n "$line" ]` を落とさないこと。** 最後の行に改行が無いと `read` は非0を返し、
# 本体を実行しないまま抜ける ＝ **最後の1個だけが静かに落ちる。** 落ちるのが値なら、
# 以降の要素が1つずれて「鍵の名前が値になる」形で入る（`ALTEROID_RUNNER_ID` の値が
# `0` になった状態で3台が並ぶ、が実際に出た）。テストで捕まえたのはこの形である
while IFS= read -r line || [ -n "$line" ]; do
  COPY_PAIRS+=("$line")
done < <(node -e '
  const d = JSON.parse(require("fs").readFileSync(process.argv[1], "utf8"));
  // 改行を含む値は1行1要素の形で運べない。**黙って壊さずに落とす**
  const usable = [];
  for (let i = 0; i < d.pairs.length; i += 2) {
    const [k, v] = [d.pairs[i], d.pairs[i + 1]];
    if (k.includes("\n") || v.includes("\n")) continue;
    usable.push(k, v);
  }
  process.stdout.write(usable.join("\n"));
' -- "$COPY_PAIRS_FILE")

MULTILINE="$(json_get "$(cat "$COPY_PAIRS_FILE")" \
  'd.pairs.filter((_, i) => i % 2 === 0).filter((k, i) => (d.pairs[i * 2 + 1] || "").includes("\n")).join(" ")')"
[ -z "$MULTILINE" ] || warn "改行を含む値は写せなかった（手で置くこと）: $MULTILINE"

[ "${#COPY_PAIRS[@]}" -ge 2 ] || die '写す変数が1つも無い。railway variable list --service '"$RUNNER_SERVICE"' を見る'

# --- 4. 新しい runner を作る -------------------------------------------------
#
# **順番は setup.sh と同じ。** 変数と Config as Code を先に置いてから source を繋ぐ
# （繋いだ瞬間にデプロイが走りうるので、後から置くと初回が必ず失敗する）

if [ -z "$GIT_REPO" ]; then
  origin="$(git -C "$REPO_ROOT" remote get-url origin 2>/dev/null || true)"
  case "$origin" in
    git@github.com:*) GIT_REPO="${origin#git@github.com:}" ;;
    https://github.com/*) GIT_REPO="${origin#https://github.com/}" ;;
  esac
  GIT_REPO="${GIT_REPO%.git}"
fi
# **既定は release/prod。** 1台だけ main を見ていると、そこだけがマージのたびに畳まれる
# （railway/README.md「デプロイは走行中の仕事を畳む操作である」1）
: "${GIT_BRANCH:=release/prod}"

deploy_failed=0

for idx in "${!NEW_NAMES[@]}"; do
  name="${NEW_NAMES[$idx]}"
  step "runner を足す（${name}）"

  railway add --service "$name" >/dev/null
  svc_id="$(service_id "$name")"
  [ -n "$svc_id" ] || die "$name の id が取れない"
  ok "$name ($svc_id)"

  put_variables "$svc_id" \
    "${COPY_PAIRS[@]}" \
    RAILWAY_RUN_UID 0 \
    ALTEROID_RUNNER_ID "${NEW_IDS[$idx]}"
  ok "変数（記憶ストアの鍵は無い / id=${NEW_IDS[$idx]}）"

  set_config_file "$svc_id" "$RUNNER_CONFIG"
  ok "Config as Code → $RUNNER_CONFIG"

  if railway service source connect --repo "$GIT_REPO" --branch "$GIT_BRANCH" --service "$name" >/dev/null 2>&1; then
    ok "$name ← $GIT_REPO / $GIT_BRANCH"
    ensure_deploy "$name" || deploy_failed=1
    wait_for_deploy "$name" || deploy_failed=1
  else
    warn "$name の GitHub 連携に失敗した（Railway の GitHub App が $GIT_REPO を見えていない）"
    info "  ダッシュボード → $name → Settings → Source で繋ぐか: railway up --service $name --detach"
    deploy_failed=1
  fi
done

# **上がっていない器を app の宛先に載せない。** 載せると、デーモンは起動時から
# 繋がらない宛先へ挑み続ける（名簿は回数で諦めないので永久に続く）。増えた台数の
# ぶんだけ「委譲が置かれない宛先」が並ぶ状態で app を入れ替えることになる
if [ "$deploy_failed" = 1 ]; then
  step '新しい runner が上がっていない'
  warn "$APP_SERVICE の宛先は置き換えていない（いまの構成のまま動いている）"
  info '  ログを見る:'
  for name in "${NEW_NAMES[@]}"; do
    info "    railway logs --service $name"
  done
  info '  直ったら、もう一度このスクリプトを回す（既にある Service は作り直さない）'
  exit 1
fi

# --- 5. app に宛先を教える（ここで初めて app が入れ替わる）-------------------
#
# **もう教えてあるなら触らない。** このスクリプトは「途中で落ちたら回し直す」形で
# 使うものなので（新しい runner が上がらなかったときは app に触らずに終わる）、
# 回し直すたびに app を入れ替えるのでは、直し方そのものが事故になる。
#
# 突き合わせるのは**解決済みの値**である（`railway variable list` は `${{…}}` を
# 展開して返す）。だから「置いた文字列と同じか」では比べられない。台数が合っていて、
# 新しい器の名前が全部その中に見えているなら、教え終わっていると読む。
# **分からないときは置き直す側に倒す**（宛先が足りないまま気づかないほうが高い）。

step "$APP_SERVICE に宛先を教える"

APP_VARS="$(railway variable list --service "$APP_SERVICE" --json 2>/dev/null || true)"
if node -e '
  const vars = JSON.parse(process.argv[1] || "{}");
  const total = Number(process.argv[2]);
  // 空配列を `${arr[@]:-}` で渡すと空文字が1つ来る（bash 3.2 の set -u 対策）
  const names = process.argv.slice(3).filter((n) => n.length > 0);
  const current = String(vars.ALTEROID_RUNNER_URLS ?? "")
    .split(",")
    .map((s) => s.trim())
    .filter((s) => s.length > 0);
  const enough = current.length === total;
  const mentioned = names.every((n) => current.some((url) => url.includes(`${n}.`)));
  // **未解決の参照を「教えてある」と読まない。** `railway variable list` は `${{…}}` を
  // 展開して返すので、ここに `${{` が残っているなら Railway が解決できていない
  // （＝デーモンはその文字列をホスト名として引きに行き、永久に繋がらない）
  const unresolved = current.some((url) => url.includes("${{"));
  process.exit(enough && mentioned && !unresolved ? 0 : 1);
' -- "$APP_VARS" "$TOTAL" "${NEW_NAMES[@]:-}" 2>/dev/null; then
  ok "$APP_SERVICE は既に ${TOTAL} 台を宛先にしている（触らない＝上げ直さない）"
  step 'できた（変えるものが無かった）'
  exit 0
fi

put_variables "$APP_ID" ALTEROID_RUNNER_URLS "$RUNNER_URLS"
ok "ALTEROID_RUNNER_URLS=$RUNNER_URLS"

# **置いたら検算する。** 置いたのは `${{…}}` の参照で、解決するのは Railway である。
# Service 名にハイフンが入る（`runner-2`）ので、**参照が解決される保証は我々の側に無い**。
# 解決されなければデーモンはその文字列をホスト名として引きに行き、名簿は繋がらない
# 相手へ永久に挑み続ける（回数では諦めない）。**症状は「増やしたのに委譲が来ない」
# という沈黙**なので、ここで見ないと器のログを追う作業になる。
#
# 実測（2026-08-21）: `runner-2` / `runner-3` のハイフン入りの参照は解決された。
# **それでもこの検算を置いてある** — 通ったのは「たまたま踏まなかった」側であって、
# 仕組みで保証されたのではない（Railway の解決規則は我々が決めていない）。
APP_VARS_AFTER="$(railway variable list --service "$APP_SERVICE" --json 2>/dev/null || true)"
resolved="$(json_get "$APP_VARS_AFTER" 'd.ALTEROID_RUNNER_URLS || ""')"
case "$resolved" in
  '')
    # 読めないだけなので止めない。**確かめられなかったことは黙らない**
    warn '置いた宛先を読み返せなかった（解決されたかは確かめていない）'
    info "  railway variable list --service $APP_SERVICE --json で ALTEROID_RUNNER_URLS を見る"
    ;;
  *'${{'*)
    die "置いた宛先の変数参照が解決されていない: ${resolved}
    Railway が \${{<Service名>.RAILWAY_PRIVATE_DOMAIN}} を解決できていない（Service 名の形か、名前の食い違い）。
    このままだとデーモンはこの文字列をホスト名として引きに行き、名簿は永久に繋がらない。
    解決済みのホスト名を直に置くこと（各 runner の RAILWAY_PRIVATE_DOMAIN の値）:
      railway variable list --service ${RUNNER_SERVICE}-2 --json | node -e '…RAILWAY_PRIVATE_DOMAIN…'
      railway variable set ALTEROID_RUNNER_URLS=http://…:$RUNNER_PORT,… --service $APP_SERVICE"
    ;;
  *) ok "宛先は解決されている: $resolved" ;;
esac

# 置いただけでは走っているデーモンに届かない（`skipDeploys: true` で置いている）。
# **届かないまま「増えた」と名乗らない**
if railway service redeploy --service "$APP_SERVICE" --yes >/dev/null 2>&1 ||
  railway service redeploy --service "$APP_SERVICE" --from-source --yes >/dev/null 2>&1; then
  ok "$APP_SERVICE を上げ直した"
  wait_for_deploy "$APP_SERVICE" || deploy_failed=1
else
  warn "$APP_SERVICE を上げ直せなかった。**変数は置いたが、走っているデーモンはまだ読んでいない**"
  info "  ダッシュボードから Redeploy するか: railway up --service $APP_SERVICE --detach"
  deploy_failed=1
fi

# --- 6. 確かめる -------------------------------------------------------------

if [ "$deploy_failed" = 1 ]; then
  step '途中まで進んだ'
  exit 1
fi

step 'できた'

cat >&2 <<EOS

    **3台居ることと、id が別々であることを確かめる**（同じ id が並ぶと
    manager_send が黙って別の器へ届く）:

      ./railway/verify.sh

    手で見るなら:

      railway ssh --service $APP_SERVICE
      curl -s http://127.0.0.1:\$ALTEROID_PORT/runners | jq '[.runners[] | {runnerId, state, label}]'

    置き先を指名して確かめる（マネージャーを1本ずつ別の器へ）:

      alteroid chat
      > runner を指名して3台へ1本ずつマネージャーを起こして、それぞれに自分の runner_id を報告させて
EOS

exit 0
