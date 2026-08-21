#!/usr/bin/env bash
# 上がったあとに、境界が本当に立っているかと能力が落ちていないかを確かめる。
#
#   ./railway/verify.sh
#
# **思い込みでは確かめない。** 見るのは `env` ではなく `/proc/1/environ` で、叩くのは
# root ではなく uid 1001（＝マネージャーと同じ主体）である。理由は railway/README.md
# 「上がったあとに確かめること」に書いてある:
#
# - `railway ssh` のシェルには Service 変数がそのまま入るので、`env` に素の合鍵が
#   見えるのは当たり前で、守りの証拠にならない。**マネージャーが読みに行く先＝
#   走っているプロセス**を見る
# - 素の `grep` も使わない。`RAILWAY_GIT_COMMIT_MESSAGE` に変数名を含む文章
#   （この README 自身）が入るので、当たって「有る」ように見える。行頭で固定する
# - `railway ssh` はサービスの実行 UID とは無関係に root で入る。root のまま叩いた
#   401 は「マネージャーから叩けない」の証拠にならないので、必ず `su` で降りる
#
# **runner は台数ぶん見る。** 見る相手は名前の付け方ではなく **Config as Code が
# `/railway/runner.json` を指しているか**で決める（`add-runner.sh` と同じ持ち主）。
# 1台だけ見て「境界は立っている」と名乗ると、**後から足した1台が確かめられていない
# ことが出力から消える**。名簿を引けなかったときは、そう書いて `!` を1つ立てる。
#
# **能力が落ちていないことも確かめる**（境界を入れた側が示す義務。north_star
# 「立ち戻るための問い」最終項）。危なそうな名前を全部消す方向へ倒れると、
# それはデグレードであってセキュリティではない。
set -euo pipefail

REPO_ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
readonly REPO_ROOT

# 色・JSON・名簿の引き方は setup.sh / add-runner.sh と共有する
# shellcheck source=railway/lib.sh
. "$REPO_ROOT/railway/lib.sh"

APP_SERVICE="${ALTEROID_APP_SERVICE:-app}"
RUNNER_SERVICES=()

usage() {
  cat <<'EOS'
Railway に上がった alteroid の境界と能力を確かめる。

  ./railway/verify.sh [オプション]

  -a, --app <名前>     daemon の Service 名（既定: app）
  -r, --runner <名前>  runner の Service 名（**繰り返せる**。既定: Config as Code から引く）
  -h, --help           これ

先に railway link でプロジェクトへ紐づいていること（setup.sh は紐づけて終わる）。
EOS
}

while [ $# -gt 0 ]; do
  case "$1" in
    -a | --app)
      APP_SERVICE="${2:-}"
      shift 2
      ;;
    -r | --runner)
      RUNNER_SERVICES+=("${2:-}")
      shift 2
      ;;
    -h | --help)
      usage
      exit 0
      ;;
    *)
      printf 'error 知らないオプション: %s（--help）\n' "$1" >&2
      exit 1
      ;;
  esac
done

FAILED=0
WARNED=0

# **出力は stdout へ**（lib.sh の同名関数は stderr へ出す。ここは読むための出力なので
# 上書きする）。数え上げは下の FAILED / WARNED が持つ
step() { printf '\n%s==>%s %s%s%s\n' "$C_BLUE" "$C_RESET" "$C_BOLD" "$*" "$C_RESET"; }
dim() { printf '    %s%s%s\n' "$C_DIM" "$*" "$C_RESET"; }
pass() { printf '    %s✓%s %s\n' "$C_GREEN" "$C_RESET" "$*"; }
fail() {
  printf '    %s✗%s %s\n' "$C_RED" "$C_RESET" "$*"
  FAILED=$((FAILED + 1))
}
warn() {
  printf '    %s!%s %s\n' "$C_YELLOW" "$C_RESET" "$*"
  WARNED=$((WARNED + 1))
}

command -v railway >/dev/null 2>&1 || {
  printf 'error railway が無い\n' >&2
  exit 1
}

# probe の出力（`key=value` の行）から1つ取る
field() { # <出力> <キー>
  printf '%s\n' "$1" | sed -n "s/^$2=//p" | tail -n1
}

# --- 見る相手を決める（役は Config as Code が持つ）---------------------------

if [ "${#RUNNER_SERVICES[@]}" -eq 0 ]; then
  step 'runner の名簿を引く'
  discovered=''
  if resolve_project; then
    discovered="$(services_with_config "$RUNNER_CONFIG")"
  fi
  while IFS= read -r name; do
    [ -n "$name" ] && RUNNER_SERVICES+=("$name")
  done <<EOF
$discovered
EOF
  if [ "${#RUNNER_SERVICES[@]}" -eq 0 ]; then
    # **「1台だった」と「引けなかった」を同じ顔にしない。** 引けなかったのに
    # 既定の1台だけ見て緑を返すと、足した台が確かめられていないことが消える
    RUNNER_SERVICES=("${ALTEROID_RUNNER_SERVICE:-runner}")
    warn "名簿を引けなかったので既定の1台だけ見る（${RUNNER_SERVICES[0]}）。railway link と Config as Code を見る"
  else
    pass "runner ${#RUNNER_SERVICES[@]} 台: ${RUNNER_SERVICES[*]}"
  fi
fi

# --- runner の中を見る -------------------------------------------------------

# **すべて1回の ssh で済ませる。** 何度も入り直すと、器が入れ替わる瞬間に
# 半分だけ古い器を見た結果が混ざる
runner_probe="$(
  cat <<'PROBE'
set -u
port="${ALTEROID_RUNNER_PORT:-4518}"
e() { tr '\0' '\n' < /proc/1/environ; }
has() { e | grep -qE "^$1="; }

has ALTEROID_DATABASE_URL        && echo db_key=present      || echo db_key=absent
has ALTEROID_RUNNER_TOKEN        && echo raw_token=present   || echo raw_token=absent
has ALTEROID_RUNNER_TOKEN_SHA256 && echo sha256=present      || echo sha256=absent
has ALTEROID_GOOGLE_CLIENT_SECRET && echo google=present     || echo google=absent
has GH_TOKEN                     && echo gh_token=present    || echo gh_token=absent

# **走っているプロセスが名乗る id を見る**（変数一覧ではなく）。器の既定は runner-primary
echo "runner_id=$(e | sed -n 's/^ALTEROID_RUNNER_ID=//p' | tail -n1)"

# マネージャーと同じ主体（uid 1001）から制御面を叩く。root で通っても意味がない
echo "control=$(su -s /bin/sh worker -c "curl -s -o /dev/null -w %{http_code} http://127.0.0.1:$port/managers" 2>/dev/null || echo err)"
echo "livez=$(su -s /bin/sh worker -c "curl -s http://127.0.0.1:$port/livez" 2>/dev/null || echo err)"

# Railway では runner から db が名前解決できてしまう（compose との差。README「先に読む」2）
getent hosts postgres.railway.internal >/dev/null 2>&1 && echo db_dns=resolvable || echo db_dns=no

# 能力: マネージャーと同じ主体で gh が通るか
if has GH_TOKEN; then
  su -s /bin/sh worker -c 'gh auth status' >/dev/null 2>&1 && echo gh_auth=ok || echo gh_auth=fail
fi
PROBE
)"

# 台ごとの runner_id を溜める（重複の検出に使う。持ち主はこの1か所）
SEEN_IDS=''

for runner_service in "${RUNNER_SERVICES[@]}"; do
  step "runner の中を見る（${runner_service}）"
  dim '見るのは env ではなく /proc/1/environ。叩くのは root ではなく uid 1001'

  runner_out="$(railway ssh --service "$runner_service" -- sh -c "$runner_probe" 2>/dev/null || true)"

  if [ -z "$runner_out" ]; then
    fail "runner に入れなかった（上がっていない / 再起動を繰り返している）"
    dim "railway logs --service $runner_service"
    continue
  fi

  case "$(field "$runner_out" db_key)" in
    absent) pass '記憶ストアの鍵が無い（ALTEROID_DATABASE_URL）' ;;
    *) fail '!! 記憶ストアの鍵がある。runner の中のマネージャーが記憶へ届く' ;;
  esac

  case "$(field "$runner_out" raw_token)" in
    absent) pass '素の合鍵が残っていない（起動時に sha256 へ畳めている）' ;;
    *)
      fail '!! 素の合鍵が残っている。子プロセスが /proc/1/environ から読める'
      dim 'startCommand が alteroid-runner か見る（node を直に叩くと畳みが起きない）'
      dim 'これは運用の間違いではなく実装のバグとして扱う'
      ;;
  esac

  case "$(field "$runner_out" sha256)" in
    present) pass '合鍵の sha256 はある（制御面は認証できる）' ;;
    *) fail 'sha256 が無い。ALTEROID_RUNNER_TOKEN が runner に渡っていない' ;;
  esac

  case "$(field "$runner_out" google)" in
    absent) pass '入口の認証の鍵が残っていない（記憶へ到達する鍵は落ちている）' ;;
    *) fail '!! ALTEROID_GOOGLE_CLIENT_SECRET が残っている。自分でトークンを発行できる' ;;
  esac

  # **同じ runner_id を名乗る2台が並ぶと、`RunnerRegistry#get` は先に見つかった方を
  # 返す**（線形一致。docs/roadmap.md M5、#106 の申し送り）。委譲した先とは別の器へ
  # `manager_send` が届き、しかも届いているように見える — 気づく場所がここしか無い
  runner_id="$(field "$runner_out" runner_id)"
  : "${runner_id:=runner-primary}"
  if printf '%s\n' "$SEEN_IDS" | grep -qxF "$runner_id"; then
    fail "!! runner_id ${runner_id} を2台が名乗っている。委譲した先とは別の器へ命令が届く"
  else
    pass "runner_id は ${runner_id}（他の台とぶつかっていない）"
  fi
  SEEN_IDS="$(printf '%s\n%s' "$SEEN_IDS" "$runner_id")"

  control="$(field "$runner_out" control)"
  case "$control" in
    401 | 403) pass "uid 1001 から制御面は ${control}（自分宛の許可確認に自分で答えられない）" ;;
    err) warn '制御面を叩けなかった（curl が無い / 器が入れ替わり中）' ;;
    *) fail "!! uid 1001 から制御面が ${control}。マネージャーが自分に allow を返せる" ;;
  esac

  livez="$(field "$runner_out" livez)"
  case "$livez" in
    *'"ok":true'*) pass '/livez は鍵なしで通る（生存確認だけは開けてある）' ;;
    *) warn "/livez が想定と違う: ${livez:-（無応答）}" ;;
  esac

  case "$(field "$runner_out" db_dns)" in
    resolvable) dim 'db は名前解決できる（Railway では経路は在り、鍵が無い。README「先に読む」2）' ;;
    *) dim 'db は名前解決できない（compose と同じ強さ）' ;;
  esac

  # --- 能力（落ちていないことの確認）---
  gh_expected=''
  if railway variable list --service "$runner_service" --json 2>/dev/null |
    node -e '
      let s = ""; process.stdin.on("data", c => (s += c)).on("end", () => {
        try { process.exit(Object.keys(JSON.parse(s)).includes("GH_TOKEN") ? 0 : 1); }
        catch { process.exit(1); }
      });
    '; then
    gh_expected=yes
  fi

  case "$(field "$runner_out" gh_token)" in
    present)
      case "$(field "$runner_out" gh_auth)" in
        ok) pass 'GH_TOKEN が届いていて gh も通る（PR を出せる）' ;;
        *) fail 'GH_TOKEN はあるが gh auth status が通らない。PAT の期限か権限を見る' ;;
      esac
      ;;
    *)
      if [ "$gh_expected" = yes ]; then
        fail '!! GH_TOKEN を置いたのに走っている runner に無い。下へ手を伸ばす鍵を伏せている（デグレード）'
      else
        dim 'GH_TOKEN は置いていない（公開リポジトリの clone だけできる）'
      fi
      ;;
  esac
done

# --- app の中を見る ----------------------------------------------------------

app_probe="$(
  cat <<'PROBE'
set -u
port="${ALTEROID_PORT:-4517}"
echo "health=$(curl -s "http://127.0.0.1:$port/health" 2>/dev/null || echo err)"
# 起動時の種。**台数はここで数える**（名簿そのものは /runners が持つが、そちらは認証が要る）
echo "seeds=$(printf '%s,%s' "${ALTEROID_RUNNER_URLS:-}" "${ALTEROID_RUNNER_URL:-}" | tr ',' '\n' | sed '/^$/d' | sort -u | wc -l | tr -d ' ')"
PROBE
)"

step "app の中を見る（${APP_SERVICE}）"

app_out="$(railway ssh --service "$APP_SERVICE" -- sh -c "$app_probe" 2>/dev/null || true)"
health="$(field "$app_out" health)"

if [ -z "$app_out" ]; then
  fail "app に入れなかった（上がっていない / 再起動を繰り返している）"
  dim "railway logs --service $APP_SERVICE"
elif [ -z "$health" ] || [ "$health" = err ]; then
  fail 'デーモンが応答しない。runner を待って listen を開いていない可能性がある'
  dim "railway logs --service $APP_SERVICE"
else
  case "$health" in
    *'"ok":true'*) pass 'デーモンが応答している' ;;
    *) fail "デーモンの応答が想定と違う: $health" ;;
  esac

  case "$health" in
    *PostgreSQL*) pass '記憶は PostgreSQL（器が違っても上の層が見るものは同じ）' ;;
    *) warn '記憶が PostgreSQL ではない。app の ALTEROID_DATABASE_URL を見る' ;;
  esac

  case "$health" in
    *'"enabled":true'*)
      pass '入口の認証が有効（外から叩ける口に境界が立っている）'
      dim 'ログインしただけでは使えない: alteroid access list → access grant <id>'
      ;;
    *) dim '入口の認証は無効（待ち受けが 127.0.0.1 なら、境界は待ち受け先の側にある）' ;;
  esac

  # **足した runner が「走っている app」に届いているか。** 変数を置いただけでは
  # 走っているデーモンには入らない（器の環境変数は起動時に決まる）ので、
  # ここがずれていたら app の再デプロイが済んでいない
  seeds="$(field "$app_out" seeds)"
  case "$seeds" in
    '' | *[!0-9]*) warn "app の委譲先の数が読めなかった（seeds=${seeds:-（空）}）" ;;
    *)
      if [ "$seeds" -eq "${#RUNNER_SERVICES[@]}" ]; then
        pass "app は runner を ${seeds} 台知っている（見た台数と同じ）"
      elif [ "$seeds" -lt "${#RUNNER_SERVICES[@]}" ]; then
        fail "app が知っている委譲先は ${seeds} 台だが、runner は ${#RUNNER_SERVICES[@]} 台ある。app の再デプロイが済んでいない（railway service redeploy --service $APP_SERVICE --yes）"
      else
        warn "app が知っている委譲先は ${seeds} 台で、見た runner（${#RUNNER_SERVICES[@]} 台）より多い。消した Service が名簿に残っていないか見る"
      fi
      ;;
  esac
fi

# --- まとめ ------------------------------------------------------------------

step 'まとめ'

if [ "$FAILED" -gt 0 ]; then
  printf '    %s%d 件が通らなかった%s（! は %d 件）\n' "$C_RED" "$FAILED" "$C_RESET" "$WARNED"
  printf '    %s\n' '「!!」が出たものは運用の間違いではなく実装のバグとして扱う（railway/README.md）'
  exit 1
fi

if [ "$WARNED" -gt 0 ]; then
  printf '    %s通った（確かめられなかったものが %d 件）%s\n' "$C_YELLOW" "$WARNED" "$C_RESET"
else
  printf '    %s境界は立っていて、能力は落ちていない（runner %d 台）%s\n' \
    "$C_GREEN" "${#RUNNER_SERVICES[@]}" "$C_RESET"
fi

cat <<EOS

    残りは中から確かめる（人が見るしかないもの）:

      railway ssh --service $APP_SERVICE
      alteroid chat
      > 作業ディレクトリで git を叩く仕事をマネージャーへ委譲して

    - 許可確認がクローン経由で /approvals に届き、/answer でその仕事だけが再開すること
    - app を再デプロイしても同じ人格で応答し、走行中だったマネージャーを把握していること
    - runner が2台以上あるなら、委譲が両方へ配られること（GET /runners と /managers）
EOS
