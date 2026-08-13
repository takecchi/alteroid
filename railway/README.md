# Railway へ常駐させる（1 runner 構成）

compose.yaml の3コンテナ構成（daemon / manager-runner / PostgreSQL）を、そのまま Railway の3 Service に写した運用手順である。ここに**要件は書かない** — 正典は [docs/](../docs/) であり、この文書は「どう置くか」だけを扱う。

roadmap M5 の「Railway の複数 Service …で runner 数を増減できるデプロイ定義」はまだ来ていない。ここで置くのは **runner 1台**である（`RunnerRegistry` の宛先が1つなのは M4 と同じ）。

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

残る2枚で M4 受け入れ基準4（**マネージャーが自分宛の許可確認に自分で `allow` を返せない**）は構造的に保たれる。制御面の全経路が `Bearer` を要求し（`apps/runner/src/app.ts` の `control`）、runner のプロセスに残るのは sha256 だけなので、`/proc/1/environ` を読めても鍵は作れない。

→ **`ALTEROID_RUNNER_TOKEN` は Shared Variables に置いてよい。** runner は起動時（`docker/alteroid-runner`）に sha256 へ畳み、素の値を自分の環境から落としてから node を `exec` する。**守りは「誰に配ったか」ではなく「走っている runner が何を持っているか」で決まる**ので、人間が2か所に別々の値を置く必要は無い（置き間違えれば 401 が出続けるだけで、1枚も守らない）。

### 2. ネットワークが1枚になる

compose の `data`（daemon↔db）/ `control`（daemon↔runner）の分離が Railway には無い。`*.railway.internal` は環境ごとにフラットなので、**runner から db が名前解決できてしまう**。

M4 受け入れ基準3の「runner から Persona 用 DB へ接続できない」が、compose の「**経路が無い**」から Railway では「**資格情報を配っていない**」に弱まる。**`ALTEROID_DATABASE_URL` は app の Service 変数にだけ置く（唯一の Shared Variables 禁止）。**

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

# 制御面の合鍵。**app と runner に同じ値を置くだけ**でよい
openssl rand -hex 32        # → ALTEROID_RUNNER_TOKEN
```

`.env.example` と同じものを Railway に置く、と思ってよい。**役ごとに違うのは `ALTEROID_DATABASE_URL` だけ**である。

### 1. プロジェクトと PostgreSQL

```bash
railway init -n alteroid
railway add --database postgres
```

### 2. Service を2つ作る（同じリポジトリから）

ダッシュボードで GitHub リポジトリを2回追加し、名前を **`app`** と **`runner`** にする（`ALTEROID_RUNNER_URL` がこの名前を参照する）。それぞれ **Settings → Config as Code** に次を指定する。

| Service  | Config as Code         |
| -------- | ---------------------- |
| `app`    | `/railway/daemon.json` |
| `runner` | `/railway/runner.json` |

Config as Code のパスは Root Directory を見ないので、**リポジトリ先頭からの絶対パス**で書く。同じ `Dockerfile` から `startCommand` で役を選ぶ（compose の `command` と同じ考え方）。

### 3. 変数（1か所に書いて両方へ配る）

**Shared Variables に書く。** `app` と `runner` の両方に紐づける（Postgres には付けない）。役ごとに書き分ける必要は無い — **使う / 使わないは役が決める**ので、片方が読まない変数が並んでいても害は無い。

| 変数                      | 値                                               | なぜ                                                                                                                                                                                                                                              |
| ------------------------- | ------------------------------------------------ | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `ALTEROID_RUNNER_TOKEN`   | `openssl rand -hex 32` の値                      | 制御面の合鍵。**同じ値を両方が持つだけでよい。** runner は起動時に sha256 へ畳み、素の値を自分の環境から落としてから走る（`docker/alteroid-runner`）ので、走っている runner に素の鍵は残らない                                                    |
| `CLAUDE_CODE_OAUTH_TOKEN` | `claude setup-token` の値                        | クローンもマネージャーも SDK セッションなので、両方に要る                                                                                                                                                                                         |
| `ALTEROID_RUNNER_URL`     | `http://${{runner.RAILWAY_PRIVATE_DOMAIN}}:4518` | 委譲の宛先（app が読む）。固定 URL をコードに埋めず、ここで名簿へ登録する。private network は Wireguard で暗号化済みなので `http://`                                                                                                              |
| `ALTEROID_RUNNER_BIND`    | `::`                                             | runner の待ち受け。Railway の private network は IPv6（新しい環境は dual stack）で、既定の `127.0.0.1` のままだと daemon から届かない。**app 側は無視する**（daemon が見るのは `ALTEROID_BIND`）                                                  |
| `ALTEROID_RUNNER_PORT`    | `4518`                                           | 同上                                                                                                                                                                                                                                              |
| `ALTEROID_RUNNER_ID`      | `runner-primary`                                 | 台帳の `manager_id → runner_id` を引く安定した識別子。器を作り直しても同じ宛先として戻る                                                                                                                                                          |
| `RAILWAY_RUN_UID`         | `0`                                              | runner は子プロセスを uid 1001 へ降ろすのに特権が要り、`USER node` のままだと**起動を拒否する**（同じ UID で走り続けるより落ちる方を選んである）。**daemon は root で起きても自分で `node` へ降りる**（`docker/alteroidd`）ので、共有して構わない |
| `TZ`                      | `Asia/Tokyo`                                     | 日報の締め時刻がこれで決まる                                                                                                                                                                                                                      |

自律の既定を変えるならこれも（省略しても動く。**自律は後から足す機能ではない**）。

| 変数                        | 値      |
| --------------------------- | ------- |
| `ALTEROID_DAILY_REPORT_AT`  | `22:00` |
| `ALTEROID_INITIATIVE_EVERY` | `60`    |

**`app` の Service 変数（ここだけ役ごと）**

| 変数                    | 値                           | なぜ                                                                                                                                       |
| ----------------------- | ---------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------ |
| `ALTEROID_DATABASE_URL` | `${{Postgres.DATABASE_URL}}` | private の接続文字列（`postgres.railway.internal`）。`DATABASE_PUBLIC_URL` は公衆網に出るので使わない。**Shared Variables に置かないこと** |

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

境界が本当に立っているかは、思い込みではなく runner の中から確かめる。

**見るのは `env` ではなく `/proc/1/environ` である。** `railway ssh` のシェルには Service / Shared Variables がそのまま入るので、`env` に素の合鍵が見えるのは当たり前で、守りの証拠にならない。**マネージャーが読みに行く先＝走っている runner のプロセス**を見る。**素の `grep` も使わない** — `RAILWAY_GIT_COMMIT_MESSAGE` にこの文書の一部が入るので、変数名を含む文章に当たって「有る」ように見える。行頭で固定する。

```bash
railway ssh --service runner -- sh -lc '
e() { tr "\\0" "\\n" < /proc/1/environ; }
e | grep -qE "^ALTEROID_DATABASE_URL=" && echo "!! DB の鍵がある" || echo "DB の鍵は無い"
e | grep -qE "^ALTEROID_RUNNER_TOKEN="  && echo "!! 素の合鍵が残っている" || echo "素の合鍵は残っていない"
e | grep -qE "^ALTEROID_RUNNER_TOKEN_SHA256=" && echo "sha256 はある（畳めている）"

# uid 1001（マネージャーと同じ主体）から制御面 → 401 であること
su -s /bin/sh worker -c "curl -s -o /dev/null -w %{http_code}\\\\n http://127.0.0.1:4518/managers"

# 生存確認だけは鍵なしで通る（制御面の情報は返さない）
su -s /bin/sh worker -c "curl -s http://127.0.0.1:4518/livez"
'
```

実測（2026-08）: 制御面は **401**、`/livez` は `{"ok":true}`、runner に `ALTEROID_DATABASE_URL` は無い。つまり M4 受け入れ基準4は Railway でも成立している。

**「素の合鍵が残っていない」の実測はこれからである**（合鍵を Shared Variables に置く形へ変えたのはこの回で、確かめたのは手元の器まで。`apps/runner/src/index.test.ts` が畳みと落としを固定している）。上のコマンドで `!!` が出たら、それは**運用の間違いではなく実装のバグ**として扱うこと（`docker/alteroid-runner` を通さず `node` を直に起こしていないか、`startCommand` を見る）。

いっぽう `getent hosts postgres.railway.internal` は `fd12:…` を返す（＝「先に読む」2の弱まりが実測でも出る）。db へ届く経路はあるが、鍵が無い。

`railway ssh` は**サービスの実行 UID とは無関係に root で入る**（`app` でも `uid=0`。デーモン本体は自分で `node` へ降りているので、`ps` で見える実体とは別である）。だから上のように `su` で降りてから叩くこと。root のまま叩いた 401 は「マネージャーから叩けない」の証拠にならない。

能力が落ちていないことも確かめる（境界を入れた側が示す義務。north_star「立ち戻るための問い」最終項）。

- `alteroid chat` でマネージャーへ委譲し、git を叩く作業が完遂すること
- 許可確認がクローン経由で `/approvals` に届き、`/answer` で**その仕事だけ**が再開すること
- `app` を再デプロイしても同じ人格で応答し、走行中だったマネージャーを把握していること

---

## マネージャーに GitHub を渡す（PR を出させる）

クローンに「実装して PR を出して」と頼むには、マネージャーの手元に**人間が Claude Code に渡しているものと同じ**3つが揃っている必要がある。

| 要るもの       | 置き場                   | 状態                                                                                  |
| -------------- | ------------------------ | ------------------------------------------------------------------------------------- |
| `gh` コマンド  | イメージ（`Dockerfile`） | 同梱済み（版は固定しない。ビルドし直せば上がる）。git の credential helper も配線済み |
| 書き込みの鍵   | **Shared Variables**     | `GH_TOKEN` を置く（下記）                                                             |
| コミットの身元 | **Shared Variables**     | `GIT_AUTHOR_*` / `GIT_COMMITTER_*` を置く（下記）                                     |

**これは下＝外の世界へ手を伸ばす鍵なので、渡すのが正しい**（記憶ストアの鍵と逆。伏せると人間が Claude Code でできる `gh pr create` が層を下りた瞬間にできなくなる＝デグレード。north_star 禁止1）。

app にも降りるが、それでよい。**クローンは人間の写像であり、人間は Claude Code に頼むだけでなく自分の手も持っている**（north_star「適用範囲」）。「クローンの道具はマネージャーだけ」は写像として成り立たない。

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

**初回はこれでよい。差し替え（ローテーション）はこの手順ではない** — 走行中のプロセスには届かないので、下の「鍵を回す」を使う。

ダッシュボードの **Shared Variables** に5つ置くのがいちばん早い（他の変数と同じ場所で済む）。CLI から入れるなら Service ごとに1回ずつになる。

```bash
# 鍵は stdin から。引数で渡すとシェル履歴とプロセス一覧に残る
printf %s 'github_pat_xxx' | railway variable set GH_TOKEN --stdin --service runner --skip-deploys

railway variable set GIT_AUTHOR_NAME=takecchi --service runner --skip-deploys
railway variable set GIT_AUTHOR_EMAIL=takeaki.kobayashi@gmail.com --service runner --skip-deploys
railway variable set GIT_COMMITTER_NAME=takecchi --service runner --skip-deploys
railway variable set GIT_COMMITTER_EMAIL=takeaki.kobayashi@gmail.com --service runner
```

`GIT_*` を**環境変数で**渡すのは、`git config` を焼くと器を作り直すたびに消えるからである（git は設定ファイルが無くてもこの4つを読む）。置き忘れると commit が `Please tell me who you are` で失敗する。**空文字で置くのは未設定より悪い** — git は `empty ident name` で即座に落ちる。置かないなら変数ごと消す。

### ローカル（`docker compose`）でも同じ

同じ5つを `.env` に置けば両方へ渡る（`compose.yaml` の `x-shared-env`）。確認は `docker compose exec -u 1001 runner gh auth status`。

### 鍵を回す（走行中でも）

**変数を置き直すだけでは走行中のマネージャーに届かない。** `railway variable set` は設定を書き換えるが、既に走っているプロセスの環境変数は書き換えられない。`--skip-deploys` を付ければなおさら何も起きない。そのまま「置いたのに 403 のまま」になり、人間は PAT の権限を疑い、マネージャーは正しく 403 を報告し続ける — **両方正しいまま、何時間も噛み合わない**（実際に起きた）。

鍵は器（`/run/alteroid/credentials`）に置いてあり、`git` も `gh` も**呼ばれるたびに読み直す**。だから差し替えは daemon 経由で降ろす。器は作り直さないので、**走行中の仕事は死なない**。

```bash
railway ssh --service app

# いま配られている鍵の指紋（値は出ない）
curl -s http://127.0.0.1:$ALTEROID_PORT/runners | jq

# 差し替える。走行中のマネージャーにも次の git / gh 呼び出しから届く
printf %s 'github_pat_xxx' | jq -Rn '{credentials:[{name:"GH_TOKEN",value:input}]}' \
  | curl -s -X POST http://127.0.0.1:$ALTEROID_PORT/runners/credentials \
      -H 'content-type: application/json' -d @-
```

**変数（Shared Variables）も一緒に直しておくこと。** 器が作り直されたとき（再デプロイ）に読まれるのは変数の方である。順序は「先に上の口で回して仕事を止めない → 落ち着いてから変数を直す」。

指紋が食い違っていたら、鍵の権限ではなく**経路**の問題である。PAT の設定を見に行く前にここを見る。

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

**M5 は実装だけでは受け入れ基準を満たさない。** 基準1が「runner を2台以上登録し、複数マネージャーが配置される」なので、`runner` Service をもう1つ（別の `ALTEROID_RUNNER_ID`）足して初めて確認できる。実装を頼むときに「1台構成のまま通るところまで」と「2台目を足してからの確認」を分けて伝えると迷子にならない。

---

## 症状から引く

| 症状                                                             | 原因                                                                                                                                                                                                                |
| ---------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `railway ssh` が一瞬で切れる（プロンプトは出る）                 | そのコンテナが再起動を繰り返している。ssh はデプロイに繋がっているので、器が入れ替わるとセッションごと落ちる。**ssh の問題ではない**ので `railway logs` を見る                                                      |
| `alteroidd: 起動に失敗しました: TypeError: fetch failed`         | daemon が runner の `/health` へ届いていない。runner のログを見る（大抵 runner が上がっていない）。次に `ALTEROID_RUNNER_URL` のサービス名と `ALTEROID_RUNNER_BIND=::` を確認する                                   |
| `alteroid-runner: ALTEROID_RUNNER_CHILD_UID が指定されているが…` | runner が root で走っていない。`RAILWAY_RUN_UID=0` が無い／名前に空白が混ざっている。**これは異常ではなく設計**で、同じ UID のまま走ると子プロセスが制御面に手を届かせるので、runner は起動を拒む                   |
| 変数を設定したのに効かない                                       | 名前の前後に空白。`railway variable list --json` で `repr` して検算する（上の「置いたら必ず名前を検算する」）                                                                                                       |
| 日報が想定と違う時刻に出る                                       | `TZ` 未設定。既定の `22:00` は**コンテナのローカル時刻**なので、UTC のまま動くと日本時間の翌 7:00 になる                                                                                                            |
| `env \| grep ALTEROID_DATABASE_URL` が runner で何か返す         | 慌てる前に行頭固定で取り直す。`RAILWAY_GIT_COMMIT_MESSAGE` にこの文書の一部が入っている                                                                                                                             |
| runner の `/proc/1/environ` に素の合鍵が残っている               | 起動スクリプトを通っていない。`startCommand` が `alteroid-runner` か（`node apps/runner/dist/index.js` を直に叩くと畳みが起きない）。**運用の間違いではなく実装のバグ**として扱う                                   |
| マネージャーの commit が `Please tell me who you are` で失敗する | `GIT_AUTHOR_*` / `GIT_COMMITTER_*` が runner に無い（「マネージャーに GitHub を渡す」）                                                                                                                             |
| マネージャーの push が 403 になる                                | **まず指紋を突き合わせる**（下記）。合っていないなら鍵が届いていない側の問題で、PAT の権限を疑うのは順番が違う。合っていて 403 なら、fine-grained PAT の Contents が Read-only か、対象リポジトリが選択されていない |
| 鍵を差し替えたのにマネージャーが「権限が無い」と言い続ける       | **走行中のマネージャーに古い鍵が残っている。** `--skip-deploys` で置いた変数は走っているプロセスに入らない。`POST /runners/credentials` で回す（下記「鍵を回す」）                                                  |

---

## 既知のざらつき

1. **runner の再デプロイで daemon も一度落ちる。** daemon は起動時に runner へ繋げないと落ちる（`apps/daemon/src/index.ts` の `openRunner`）。`ALWAYS` で復帰し、走行中のマネージャーは runner が生きていれば繋ぎ直し、器ごと落ちていれば JobStore の `session_id` と預かった生ログから resume される。起動時リトライを入れるかは別途判断（要件ではなく実装のざらつき）
2. **App Sleep を有効にしないこと。** 常駐は自律の前提であり、寝かせると起点②〜④が止まる
3. **3 Service が常時起動する。** 止めてよいのは承認待ちの仕事だけで、器ではない
