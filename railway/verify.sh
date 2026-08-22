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
# **能力が落ちていないことも確かめる**（境界を入れた側が示す義務。north_star
# 「立ち戻るための問い」最終項）。危なそうな名前を全部消す方向へ倒れると、
# それはデグレードであってセキュリティではない。
set -euo pipefail

APP_SERVICE="${ALTEROID_APP_SERVICE:-app}"
RUNNER_SERVICE="${ALTEROID_RUNNER_SERVICE:-runner}"

usage() {
  cat <<'EOS'
Railway に上がった alteroid の境界と能力を確かめる。

  ./railway/verify.sh [オプション]

  -a, --app <名前>     daemon の Service 名（既定: app）
  -r, --runner <名前>  runner の Service 名（既定: runner。複数回渡せる）
  -h, --help           これ

-r を渡さないと、runner は Railway 側の一覧から数える（runner / runner-2 / …）。
**1台だけ見て済ませない** — 境界は台ごとに立っているものなので、
2台目に鍵が残っていても1台目を見ただけでは「立っている」に見える。

先に railway link でプロジェクトへ紐づいていること（setup.sh は紐づけて終わる）。
EOS
}

# **明示された runner。空なら Railway 側から数える**（下）。人間が名前を数え上げる
# 形にすると、足した1台が見張りの外に出る
RUNNER_SERVICES=()

while [ $# -gt 0 ]; do
  case "$1" in
    -a | --app)
      APP_SERVICE="${2:-}"
      shift 2
      ;;
    -r | --runner)
      RUNNER_SERVICES+=("${2:-}")
      RUNNER_SERVICE="${2:-}"
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

if [ -t 1 ]; then
  C_RESET=$'\033[0m' C_BOLD=$'\033[1m' C_DIM=$'\033[2m'
  C_RED=$'\033[31m' C_GREEN=$'\033[32m' C_YELLOW=$'\033[33m' C_BLUE=$'\033[34m'
else
  C_RESET='' C_BOLD='' C_DIM='' C_RED='' C_GREEN='' C_YELLOW='' C_BLUE=''
fi
readonly C_RESET C_BOLD C_DIM C_RED C_GREEN C_YELLOW C_BLUE

FAILED=0
WARNED=0

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

# --- 見る runner を数える ----------------------------------------------------
#
# **数え上げの持ち主は Railway 側である。** `-r` で明示されたらそれに従うが、
# 何も言われなければ `runner` / `runner-2` / `runner-3` … を Service の一覧から拾う。
# ここを1台に決め打ちすると、**増やした台の境界を一度も見ないまま「立っている」と
# 報告する**（1台目だけを見て通るので、通ったことが証拠にならない）。

if [ "${#RUNNER_SERVICES[@]}" -eq 0 ]; then
  service_list="$(railway service list --json 2>/dev/null || true)"
  found="$(
    printf '%s' "$service_list" | node -e '
      let s = "";
      process.stdin.on("data", (c) => (s += c)).on("end", () => {
        let list = [];
        try {
          list = JSON.parse(s);
        } catch {
          /* 読めなければ既定の1台に落ちる（呼び側が拾う） */
        }
        const base = process.argv[1];
        const names = new Set((Array.isArray(list) ? list : []).map((x) => x.name));
        const out = [];
        for (let i = 1; ; i += 1) {
          const name = i === 1 ? base : `${base}-${i}`;
          if (!names.has(name)) break;
          out.push(name);
        }
        process.stdout.write(out.join("\n"));
      });
    ' -- "$RUNNER_SERVICE" 2>/dev/null || true
  )"
  if [ -n "$found" ]; then
    while IFS= read -r name || [ -n "$name" ]; do
      RUNNER_SERVICES+=("$name")
    done <<EOF
$found
EOF
  else
    # 一覧が読めない（リンクしていない等）。**黙って1台にしない**
    RUNNER_SERVICES=("$RUNNER_SERVICE")
    warn "Service の一覧が読めないので ${RUNNER_SERVICE} だけを見る（他の台は確かめていない）"
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

# **この器が名乗る id。** 未設定なら runner は 'runner-primary' を名乗る（既定値）ので、
# 2台目に置き忘れると**2台が同じ名前を名乗る**。値そのものを出す（秘密ではない）
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

# **全台に同じことを聞く。** 境界は台ごとに立っているものなので、1台の結果を
# 他の台の証拠にしない（`scale-runners.sh` は鍵を写して増やすので、写し間違いは
# 「増やした台だけ守りが無い」という形で出る）
SEEN_RUNNER_IDS=()

for RUNNER_SERVICE in "${RUNNER_SERVICES[@]}"; do
  step "runner の中を見る（${RUNNER_SERVICE}）"
  dim '見るのは env ではなく /proc/1/environ。叩くのは root ではなく uid 1001'

  runner_out="$(railway ssh --service "$RUNNER_SERVICE" -- sh -c "$runner_probe" 2>/dev/null || true)"

  if [ -z "$runner_out" ]; then
    fail "runner に入れなかった（上がっていない / 再起動を繰り返している）"
    dim "railway logs --service $RUNNER_SERVICE"
  else
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

    # **id は台ごとに違わなければならない。** 重複の判定は全台を見終わってから
    # （下の「名前が重ならないか」）。ここでは何を名乗っているかだけ出す
    runner_id="$(field "$runner_out" runner_id)"
    if [ -z "$runner_id" ]; then
      # 未設定は「無い」ではない。runner は既定値を名乗る（runnerIdOf）
      dim 'ALTEROID_RUNNER_ID が無いので runner-primary を名乗る（2台目以降なら重複する）'
      SEEN_RUNNER_IDS+=("runner-primary")
    else
      dim "名乗る id: ${runner_id}"
      SEEN_RUNNER_IDS+=("$runner_id")
    fi

    # --- 能力（落ちていないことの確認）---
    gh_expected=''
    if railway variable list --service "$RUNNER_SERVICE" --json 2>/dev/null |
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
  fi
done

# --- 名前が重ならないか -------------------------------------------------------
#
# **これは3台構成でいちばん静かに壊れるところである。** 同じ `runner_id` を2台が
# 名乗ると、台帳の `manager_id → runner_id` を引く `RunnerRegistry#get` は線形一致で
# **先に見つかった方を黙って返す**（`select({runnerId})` だけは「一意でない」と拒むが、
# `manager_send` / `abort` / `transcript` / `restore` が通るのは `get` である）。
# 名簿は重複を検出しないので、症状は「たまに応答が噛み合わない」だけになる。

if [ "${#SEEN_RUNNER_IDS[@]}" -gt 1 ]; then
  step 'runner の名前が重なっていないか'
  dupes="$(printf '%s\n' "${SEEN_RUNNER_IDS[@]}" | sort | uniq -d | tr '\n' ' ')"
  if [ -n "${dupes// /}" ]; then
    fail "!! 同じ id を名乗る器がある: ${dupes}"
    dim 'manager_send が割り当て先ではない器へ黙って届く。ALTEROID_RUNNER_ID を台ごとに違う値にする'
    dim 'これは運用の間違いだが、名簿が検出しないので実装の穴でもある（M5 PR4 の fencing 待ち）'
  else
    pass "${#SEEN_RUNNER_IDS[@]} 台が別々の id を名乗っている（sticky routing が引ける）"
  fi
fi

# --- app の中を見る ----------------------------------------------------------
#
# 名簿（`GET /runners`）は**認証が要る**（デーモンの API は叩けばクローンのターンが
# 起きる実行の口である）。実行環境の持ち主の資格＝`state/daemon.json` を読めること
# なので、器の中からその token を使って聞く。**token は表に出さない**

app_probe="$(
  cat <<'PROBE'
set -u
port="${ALTEROID_PORT:-4517}"
echo "health=$(curl -s "http://127.0.0.1:$port/health" 2>/dev/null || echo err)"

# 名簿を聞く。**器の中から、持ち主の資格で。** 出すのは台数と id と状態だけ
ALTEROID_STATE_HOME="${ALTEROID_HOME:-/data/alteroid}" ALTEROID_DAEMON_PORT="$port" node -e '
  const fs = require("fs");
  const home = process.env.ALTEROID_STATE_HOME;
  const port = process.env.ALTEROID_DAEMON_PORT;
  let token = "";
  try {
    token = JSON.parse(fs.readFileSync(home + "/state/daemon.json", "utf8")).token;
  } catch {
    process.stdout.write("registry=state_unreadable\n");
    process.exit(0);
  }
  fetch("http://127.0.0.1:" + port + "/runners", {
    headers: { authorization: "Bearer " + token },
  })
    .then(async (r) => {
      if (!r.ok) {
        process.stdout.write("registry=http_" + r.status + "\n");
        return;
      }
      const body = await r.json();
      const runners = Array.isArray(body.runners) ? body.runners : [];
      process.stdout.write("registry_count=" + runners.length + "\n");
      process.stdout.write(
        "registry_ids=" + runners.map((x) => x.runnerId || "(未名乗り)").join(",") + "\n",
      );
      process.stdout.write(
        "registry_states=" +
          runners.map((x) => (x.runnerId || x.label) + ":" + x.state).join(" ") + "\n",
      );
    })
    .catch((e) => process.stdout.write("registry=err_" + String(e && e.message) + "\n"));
' 2>/dev/null || echo registry=node_failed
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

  # --- 名簿（デーモンが実際に何台を宛先にしているか）---
  #
  # **Service が3つ在ることと、デーモンが3台を宛先にしていることは別である。**
  # 宛先は起動時の env（`ALTEROID_RUNNER_URLS`）から作られるので、器を足しただけ
  # では増えない。ここを見ないと「増えた」と「増えたつもり」が区別できない
  registry_count="$(field "$app_out" registry_count)"
  registry_error="$(field "$app_out" registry)"
  if [ -n "$registry_error" ]; then
    warn "名簿を聞けなかった（${registry_error}）"
    dim 'railway ssh --service '"$APP_SERVICE"' して curl で確かめる（README「鍵を回す」）'
  elif [ -z "$registry_count" ]; then
    warn '名簿の応答が読めなかった'
  else
    expected="${#RUNNER_SERVICES[@]}"
    if [ "$registry_count" = "$expected" ]; then
      pass "デーモンは ${registry_count} 台を宛先にしている（Service の数と合っている）"
    else
      fail "!! Service は ${expected} 台あるのに、デーモンの宛先は ${registry_count} 台"
      dim 'app の ALTEROID_RUNNER_URLS を見る。置いても、上げ直すまで走っているデーモンには届かない'
    fi
    dim "名乗り: $(field "$app_out" registry_ids)"
    dim "状態: $(field "$app_out" registry_states)"

    # 名簿の側で重複していないか（器を数えた側とは別の観測である）
    reg_dupes="$(printf '%s\n' "$(field "$app_out" registry_ids)" | tr ',' '\n' |
      sed '/^$/d' | sort | uniq -d | tr '\n' ' ')"
    if [ -n "${reg_dupes// /}" ]; then
      fail "!! 名簿に同じ id が並んでいる: ${reg_dupes}"
      dim 'manager_send が割り当て先ではない器へ黙って届く（RunnerRegistry#get は線形一致）'
    fi

    case "$(field "$app_out" registry_states)" in
      *:unusable*)
        fail '!! unusable な宛先がある（鍵を拒まれている。待っても直らない）'
        dim 'ALTEROID_RUNNER_TOKEN が全 Service で同じ値か見る'
        ;;
      *:lost* | *:unreachable*)
        warn '繋がっていない宛先がある（器の入れ替え中なら収束する。名簿は回数で諦めない）'
        ;;
    esac
  fi
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
  printf '    %s境界は立っていて、能力は落ちていない%s\n' "$C_GREEN" "$C_RESET"
fi

cat <<EOS

    残りは中から確かめる（人が見るしかないもの）:

      railway ssh --service $APP_SERVICE
      alteroid chat
      > 作業ディレクトリで git を叩く仕事をマネージャーへ委譲して

    - 許可確認がクローン経由で /approvals に届き、/answer でその仕事だけが再開すること
    - app を再デプロイしても同じ人格で応答し、走行中だったマネージャーを把握していること
EOS
