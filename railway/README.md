# Railway へ常駐させる

compose.yaml のコンテナ構成（daemon / manager-runner / PostgreSQL）を、そのまま Railway の Service に写した運用手順である。ここに**要件は書かない** — 正典は [docs/](../docs/) であり、この文書は「どう置くか」だけを扱う。

まずは **runner 1台**（M4 と同じ形）で上げ、必要になったら [runner を増やす](#runner-を増やすm5)。**増やしても能力もプロトコルも変わらない**（roadmap M5 のゴール）ので、1台で上げてから足すのが安全である。

---

## 先に読む — compose と何が違うか

Railway の実行環境の性質で、境界が2か所ゆるむ。**どちらも能力の削減ではないが、黙って進めてよい話でもない**ので先に書く。

### 1. 制御面が Unix ソケットから TCP になる

Railway はサービス間でボリュームを共有できないので、共有 volume 上のソケット（`/run/alteroid/runner.sock`）が置けない。runner の制御面を守る4枚のうち2枚が消える。

| 守り                           | compose | Railway                                    |
| ------------------------------ | ------- | ------------------------------------------ |
| runner は TCP を開かない       | ○       | **×**（private network 越しに TCP で待つ） |
| ソケットは 0600・デーモン所有  | ○       | **×**（ソケットが無い）                    |
| 合鍵は runner にはハッシュだけ | ○       | ○                                          |
| SDK 子プロセスは別 UID（1001） | ○       | ○                                          |

残る2枚で M4 受け入れ基準4（**マネージャーが自分宛の許可確認に自分で `allow` を返せない**）は構造的に保たれる。制御面の全経路が `Bearer` を要求し（`apps/runner/src/app.ts` の `control`）、runner が持つのは sha256 だけなので、`/proc/1/environ` を読めても鍵は作れない。

→ **`ALTEROID_RUNNER_TOKEN`（素の合鍵）を Shared Variables に置かないこと。** 置いた瞬間に runner にも降り、残った2枚のうち1枚が0枚になる。Service ごとの変数に置く。

### 2. ネットワークが1枚になる

compose の `data`（daemon↔db）/ `control`（daemon↔runner）の分離が Railway には無い。`*.railway.internal` は環境ごとにフラットなので、**runner から db が名前解決できてしまう**。

M4 受け入れ基準3の「runner から Persona 用 DB へ接続できない」が、compose の「**経路が無い**」から Railway では「**資格情報を配っていない**」に弱まる。`ALTEROID_DATABASE_URL` は daemon の Service 変数にだけ置く（ここも Shared Variables 禁止）。

### 3. workspace は毎デプロイで消える

**ボリュームを付けない。** roadmap M5「workspace locator の運用選択（runner-volume / 共有 FS / Git 再構築）」のうち **Git 再構築**を採る、という運用判断である。人間がやることと同じで、マネージャーの作業は git へ push されて初めて残る。

その代わり、次の2つが毎デプロイで消える。

- マネージャーの作業ディレクトリ（コミットしていない変更は失われる）
- `/workspace/.mcp.json`（＝MCP 連携）

MCP を渡したいなら、`/workspace` にボリュームを付けて所有者を uid 1001 に揃えるか、設定をイメージへ焼く。**「Railway だから MCP が使えない」は仕様ではなくバグ**なので、必要になった時点でどちらかを選ぶ（north_star 禁止1）。

記憶・日誌・ジョブ・生ログは PostgreSQL にあるので、**ボリュームは1つも要らない**。`ALTEROID_HOME`（`/data/alteroid`）に残るのは `state/daemon.json` と `daemon.log` だけで、これは CLI がデーモンを見つける手段であって記憶ではない。

---

## 手順

### 0. 用意するもの

```bash
npm i -g @railway/cli
railway login

# クローンとマネージャーの認証（サブスクリプションの長期トークン）
claude setup-token          # → CLAUDE_CODE_OAUTH_TOKEN

# 制御面の合鍵。素の値は daemon にだけ、sha256 は runner にだけ置く
TOKEN=$(openssl rand -hex 32)
echo "raw   : $TOKEN"
echo "sha256: $(printf %s "$TOKEN" | shasum -a 256 | cut -d' ' -f1)"
```

### 1. プロジェクトと PostgreSQL

```bash
railway init -n alteroid
railway add --database postgres
```

### 2. Service を2つ作る（同じリポジトリから）

ダッシュボードで GitHub リポジトリを2回追加し、名前を **`app`** と **`runner`** にする（`ALTEROID_RUNNER_URLS` がこの名前を参照する）。それぞれ **Settings → Config as Code** に次を指定する。

| Service  | Config as Code         |
| -------- | ---------------------- |
| `app`    | `/railway/daemon.json` |
| `runner` | `/railway/runner.json` |

Config as Code のパスは Root Directory を見ないので、**リポジトリ先頭からの絶対パス**で書く。同じ `Dockerfile` から `startCommand` で役を選ぶ（compose の `command` と同じ考え方）。

### 3. 変数（Shared Variables は使わない）

**`runner`**

| 変数                           | 値                        | なぜ                                                                                                                                                                                                                       |
| ------------------------------ | ------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `RAILWAY_RUN_UID`              | `0`                       | イメージの `USER node` のままだと子プロセスを uid 1001 へ降ろす特権が無く、runner は**起動を拒否する**（同じ UID で走り続けるより落ちる方を選んである）。root なのは権限を配るためではなく、降ろすのに特権が要るからである |
| `ALTEROID_RUNNER_BIND`         | `::`                      | Railway の private network は IPv6（新しい環境は dual stack）。既定の `127.0.0.1` のままだと daemon から届かない                                                                                                           |
| `ALTEROID_RUNNER_PORT`         | `4518`                    |                                                                                                                                                                                                                            |
| `ALTEROID_RUNNER_ID`           | `runner-primary`          | 台帳の `manager_id → runner_id` を引く安定した識別子。器を作り直しても同じ宛先として戻る                                                                                                                                   |
| `ALTEROID_RUNNER_TOKEN_SHA256` | 上の sha256               | **ハッシュだけ。** 素の値をここに置かない                                                                                                                                                                                  |
| `CLAUDE_CODE_OAUTH_TOKEN`      | `claude setup-token` の値 | マネージャーと作業者の認証                                                                                                                                                                                                 |
| `TZ`                           | `Asia/Tokyo`              |                                                                                                                                                                                                                            |

**`app`**

| 変数                        | 値                                               | なぜ                                                                                                                                         |
| --------------------------- | ------------------------------------------------ | -------------------------------------------------------------------------------------------------------------------------------------------- |
| `ALTEROID_DATABASE_URL`     | `${{Postgres.DATABASE_URL}}`                     | private の接続文字列（`postgres.railway.internal`）。`DATABASE_PUBLIC_URL` は公衆網に出るので使わない                                        |
| `ALTEROID_RUNNER_URLS`      | `http://${{runner.RAILWAY_PRIVATE_DOMAIN}}:4518` | 委譲先の名簿（カンマ区切りで何台でも）。固定 URL をコードに埋めず、ここで登録する。private network は Wireguard で暗号化済みなので `http://` |
| `ALTEROID_RUNNER_TOKEN`     | 素の `$TOKEN`                                    | **素の値を持つのは daemon だけ**                                                                                                             |
| `CLAUDE_CODE_OAUTH_TOKEN`   | `claude setup-token` の値                        | クローンも SDK セッションなので要る                                                                                                          |
| `ALTEROID_DAILY_REPORT_AT`  | `22:00`                                          | 省略しても既定で動く（自律は後から足す機能ではない）                                                                                         |
| `ALTEROID_INITIATIVE_EVERY` | `60`                                             | 同上（分）                                                                                                                                   |
| `TZ`                        | `Asia/Tokyo`                                     | 日報の締め時刻がこれで決まる                                                                                                                 |

**置かないもの**

- `ALTEROID_BIND` — デーモンの API は**叩けばクローンのターンが起きる実行の口**で、認証が無い。127.0.0.1 のままにする
- public domain（Generate Domain）— 上と同じ理由。外から使いたくなったら、手前に境界（認証・トンネル・リバースプロキシ）を置くのが先

**置いたら必ず名前を検算する。** ダッシュボードへ貼るときに前後の空白が混ざると、Railway は `RAILWAY_RUN_UID` と ` RAILWAY_RUN_UID` を**別の変数として保存する**。後者は誰も読まないので「設定したのに効かない」になる。

```bash
railway variable list --service runner --json | python3 -c "import json,sys; [print(repr(k)) for k in json.load(sys.stdin)]"
```

`' RAILWAY_RUN_UID'` のように引用符の内側に空白が見えたら消して置き直す（`railway variable delete " RAILWAY_RUN_UID" --service runner`）。

### 4. デプロイ

**`runner` を先に上げる。** daemon は起動時に runner の `/health` へ名乗りを聞きに行き、繋がらなければ落ちる（鍵無しで繋ぐくらいなら起動しない設計）。`restartPolicyType: ALWAYS` なので放っておいても収束するが、順番どおりなら1回で上がる。

GitHub 連携で作った Service は push で自動デプロイされる。初回だけダッシュボードから `runner` → `app` の順に Deploy を押す（以後は両方が同時に上がり直し、daemon が1〜2回再起動して収束する）。

```bash
railway logs --service runner
railway logs --service app
```

ローカルから直に上げるなら `railway up --service runner --detach` → `railway up --service app --detach`。

`app` のログにこれが出れば上がっている。

```
alteroidd: http://127.0.0.1:4517 （記憶: PostgreSQL（postgres.railway.internal:5432/railway） / 作業: /workspace）
```

### 5. 使う

CLI はデーモンを `$ALTEROID_HOME/state/daemon.json` 経由で `127.0.0.1` に見に行く。**リモートのデーモンを指す手段は無い**（意図的）ので、同じコンテナの中から使う。

```bash
railway ssh --service app
alteroid chat
```

chat の中で使えるもの:

| 入力                                         | 何が起きるか                                                         |
| -------------------------------------------- | -------------------------------------------------------------------- |
| `/approvals` → `/answer <番号> <回答>`       | 溜まった承認待ちを処理する。**人間の不在で止まってよいのはこれだけ** |
| `/managers` / `/manager <id>`                | 委譲の一覧と生ログ                                                   |
| `/report` / `/reports`                       | 日報                                                                 |
| `/run daily_report` / `/run self_initiative` | 時間起点を待たずに起こす                                             |
| `/event <source> <本文>`                     | 外部イベント起点を手で叩く                                           |

### 6. 上がったあとに確かめること

境界が本当に立っているかは、思い込みではなく runner の中から確かめる。**素の `grep` は使わない** — `RAILWAY_GIT_COMMIT_MESSAGE` にこの文書の一部が入るので、変数名を含む文章に当たって「有る」ように見える。行頭で固定する。

```bash
railway ssh --service runner -- sh -lc '
env | grep -qE "^ALTEROID_DATABASE_URL=" && echo "!! DB の鍵がある" || echo "DB の鍵は無い"
env | grep -qE "^ALTEROID_RUNNER_TOKEN="  && echo "!! 素の合鍵がある" || echo "素の合鍵は無い（sha256 だけ）"

# uid 1001（マネージャーと同じ主体）から制御面 → 401 であること
su -s /bin/sh worker -c "curl -s -o /dev/null -w %{http_code}\\\\n http://127.0.0.1:4518/managers"

# 生存確認だけは鍵なしで通る（制御面の情報は返さない）
su -s /bin/sh worker -c "curl -s http://127.0.0.1:4518/livez"
'
```

実測（2026-08）: 制御面は **401**、`/livez` は `{"ok":true}`、runner の環境変数は `ALTEROID_RUNNER_TOKEN_SHA256` だけで素の合鍵と `ALTEROID_DATABASE_URL` は無い。つまり M4 受け入れ基準4は Railway でも成立している。

いっぽう `getent hosts postgres.railway.internal` は `fd12:…` を返す（＝「先に読む」2の弱まりが実測でも出る）。db へ届く経路はあるが、鍵が無い。

`railway ssh` は**サービスの実行 UID とは無関係に root で入る**（`RAILWAY_RUN_UID` を設定していない `app` でも `uid=0`）。だから上のように `su` で降りてから叩くこと。root のまま叩いた 401 は「マネージャーから叩けない」の証拠にならない。

能力が落ちていないことも確かめる（境界を入れた側が示す義務。north_star「立ち戻るための問い」最終項）。

- `alteroid chat` でマネージャーへ委譲し、git を叩く作業が完遂すること
- 許可確認がクローン経由で `/approvals` に届き、`/answer` で**その仕事だけ**が再開すること
- `app` を再デプロイしても同じ人格で応答し、走行中だったマネージャーを把握していること

---

## runner を増やす（M5）

**足すのは Service と変数だけである。** コードもプロトコルも変わらない — デーモンは名簿（`RunnerRegistry`）しか見ておらず、宛先が1つか3つかを知らない。

### 1. Service をもう1つ作る

同じリポジトリから Service を追加し、**`runner-2`** という名前にする。Config as Code は `/railway/runner.json`（1台目と同じ）。変数は1台目と同じものを置き、**`ALTEROID_RUNNER_ID` だけを変える**。

| 変数                           | `runner`         | `runner-2` | なぜ                                                                                           |
| ------------------------------ | ---------------- | ---------- | ---------------------------------------------------------------------------------------------- |
| `ALTEROID_RUNNER_ID`           | `runner-primary` | `runner-2` | **器ごとに違う値**。台帳の `manager_id → runner_id` はこれで引くので、被ると宛先が壊れる       |
| `ALTEROID_RUNNER_TOKEN_SHA256` | 同じ             | 同じ       | 制御面の本人確認は「デーモンかどうか」の判定であって、器を区別するためのものではない           |
| `ALTEROID_RUNNER_LEASE_TTL`    | `30`（既定）     | 同じ       | **器が自分でセッションを畳むまでの秒数。移送の安全はここが根拠である**（下の「3.5」）          |
| `ALTEROID_RUNNER_LEASE_GRACE`  | `5`（既定）      | 同じ       | 期限切れから**畳み終わる**までに要りうる秒数。デーモンはこのぶんも待ってから移送する           |
| `RAILWAY_RUN_UID`              | `0`              | `0`        | 子プロセスを uid 1001 へ降ろす特権（無いと runner は起動を拒む）                               |
| `ALTEROID_RUNNER_BIND`         | `::`             | `::`       | Railway の private network（IPv6）                                                             |
| `ALTEROID_RUNNER_PORT`         | `4518`           | `4518`     | Service ごとに別ホストなので、同じ番号でよい                                                   |
| `CLAUDE_CODE_OAUTH_TOKEN`      | 同じ             | 同じ       | マネージャーと作業者の認証                                                                     |
| `GH_TOKEN` / `GIT_*`           | 同じ             | 同じ       | どの器へ置かれたマネージャーも同じことができなければならない（**片方だけに置くとデグレード**） |

### 2. daemon に宛先を並べる

```bash
railway variable set \
  'ALTEROID_RUNNER_URLS=http://${{runner.RAILWAY_PRIVATE_DOMAIN}}:4518,http://${{runner-2.RAILWAY_PRIVATE_DOMAIN}}:4518' \
  --service app
```

**1台が落ちていても daemon は上がる**（複数構成では、名乗りを返さない器は名簿に載ったまま生存確認の対象になり、返るようになった時点で使われる）。全部が返らないときだけ起動を止める。

### 3. workspace の運用を選ぶ（増やすなら必須）

Railway はボリュームを付けていないので（「先に読む」3）、器が落ちた委譲の作業ディレクトリは**その器と一緒に消える**。2台以上で運用するなら、**git 再構築**を選ぶ。

```bash
railway variable set ALTEROID_WORKSPACE_KIND=git --service app
railway variable set ALTEROID_WORKSPACE_REPOSITORY=https://github.com/<owner>/<repo> --service app
railway variable set ALTEROID_WORKSPACE_REF=main --service app
```

これを置かないと（既定の `runner-volume`）、器が落ちた委譲は別の器へ移せない。**移せないこと自体は黙って起きない** — 「セッションは預かってあるが、コミットしていない変更は復旧できない」という報告がクローンの受信箱へ届き、そこから人間へ回る（roadmap M5 受け入れ基準4 の後段）。それでも作業は戻らないので、先に選んでおくこと。

### 3.5 貸し出し期限を確かめる（移送の安全はここが根拠）

**「器へ届かない」ことは「器が止まっている」ことではない。** ネットワークだけが切れて、マネージャーはその器で走り続けていることがある。そこで同じ session を別の器で開けば、**1つの仕事が2か所で動く** — 同じリポジトリへの二重 push、`gh pr create` の二重実行、Slack への二重投稿。デーモン側の排他は別の器で走っている1本を止められない。

そこで器の側が降りる。`ALTEROID_RUNNER_LEASE_TTL`（秒。既定 30 / `off` で無効）のあいだデーモンから `GET /health` が届かなければ、runner は**自分で**走行中のセッションを畳む。デーモンはこの約束を根拠に、最後の名乗りから期限＋余裕を過ぎたときだけ別の器で開き直す。

```bash
railway ssh --service app
curl -s http://${RUNNER_HOST}:4518/health -H "authorization: Bearer $ALTEROID_RUNNER_TOKEN" | jq .lease
# => { "ttlMs": 30000, "graceMs": 5000, "incarnation": "..." }
#    これが出ない器の仕事は、自動では移らない
```

3つとも意味がある。

- `ttlMs` — この時間名乗りを聞かれなければ、器は畳み**始める**
- `graceMs` — 畳み**終わる**までの上限。デーモンは `ttlMs + graceMs` ＋自分の余裕を過ぎてから移送する。**申告ではなく約束である** — この時間内に畳み終わらなければ、runner は器ごと終了する（コンテナなので中の SDK 子プロセスも一緒に消え、約束が守られる。オーケストレータが起こし直す）
- `incarnation` — 器の**この起動**を指す id。`runner_id` は器を作り直しても同じ名前で戻るので、これが無いと、ローリング更新で入れ替わった新しい器の応答を、分断されたまま走り続けている古い器の応答と取り違える

デーモンは**その仕事を置いた起動について観測したもの**（最後に見た時刻と、そのとき名乗っていた `ttlMs` / `graceMs`）だけで期限を数える。だから期限を短くする変更を入れても、その前から走っている仕事は**古い設定のまま**待たれる。観測が無い起動（このデーモンが一度も見ていない）については自動で移さず、`manager_move` の確認へ回る。

`off` にした器（と、この版より古い器）は「畳まない器」として扱われ、その仕事は自動では移らない。落ちたときは「元の器が止まっているかを確かめられない」という報告がクローンの受信箱へ届き、確かめた上で `manager_move`（chat では `/move <id> force`）で引き取る形になる。**黙って二重に走らせるよりは止める**、という選択である。

これは能力の制限ではない（north_star 禁止2）。ターン数や実行回数のような人工上限ではなく、「デーモンに繋がっていない器はセッションを持ち続けない」という実行環境の境界である。

### 4. 確かめる

```bash
railway ssh --service app
alteroid chat
> /runners     # 2台とも「生存」で、CPU・メモリ・走行中の本数が出る
> /managers    # 各マネージャーの runner が出る（宛先は台帳から引かれる）
```

`GET /runners` でも同じものが読める。**`capacity` は実測であって定員ではない** — 空きが少ないことは「もう頼めない」を意味しない（配置の材料。人工上限はどの層にも無い）。

片方の Service を Stop すると、そこに居た走行中の委譲が別の器で開き直り、クローンの受信箱へ「移した」報告が届く（`git` 運用なら clone し直しの指示つき）。**すぐには移らない** — 止めた器が自分でセッションを畳む期限（既定 30 秒）＋余裕を待ってから移る。待っているあいだも受信箱には「あと何秒で置き直す」が届くので、黙って止まっているわけではない。

### 他のオーケストレータ（ECS / Fargate 等）へ写すとき

守るのは4つだけで、あとは器の話である。

1. **器ごとに違う `ALTEROID_RUNNER_ID`** を渡す（台帳の宛先。被らせない・使い回さない）
2. **全 runner の宛先を daemon の `ALTEROID_RUNNER_URLS` に並べる**（合鍵の sha256 は全器で同じ）
3. **記憶ストアの鍵を runner へ渡さない**（`ALTEROID_DATABASE_URL` は daemon だけ。素の合鍵も daemon だけ）
4. **workspace の運用を選ぶ**（`ALTEROID_WORKSPACE_KIND`）。共有 FS を全器へ同じパスでマウントするか、git 再構築にする

**いまの登録は静的である。** 名簿は起動時に `ALTEROID_RUNNER_URLS` から作られるので、オートスケールで器が増えても daemon は勝手には見つけない（`RunnerRegistry.register` は動的登録を受けられる形にしてあるが、サービス発見の口はまだ無い）。台数を変えたら daemon の変数を更新して上げ直す。**これは制限ではなく未実装**であり、必要になったら発見の口を足す側で直す。

---

## マネージャーに GitHub を渡す（PR を出させる）

クローンに「実装して PR を出して」と頼むには、マネージャーの手元に**人間が Claude Code に渡しているものと同じ**3つが揃っている必要がある。

| 要るもの       | 置き場                       | 状態                                                                                  |
| -------------- | ---------------------------- | ------------------------------------------------------------------------------------- |
| `gh` コマンド  | イメージ（`Dockerfile`）     | 同梱済み（版は固定しない。ビルドし直せば上がる）。git の credential helper も配線済み |
| 書き込みの鍵   | **`runner` の Service 変数** | `GH_TOKEN` を置く（下記）                                                             |
| コミットの身元 | **`runner` の Service 変数** | `GIT_AUTHOR_*` / `GIT_COMMITTER_*` を置く（下記）                                     |

**daemon 側には置かない。** これはクローンの鍵ではなく**マネージャー自身の道具の鍵**である（クローンの道具はマネージャーであって git ではない）。記憶ストアの鍵と逆で、下へ渡すのが正しい。

### 鍵を作る

GitHub → Settings → Developer settings → Personal access tokens → **Fine-grained tokens**

| 項目              | 値                                            |
| ----------------- | --------------------------------------------- |
| Repository access | Only select repositories → 対象リポジトリだけ |
| Contents          | Read and write（clone / push）                |
| Pull requests     | Read and write（`gh pr create`）              |
| Metadata          | Read-only（自動で付く）                       |
| Expiration        | 切る。無期限にしない                          |

公開リポジトリなら clone だけは鍵なしで通る。**push と PR 作成に要る**のがこの鍵である。

### 置く

```bash
# 鍵は stdin から。引数で渡すとシェル履歴とプロセス一覧に残る
printf %s 'github_pat_xxx' | railway variable set GH_TOKEN --stdin --service runner --skip-deploys

railway variable set GIT_AUTHOR_NAME=takecchi --service runner --skip-deploys
railway variable set GIT_AUTHOR_EMAIL=takeaki.kobayashi@gmail.com --service runner --skip-deploys
railway variable set GIT_COMMITTER_NAME=takecchi --service runner --skip-deploys
railway variable set GIT_COMMITTER_EMAIL=takeaki.kobayashi@gmail.com --service runner
```

**Shared Variables に置かない。** `runner` の Service 変数として置く（daemon にも降りる場所へ置くと、記憶の鍵と同じ器に GitHub の書き込み権が並ぶ）。

`GIT_*` を**環境変数で**渡すのは、`git config` を焼くと器を作り直すたびに消えるからである（git は設定ファイルが無くてもこの4つを読む）。置き忘れると commit が `Please tell me who you are` で失敗する。**空文字で置くのは未設定より悪い** — git は `empty ident name` で即座に落ちる。置かないなら変数ごと消す。

### ローカル（`docker compose`）でも同じ

同じ5つを `.env` に置けば `runner` へ渡る（`compose.yaml` の runner の `environment`）。確認は `docker compose exec -u 1001 runner gh auth status`。

### 通っているか確かめる

マネージャーと同じ主体（uid 1001）で確かめる。root で通っても意味がない。

```bash
railway ssh --service runner -- su -s /bin/sh worker -c '
  gh auth status
  cd /tmp && git clone --depth 1 https://github.com/<owner>/<repo> r && cd r
  git commit --allow-empty -m "probe" && git log -1 --format="%an <%ae>"
'
```

### 頼む

```bash
railway ssh --service app
alteroid chat
> alteroid リポジトリの M5 を実装して PR を出して。AGENTS.md と docs/roadmap.md を先に読んで。
```

あとは閉じてよい。**人間の不在で止まるのは承認待ちだけ**なので、判断に迷ったものが `/approvals` に溜まる。溜まったら `alteroid chat` の `/approvals` → `/answer <番号> <回答>`。進み具合は `/managers` と `/manager <id>`（生ログ）で見える。

**長い仕事を頼むときは、早めに push させること。** workspace はボリュームを付けていないので、runner が再デプロイされるとコミット前の変更は消える（「先に読む」3）。数時間かかる仕事を投げるなら、その間デプロイしないか、`/workspace` にボリュームを付ける。

**runner を2台以上にしてからしか確認できないこともある**（M5 受け入れ基準1・4）。実装は入っているが、実際に配置が分かれることと器の停止から続けられることは、Service を足して初めて見える → [runner を増やす](#runner-を増やすm5)。

---

## 症状から引く

| 症状                                                             | 原因                                                                                                                                                                                                                                       |
| ---------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| `railway ssh` が一瞬で切れる（プロンプトは出る）                 | そのコンテナが再起動を繰り返している。ssh はデプロイに繋がっているので、器が入れ替わるとセッションごと落ちる。**ssh の問題ではない**ので `railway logs` を見る                                                                             |
| `alteroidd: 起動に失敗しました: TypeError: fetch failed`         | daemon が runner の `/health` へ届いていない。runner のログを見る（大抵 runner が上がっていない）。次に `ALTEROID_RUNNER_URLS` のサービス名と `ALTEROID_RUNNER_BIND=::` を確認する（**2台以上なら1台の不在では落ちない**ので、全滅を疑う） |
| `alteroid-runner: ALTEROID_RUNNER_CHILD_UID が指定されているが…` | runner が root で走っていない。`RAILWAY_RUN_UID=0` が無い／名前に空白が混ざっている。**これは異常ではなく設計**で、同じ UID のまま走ると子プロセスが制御面に手を届かせるので、runner は起動を拒む                                          |
| 変数を設定したのに効かない                                       | 名前の前後に空白。`railway variable list --json` で `repr` して検算する（上の「置いたら必ず名前を検算する」）                                                                                                                              |
| 日報が想定と違う時刻に出る                                       | `TZ` 未設定。既定の `22:00` は**コンテナのローカル時刻**なので、UTC のまま動くと日本時間の翌 7:00 になる                                                                                                                                   |
| `env \| grep ALTEROID_DATABASE_URL` が runner で何か返す         | 慌てる前に行頭固定で取り直す。`RAILWAY_GIT_COMMIT_MESSAGE` にこの文書の一部が入っている                                                                                                                                                    |
| マネージャーの commit が `Please tell me who you are` で失敗する | `GIT_AUTHOR_*` / `GIT_COMMITTER_*` が runner に無い（「マネージャーに GitHub を渡す」）                                                                                                                                                    |
| マネージャーの push が 403 になる                                | `GH_TOKEN` が無いか、fine-grained PAT の Contents が Read-only か、対象リポジトリが選択されていない                                                                                                                                        |

---

## 既知のざらつき

1. **runner 1台構成では、runner の再デプロイで daemon も一度落ちる。** 宛先が1つのときだけ、繋げない起動は失敗にしてある（`apps/daemon/src/index.ts` の `openRunners`）。`ALWAYS` で復帰し、走行中のマネージャーは runner が生きていれば繋ぎ直し、器ごと落ちていれば JobStore の `session_id` と預かった生ログから resume される。**2台以上なら落ちない**（残りで走り、戻った器は生存確認が拾う）
2. **App Sleep を有効にしないこと。** 常駐は自律の前提であり、寝かせると起点②〜④が止まる
3. **全 Service が常時起動する。** 止めてよいのは承認待ちの仕事だけで、器ではない
