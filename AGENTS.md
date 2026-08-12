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
- クローンの挙動を SDK 抜きで検証したいときは `createClone({ queryFn })` に偽の `query` を渡す（`packages/core/src/clone.test.ts`）。マネージャー側は runner に偽の `query` を渡す（`createLocalRunner({ queryFn })` → `createRunnerRegistry`。`packages/core/src/manager.test.ts`）。デーモンと runner の境界そのものは `apps/daemon/src/runner-client.test.ts` が実際の HTTP 経路で通している

## クラウド構成（PostgreSQL と3コンテナ）

- 構成は **daemon（クローン＋記憶）/ manager-runner（SDK）/ PostgreSQL** の3つ。マネージャーは runner の中だけで走る
  - **runner に記憶ストアの鍵を足さないこと。** 足した瞬間、その中の子プロセス（＝マネージャー）が `/proc/1/environ` から鍵を取れる状態に戻り、分離した意味が消える
  - **繋ぎに行くのは常にデーモン側**（命令は HTTP、出来事は `GET /events` の SSE）。逆向きのコールバックを足すと、同じ経路でマネージャーが記憶へ届く
  - **制御面（runner API）はマネージャーから触れない形を崩さないこと。** 触れると自分宛の許可確認に自分で `allow` を返せる。守っているのは3枚（TCP を開かない / ソケットは 0600・デーモン所有 / 合鍵は runner にはハッシュだけ）＋ SDK 子プロセスを別 UID で走らせること
    - **素の合鍵を runner の環境変数に置かない。** 置いた瞬間、子プロセスが `/proc/1/environ` から読めるようになり3枚目が消える
    - 確認は `apps/runner/src/boundary.test.ts`（実際に子プロセスを起こして全経路を叩く）と、コンテナでは `docker compose exec -u 1001 runner curl --unix-socket ...`（繋がらないこと）
  - runner を立てていないローカルでは同一プロセスの runner に落ちる（`ALTEROID_RUNNER_URL` が無いとき）。**そのときは既知の穴が残る** — 塞ぐのはコンテナ構成の役目で、ツール削除ではない
  - 委譲の宛先は `RunnerRegistry` 越しに決める。固定 URL も runner のローカルパスもデーモンに書かない（M5 で runner が増える）
- 記憶の置き場は `ALTEROID_DATABASE_URL` の有無だけで決まる（無ければローカルの fs）。**器が違うだけで、上の層が見るものは同じ**。切り替えでできなくなることを作らない
  - 起動時にスキーマを自分で用意する（`packages/storage-pg/src/migrate.ts`）。「先にマイグレーションを流す」という人間の手順を足さないこと
  - `state/daemon.json`（CLI がデーモンを見つける手段）は pg 構成でもローカルに残る。記憶ではない
- `docker compose up -d` → `docker compose exec app alteroid chat`。`.env` に `CLAUDE_CODE_OAUTH_TOKEN`（`claude setup-token`）と `POSTGRES_PASSWORD` を置く。先に `mkdir -p workspace`（Docker に作らせると root 所有になり、コンテナ内の `node` が書けない＝「コンテナだからできない」が生まれる）
  - **ポートは公開していない。** 待ち受けは既定で 127.0.0.1（`ALTEROID_BIND` で開けられるが、開けるなら手前に境界を置くのが先）。runner だけは `ALTEROID_RUNNER_BIND=0.0.0.0` でデーモンから届かせるが、公開はしない
  - ネットワークも分けてある（`data`: daemon↔db / `control`: daemon↔runner）。**runner から db は名前解決すらできない**。ここを1つに戻すと、鍵を持たないという境界が「鍵を渡していないだけ」に薄まる
  - マネージャーへ渡す MCP 設定・プロジェクト設定は `workspace/`（＝runner コンテナの `/workspace`）に置く。cwd がそこなので `settingSources: ['project','local']` がそのまま拾う
  - 境界の確認は `docker compose exec runner env | grep ALTEROID_DATABASE_URL`（出ないこと）と `docker compose exec runner getent hosts db`（引けないこと）
  - マネージャーに PR を出させるなら `.env` に `GH_TOKEN` と `GIT_AUTHOR_*` / `GIT_COMMITTER_*` を足す（runner へ渡る）。無くても公開リポジトリの clone は通る。手順とスコープは [railway/README.md](./railway/README.md) の「マネージャーに GitHub を渡す」。**`gh` の版は固定していない** — 固定すると人間の手元より古い `gh` を配ることになり、その遅れがデグレードになる
- ホスティング（Railway）の手順は [railway/README.md](./railway/README.md)。**同じ3つを Service に写すだけだが、境界が2か所ゆるむ**（サービス間でボリュームを共有できないので制御面が TCP になる／`*.railway.internal` がフラットなので runner から db が名前解決できる）。ゆるみの内訳と、それでも残る守りは同文書に書いてある。**素の合鍵と `ALTEROID_DATABASE_URL` を Shared Variables に置かないこと** — 置いた瞬間に runner へ降りて、残った守りが消える
- pg ドライバのテストは PGlite（インプロセスの実 PostgreSQL）で回る。CI に DB を用意する必要はないが、**偽の DB で代用しない**（SQL と索引と冪等性ごと確かめる意味が消える）
- デーモン再起動時の引き取りは2通り。**runner が生きていれば繋ぎ直すだけ**（マネージャーは走り続けている）、**runner ごと落ちていれば実際に resume する**（JobStore の `session_id` ＋ 預かった生ログ）。どちらもクローンの受信箱へ知らせる
  - **走行中だったものを「話しかけられるまで止めておく」にしないこと。** 人間の不在で止まってよいのは承認待ちの仕事だけである（PRD「自律」）。待機（`done`）だったものだけが遅延 resume でよい

## 自律まわりの動かし方（起点4つ）

- **既定で動く。** 日報（既定 22:00）と発意 tick（既定 60 分）は何も設定しなくても回る。常駐と自律は後から足す機能ではないので、既定を「止まっている」にしないこと
  - `ALTEROID_DAILY_REPORT_AT`（`HH:MM` / `off`）、`ALTEROID_INITIATIVE_EVERY`（分 / `off`）、`ALTEROID_REPORT_LOOKBACK_DAYS`（起動時に遡って日報を作る日数、既定 3）
  - これらは**方針**の設定であって、暴走を止めるための回数制限ではない。抑止は実行環境の境界で行う（north_star 禁止2）
- 待たずに確かめるなら `POST /schedule/:kind/run`（chat では `/run daily_report` / `/run self_initiative`）。`GET /schedule` で次の発火が見える
- **外部イベントの入口は HTTP の `POST /events`**（`{source, payload}`）。送り元の形を変えられない webhook 用に `POST /events/:source`（本文まるごとが payload）もある。chat からは `/event <source> <本文>`
  - 開いているのは 127.0.0.1 だけ。外から叩かせるならトンネル・リバースプロキシ側に境界を置く（ここで認証を足す前に、それが方針か境界かを考える）
  - **鍵を置けば API 全体に本人確認が付く**（`ALTEROID_API_TOKEN` / 差し替えたいなら `ALTEROID_API_TOKEN_FILE`。`apps/daemon/src/auth.ts`）。置かなければ何も要求しない — ローカルの体験を公開したい人の都合で壊さないため。これは「誰か」を確かめるだけで、**通った先で何ができるかには触らない**（クローンの権限境界は記憶を根拠にした判断のまま）
    - 経路ごとに要否を選ばないこと。「この口は読むだけだから」という判断が入り込むと、その判断が漏れたところが穴になる。鍵なしで通るのは `GET /livez` と `GET /auth` だけである
  - **127.0.0.1 で待つことはブラウザからの保護にならない。** 人間が開いた任意のページが単純リクエスト（`text/plain` や form の POST）を投げられ、応答が読めなくても送信は成立する。状態を変える POST を足すときは、`zValidator('json', ...)` を付けるか、本文の無い経路なら `deliberateClient`（`apps/daemon/src/app.ts`）を必ず通すこと — でないと他人がクローンのターンを起こせる。塞ぐのは能力側ではなく実行環境の境界である
  - MCP 経由のポーリングは**別機構にしない**。「Slack を見に行く」は定期ジョブ＋マネージャーへの委譲で足りる（マネージャーは人間と同じ `.mcp.json` を持つ）
- 日報は `GET /reports` / `GET /reports/:date`、chat では `/report` `/reports`。**日報が無い日を作らないこと** — クローンが `daily_report_write` を呼び忘れたらその応答をそのまま日報にする実装になっている（`clone.ts` の `#dailyReport`）
- 溜まった承認待ちは chat の `/approvals`（番号付き）→ `/answer <番号> <回答>`、API では `POST /approvals/answer` にまとめて渡す
- 時間起点の確認を SDK 抜きでやるなら `createScheduler({ now, post })` に偽の時計を渡して `tick(日時)` を直接呼ぶ（`packages/core/src/schedule.test.ts`）。実 SDK での確認は `ALTEROID_INITIATIVE_EVERY=1`＋締め時刻を数分後にして放置するのが早い
