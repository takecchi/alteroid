# Railway へ常駐させる（runner は N 台）

compose.yaml の3コンテナ構成（daemon / manager-runner / PostgreSQL）を、そのまま Railway の Service に写した運用手順である。ここに**要件は書かない** — 正典は [docs/](../docs/) であり、この文書は「どう置くか」だけを扱う。

**runner は増やせる。減らすのはまだできない。**

|                   | 何で                              | 状態                                                                                               |
| ----------------- | --------------------------------- | -------------------------------------------------------------------------------------------------- |
| 新しく N 台建てる | `./railway/setup.sh -c 3`         | ある（既定は1台。台数は費用なので、増やすのは人間が言ったときだけ）                                |
| 既存に足す        | `./railway/scale-runners.sh -n 3` | ある（下の「runner を増やす」）                                                                    |
| 減らす            | —                                 | **無い。** その器で走っているマネージャーの移送が要り、移送は fencing の後（roadmap M5 PR4 → PR5） |

roadmap M5 の「Railway の複数 Service …で runner 数を増減できるデプロイ定義」のうち、**増やす側だけが来ている**。減らす側を自動でやらないのは、**「落ちた」は観測の欠落であって停止の証明ではない**からで、いま減らすと同じセッションが2か所で走りうる。

---

## 先に読む — compose と何が違うか

Railway の実行環境の性質で、境界がいくつかゆるむ。**どれも能力の削減ではないが、黙って進めてよい話でもない**ので先に書く。**数はここにしか書かない** — 「2か所ゆるむ」と他の文書にも書くと、増えるたびに数を直して回ることになり、片方だけ古びる。

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

M4 受け入れ基準3の「runner から Persona 用 DB へ接続できない」が、compose の「**経路が無い**」から Railway では「**資格情報を配っていない**」に弱まる。**`ALTEROID_DATABASE_URL` は app の Service 変数にだけ置く。**

**Shared Variables に置けないものはもう1つある**（`ALTEROID_RUNNER_ID`）が、**理由の種類が違う** — あちらは「配ると危ない」ではなく「**台ごとに違う値だから共有できない**」である。境界の話ではないので、ここには数えない（下の「変数」の表が持つ）。

### 3. workspace は毎デプロイで消える

**ボリュームを付けない。** roadmap M5「workspace locator の運用選択（runner-volume / 共有 FS / Git 再構築）」のうち **Git 再構築**を採る、という運用判断である。人間がやることと同じで、マネージャーの作業は git へ push されて初めて残る。

その代わり、次の2つが毎デプロイで消える。

- マネージャーの作業ディレクトリ（コミットしていない変更は失われる）
- `/workspace/.mcp.json`（＝MCP 連携）

MCP を渡したいなら、`/workspace` にボリュームを付けて所有者を uid 1001 に揃えるか、設定をイメージへ焼く。**「Railway だから MCP が使えない」は仕様ではなくバグ**なので、必要になった時点でどちらかを選ぶ（north_star 禁止1）。

記憶・日誌・ジョブ・生ログは PostgreSQL にあるので、**ボリュームは1つも要らない**。`ALTEROID_HOME`（`/data/alteroid`）に残るのは `state/daemon.json` と `daemon.log` だけで、これは CLI がデーモンを見つける手段であって記憶ではない。

**消えたことは黙っていない。** runner が入れ替わった後の再開では、マネージャーに「作業ディレクトリが残っているとは限らない」と伝え、クローンへの通知にも「コミット前の変更は失われている」と書く（`packages/core/src/manager.ts` の `restartNudge` / `#notifyRestored`）。黙って再開させると、消えた作業を書いたつもりで続きを進める。

roadmap M5 受け入れ基準4の後半（「復旧不能な未永続状態を人間へ明示できる」）はこれで満たすが、**前半（workspace から継続できる）はまだ来ていない**。倒すなら `/workspace` にボリュームを付けて所有者を uid 1001 に揃える。

### 4. 公開構成では runner からデーモンへ TCP が届く

フラットな `*.railway.internal` が効くのは db だけではない。**外から HTTP API を叩ける形にすると**（`setup.sh` の「公開する」— Google ログインの鍵2つ ＋ `ALTEROID_PUBLIC_URL` ＋ `ALTEROID_BIND=::` を app に置く分岐）、外から届かせるためにデーモンがループバック以外でも待つことになり、**runner の中の子プロセス（＝マネージャー）からもデーモンへ TCP が届く**。

実測（2026-08-14。マネージャーのプロセスから `app.railway.internal:4517` へ）:

| 叩いた先                                        | 結果                                                                                       |
| ----------------------------------------------- | ------------------------------------------------------------------------------------------ |
| TCP 接続                                        | **届く**                                                                                   |
| `GET /health`                                   | **200**（認証を要求しない経路。ほかに `/openapi.json` `/docs` `/auth/*` — `isPublicPath`） |
| `GET /memory` `/journal` `/managers` `/profile` | **いずれも 401**                                                                           |

**いま守っているのはログイン認証だけである。** アクセストークンはデーモン側の DB にあり、`ALTEROID_GOOGLE_CLIENT_ID` / `_SECRET` は app の Service 変数にしか置かない（`setup.sh` の `app_pairs`）ので、**マネージャーにはトークンを手に入れる経路が無い**。`/auth/*` は開いているが、その先は Google のアカウントと人間の `access grant` を通らないと何も持てず、許可されるアカウントは高々1つである。制御面（runner API）の3枚とは別の話で、そちらは上の1のとおり保たれている。

**これは運用として正しい選択の副作用である。** 外から叩かせるには待ち受けを開けるほかなく、`setup.sh` は**ログイン（境界）が立つときにだけ**開ける（鍵2つと `ALTEROID_BIND=::` は同じ分岐にある）。公開しない構成では既定の `127.0.0.1` のままなので、この経路は開かない。

**そのうえで、失われた守りを書いておく。** [docs/architecture.md](../docs/architecture.md)「runner API — 命令は下り、出来事は上る」の**「逆向きの経路は無い」は多層防御の1枚だった**。経路が無ければ、認証に穴が空いても記憶へは届かない。公開構成ではその1枚が抜けて、**認証だけが砦になっている** — デーモンの認証のバグは、compose なら「外の誰かに開く」で済むが、ここでは**マネージャーが記憶へ届く**ところまで開く。

持ち主の判断（2026-08-14）: **受け入れる。** 塞ぐには private network 内で app への到達を runner だけ落とす手段が要るが、環境ごとにフラットな `*.railway.internal` にそれは無い。**この1枚が抜けている前提で、デーモンの認証を「外向きの利便」ではなく境界として扱うこと。**

---

## デプロイは走行中の仕事を畳む操作である

**器の入れ替えは、その中で手を動かしているマネージャーと作業者を畳む。** だから無関係な変更で起こさないし、**起こす時刻も自分で決める。** 4つで抑えてある。

### 1. マージした瞬間には落とさない（`release/prod` へ夜に2回写す）

Railway に見せる枝を `main` ではなく **`release/prod`** にする（**向き先を切り替えるのは人間の作業である** — 下の⚠️）。切り替わっていれば `main` へマージしても何も起きず、`.github/workflows/release-prod.yml` が **1日2回、夜だけ**（JST 22:17 / 翌 4:17 を目安に）`main` と `release/prod` の SHA を比べ、違えば `release/prod` を `main` の先端へ動かす。**デプロイが走る時刻を決めているのはこのワークフローであって、マージした時刻ではない。**

**この2回は均等な間隔ではない**（6時間と18時間）。**揃えたいのは間隔ではなく「人間が手を動かしている時間帯に器を入れ替えない」ことである。** 均等に割ると12時間離れる以上どちらか一方が必ず日中に来るので、不揃いなのは意図である。

これが無いと「PR を出したマネージャーが、自分のマージによるデプロイで死ぬ」が起きる。実際に起きている — 2026-08-14 にマージ4本で走行中の4本を失い、2026-08-18 には #73 をマージしたマネージャーが30秒後に畳まれた（PR は入っていたので成果は残り、報告だけが届かなかった）。

**⚠️ Railway 側の向き先を切り替えるまで、ここに書いたことは効かない。** `app` / `runner` の Settings → Source の枝が `main` のままなら、**従来どおりマージした瞬間に落ちる。** ワークフローが `release/prod` を作っていることと、Railway がそれを見ていることは別の話である。**「反映の仕組みが入ったからもう安全」と読まないこと** — どちらを見ているかは Railway の画面でしか判らない。**いまの本番はこの切り替えが済んでいる**（2026-08-19 時点。人間による確認）。ここを残してあるのは、新しく環境を建てるときに同じ穴が開くからである。

`cron` は**設定どおりには発火しない。** このリポジトリでの実測（`gh run list --workflow=release-prod.yml`、観測 `2026-08-19T08:23:15Z`。6時間設定だった頃の連続4回）で、発火は設定時刻から40〜97分遅れた。つまり**実際に走るのは JST 23〜24時頃と5〜6時頃**である。**遅れは日中へ近づく方向にしか効かない**ので、時刻を昼寄りへ動かすときは遅れの分を先に引いておくこと。待てないとき（本番が壊れている・直した欠陥をいま確かめたい）は Actions から `workflow_dispatch` で起こす。

**差分が無くても必ず1行出る**（`=== 反映結果: …`）。出さないと、何も出ていないログを見たときに「差分が無かった」と「ワークフローが壊れて何もしなかった」が区別できない。

**切り替えたあと、最初の反映が実際にデプロイを起こしたかを一度だけ確かめること。** 押しているのは GitHub Actions の `GITHUB_TOKEN` で、**この鍵の push は GitHub Actions のワークフローを起こさない**（GitHub の仕様）。Railway は Actions ではなく GitHub App の webhook で動くので効くはずだが、**ここが違っていた場合の症状は「デプロイが二度と来ない」という沈黙である。** 一度でも Deployments に出れば以後は疑わなくてよい。出ないなら `GITHUB_TOKEN` ではなく PAT を Secrets に置いて押す形へ変える。

`release/prod` への push は `--force-with-lease` である。**`release/prod` はデプロイ専用の枝で、正典は `main`** なので、固有の履歴が無く上書きで壊れるものが無い。平常時に force が要らないことと、それでも要る一点は `.github/scripts/reflect-release-prod.sh` の先頭に書いた。**「force push は危険」と思って直しに来ないこと。**

### 2. その Service が動かすものが変わったときだけ落とす（`watchPatterns`）

`railway/daemon.json` / `railway/runner.json` の `build.watchPatterns` に、その Service が実際に動かすパスだけを並べてある。`docs/` の更新、この README、`compose.yaml`、CI の変更では**どちらも落ちない**。

**2つの役は対称ではない。** daemon の余分なデプロイは数十秒の断だが、**runner の余分なデプロイは走行中の仕事の死**である。だから runner だけ狭くしてある（runner が何台あっても同じ `railway/runner.json` を指すので、この表は台数に関係なく効く）。

|                                  | `app` | `runner`                                   |
| -------------------------------- | ----- | ------------------------------------------ |
| `apps/daemon/**` / `apps/cli/**` | ○     | — （`alteroid chat` が走るのは daemon 側） |
| `apps/runner/**`                 | —     | ○                                          |
| `packages/**`                    | ○     | `packages/core/**` のみ                    |
| `Dockerfile` / `.dockerignore`   | ○     | ○                                          |
| `docker/**`                      | ○     | ○                                          |

runner が import するのは `@alteroid/core` だけである（`storage-fs` / `storage-pg` / `api-client` は記憶の鍵を持たない runner が触らない）。ここを `packages/**` にしておくと、**`storage-pg` の1行修正がマネージャーを畳む。** 依存が増えたら `pnpm-lock.yaml` 側で拾える。

**イメージの中身を変えるものは全部入れる。** `Dockerfile` と `.dockerignore` はビルドコンテキストそのものを変える。`docker/**` は `startCommand` の実体である（`alteroidd` / `alteroid-runner`）。**とくに `docker/alteroid-runner` は合鍵を sha256 へ畳んで素の値を落とす処理そのもの**なので、ここが watchPatterns から漏れていると「守りを直したのに走っている runner が古いまま」になる。

逆に `eslint.config.js` `vitest.config.ts` `mise.toml` `.github/**` `.env.example` は焼かれるものを変えないので入れていない（node の版は `Dockerfile` が直に固定していて、mise を読まない）。

パスを増やしたときは watchPatterns も直すこと。**漏らすと「直したのに反映されない」になる**ので、`app` 側は迷ったら広めに入れる。`runner` 側だけは、そこで本当に走るものかを確かめてから足す。

`overlapSeconds` は使っていない。新旧の runner が同じ `ALTEROID_RUNNER_ID` で並ぶと、台帳の `manager_id → runner_id` がどちらを指すのか決まらない。**同じ理由で、runner Service の Replicas を2以上にしないこと** — 1つの `runner_id` の裏に複数のプロセスが並ぶと、SSE と `list()` が別のプロセスに当たって取り直しが誤判定する。

**「レプリカを増やす」と「Service を足す」は別である。** 台数を増やすのは後者で、**別の `ALTEROID_RUNNER_ID` を持つ Service を足す**（下の「runner を増やす」）。前者は同じ id のプロセスを並べるので、上の理由でしてはいけない。

**そして runner が3台あると、runner のコード変更は3台を同時に畳む。** `watchPatterns` に当たる変更を `release/prod` へ反映すると、3つの Service がそれぞれデプロイされる。1台構成のときより落ちる仕事の数が増えるということで、**台数を増やすことは「デプロイの事故の規模を増やすこと」でもある**（減らないのは委譲が待たされる時間だけである）。

### 3. 畳む時間を渡す（`drainingSeconds: 60`）

compose の `stop_grace_period: 60s` に対応する。Railway の既定は短く、ここを書かないと SIGTERM の直後に SIGKILL が来る。

- `runner`: 走行中のマネージャーを畳み、**生ログをデーモンへ渡し切る**時間。渡し切れないと `manager_id` から生ログへ降りる経路が切れる
- `app`: 落ちる前の**最後の蒸留**（クローンのターン1本）が終わる猶予

**この値を変えるなら `apps/daemon/src/index.ts` / `apps/runner/src/index.ts` の強制 exit も変えること。** どちらのプロセスも SIGTERM から **55秒**（＝ここの 60 から5秒引いた値）で自分に見切りをつけて `exit(0)` する。**`railway/*.json` は JSON なのでファイル側にこの対応を書けない。この節がその導線である。**

**5秒は同着を避けるためであって、作業時間ではない。** 猶予が切れる時刻には器の SIGKILL が来るので、強制 exit を 60 ちょうどに揃えると「行儀よく終われなかったときに、それでも自分の意思で終わる」という最後の口が SIGKILL に負けて消える。**揃えに来ないこと。**

**55秒あれば完走する、とも読まないこと。** 60 は外枠、55 は自分で決めた見切りであって、どちらも「蒸留1本が終わる」保証ではない。**猶予を延ばすことは、落ちる前に取りこぼす仕事を減らすだけで、無くしはしない**（受信箱はインメモリで、読まれる前にプロセスが消えれば積まれた分は消える）。compose 側（`compose.yaml` の `stop_grace_period: 60s`）も同じ 60 で、同じ 55 が効く。

### 4. 落ちた側を待つ / 取り直す

- **daemon は runner を待つ**（最大2分、指数バックオフ）。以前は起動時に繋がらないと即 `exit(1)` していたので、同時デプロイのたびにクラッシュループしていた。**方針の誤りは待たない** — 鍵が無ければ起動前に、鍵を拒まれたら（401/403）その場で落ちる。待っても直らないものを再試行で隠さない
- **runner が入れ替わったら、走行中だった仕事を取り直す。** runner の SSE は繋ぎ直すたびに名乗る（`hello`）。名乗りを聞いたら `list()` を突き合わせ、器の中に居なくなっていたものを `session_id` と預かった生ログから resume する。ストリームが一瞬切れただけなら `list()` にそのまま並ぶので何も起きない
  - **「初回の名乗りは繋いだだけ」と決めつけない。** 上の `drainingSeconds` の猶予の間、畳まれつつある旧 runner は `/health` にも `/managers` にも答え続ける。起動時の引き取りがそれを見て「生きている」と判断した直後に SSE が新しい器へ繋がる、という順序が普通に起きる
  - 待っていた確認は**持ち越さない**。新しい器はその `request_id` を知らないので、残すと以後の指示が死んだ確認への回答として横取りされ、誰も届かないマネージャーになる
  - **こけたら、名乗りを待たずに自分で挑み直す。** 器が上がってストリームも安定しているのに、`GET /managers`（生死確認）や `POST /managers/:id/resume` が一時的に失敗する（起動直後・瞬断・5xx）ことがある。次の名乗りは永久に来ないので、外からの合図に頼ると台帳が `running` のまま誰も走っていない仕事が残る。1秒から倍々で 30 秒まで伸ばし、**回数では諦めない**
  - **予約するのは resume の失敗だけではない。** 名簿を引けない・台帳を読めない・生死を聞けない、のどれでも同じ経路に載せる。**どこか1段でも「黙って引き下がる」が残っていると、恒久停止がその段階に移るだけ**である（実際に2回、別の段で見つかった）
  - ただし **4xx は挑み直さない**（408 / 429 を除く）。runner が「その命令は受け取れない」と答えているので、同じものを投げ直しても同じ答えが返る。代わりにクローンへ「戻せなかった」と知らせる（M5 受け入れ基準4「復旧不能な未永続状態を人間へ明示できる」）
  - **諦めはジョブごとに覚える。** 予約は runner 単位なので、同じ runner に一時障害の仕事が1本あるだけで予約は積まれ続ける。ジョブ側に覚えないと、諦めたはずの仕事が毎回巻き込まれて再送され、同じ通知が予約の間隔ごとに積み上がる。諦めるのは**自動の取り直しだけ**で、`manager_send` で頼めば投げに行く（結果は呼び手へ返る）

4番目が無いと、**daemon が生き残って runner だけ入れ替わった場合に仕事が誰にも拾われない**（引き取りの契機が daemon の起動時しか無いため）。2番で落ちる範囲を分けた以上、この経路は必須である。人間の不在で止まってよいのは承認待ちの仕事だけである（PRD「自律」）。

**それでも、走行中の仕事にとってデプロイは事故である。** 上の4つは被害を減らすだけで、無くしはしない。1番で消えたのは「**自分の**マージで死ぬ」だけで、**畳まれる契機がマージから夜2回の反映へ移った**にすぎない。しかも移った先は**自分の操作と無関係な時刻**なので、「いま落ちない」と言える瞬間は前より減っている。**夜へ寄せたぶん日中は落ちにくくなったが、それは「落ちない」ではない** — `workflow_dispatch` は誰でもいつでも押せるし、遅れは日中の側へしか伸びない。長い仕事は早めに push させる（下の「頼む」）。

---

## 手順（スクリプト）

```bash
npm i -g @railway/cli
railway login
claude setup-token          # → CLAUDE_CODE_OAUTH_TOKEN（人間が一度だけ）

./railway/setup.sh          # ここから下は全部これがやる
```

**埋めるものは compose と同じ `.env` である。** 在る値は読み、無い値だけ尋ね、作れるもの（合鍵）は作って `.env` へ書き戻す。だから「compose では動くのに Railway では埋め直し」が起きない。`.env` が無くても、尋ねた値を書き留めるので次からは尋ねない。

途中で2つだけ尋ねる。どちらも後から足せる。

| 尋ねること                                                      | いいえのとき                                      |
| --------------------------------------------------------------- | ------------------------------------------------- |
| マネージャーに GitHub を渡すか（clone / push / `gh pr create`） | 公開リポジトリの clone だけできる                 |
| 外から HTTP API を叩くか（Google ログイン）                     | 待ち受けは 127.0.0.1 のまま。ドメインも生成しない |

やることは下の「手で置くなら」と同じで、順番と役の割り振りだけが固定されている。

- プロジェクトを**新しく作る**（既存には触らない）→ PostgreSQL → `app` / `runner`
- **Config as Code のパスを指す**（CLI に口が無いので GraphQL を直に叩く。ここを忘れると `startCommand` が無く、役が決まらない）
- 変数を**役ごとに**置く（記憶ストアの鍵は `app` だけ、`RAILWAY_RUN_UID=0` は `runner` だけ）
- **`runner` を先に**上げ、上がってから `app` を繋ぐ
- 上がらなかったら **0 を返さない**（器と変数だけ作って「できた」と名乗らない）
- **頼まれたものと違うものができたときも 0 を返さない。** Google ログインを選んだのにドメインを作れなかった場合、鍵と待ち受けは置かない（境界の無い口を外に出さないため）が、それは**頼まれた構成ではない**ので非0で終わり、残りを手でやる手順を出す。黙ると、外から叩けない理由を Google 側の設定に探しに行くことになる
- **`.env` に残っている生成ドメイン（`*.railway.app`）は信じない。** 毎回新しいプロジェクトを作るので、それは前の器のものである。作り直して `.env` も置き直す。持ち込みのドメインの場合は、新しい Service に繋がっているかだけ確かめる（繋ぐのと DNS を向けるのは人間の作業なので代行しない。繋がっていなければ上と同じく非0で終わる）

`-y` で尋ねなくなる（値は `.env` から取る）。`--help` に残りのオプションがある。

**繋ぐ枝は `release/prod` である**（`setup.sh` / `scale-runners.sh` の既定。`-b` で変えられる）。`main` へ繋ぐと、マージした瞬間に落ちる形へ戻る（「デプロイは走行中の仕事を畳む操作である」1）。**runner Service を足すときも同じ枝に繋ぐこと** — 1台だけ `main` を見ていると、そこだけがマージのたびに畳まれる（`scale-runners.sh` の既定が `release/prod` なのはこのためである）。

**台数を指定するのは `-c` である**（既定1）。`./railway/setup.sh -c 3` で `runner` / `runner-2` / `runner-3` を作り、`app` には3台ぶんの `ALTEROID_RUNNER_URLS` を置く。**既定を増やしていないのは、台数がそのまま費用だからである**（能力の上限ではない — 配置は実行環境の資源で決まり、人工の定員は置かない）。

**GitHub 連携に失敗したら、ローカルから上げる形に落ちる**（Railway の GitHub App がそのリポジトリを見えていないとき）。その場合 `watchPatterns` による自動デプロイは効かないので、繋ぎ直すならダッシュボードの Settings → Source から。

### 上がったら

```bash
railway ssh --service app
alteroid chat
```

境界と能力の確認は `./railway/verify.sh`（後述「上がったあとに確かめること」）。

---

## 手で置くなら（スクリプトが何をしているか）

ダッシュボードで作るときの手順である。**スクリプトを直すときはここも読むこと。**

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

### 2. Service を作る（同じリポジトリから）

ダッシュボードで GitHub リポジトリを追加し、名前を **`app`** と **`runner`**（2台目以降は **`runner-2`** / **`runner-3`** …）にする（`ALTEROID_RUNNER_URL` / `_URLS` がこの名前を参照する）。それぞれ **Settings → Config as Code** に次を指定する。

| Service                 | Config as Code         |
| ----------------------- | ---------------------- |
| `app`                   | `/railway/daemon.json` |
| `runner` / `runner-2` … | `/railway/runner.json` |

**runner の Service はどれも同じ Config as Code を指す。** 役は `startCommand` で決まり、台を分けるのは変数（`ALTEROID_RUNNER_ID`）だけである。だから `railway/runner.json` を台数ぶん複製しない — 複製すると `drainingSeconds` を直す場所が台数ぶんに増える。

Config as Code のパスは Root Directory を見ないので、**リポジトリ先頭からの絶対パス**で書く。同じ `Dockerfile` から `startCommand` で役を選ぶ（compose の `command` と同じ考え方）。

### 3. 変数（1か所に書いて両方へ配る）

> **ここへ変数を増やす前に、実行環境プロファイルを検討すること**（`alteroid profile edit`）。道具の鍵や `PATH` をここへ足すと、1つ増えるたびに Service 変数を置き直して**デプロイし直す**ことになる ＝「環境を直す」と「走行中の仕事を失う」が同じ操作になる（この文書が上で言っているのと同じ話である）。プロファイルは記憶ストア側に置かれ、器を作り直さずに差し替えられる。**ここに残すのは、プロファイルが降りる前から要るもの**（デーモンと runner が起動するために要る鍵と、記憶ストアの所在）だけでよい。設計は [docs/architecture.md](../docs/architecture.md)「実行環境プロファイル」。

**Shared Variables に書く。** `app` と `runner`（と2台目以降）の**全部**に紐づける（Postgres には付けない）。役ごとに書き分ける必要は無い — **使う / 使わないは役が決める**ので、片方が読まない変数が並んでいても害は無い。

**例外が2つある。Shared Variables に置いてはいけないもの:**

1. `ALTEROID_DATABASE_URL` — 記憶ストアの鍵（下の「先に読む」2）
2. `ALTEROID_RUNNER_ID` — **台ごとに違う値**である。共有に置くと全台が同じ id を名乗り、`manager_send` が黙って別の器へ届く（下の表）

> **`setup.sh` はここだけ違うことをする。** Shared Variables ではなく、同じ内容を**役ごとの Service 変数として**置く。人間が手で置くなら1か所で済むほうが良いが、スクリプトが置くなら役ごとに分けるほうが下の2つを**構造として**守れる（`runner` の変数一覧に記憶ストアの鍵が載る経路そのものが無くなる／`RAILWAY_RUN_UID=0` が `app` へ漏れない）。人間が埋める1か所は `.env` のままなので、二重管理は増えていない。
>
> そのため**ダッシュボードで値を直すときは2か所**になる（`app` と `runner`）。`.env` を直して `setup.sh` を回し直すか、`railway variable set K=V --service app` と `--service runner` の2回。走行中の仕事を殺さずに `GH_TOKEN` を差し替えるなら、変数ではなく後述「鍵を回す（走行中でも）」を使う。

| 変数                      | 値                                               | なぜ                                                                                                                                                                                                                                                                                  |
| ------------------------- | ------------------------------------------------ | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `ALTEROID_RUNNER_TOKEN`   | `openssl rand -hex 32` の値                      | 制御面の合鍵。**同じ値を両方が持つだけでよい。** runner は起動時に sha256 へ畳み、素の値を自分の環境から落としてから走る（`docker/alteroid-runner`）ので、走っている runner に素の鍵は残らない                                                                                        |
| `CLAUDE_CODE_OAUTH_TOKEN` | `claude setup-token` の値                        | クローンもマネージャーも SDK セッションなので、両方に要る                                                                                                                                                                                                                             |
| `ALTEROID_RUNNER_URL`     | `http://${{runner.RAILWAY_PRIVATE_DOMAIN}}:4518` | 委譲の宛先（**app が読む。runner 自身は読まない**）。固定 URL をコードに埋めず、ここで名簿へ登録する。private network は Wireguard で暗号化済みなので `http://`。**複数台なら下の `ALTEROID_RUNNER_URLS` を使う**。どちらも起動時の種であって、繋ぐのは待ち受けを開いた後の背景である |
| `ALTEROID_RUNNER_BIND`    | `::`                                             | runner の待ち受け。Railway の private network は IPv6（新しい環境は dual stack）で、既定の `127.0.0.1` のままだと daemon から届かない。**app 側は無視する**（daemon が見るのは `ALTEROID_BIND`）                                                                                      |
| `ALTEROID_RUNNER_PORT`    | `4518`                                           | 同上                                                                                                                                                                                                                                                                                  |

**台ごとに違う変数（Shared Variables に置いてはいけない唯一のもう1つ）**

| 変数                 | 値                                           | なぜ                                                                                                                                                                                                                                                                                                                                                                                                                                                 |
| -------------------- | -------------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `ALTEROID_RUNNER_ID` | `runner-primary` / `runner-2` / `runner-3` … | 台帳の `manager_id → runner_id` を引く安定した識別子。器を作り直しても同じ宛先として戻る。**同じ値が2台に載ると静かに壊れる** — `RunnerRegistry#get` は線形一致で**先に見つかった方を黙って返す**ので、`manager_send` / `abort` / `transcript` / `restore` が割り当て先ではない器へ届く（`select({runnerId})` だけは「一意でない」と拒む）。**名簿は重複を検出しない。** 未設定の器は `runner-primary` を名乗るので、**2台目に置き忘れると重複する** |

**複数台のときの宛先**

| 変数                   | 値                                                                                                  | なぜ                                                                                                                                                                       |
| ---------------------- | --------------------------------------------------------------------------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `ALTEROID_RUNNER_URLS` | `http://${{runner.RAILWAY_PRIVATE_DOMAIN}}:4518,http://${{runner-2.RAILWAY_PRIVATE_DOMAIN}}:4518,…` | カンマ区切り。**単数形（`ALTEROID_RUNNER_URL`）も引き続き読む**（両方読んで空白と重複を落とす。`parseRunnerUrls`）ので、既存の単数形が残っていても害は無い。app にだけ置く |

**デーモンはこれを起動時に1回だけ読む。** 実行中に名簿へ足す口は無い（`POST /runners` は無い）。だから**宛先を増やしたら app を上げ直すまで増えない** — 「Service は3つ在るのに宛先は1台」という状態が普通に起きるので、`verify.sh` はそこを別の観測として見ている。
| `RAILWAY_RUN_UID` | `0` | runner は子プロセスを uid 1001 へ降ろすのに特権が要り、`USER node` のままだと**起動を拒否する**（同じ UID で走り続けるより落ちる方を選んである）。**daemon は root で起きても自分で `node` へ降りる**（`docker/alteroidd`）ので、共有して構わない |
| `TZ` | `Asia/Tokyo` | 日報の締め時刻がこれで決まる |

自律の既定を変えるならこれも（省略しても動く。**自律は後から足す機能ではない**）。層とモデル帯の対応を差し替えるなら下の3つも同じ Shared Variables へ置く — ただし**こちらは設定ではなく、人間の承認の置き場である**（層とモデル帯の対応は設計判断であり、変更には人間の承認が要る。AGENTS.md 地雷5）。費用を詰めるための旋盤ではないので、既定でよければ置かない。置いた事実は起動時に必ず表へ出る。

| 変数                        | 値       |
| --------------------------- | -------- |
| `ALTEROID_DAILY_REPORT_AT`  | `22:00`  |
| `ALTEROID_INITIATIVE_EVERY` | `55`     |
| `ALTEROID_CLONE_MODEL`      | `fable`  |
| `ALTEROID_MANAGER_MODEL`    | `opus`   |
| `ALTEROID_WORKER_MODEL`     | `sonnet` |

**モデル帯の3つは Shared Variables で正しい。** `ALTEROID_MANAGER_MODEL` / `ALTEROID_WORKER_MODEL` を実際に SDK へ渡すのは `runner` で、そこが正本である。`app` も同じ値を読むが、使うのは自己認識に載せる**宣言**のためだけで、両方へ同じ値が降りているから食い違わない（片方にだけ置くと、クローンが「Opus に委譲している」と宣言しながら別の帯が走る）。空・空白のみは「未設定」として既定へ落ちるので、空で残っていても壊れない。

**これを実行環境プロファイル（`alteroid profile edit`）で解かないこと。** 読むのは器（`app` と `runner`）自身の環境変数なので、その先の SDK 子プロセスで評価されるプロファイルは届かない。そしてプロファイルは**クローン自身が `profile_write` で書ける** — そこから読めばクローンが自分のモデル帯を黙って差し替えられる ＝ 承認が承認でなくなる。上の「変数を増やす前にプロファイルを検討すること」の、数少ない例外である。

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

**`runner` を先に上げる。** daemon は起動時に runner の `/health` へ名乗りを聞きに行く（鍵無しで繋ぐくらいなら起動しない設計）。繋がらなければ最大2分は待ち直すので順番を外しても収束するが、順番どおりなら待たずに上がる。

GitHub 連携で作った Service は push で自動デプロイされる（`watchPatterns` に当たる変更のときだけ）。初回だけダッシュボードから `runner` → `app` の順に Deploy を押す。

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

```bash
./railway/verify.sh
```

下の確認を全部回して、**通らなかったら 0 を返さない**。「!!」が出たものは運用の間違いではなく実装のバグとして扱う（理由は各項に書いてある）。能力が落ちていないかも一緒に見る（`GH_TOKEN` を置いたのに走っている runner に無い、など）。

以下はそれが何をしているかで、手で確かめるときはこれを打つ。境界が本当に立っているかは、思い込みではなく runner の中から確かめる。

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

**長い仕事を頼むときは、早めに push させること。** workspace はボリュームを付けていないので、runner が再デプロイされるとコミット前の変更は消える（「先に読む」3）。器が入れ替わっても仕事は取り直され、消えたことも伝わるが（「デプロイは走行中の仕事を畳む操作である」）、**書いたものが戻るわけではない**。数時間かかる仕事を投げるなら、`/workspace` にボリュームを付ける。**「その間マージしない」だけでは足りなくなった** — 反映は前回からの差分を出すので、自分が止めても**前のマージが未反映で残っていれば次の反映で出ていく。**

**クローン自身が PR を出す構成では、ここが輪になっていた。** マネージャーが出した PR を人間がマージした瞬間にデプロイが走り、まだ走っている別の仕事を畳む — 出した本人ごと畳まれることもあった（2026-08-18、#73）。**`release/prod` を夜に2回写す形にしてこの輪は切れている**（「デプロイは走行中の仕事を畳む操作である」1）。**マージしても、その瞬間には何も落ちない。** ただし落ちる時刻が自分の操作から離れただけなので、`/managers` を見る意味は消えていない — 見るのが「マージする前」から「長い仕事を投げる前」に変わった。

**M5 は実装だけでは受け入れ基準を満たさない。** 基準1が「runner を2台以上登録し、複数マネージャーが配置される」なので、`runner` Service をもう1つ（別の `ALTEROID_RUNNER_ID`）足して初めて確認できる。**足す手順は下の「runner を増やす」である。**

---

## runner を増やす（既存の器に足す）

```bash
./railway/scale-runners.sh -n 3 --dry-run   # 何をするか見る（何も作らない）
./railway/scale-runners.sh -n 3             # 計3台にする（足りないぶんだけ作る）
./railway/verify.sh                         # 3台とも境界が立っているか＋名簿に3台並ぶか
```

`setup.sh` は毎回新しいプロジェクトを作る（既存には触らない）。**こちらは逆で、いま走っているものだけを触る。**

### 何を触り、何を触らないか

| 対象              | どうする                                           | なぜ                                                                                               |
| ----------------- | -------------------------------------------------- | -------------------------------------------------------------------------------------------------- |
| 既存の `runner`   | **1文字も触らない**                                | 変数を置き直すと器が入れ替わり、その中で手を動かしているマネージャーと作業者が死ぬ                 |
| 新しい `runner-N` | 作る。**鍵はいま走っている `runner` から写す**     | 合鍵が1文字でも食い違うとデーモンは 401 を受けて `unusable` にする（待っても直らないので挑まない） |
| `app`             | `ALTEROID_RUNNER_URLS` を置いて**1度だけ上げ直す** | デーモンは宛先を起動時に1回だけ読む。置いただけでは走っているデーモンに届かない                    |

**写さないものが3種類ある。** `RAILWAY_*`（器ごとに Railway が注入する。ただし `RAILWAY_RUN_UID=0` は人間が置く設定なので置き直す）／`ALTEROID_RUNNER_ID`（台ごとに違う）／`ALTEROID_DATABASE_URL`（runner には無いはずのもの。**在ったら実装のバグ**なのでスクリプトはそこで止まる）。

**`.env` から作り直さない**のは、正本が「いま走っている器が持っているもの」だからである。手元のファイルが古い可能性を、増やす操作のたびに引き受ける理由が無い。

### app が入れ替わる、ということ

**マネージャーは畳まれない**（runner の中で走っている）。落ちるのはクローンのターン1本と chat の接続で、数十秒である。デーモンは起き直したときに runner へ名乗りを聞き、走っていた仕事を引き取る（「デプロイは走行中の仕事を畳む操作である」4）。

**新しい runner が上がらなかったときは、app に触らずに終わる**（非0）。上がっていない宛先を名簿へ載せると、デーモンは繋がらない相手へ挑み続ける（回数では諦めない）。直してからスクリプトを回し直せばよい — **既にある Service は作り直さないし、app へ既に3台を教えてあるなら上げ直さない。**

### 増えたことを確かめる

**「Service が3つ在る」と「デーモンが3台を宛先にしている」は別の観測である。**

```bash
./railway/verify.sh     # 全台の /proc/1/environ を見て、名簿にも聞く
```

`verify.sh` は台数を Railway 側から数える（`runner` / `runner-2` / …）ので、増やしたあとに引数を足す必要は無い。見ているのは:

- **全台**の境界（記憶ストアの鍵が無い／素の合鍵が残っていない／uid 1001 から制御面が 401）。**1台だけ見て済ませない** — 鍵を写して増やすので、写し間違いは「増やした台だけ守りが無い」形で出る
- **`runner_id` が台ごとに違うこと**（重複すると `manager_send` が黙って別の器へ届く）
- **デーモンの名簿の台数**（`GET /runners`）が Service の数と合っていること

手で見るなら、器の中から持ち主の資格で聞く。

```bash
railway ssh --service app
curl -s -H "authorization: Bearer $(node -e 'console.log(JSON.parse(require("fs").readFileSync(process.env.ALTEROID_HOME + "/state/daemon.json","utf8")).token)')" \
  "http://127.0.0.1:$ALTEROID_PORT/runners" | jq '[.runners[] | {runnerId, state, label}]'
```

### 減らすとき（自動ではやらない）

`-n` に今より小さい数を渡すと**断る**（非0）。台数を減らす操作は、その器で走っているマネージャーを移送できて初めて安全になり、移送は fencing（貸し出し期限）の後でしかできない（roadmap M5 PR4 → PR5）。**「落ちた」は観測の欠落であって停止の証明ではない**ので、いま減らすと同じセッションが2か所で走りうる。

手で消すなら、**その器に仕事が無いことを先に見る**（上の `GET /runners` と `/managers`）。消す順番は「app の `ALTEROID_RUNNER_URLS` から外して上げ直す → Service を消す」である。逆にすると、宛先だけが残って名簿が永久に挑み続ける。

---

## 症状から引く

| 症状                                                             | 原因                                                                                                                                                                                                                                                                                             |
| ---------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| `railway ssh` が一瞬で切れる（プロンプトは出る）                 | そのコンテナが再起動を繰り返している。ssh はデプロイに繋がっているので、器が入れ替わるとセッションごと落ちる。**ssh の問題ではない**ので `railway logs` を見る                                                                                                                                   |
| `GET /runners` の `state` が `unreachable` のまま戻らない        | 器の入れ替え中ならそのうち収束する（名簿が背景で挑み直し続ける。**回数では諦めない**）。デーモン自体は上がっているので chat も日誌も承認も動き、止まるのは委譲だけである。収束しないなら runner のログを見る                                                                                     |
| `alteroidd: runner (…) に鍵を拒まれた（401）`                    | 合鍵が食い違っている。**待っても直らないので挑み直さない**（`GET /runners` の `state` が `unusable` になり、クローンの受信箱にも届く）。 `ALTEROID_RUNNER_TOKEN` が Shared Variables にあり、app と runner の両方に紐づいているかを見る（片方だけに Service 変数で上書きが載っていると食い違う） |
| 委譲だけが返ってこない（chat と日誌は動く）                      | daemon が runner の `/health` へ届いていない。**デーモンは runner を待たずに上がる**ので、これは起動の失敗ではない。runner のログを見る（大抵 runner が上がっていない）。次に `ALTEROID_RUNNER_URL` のサービス名と `ALTEROID_RUNNER_BIND=::` を確認する                                          |
| 役が決まらない（`alteroidd` も `alteroid-runner` も走らない）    | その Service の **Config as Code のパスが未設定**。同じイメージから2役を出しているので、これが無いと `startCommand` が決まらない。Settings → Config as Code に `/railway/daemon.json` か `/railway/runner.json`（`setup.sh` はここを GraphQL で置く）                                            |
| コードを直したのに反映されない                                   | その Service の `watchPatterns` にパスが入っていない（`railway/*.json`）。新しいディレクトリを足したときに漏れやすい（`docker/**` のような、コードではないがイメージに焼かれるものがとくに危ない）                                                                                               |
| `alteroid-runner: ALTEROID_RUNNER_CHILD_UID が指定されているが…` | runner が root で走っていない。`RAILWAY_RUN_UID=0` が無い／名前に空白が混ざっている。**これは異常ではなく設計**で、同じ UID のまま走ると子プロセスが制御面に手を届かせるので、runner は起動を拒む                                                                                                |
| 変数を設定したのに効かない                                       | 名前の前後に空白。`railway variable list --json` で `repr` して検算する（上の「置いたら必ず名前を検算する」）                                                                                                                                                                                    |
| Service を足したのに `GET /runners` が増えない                   | **デーモンは宛先を起動時に1回だけ読む**（実行中に足す口は無い）。`app` の `ALTEROID_RUNNER_URLS` に並んでいるかを見て、並んでいるなら `app` を上げ直す。`--skip-deploys` で置いた変数は走っているプロセスに入らない                                                                              |
| `GET /runners` に同じ `runnerId` が2行並ぶ                       | どちらかの Service に `ALTEROID_RUNNER_ID` が無い（未設定は `runner-primary` を名乗る）か、Shared Variables に置いてしまっている。**この状態では `manager_send` が割り当て先ではない器へ黙って届く**（`RunnerRegistry#get` は線形一致）。台ごとに違う値を Service 変数で置く                     |
| 増やした台にだけ委譲が来ない                                     | その器が `lost` か `unusable` か見る（`GET /runners`）。`unusable` は鍵の食い違い（写し間違い）で、待っても直らない。`lost` なら器が上がっていない                                                                                                                                               |
| 日報が想定と違う時刻に出る                                       | `TZ` 未設定。既定の `22:00` は**コンテナのローカル時刻**なので、UTC のまま動くと日本時間の翌 7:00 になる                                                                                                                                                                                         |
| `env \| grep ALTEROID_DATABASE_URL` が runner で何か返す         | 慌てる前に行頭固定で取り直す。`RAILWAY_GIT_COMMIT_MESSAGE` にこの文書の一部が入っている                                                                                                                                                                                                          |
| runner の `/proc/1/environ` に素の合鍵が残っている               | 起動スクリプトを通っていない。`startCommand` が `alteroid-runner` か（`node apps/runner/dist/index.js` を直に叩くと畳みが起きない）。**運用の間違いではなく実装のバグ**として扱う                                                                                                                |
| マネージャーの commit が `Please tell me who you are` で失敗する | `GIT_AUTHOR_*` / `GIT_COMMITTER_*` が runner に無い（「マネージャーに GitHub を渡す」）                                                                                                                                                                                                          |
| マネージャーの push が 403 になる                                | **まず指紋を突き合わせる**（下記）。合っていないなら鍵が届いていない側の問題で、PAT の権限を疑うのは順番が違う。合っていて 403 なら、fine-grained PAT の Contents が Read-only か、対象リポジトリが選択されていない                                                                              |
| 鍵を差し替えたのにマネージャーが「権限が無い」と言い続ける       | **走行中のマネージャーに古い鍵が残っている。** `--skip-deploys` で置いた変数は走っているプロセスに入らない。`POST /runners/credentials` で回す（下記「鍵を回す」）                                                                                                                               |

---

## 既知のざらつき

1. **コミット前の変更はデプロイで消える。** `/workspace` にボリュームを付けていないため（「先に読む」3）。消えたことはマネージャーとクローンの両方に伝わるが、**戻せはしない**。roadmap M5「workspace locator の運用選択」を runner-volume に倒すまで残る
2. **runner を待っている2分の間、daemon は待ち受けを開かない。** chat・日誌・日報・承認への回答は runner に一切依存しないのに、委譲先が不在なだけで一緒に止まっている。素直な形は「先に listen し、runner へは背景で繋ぎ直し続け、委譲だけが一時的に失敗する」で、M5 で runner の登録・生存判定を入れるときに倒す。それまでの緩衝として `restartPolicyMaxRetries: 100` を置いてある（既定の10回だと、runner の不調が20分続いた時点で daemon が恒久停止し、人間が押しに行くまで戻らない）
3. **App Sleep を有効にしないこと。** 常駐は自律の前提であり、寝かせると起点②〜④が止まる
4. **Service は全部常時起動する**（app / runner × N / PostgreSQL）。止めてよいのは承認待ちの仕事だけで、器ではない。**台数はそのまま費用である** — だから `setup.sh` の既定は1台で、増やすのは人間が言ったときだけにしてある
5. **runner が3台あると、runner のコード変更は3台を同時に畳む。** 増やすことは「デプロイの事故の規模を増やすこと」でもある（「デプロイは走行中の仕事を畳む操作である」2）
6. **同じ `runner_id` の重複を、名簿は検出しない。** 置き方（`setup.sh` / `scale-runners.sh`）が構造として一意にし、`verify.sh` が事後に見る、という二段でしか守っていない。片側だけで言える形にするのは fencing（roadmap M5 PR4）である
