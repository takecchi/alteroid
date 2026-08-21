---
name: cloud-deployment
description: クラウド構成（docker compose、PostgreSQL、daemon / manager-runner / db の3コンテナ、Railway）を触るときに読む。runner に記憶ストアの鍵を置かない境界、合鍵を sha256 へ畳む形、ネットワーク分離、.env に埋める3つ、デーモン再起動時の引き取り2通り。
---

# クラウド構成（PostgreSQL と3コンテナ）

<!-- AGENTS.md から移設。本文は1文字も変えていない。パスはリポジトリの根からの相対である。 -->

- 構成は **daemon（クローン＋記憶）/ manager-runner（SDK）/ PostgreSQL** の3つ。マネージャーは runner の中だけで走る
  - **runner に記憶ストアの鍵を足さないこと。** 足した瞬間、その中の子プロセス（＝マネージャー）が `/proc/1/environ` から鍵を取れる状態に戻り、分離した意味が消える
  - **繋ぎに行くのは常にデーモン側**（命令は HTTP、出来事は `GET /events` の SSE）。逆向きのコールバックを足すと、同じ経路でマネージャーが記憶へ届く
  - **制御面（runner API）はマネージャーから触れない形を崩さないこと。** 触れると自分宛の許可確認に自分で `allow` を返せる。守っているのは3枚（TCP を開かない / ソケットは 0600・デーモン所有 / **走っている runner に残るのは合鍵のハッシュだけ**）＋ SDK 子プロセスを別 UID で走らせること
    - **素の合鍵を runner のプロセスに残さない。** 残った瞬間、子プロセスが `/proc/1/environ` から読めるようになり3枚目が消える
    - **人間が置く値は app と runner で同じでよい**（`ALTEROID_RUNNER_TOKEN`）。器の起動スクリプト（`docker/alteroid-runner`）が `exec` の前に sha256 へ畳んで素の値を落とす。**守りは「誰に配ったか」ではなく「走っている runner が何を持っているか」で決まる** — 人間に二重管理（素の値とハッシュを別々に置く）をさせても、ずれた瞬間に 401 が出続けるだけで1枚も守らない
    - 確認は `apps/runner/src/boundary.test.ts`（実際に子プロセスを起こして全経路を叩く）と、コンテナでは `docker compose exec -u 1001 runner curl --unix-socket ...`（繋がらないこと）
  - runner を立てていないローカルでは同一プロセスの runner に落ちる（`ALTEROID_RUNNER_URL` が無いとき）。**そのときは既知の穴が残る** — 塞ぐのはコンテナ構成の役目で、ツール削除ではない
  - 委譲の宛先は `RunnerRegistry` 越しに決める。固定 URL も runner のローカルパスもデーモンに書かない
  - **runner は複数台置ける**（`ALTEROID_RUNNER_URLS` にカンマ区切り。単数形も引き続き効く）。**宛先は起動時に1回だけ読む** — 実行中に名簿へ足す口は無いので、増やしたらデーモンを上げ直すまで増えない。Railway で増やす手順は `railway/scale-runners.sh`（README「runner を増やす」）
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
- ホスティング（Railway）の手順は [railway/README.md](./railway/README.md)。**同じ3つを Service に写すだけだが、境界がいくつかゆるむ**（サービス間でボリュームを共有できないので制御面が TCP になる／`*.railway.internal` がフラットなので runner から db が名前解決でき、**外から叩ける形にすると runner からデーモンへも TCP が届く** — 守っているのはログイン認証だけになる）。**ここに数を書かないこと**（増えるたびに数え直すことになる。数え上げは同文書「先に読む」だけが持つ）。ゆるみの内訳と、それでも残る守りは同文書に書いてある。**Shared Variables に置かないものは2つ** — `ALTEROID_DATABASE_URL`（置いた瞬間に runner へ降りて、残った守りが消える。合鍵は runner 側で畳まれるので共有してよい）と `ALTEROID_RUNNER_ID`（**台ごとに違う値**である。共有すると全台が同じ id を名乗り、`manager_send` が割り当て先ではない器へ黙って届く — 名簿の `get` は線形一致で、重複を検出しない）
- pg ドライバのテストは PGlite（インプロセスの実 PostgreSQL）で回る。CI に DB を用意する必要はないが、**偽の DB で代用しない**（SQL と索引と冪等性ごと確かめる意味が消える）
- デーモン再起動時の引き取りは2通り。**runner が生きていれば繋ぎ直すだけ**（マネージャーは走り続けている）、**runner ごと落ちていれば実際に resume する**（JobStore の `session_id` ＋ 預かった生ログ）。どちらもクローンの受信箱へ知らせる
  - **走行中だったものを「話しかけられるまで止めておく」にしないこと。** 人間の不在で止まってよいのは承認待ちの仕事だけである（PRD「自律」）。待機（`done`）だったものだけが遅延 resume でよい
