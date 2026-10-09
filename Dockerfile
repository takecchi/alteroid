# alteroidd をコンテナで常駐させる（roadmap M4）。
#
# ここで作るのは「ローカルと同じもの」の器である。能力を削った軽量版を作らない —
# マネージャーは実際に git を叩き、コマンドを走らせ、ファイルを書く（人間が
# Claude Code でやることと同じ）。だから ca-certificates・git・ripgrep のような
# 素の道具は入れる。入れないと「コンテナだからできない」が生まれ、それは仕様では
# なくバグである（north_star 禁止1）。

# Codex CLI（Issue #486 M7）の版。**版を持つ場所はここ1か所だけ**（`runtime` ステージの
# `npm install -g` も、CI の `image` の版の突き合わせも、後の段で `codex app-server
# generate-ts` のスキーマを生成するときも、この値を読む）。
#
# **`gh` などの素の道具とは逆に、版を固定する。** Codex の app-server のプロトコルは
# 版ごとに変わりうる（スキーマは `codex app-server generate-ts` が版ごとに吐く）ので、
# 器に入る版と、alteroid が型を生成した版がずれた瞬間に黙って壊れる。
# 上げるときは npm の `latest` dist-tag の安定版（alpha でないもの）を採る:
#   npm view @openai/codex dist-tags.latest
# 0.160.0 は 2026-10-02 に `latest` だったもの。
ARG CODEX_VERSION=0.160.0

# base は digest で固定する（Issue #3321）。タグだけだと Docker Hub 側の入れ替わりで
# image ジョブのキャッシュが外れる時刻を上流に任せることになる。digest は Renovate の PR で
# 上げる（`.github/renovate.json5`）。**build と runtime の2か所は同じ digest にそろえる**
# （Renovate は2か所を同じ依存として一緒に更新する）。
#
# Docker Hub（`node:…`）ではなく ECR Public のミラーから取る。夜の release/prod で全
# プロジェクトの app と runner が一斉にビルドし、Railway のビルダーが Docker Hub の匿名の
# 取得制限（429 Too Many Requests）に当たってビルドが落ちた（2026-10-10 JST）。
# ミラーは Docker 公式イメージと同じ digest を持つので、中身は digest のまま変わらない。
FROM public.ecr.aws/docker/library/node:22-trixie-slim@sha256:154ba2f4d6fec323d28e4f4bb86bba4677f1223391a1979cf521304e03a98dfa AS build

ENV PNPM_HOME=/pnpm
ENV PATH=$PNPM_HOME:$PATH
ENV CI=true
RUN corepack enable

WORKDIR /app

# 依存の解決に要るものだけ先に置く（ソース変更でインストールをやり直さない）
COPY package.json pnpm-lock.yaml pnpm-workspace.yaml ./
COPY packages/core/package.json packages/core/
COPY packages/storage-fs/package.json packages/storage-fs/
COPY packages/storage-pg/package.json packages/storage-pg/
# 外部向けの生成クライアント。この器では使わないが、ワークスペースの一員なので
# 置かないと `--frozen-lockfile` が「lockfile と合わない」で落ちる
COPY packages/api-client/package.json packages/api-client/
# 公式の画面。**この器では配信しない**（静的成果物なので置き場は人間が選ぶ）が、
# 同じくワークスペースの一員なので、置かないと `--frozen-lockfile` が落ちる
COPY apps/web/package.json apps/web/
# 画面から切り出した3つ（見た目・純ロジック・通信の層）。apps/web と同じ理由で置く
COPY packages/ui/package.json packages/ui/
COPY packages/logic/package.json packages/logic/
COPY packages/swr/package.json packages/swr/
COPY apps/daemon/package.json apps/daemon/
COPY apps/runner/package.json apps/runner/
COPY apps/cli/package.json apps/cli/
RUN pnpm install --frozen-lockfile

COPY . .

# デーモンと runner の自己認識に載るリビジョン。**`.git` はビルド文脈に入れない**
# ので（.dockerignore）、`ALTEROID_BUILD_REV` を渡さない限り、焼き込みは
# `write-canon.mjs` の git フォールバックに委ねられる（`CANON_REVISION_SOURCE`
# が `'workspace'` になる。それも取れなければ空——不明でも壊れない）。
#   docker build --build-arg ALTEROID_BUILD_REV=$(git rev-parse HEAD) .
#
# **`RAILWAY_GIT_COMMIT_SHA` はフォールバックの種として渡すだけ。** Railway が
# Dockerfile ビルドへ Service 変数を build arg として自動で渡すかどうかは、
# **確かめていない仮説である。** 渡らなければこの ARG は空のまま素通りするだけで
# 害は無い——そのときは実行時の `RAILWAY_GIT_COMMIT_SHA`
# （`packages/core/src/revision.ts` の優先順位3、`source: 'platform'`）が拾う。
# **どちらの経路が実際に効いたかは、焼き込みが効けば `CANON_REVISION_SOURCE`
# （`'build'` になる）として、効かなければ実行時の `source: 'platform'` として
# 観測できる** — 仮説が外れても嘘の値には繋がらない。
ARG RAILWAY_GIT_COMMIT_SHA=""
ARG ALTEROID_BUILD_REV=""
ENV ALTEROID_BUILD_REV=${ALTEROID_BUILD_REV:-$RAILWAY_GIT_COMMIT_SHA}

RUN pnpm build


FROM public.ecr.aws/docker/library/node:22-trixie-slim@sha256:154ba2f4d6fec323d28e4f4bb86bba4677f1223391a1979cf521304e03a98dfa AS runtime

# マネージャーが人間と同じ手つきで作業するための素の道具（runner で使う）。
#
# **`gh` も素の道具である。** 人間の Claude Code には `gh` があるので、ここに無いと
# 「PR を出す」が層を下りた瞬間にできなくなる — それは仕様ではなくバグである
# （north_star 禁止1）。**`gh` は Debian の apt にも在る**（実測 2026-09-15、
# `packages.debian.org/trixie/gh`: trixie の main に `2.46.0-3` が在る）が、**版が
# 古い**（`cli.github.com` はこの実測時点で `2.100.0` を配っていた）ので、新しい版を
# 取りに GitHub 公式の apt リポジトリを足す（#806。以前ここは「Debian の apt には
# 無いので」と書いていたが、それは書かれた時点から偽だった）。
#
# **版は固定しない。** git / ripgrep / curl と同じ扱いにして、器を作り直したときに
# その時点の版が入るようにしてある。`gh` だけを固定版にすると、人間の手元より古い
# `gh` をマネージャーに持たせることになり、その遅れがそのままデグレードになる
# （新しい subcommand が「マネージャーだと使えない」として現れる）。版を揃える必要が
# 出たら、固定するのは `gh` 単体ではなくベースイメージごとである。
#
# **`tini` は runner の pid 1 になる init である（#315）。** `docker/alteroid-runner`
# が起動の最後で `exec tini -- node …` する（理由と `-g` を付けない理由はそのシムの
# 側に書いてある）。ここではベースイメージの Debian main のパッケージとして入れる
# だけで、`apt-get install` の行に足す形は `gh` と同じにする — パッケージが消えたり
# 名前が変わったら、この `image` ステージのビルドで気づける（下の `tini --version`
# が存在確認を兼ねる）。**`tini` は Debian main にしか無いので、これは成立する** —
# 消えれば `apt-get install` がそのまま落ちる。
#
# ⚠ **`gh` については同じ強さで成立しない（#806）。** `gh` は Debian main にも
# 在る（上のコメント）ので、`cli.github.com` と Debian main の両方が `gh` を配って
# いる状態になる。ふだんは版の高い `cli.github.com` 側が候補に選ばれるが、
# `cli.github.com` が消えた／到達できなくなった場合、apt は `apt-get install` を
# 落とさずに Debian 側の古い `gh` へ静かに落ちる。`gh --version` もその古い版で
# 通ってしまうので、**「存在確認を兼ねる」は存在は確かめるが、どこから来たかは
# 確かめない** — 版が何マイナーも戻ってもビルドは緑のままで、壊れるのは実行時
# である。取得元（`apt-cache policy gh` 等）まで検査する歯を足す案はビルドに1段
# 乗るので、入れるかどうかは費用対効果を見て別に判断する。
#
# **`postgresql-17` / `postgresql-17-pgvector` も同じ RUN に足す（#965 段2）。**
# 委譲先の器には docker も postgres も無く、DB を要る検証（mnemora #247 が典型）が
# 「判定不能」で止まっていた。ここに足すのは、作業者が使い捨てのクラスタを
# 自分の作業ディレクトリへ都度立てるための「道具」である — マネージャーの道具と
# 同じ扱い（上のコメント参照）。
#
# **実際に立てるのは uid 1001（`worker`。下の `ENV ALTEROID_RUNNER_CHILD_UID`）
# であって、root でも `postgres` システムユーザーでもない。** apt が作る
# `postgres` システムユーザーは Debian の作法（`pg_createcluster` 経由）の
# ためのもので、ここでは使わない — `/etc/postgresql` を焼いていないので
# `pg_createcluster` / `pg_ctlcluster` はそもそも使えない（下で消す）。
# **作業者は `initdb` / `pg_ctl` を非 root のまま自分の作業ディレクトリで直に
# 叩く。** 実際に通る手順は `AGENTS.md`「自分が走っている器」に書く（机上では
# なく、CI の `image` ジョブで uid 1001 のまま通したものを転記する）。
#
# **外部の apt 出所は要らない。** `postgresql-17` / `postgresql-17-pgvector` は
# どちらも Debian trixie の main（= このイメージが最初から使っている
# `deb.debian.org` のソース）に在る。PGDG のような別ソース・別鍵は足していない
# （実測は #965 と、この行を足した PR の本文に書く）。
#
# **`postgresql-17-pgvector` の依存 `postgresql-17-jit-llvm (>= 19)` は、
# パッケージとしては存在しない（`apt-cache show` で確認できない）が、
# `postgresql-17` 自身がその名前を仮想パッケージとして provide しており
# （`Provides: postgresql-17-jit-llvm (= 19)`）、依存は解決する。** 一見
# 壊れて見える依存なので、ここに書いておく。
#
# **`locales` を明示で足す。** `postgresql-17` の Depends は `locales |
# locales-all` という選択式で、`locales-all`（≈231MiB）は `locales`
# （≈15MiB）の15倍太い。どちらも入っていない器では apt が先に書かれた方を
# 選ぶ実装が多いが、選ぶ根拠を apt の内部ヒューリスティックに委ねたくないので、
# 欲しい方（`locales`）をここで名指しして固定する。
#
# **既定クラスタは焼かない。** `postgresql-common` の postinst が
# `/var/lib/postgresql/17/main` を initdb 済みで自動生成するが、これは
# 使われないまま太りだけを増やす（イメージには空のクラスタではなく道具だけを
# 置きたい）。同じ RUN の中で消し、層に残さない。
RUN set -eux; \
  apt-get update; \
  apt-get install -y --no-install-recommends ca-certificates curl; \
  install -m 0755 -d /etc/apt/keyrings; \
  curl -fsSL https://cli.github.com/packages/githubcli-archive-keyring.gpg \
    -o /etc/apt/keyrings/githubcli-archive-keyring.gpg; \
  chmod 0644 /etc/apt/keyrings/githubcli-archive-keyring.gpg; \
  echo "deb [arch=$(dpkg --print-architecture) signed-by=/etc/apt/keyrings/githubcli-archive-keyring.gpg] https://cli.github.com/packages stable main" \
    > /etc/apt/sources.list.d/github-cli.list; \
  apt-get update; \
  apt-get install -y --no-install-recommends \
    git ripgrep jq gh tini \
    locales postgresql-17 postgresql-17-pgvector; \
  rm -rf /etc/postgresql /var/lib/postgresql/17/main; \
  rm -rf /var/lib/apt/lists/*; \
  gh --version; \
  tini --version; \
  /usr/lib/postgresql/17/bin/postgres --version

# git の資格情報は `gh` から借りる（人間が `gh auth setup-git` でやることと同じ）。
# **鍵をイメージに焼かない。** ここにあるのは経路だけである。
# Codex CLI。版は先頭の `ARG CODEX_VERSION`（ステージをまたぐには再宣言が要る）。
# root で `-g` に入れるので、uid 1001（マネージャーが走る主体）からは読んで実行する
# だけである。**`CODEX_HOME`（認証情報の置き場）はここでは決めない** — 鍵も
# auth.json もイメージには焼かない。
# `codex --version` が版と一致することは CI の `image` が uid 1001 で見る。
ARG CODEX_VERSION
RUN set -eux; \
  npm install -g --omit=dev --no-fund --no-audit "@openai/codex@${CODEX_VERSION}"; \
  npm cache clean --force; \
  codex --version

RUN git config --system credential.https://github.com.helper '!gh auth git-credential'

# `gh` は鍵を**呼ばれるたびにファイルから**読む。
#
# **なぜ環境変数のままではだめか。** env で渡すと、鍵は runner のプロセスが起動した
# 瞬間に凍る。人間が鍵を差し替えても、器を作り直すまで届かない —「鍵を直す」と
# 「走行中の仕事を失う」が同じ操作になる。しかも既に走っている SDK 子プロセスには
# 永久に届かない（プロセスの環境変数は外から書き換えられない）。
#
# このシムを通せば、`gh` も、`gh` から資格情報を借りる `git` も、**次の呼び出しから**
# 新しい鍵を使う。走行中のマネージャーを殺さずに鍵が回る。
#
# 能力は1つも減っていない。`gh` の版も引数もそのままで、変えたのは鍵の読み場所だけ。
#
# **中身は `docker/gh` に在る（#865）。** 独立ファイルにして歯（`docker/gh.test.ts`）を掛けている。
# 以前は、マネージャー・作業者の層が `gh` 経由で release-prod（本番デプロイ）を起動するのを止める門も
# ここに在ったが、外した（#2884）。確認は Bash の `PreToolUse`（`bash-release-prod-guard.ts`）が持つ。
COPY docker/gh /usr/local/bin/gh
RUN chmod 0755 /usr/local/bin/gh; \
  test -x /usr/bin/gh
# 鍵の置き場。中身は runner が起動時と差し替え時に書く（イメージには入らない）。
# 一覧はできなくてよいので 0711 — 読めるのは、名前を知っている子プロセスだけである。
RUN install -d -m 0711 /run/alteroid/credentials

# 実行環境プロファイル（人間の `~/.zprofile` に当たるもの）の置き場。
#
# **中身はイメージに入らないし、runner が取りに行くこともない。** 本文は記憶
# ストア側にあり、デーモンが繋いだときに制御面で降ろす（runner に記憶ストアの鍵は
# 無い）。ここに用意するのは器だけである。
RUN install -d -m 0711 /run/alteroid/profile

# クローンの道具の中継（Issue #486 48(a) 案D）の Unix ソケットの置き場。
#
# **上の2つ（0711）とは絞りが違う。** あちらはデーモンと別 UID の runner
# からも読む必要があるが、この中継はデーモンと同じ UID のクローンの子
# プロセスとしか繋がない（`clone-tool-relay-host.ts` の doc）ので、他の
# UID には traverse すら要らない——0700 にする。**デーモン起動時にも
# `createCloneToolRelayHost` が同じ mode で作り直す**（このイメージのぶんは
# volume の初回コピー用の下地であって、実際の絞り込みは実行時にも重ねて
# 効く）。
#
# **持ち主は node（デーモンが降りた先の主体、uid 1000）にする。** root の持ち物の
# 0700 だと、デーモンは中へ入れず、`createCloneToolRelayHost` の listen も chmod も
# 失敗する（落ちるのは stdio のときだけ。既定の sdk ではこの置き場を使わない）。
RUN install -d -m 0700 -o node -g node /run/alteroid/clone-tool-relay

# マネージャー層の peer 専用ソケット（Issue #486 S7）の置き場。
#
# **Codex の資格（ChatGPT ログインか `CODEX_API_KEY`）が1度も届かない器では、この中にソケットは
# 作られない**（器だけがある）。資格が初めて届いたときに runner が作る（#4118）。
# 0711 は、別 UID（降ろした子）が名前を知っていれば traverse できるようにするため（一覧は不可）。
# ソケット自身は、runner（root）が子の UID だけを持ち主にした 0600 で作る。
# **同じ子の UID の別プロセスからもソケット自体には届く。守りはセッションごとの使い捨ての token。**
# runner も開くときに同じ mode で作り直す（`createPeerSocketHost`）。以前はこの行が build
# ステージに在り、runtime のイメージには入っていなかった（#4118）。
RUN install -d -m 0711 /run/alteroid/peer

# マネージャー自身の道具（MCP `alteroid-manager`。#2987）のソケットの置き場。peer と違い、runner が
# 起動時に資格を待たずに作る。mode と持ち主の考え方は peer と同じ（0711 の置き場に、子の UID 持ちの 0600）。
# runner も開くときに同じ mode で作り直す（`createManagerToolsSocketHost`）。
RUN install -d -m 0711 /run/alteroid/manager

ENV PNPM_HOME=/pnpm
ENV PATH=$PNPM_HOME:$PATH
ENV CI=true
RUN corepack enable

WORKDIR /app

# 実行に要る依存だけを入れ直す（ビルド道具は持ち込まない）
COPY package.json pnpm-lock.yaml pnpm-workspace.yaml ./
COPY packages/core/package.json packages/core/
COPY packages/storage-fs/package.json packages/storage-fs/
COPY packages/storage-pg/package.json packages/storage-pg/
# 外部向けの生成クライアント。この器では使わないが、ワークスペースの一員なので
# 置かないと `--frozen-lockfile` が「lockfile と合わない」で落ちる
COPY packages/api-client/package.json packages/api-client/
# 公式の画面。**この器では配信しない**（静的成果物なので置き場は人間が選ぶ）が、
# 同じくワークスペースの一員なので、置かないと `--frozen-lockfile` が落ちる
COPY apps/web/package.json apps/web/
# 画面から切り出した3つ（見た目・純ロジック・通信の層）。apps/web と同じ理由で置く
COPY packages/ui/package.json packages/ui/
COPY packages/logic/package.json packages/logic/
COPY packages/swr/package.json packages/swr/
COPY apps/daemon/package.json apps/daemon/
COPY apps/runner/package.json apps/runner/
COPY apps/cli/package.json apps/cli/
#
# **`/app` の持ち主を node にする `chown -R` は、ここ（install と同じ層）でやる。**
# 後段の別の `RUN chown -R node:node /app` にすると、node_modules（約 190MB）が
# 丸ごともう一枚の層として複製される（overlay の copy-up）。実測（#2719、main の
# run 37174761244）: その RUN だけで 15 秒、層の export と `docker load` でさらに
# 数十秒。同じ層の中で済ませれば複製は起きず、最終的な持ち主は変わらない。
RUN pnpm install --prod --frozen-lockfile \
  && chown -R node:node /app

# `--chown` は上の理由（後段で /app を chown -R し直さない）と対になっている。
COPY --from=build --chown=node:node /app/packages/core/dist packages/core/dist
COPY --from=build --chown=node:node /app/packages/storage-fs/dist packages/storage-fs/dist
COPY --from=build --chown=node:node /app/packages/storage-pg/dist packages/storage-pg/dist
COPY --from=build --chown=node:node /app/apps/daemon/dist apps/daemon/dist
COPY --from=build --chown=node:node /app/apps/runner/dist apps/runner/dist
COPY --from=build --chown=node:node /app/apps/cli/dist apps/cli/dist

# `docker compose exec app alteroid chat` で入れるようにする。CLI はデーモンへの
# 薄いクライアントであり、コンテナの中から脳に接続する手段である。
RUN ln -sf /app/apps/cli/dist/index.js /usr/local/bin/alteroid \
  && chmod +x /app/apps/cli/dist/index.js /app/apps/daemon/dist/index.js \
    /app/apps/runner/dist/index.js

# 役ごとの起こし方。**`node <entry>` を直に叩かず、この2つを通す。**
#
# 器が引き受けているのは、人間が置く環境変数を app と runner で1つにするための
# 前処理だけである（合鍵を sha256 へ畳む / root で来たら降りる）。判断は無い。
COPY docker/alteroidd docker/alteroid-runner /usr/local/bin/
RUN chmod 0755 /usr/local/bin/alteroidd /usr/local/bin/alteroid-runner

# 人格データの置き場（pg 構成では state だけがここに残る）と、マネージャーの
# 作業ディレクトリ。**別々に持つ。** 記憶と実プロジェクトを同じ場所に置くと、
# マネージャーの作業が記憶の隣で行われることになる。
ENV ALTEROID_HOME=/data/alteroid
ENV ALTEROID_WORKSPACE=/workspace
RUN mkdir -p /data/alteroid /workspace \
  && chown -R node:node /data

# マネージャーと作業者を走らせる UID。**runner 本体（root）とは別にする。**
# 同じ UID だと、子プロセスが runner の /proc/1/environ を読み、制御面のソケットにも
# 繋げてしまう — 自分宛の許可確認に自分で allow を返せる状態になる。
RUN useradd --uid 1001 --create-home --shell /usr/sbin/nologin worker \
  && chown -R worker:worker /workspace
ENV ALTEROID_RUNNER_CHILD_UID=1001
ENV ALTEROID_RUNNER_CHILD_GID=1001
ENV ALTEROID_RUNNER_CHILD_HOME=/home/worker

# 待ち受けは 127.0.0.1 のまま（既定）。コンテナの外から叩きたい場合は
# ALTEROID_BIND を開けたうえで、手前に境界（認証・トンネル）を置くこと。
ENV ALTEROID_PORT=4517

# 既定はデーモン（＝非特権）。runner だけは compose 側で root へ上げる
# （子プロセスを別 UID へ降ろすのに特権が要るため。降ろした先が worker である）。
# root で起こされた場合、デーモンは自分で `node` へ降りる（`docker/alteroidd`）。
USER node

# 同じ像から2つの役を起こす（compose と Railway が command で選ぶ）:
#   デーモン: alteroidd         ← 記憶ストアの鍵を持つ。root で来たら node へ降りる
#   runner  : alteroid-runner   ← **鍵を持たない**。合鍵は起動時に sha256 へ畳む
CMD ["alteroidd"]

# 使う人ごとの道具を足す、ビルド時の追加層（#2534 段1）。**最終ステージはここ**
# （Railway は `target` を指定しないので最後のステージを焼き、compose の `build` にも
# `target` は無い）。上の「同じ像から2つの役」は、この `final` から起こす。
#
# 入力は build arg 2つ（Railway では Service 変数として渡る）:
#   ALTEROID_EXTRA_APT_PACKAGES  apt のパッケージ名（空白・改行区切り）
#   ALTEROID_EXTRA_SETUP         root で走らせる sh スクリプトの本文
# **どちらも空（既定）なら `docker/runner-extra` は何もせず、ファイル系は `runtime` と
# 変わらない**（CI の `image` が両者の差が無いことを見る）。ただし `RUN` の層は1枚増える
# ので image の digest は変わる。実行時の主体（uid 1001 の worker）の境界は変えない。
#
# **スクリプトは `COPY` で入れ、走らせたら同じ `RUN` の中で消す。** 最終のファイル系には
# 残らない（中身は `COPY` の層に残るが、リポジトリに在る公開の sh なので害は無い）。
# **`RUN --mount=type=bind` は使わないこと。** #2678 でそう書いたところ、Railway の3環境の
# ビルドが開始から約13秒で落ちた（2026-10-03T01:00Z、11d46a40。ビルドログは見ていない
# ので原因の特定ではないが、Dockerfile の変更はこの段だけだった）。CI の buildx では通る
# ので、CI が緑でも Railway で通る保証にはならない。
FROM runtime AS final
ARG ALTEROID_EXTRA_APT_PACKAGES=""
ARG ALTEROID_EXTRA_SETUP=""
USER root
COPY docker/runner-extra /usr/local/sbin/runner-extra
RUN sh /usr/local/sbin/runner-extra && rm -f /usr/local/sbin/runner-extra
USER node
# `CMD` は `runtime` から継ぐ（`alteroidd`。runner は command で選ぶ）。
