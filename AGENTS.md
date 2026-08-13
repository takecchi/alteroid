# AGENTS.md — alteroid を実装する AI への指示

## まず読む

1. [docs/north_star.md](./docs/north_star.md) — **正典**。プロダクトの全判断の基準
2. [docs/PRD.md](./docs/PRD.md) — 正典から導出された要件
3. [docs/architecture.md](./docs/architecture.md) — 設計
4. [docs/roadmap.md](./docs/roadmap.md) — 実装計画。**実装を引き継いだらここから着手する**

**これらの文書とコードが矛盾したら、バグなのはコードである**（優先順位は番号順）。実装の都合で要件を下げない。

## この文書の役割

ここに**要件は書かない**。書けば docs と二重管理になり、必ずずれる。ここにあるのは作業手順と、実装で踏みやすい地雷だけである。

## 用語

| 語           | 意味                                                                                                     |
| ------------ | -------------------------------------------------------------------------------------------------------- |
| クローン     | 人間の価値観をコピーした AI。人間の代理。**道具は全部持つ**が、重い実作業は方針として下へ委ねる（Fable） |
| マネージャー | 人間が使う Claude Code に相当する層。**能力の等価性の基準はここ**（Opus）                                |
| 作業者       | マネージャーがコストと文脈のために切り出した実作業の担い手。実装に限らない（Sonnet）                     |

## 作業を始める前に

`docs/north_star.md` の「立ち戻るための問い」を上から通す。1つでも引っかかったら、その設計のまま進めない。

## 踏みやすい地雷

いずれも「良かれと思って」入れたくなるものばかりで、入れた瞬間に北極星が壊れる。

| やりがちなこと                                            | なぜ違反か                                   | 代わりに                                                           |
| --------------------------------------------------------- | -------------------------------------------- | ------------------------------------------------------------------ |
| 作業者の `tools` を明示リストで絞る                       | 能力の削除（追加制限禁止）                   | preset 一式を渡す。SDK が増やしたツールに自動で追いつかせる        |
| ターン数上限・実行回数上限で暴走を止める                  | 同上                                         | 実行環境の境界（サンドボックス・ネットワーク・認証情報の配布範囲） |
| 確認が要る行為の一覧（`permissions.yaml` 的なもの）を作る | 権限境界はクローンの判断であって設定ではない | 記憶に根拠があるかで判断させ、判断を日誌に残す                     |
| 人間が `chat` を開いた時だけ動く作りにする                | 人間起点の固定（自律要件違反）               | 常駐させ、時間・外部イベント・クローン自身の発意からも仕事を起こす |
| 安いモデルに寄せる / 階層を潰して速くする                 | プロダクトの前提そのものの破壊               | Fable / Opus / Sonnet の対応は固定。変更には人間の承認が要る       |
| 能力の欠落を「スコープ外」と書いて正当化する              | デグレード禁止                               | できないならバグとして扱い、直す                                   |
| クローンの `tools` を絞る / 人間の MCP 連携を渡さない     | 能力の削除（追加制限禁止）                   | クローンにも preset 一式と MCP 連携を渡す。委譲は方針で表す        |
| 作業者を実装専用として設計する                            | 代行対象は調査・相談・確認・レビューも含む   | 仕事の型を実装に狭めない                                           |

## 実装の前提

- エージェント実行基盤は自作しない。**Claude Agent SDK をラップする**
- 外部サービス接続は **MCP**
- インターフェースは **CLI と HTTP API のみ**（Web UI とマルチユーザーは非ゴール）

## リポジトリの約束

- コミットメッセージ: `<type>: <description>`（type は feat / fix / refactor / docs / test / chore / perf / ci）
- **ブランチを切って PR を出す。main へ直接 push しない**（進捗チェックボックス以外の docs/ 変更も PR で人間の確認を通す）
- `docs/` は正典。**AI が単独で書き換えない。** 要件を変える必要が出たら手を止めて人間に確認する（例外: docs/roadmap.md の進捗チェックボックス更新のみ可）

## 開発手順

- 実行系の版は **`mise.toml`**（Node / pnpm）。`mise install` で揃える。CI も同じファイルを読む（`jdx/mise-action`）ので、ここを直せば両方が動く
  - mise を使わないなら Node 22 系 / pnpm は `package.json` の `packageManager` に合わせる（`corepack enable`）
- `pnpm install` → `pnpm build` → `pnpm typecheck` / `pnpm lint` / `pnpm format:check` / `pnpm test`
- **build が先。** ワークスペース間の型解決が各パッケージの `dist/` に依存するため、build 前の typecheck / test は失敗する
- TypeScript は 6 系に固定（typescript-eslint が TS 7 未対応のため。`pnpm-workspace.yaml` の catalog 参照）。TS6 は `@types` を自動で取り込まないので、新パッケージには `@types/node`（`catalog:`）を devDependencies に入れる
- 新しい依存の追加はバージョンを catalog（`pnpm-workspace.yaml`）に寄せられるか先に検討する
- CI はイメージ（`runtime` ステージ）も焼き、**uid 1001＝マネージャーが実際に走る主体**で道具が揃っているかを見る（`.github/workflows/ci.yml` の `image`）。マネージャーの道具は版を固定していないので、上流の変化で壊れたことに気づく場所はここしかない。手元で同じことをするなら `docker build --target runtime -t alteroid:ci .`

## 動かす

- `alteroid init` → `alteroid chat`。chat はデーモンが居なければ自分で起こす
- 人格データは既定で `~/.alteroid/`。**`ALTEROID_HOME` で差し替えられる**ので、動作確認は必ず一時ディレクトリを指すこと（自分の記憶を壊さない）
- デーモンの待ち受けポートは `ALTEROID_PORT`（既定 4517）。接続先とプロセス id は `$ALTEROID_HOME/state/daemon.json` にある
- マネージャーの既定の作業ディレクトリは `ALTEROID_WORKSPACE`（既定はデーモンの cwd）。**実プロジェクトを直に触るので、動作確認では捨ててよい一時ディレクトリを指すこと**
- `ALTEROID_HOME` `ALTEROID_PORT` `ALTEROID_DATABASE_URL` はマネージャー子プロセスの環境変数から落としてある（記憶ストアの所在を配らない）。ここに環境変数を足すときは、それが下へ漏れてよいものか先に考える。記憶へ到達する鍵を増やしたら `Storage.withheldEnvKeys`（`apps/daemon/src/storage.ts`）にも足すこと
  - **下へ渡す鍵を環境変数で固定しないこと。** env で配ると鍵は runner の起動時に凍り、人間が差し替えても器を作り直すまで届かない＝**「鍵を直す」と「走行中の仕事を失う」が同じ操作**になる。しかも既に走っている SDK 子プロセスには永久に届かない。鍵は器（`packages/core/src/credentials.ts`）に置き、`git` / `gh` が呼ばれるたびに読み直す形にしてある。回すのは `POST /runners/credentials`、突き合わせは `GET /runners`（指紋だけ。値は出さない）
  - **逆に、マネージャー自身の道具の鍵（`GH_TOKEN` `CLAUDE_CODE_OAUTH_TOKEN` MCP の認証情報など）は下へ渡すのが正しい。** これを「鍵は配らない」と混同して伏せると、人間が Claude Code でできる `gh pr create` が層を下りた瞬間にできなくなる＝デグレード（north_star 禁止1）。伏せるのは**上（記憶）へ到達する鍵**だけであって、**下（外の世界）へ手を伸ばす鍵**ではない
- SDK を実際に呼ぶ確認は `curl -N -X POST http://127.0.0.1:$PORT/chat -d '{"text":"..."}'` が手軽。ローカルの `claude` のログイン認証がそのまま使われる
- 委譲まわりの確認は `GET /managers`（一覧と状態）、`GET /managers/:id/transcript`（生ログ）、`GET /journal?type=tool_use`（マネージャー・作業者の全ツール実行）を見る。chat からは `/managers` `/manager <id>`
- **API の仕様は `GET /openapi.json`（OpenAPI 3.1）、人間が読むなら `GET /docs`。** 経路の zod スキーマから機械生成しており、`pnpm build` が `apps/daemon/openapi.json` を毎回書き直す。**手書きの spec を別に置かないこと**（二重管理になって必ずずれる）
  - コミット済みの spec とコードがずれたら CI が落ちる（`.github/workflows/ci.yml` の「OpenAPI spec がコードと一致しているか」）。**経路やスキーマを変えたら `pnpm build` して `openapi.json` の差分も一緒にコミットすること**
  - 外部向けの生成クライアントは `packages/api-client`（`openapi-typescript` + `openapi-fetch`）。**CLI はこれを使わない** — 同一リポジトリからは `hono/client` の型共有で足りているので無理に置き換えない。生成クライアントは外へ出す成果物である
  - 対象は**デーモンの API だけ**。runner の API は制御面であって外へ出すものではない（触れると自分宛の許可確認に自分で答えられる）
- クローンの挙動を SDK 抜きで検証したいときは `createClone({ queryFn })` に偽の `query` を渡す（`packages/core/src/clone.test.ts`）。マネージャー側は runner に偽の `query` を渡す（`createLocalRunner({ queryFn })` → `createRunnerRegistry`。`packages/core/src/manager.test.ts`）。デーモンと runner の境界そのものは `apps/daemon/src/runner-client.test.ts` が実際の HTTP 経路で通している

## ログインとアクセス許可（入口の認証）

**PRD「権限境界」と混同しないこと。** あちらは「クローンが何を人間へ確認するか」を*記憶*で決める話で、行為の一覧を持ってはいけない。ここは「そもそも誰が HTTP API に触れるか」の話であり、north_star 禁止2 が制限の表現方法として**認めている実行環境の境界**（認証情報の配布範囲）そのものである。持っているのは**許可されているか否かの2値だけ**で、クローン・マネージャー・作業者の道具は1つも減らない。

- マルチユーザーではない（PRD 非ゴール）。**持ち主が複数の端末・複数のログイン手段から入れるようにするための層**であって、利用者ごとにデータを分けない
- **通る資格は2種類**。①`Authorization: Bearer <アクセストークン>`（`alteroid login` で発行。許可されたアカウントのものだけ通る）②`Authorization: Bearer <state/daemon.json の token>`（＝**実行環境の持ち主**。CLI が使う。この口だけが `/access/*` を叩ける）
  - ②が「最初の1人を誰が通すか」の出口である。守っているのは**ファイルの許可**であって新しい秘密ではない。これが無いと誰も `access grant` を実行できない
- **既定では認証を要求しない。** `ALTEROID_GOOGLE_CLIENT_ID` と `ALTEROID_GOOGLE_CLIENT_SECRET` が揃うと自動で有効になり、`ALTEROID_AUTH=off` で明示的に切れる。設定していない人の `alteroid chat` が突然通らなくなるのは、境界の導入が実質のデグレードになる典型なので、**既定を「要求する」に倒さないこと**
- **ログインしただけでは使えない。** `alteroid access list` で見て `alteroid access grant <id>` で通す。取り消しは `revoke` で、**発行済みトークンを消さなくても即座に効く**（許可はリクエストごとに見ている）
- **許可されたアカウントは高々1つ**（2つ目の `grant` は 409）。ここを開けるとログインした人数だけ同じクローンの記憶・日誌・実行 API が開き、そのままマルチユーザーになる（PRD 非ゴール）。**「データを分けない」ことは「複数人を受け入れない」ことではない** — 受け入れないことは grant 側で強制する。持ち主を移すときは先に `revoke` する
- **不変条件はストアの1操作に閉じること。** ここは同じ失敗を3度踏んでいる場所である。ログインの経路は「読む → 外の世界と話す → 書く」の形をしていて、その真ん中が遅いので**必ず割り込まれる**と考えること
  - `beginLoginExchange` — `pending → processing`。**外部プロバイダとの交換へ進む権利**を1本に絞る。ブラウザの再送やプロキシのリトライで同じ callback が並行に届くのは普通に起きて、両方が交換すると認可コードは一度きりなので片方が必ず失敗し、その失敗が古い写しから `failed` を書いて成功側の `authenticated` を上書きしうる
    - **テストは「交換が1回だけ起きたか」を見ること。** 上書きが起きるかは処理順に依るので、最終状態だけを見るテストは通ってしまう（実際に通った）
  - `claimLoginRequest` — 消費とトークン保存を**1操作で**行う。「読む→検査→書く」に割ると同じ claim の並行送信で二重発行になり、「先に consumed→後で保存」に割ると保存失敗でログインを回収できなくなる（トークンは返らないのに要求は消費済み）
  - `grantExclusive` — 「他に持ち主が居なければ許可する」を1操作で。一覧を見てから書く形だと、持ち主が居ない状態の同時 grant を両方すり抜けて**マルチユーザーになる**
  - fs は1回の書き込み、pg はトランザクションと**部分一意索引**（`auth_accounts_single_owner_idx`）で強制する。**drizzle は例外を包むので、一意制約違反は `cause` を辿って判定すること**（最前面だけ見ると制約違反が予期しない例外として漏れる）
- **`/access/*` に行為ごとのスコープを足さないこと。** 「chat は可・記憶の編集は不可」を入れた瞬間、それは地雷表3行目の `permissions.yaml` と同じ形になる
- **`/health` にトークンを載せ直さないこと。** かつては返していたが、いまその値は `access grant` を通せる資格そのものである。CLI は「提示して `operator` が返るか」で本人確認する（PID 再利用の検知としては同じ強さ）
- 認証の鍵は**上（記憶）へ到達する鍵**である（握られれば誰でもトークンを発行でき、API 経由で記憶に届く）。`GH_TOKEN` のような**下（外の世界）へ手を伸ばす鍵**とは扱いが逆で、落とす場所が2つある
  - **走っている runner**: `docker/alteroid-runner` が `exec` の前に `unset` する。人間は共有の1か所（`x-shared-env`）に置くだけでよく、runner はそれを持たない — 合鍵を sha256 へ畳むのとまったく同じ形である。CI の `image` ジョブが `/proc/1/environ` で見ている（**同時に `GH_TOKEN` が残ることも見る** — 「危なそうな名前を全部消す」方向へ倒れるとデグレードになる）
  - **マネージャー子プロセス**: デーモンが env から落とす（`AUTH_WITHHELD_ENV_KEYS`）。runner を立てないローカル構成でも塞がるようにするため
  - 環境変数名に `ALTEROID_` を付けてあるのは、人間が MCP で使う素の `GOOGLE_CLIENT_ID` を巻き添えで伏せないため
- ログイン手段を足すのは `packages/core/src/auth-providers.ts` に1つ書いて登録するだけ。**メール+パスワードは `oauth2` の枠に押し込まない**（`kind: 'password'` の枠を型として用意してある — パスワードは「外部の identity」ではなく「本人が持つ資格情報」で、概念が違う）
- **メールが一致しても既存アカウントへ相乗りさせない。** 別プロバイダで他人のメールを名乗れる以上、自動結合は乗っ取り経路になる。必ず別アカウントを作り、許可は人間が明示的に与える
- 動作確認: `alteroid login` / `alteroid whoami` / `alteroid access list|grant|revoke`。別のデーモンへ繋ぐなら `ALTEROID_URL=https://…`（手元のデーモンには**ログイン不要**で、状態ファイルを読めることで通る）
- コンテナでは `docker compose exec app alteroid access grant <id>`。Redirect URI は `<ALTEROID_PUBLIC_URL>/auth/google/callback` の1本だけ登録すればよい

## クラウド構成（PostgreSQL と3コンテナ）

- 構成は **daemon（クローン＋記憶）/ manager-runner（SDK）/ PostgreSQL** の3つ。マネージャーは runner の中だけで走る
  - **runner に記憶ストアの鍵を足さないこと。** 足した瞬間、その中の子プロセス（＝マネージャー）が `/proc/1/environ` から鍵を取れる状態に戻り、分離した意味が消える
  - **繋ぎに行くのは常にデーモン側**（命令は HTTP、出来事は `GET /events` の SSE）。逆向きのコールバックを足すと、同じ経路でマネージャーが記憶へ届く
  - **制御面（runner API）はマネージャーから触れない形を崩さないこと。** 触れると自分宛の許可確認に自分で `allow` を返せる。守っているのは3枚（TCP を開かない / ソケットは 0600・デーモン所有 / **走っている runner に残るのは合鍵のハッシュだけ**）＋ SDK 子プロセスを別 UID で走らせること
    - **素の合鍵を runner のプロセスに残さない。** 残った瞬間、子プロセスが `/proc/1/environ` から読めるようになり3枚目が消える
    - **人間が置く値は app と runner で同じでよい**（`ALTEROID_RUNNER_TOKEN`）。器の起動スクリプト（`docker/alteroid-runner`）が `exec` の前に sha256 へ畳んで素の値を落とす。**守りは「誰に配ったか」ではなく「走っている runner が何を持っているか」で決まる** — 人間に二重管理（素の値とハッシュを別々に置く）をさせても、ずれた瞬間に 401 が出続けるだけで1枚も守らない
    - 確認は `apps/runner/src/boundary.test.ts`（実際に子プロセスを起こして全経路を叩く）と、コンテナでは `docker compose exec -u 1001 runner curl --unix-socket ...`（繋がらないこと）
  - runner を立てていないローカルでは同一プロセスの runner に落ちる（`ALTEROID_RUNNER_URL` が無いとき）。**そのときは既知の穴が残る** — 塞ぐのはコンテナ構成の役目で、ツール削除ではない
  - 委譲の宛先は `RunnerRegistry` 越しに決める。固定 URL も runner のローカルパスもデーモンに書かない（M5 で runner が増える）
- 記憶の置き場は `ALTEROID_DATABASE_URL` の有無だけで決まる（無ければローカルの fs）。**器が違うだけで、上の層が見るものは同じ**。切り替えでできなくなることを作らない
  - 起動時にスキーマを自分で用意する（`packages/storage-pg/src/migrate.ts`）。「先にマイグレーションを流す」という人間の手順を足さないこと
  - `state/daemon.json`（CLI がデーモンを見つける手段）は pg 構成でもローカルに残る。記憶ではない
- `cp .env.example .env` → `docker compose up -d` → `docker compose exec app alteroid chat`。埋めるのは3つ（`CLAUDE_CODE_OAUTH_TOKEN` / `ALTEROID_RUNNER_TOKEN` / `POSTGRES_PASSWORD`）。ホストのディレクトリを workspace にするなら先に `mkdir -p workspace`（Docker に作らせると root 所有になり、コンテナ内の `node` が書けない＝「コンテナだからできない」が生まれる）
  - **環境変数は app と runner で同じものを渡す**（`compose.yaml` の `x-shared-env`）。**役ごとに違うのは `ALTEROID_DATABASE_URL` だけ**で、使う / 使わないは役が決める。ここへ変数を足すときは「runner に降りてよいか」だけを考えればよく、降りてはいけないなら app の `environment` に直接書く
  - 役は `command` で選ぶ。**`node <entry>` を直に叩かない** — `alteroidd`（root なら `node` へ降りる）と `alteroid-runner`（合鍵を畳んで素の値を落とす）が器側の前処理を持っている（`docker/`）
  - **ポートは公開していない。** 待ち受けは既定で 127.0.0.1（`ALTEROID_BIND` で開けられるが、開けるなら手前に境界を置くのが先）。runner だけは `ALTEROID_RUNNER_BIND=0.0.0.0` でデーモンから届かせるが、公開はしない
  - ネットワークも分けてある（`data`: daemon↔db / `control`: daemon↔runner）。**runner から db は名前解決すらできない**。ここを1つに戻すと、鍵を持たないという境界が「鍵を渡していないだけ」に薄まる
  - マネージャーへ渡す MCP 設定・プロジェクト設定は `workspace/`（＝runner コンテナの `/workspace`）に置く。cwd がそこなので `settingSources: ['project','local']` がそのまま拾う
  - 境界の確認は `docker compose exec runner env | grep ALTEROID_DATABASE_URL`（出ないこと）、`docker compose exec runner tr '\0' '\n' < /proc/1/environ | grep '^ALTEROID_RUNNER_TOKEN='`（出ないこと。sha256 だけが残る）、`docker compose exec runner getent hosts db`（引けないこと）
  - マネージャーに PR を出させるなら `.env` に `GH_TOKEN` と `GIT_AUTHOR_*` / `GIT_COMMITTER_*` を足す（両方へ渡る）。無くても公開リポジトリの clone は通る。手順とスコープは [railway/README.md](./railway/README.md) の「マネージャーに GitHub を渡す」。**`gh` の版は固定していない** — 固定すると人間の手元より古い `gh` を配ることになり、その遅れがデグレードになる
- ホスティング（Railway）の手順は [railway/README.md](./railway/README.md)。**同じ3つを Service に写すだけだが、境界が2か所ゆるむ**（サービス間でボリュームを共有できないので制御面が TCP になる／`*.railway.internal` がフラットなので runner から db が名前解決できる）。ゆるみの内訳と、それでも残る守りは同文書に書いてある。**Shared Variables に置かないのは `ALTEROID_DATABASE_URL` だけ** — 置いた瞬間に runner へ降りて、残った守りが消える（合鍵は runner 側で畳まれるので共有してよい）
- pg ドライバのテストは PGlite（インプロセスの実 PostgreSQL）で回る。CI に DB を用意する必要はないが、**偽の DB で代用しない**（SQL と索引と冪等性ごと確かめる意味が消える）
- デーモン再起動時の引き取りは2通り。**runner が生きていれば繋ぎ直すだけ**（マネージャーは走り続けている）、**runner ごと落ちていれば実際に resume する**（JobStore の `session_id` ＋ 預かった生ログ）。どちらもクローンの受信箱へ知らせる
  - **走行中だったものを「話しかけられるまで止めておく」にしないこと。** 人間の不在で止まってよいのは承認待ちの仕事だけである（PRD「自律」）。待機（`done`）だったものだけが遅延 resume でよい

## 自律まわりの動かし方（起点4つ）

- **既定で動く。** 日報（既定 22:00）と発意 tick（既定 60 分）は何も設定しなくても回る。常駐と自律は後から足す機能ではないので、既定を「止まっている」にしないこと
  - `ALTEROID_DAILY_REPORT_AT`（`HH:MM` / `off`）、`ALTEROID_INITIATIVE_EVERY`（分 / `off`）、`ALTEROID_REPORT_LOOKBACK_DAYS`（起動時に遡って日報を作る日数、既定 3）
  - これらは**方針**の設定であって、暴走を止めるための回数制限ではない。抑止は実行環境の境界で行う（north_star 禁止2）
- 待たずに確かめるなら `POST /schedule/:kind/run`（chat では `/run daily_report` / `/run self_initiative`）。`GET /schedule` で次の発火が見える
- **「定期的に〜しておいて」は記憶だけに書かせない。** 記憶は根拠を置く場所で時計を持たないので、そこにだけ書いた依頼は「発意 tick のときに思い出せるかどうか」の賭けになる。継続する依頼はクローンが `schedule_create`（`kind` ＋ `dailyAt` / `everyMinutes` / `cron` のどれか1つ ＋ 依頼の本文）で仕込み、時刻が来れば必ず受信箱へ届く形にする（`schedule_list` / `schedule_remove` で読む・外す）
  - 周期は3つ。曜日や月の指定が要るものは **cron 式**（`croner`。ローカル時刻。例 `0 10 * * 1`）で書く。**「毎日起きて曜日を見て何もしない」で代用しないこと** — 7回に6回は Fable のターンを空焼きする。読めない式は保存の時点で弾く（`scheduleSpecSchema`）ので、経路ごとに検査を足さない
  - 器は `ScheduleStore`（`packages/core/src/store.ts`）。fs では `~/.alteroid/jobs/schedules.json`、pg では `schedules` テーブル。**真実はストア側だけに置く** — スケジューラへ直接足す口を作ると、デーモン再起動で仕込みが消える
  - スケジューラは `refresh()` でストアを読み直す。内部タイマーが刻むたびに通るので、足した依頼は最大1分で効く。人間が API から足した時とデーモン起動時は明示的に呼んで待たせない
  - 発火イベントに載るのは `kind` だけである。**依頼の本文をイベントに載せないこと** — 載せた瞬間に発火時点の写しになり、人間が本文を直しても古い依頼で走る
  - **引き受け（`claimRun`）と完了（`completeRun`）を1つに戻さないこと。** 引き受けた印（`pendingRun`）だけを残して定期の基準（`lastScheduledRunAt`）は完了時に進める。片方に寄せると必ずどちらかが壊れる — 先に基準を進めれば claim 直後に落ちた回が「もう動いた」ことになって日次なら翌日まで消え、印だけにすると動いた後に落ちた回を止められない。印が残っていれば次の起動で配り直し、走りかけていた可能性をプロンプトに添える（`prompt.ts` の `unfinishedAt`）
  - **手で起こした1回（`POST /schedule/:kind/run`）で定期の予定をずらさない。** 発火の合図の `cause` で区別し、`manual` では観測用の `lastRunAt` だけを動かす。ここを混ぜると、手動実行のたびに位相が動く（再起動後に露呈する）
  - 依頼を直す経路（`schedule_create` / `POST /schedule`）では `lastScheduledRunAt` と `pendingRun` を**引き継ぐ**こと。落とすと、直した瞬間に位相が `createdAt` から引き直され、引き受けたまま終わっていない回も消える
  - 発火のたびに `lastRunAt` が付き、依頼の一覧と前回時刻は digest（`digest.ts`）にも常に載る。同じ issue に何本もマネージャーが立つのを止めるのはこの材料と `manager_list` であって、**同時数の上限ではない**（north_star 禁止2）
  - 人間側の口は `GET /schedule`（`request` / `lastRunAt` 付き）・`POST /schedule`・`DELETE /schedule/:kind`、chat では `/schedule` と `/unschedule <kind>`。`daily_report` / `self_initiative` の名前は奪えない（`RESERVED_SCHEDULE_KINDS`）
- **外部イベントの入口は HTTP の `POST /events`**（`{source, payload}`）。送り元の形を変えられない webhook 用に `POST /events/:source`（本文まるごとが payload）もある。chat からは `/event <source> <本文>`
  - 開いているのは 127.0.0.1 だけ。外から叩かせるならトンネル・リバースプロキシ側に境界を置く（ここで認証を足す前に、それが方針か境界かを考える）
  - **127.0.0.1 で待つことはブラウザからの保護にならない。** 人間が開いた任意のページが単純リクエスト（`text/plain` や form の POST）を投げられ、応答が読めなくても送信は成立する。状態を変える POST を足すときは、`zValidator('json', ...)` を付けるか、本文の無い経路なら `deliberateClient`（`apps/daemon/src/app.ts`）を必ず通すこと — でないと他人がクローンのターンを起こせる。塞ぐのは能力側ではなく実行環境の境界である
  - MCP 経由のポーリングは**別機構にしない**。「Slack を見に行く」は定期ジョブ＋マネージャーへの委譲で足りる（マネージャーは人間と同じ `.mcp.json` を持つ）
- 日報は `GET /reports` / `GET /reports/:date`、chat では `/report` `/reports`。**日報が無い日を作らないこと** — クローンが `daily_report_write` を呼び忘れたらその応答をそのまま日報にする実装になっている（`clone.ts` の `#dailyReport`）
- 溜まった承認待ちは chat の `/approvals`（番号付き）→ `/answer <番号> <回答>`、API では `POST /approvals/answer` にまとめて渡す
- 時間起点の確認を SDK 抜きでやるなら `createScheduler({ now, post })` に偽の時計を渡して `tick(日時)` を直接呼ぶ（`packages/core/src/schedule.test.ts`）。実 SDK での確認は `ALTEROID_INITIATIVE_EVERY=1`＋締め時刻を数分後にして放置するのが早い
