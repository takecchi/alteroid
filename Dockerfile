# alteroidd をコンテナで常駐させる（roadmap M4）。
#
# ここで作るのは「ローカルと同じもの」の器である。能力を削った軽量版を作らない —
# マネージャーは実際に git を叩き、コマンドを走らせ、ファイルを書く（人間が
# Claude Code でやることと同じ）。だから ca-certificates・git・ripgrep のような
# 素の道具は入れる。入れないと「コンテナだからできない」が生まれ、それは仕様では
# なくバグである（north_star 禁止1）。
FROM node:22-bookworm-slim AS build

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


FROM node:22-bookworm-slim AS runtime

# マネージャーが人間と同じ手つきで作業するための素の道具（runner で使う）。
#
# **`gh` も素の道具である。** 人間の Claude Code には `gh` があるので、ここに無いと
# 「PR を出す」が層を下りた瞬間にできなくなる — それは仕様ではなくバグである
# （north_star 禁止1）。Debian の apt には無いので GitHub 公式の apt リポジトリを足す。
#
# **版は固定しない。** git / ripgrep / curl と同じ扱いにして、器を作り直したときに
# その時点の版が入るようにしてある。`gh` だけを固定版にすると、人間の手元より古い
# `gh` をマネージャーに持たせることになり、その遅れがそのままデグレードになる
# （新しい subcommand が「マネージャーだと使えない」として現れる）。版を揃える必要が
# 出たら、固定するのは `gh` 単体ではなくベースイメージごとである。
#
# **`tini` は runner の pid 1 になる init である（#315）。** `docker/alteroid-runner`
# が起動の最後で `exec tini -- node …` する（理由と `-g` を付けない理由はそのシムの
# 側に書いてある）。ここでは Debian bookworm main のパッケージとして入れるだけで、
# `apt-get install` の行に足す形は `gh` と同じにする — パッケージが消えたり名前が
# 変わったら、この `image` ステージのビルドで気づける（下の `tini --version` が
# 存在確認を兼ねる。`gh --version` と同じ理由）。
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
  apt-get install -y --no-install-recommends git ripgrep jq gh tini; \
  rm -rf /var/lib/apt/lists/*; \
  gh --version; \
  tini --version

# git の資格情報は `gh` から借りる（人間が `gh auth setup-git` でやることと同じ）。
# **鍵をイメージに焼かない。** ここにあるのは経路だけである。
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
RUN set -eux; \
  printf '%s\n' \
    '#!/bin/sh' \
    '# 鍵は毎回ファイルから読む（走行中の差し替えを届かせるため）。' \
    '# **扱う鍵ぜんぶを読む。** 片方だけ読むと「回せる」と言いながら回らない鍵ができる。' \
    'd="${ALTEROID_CREDENTIAL_DIR:-/run/alteroid/credentials}"' \
    'for n in GH_TOKEN GITHUB_TOKEN; do' \
    '  eval "f=\${ALTEROID_${n}_FILE:-$d/$n}"' \
    '  [ -r "$f" ] || continue' \
    '  t="$(cat "$f")"' \
    '  # 空を export すると「鍵が無い」より悪い（hosts.yml も無視される）' \
    '  [ -n "$t" ] || continue' \
    '  eval "$n=\$t"; export "$n"' \
    'done' \
    '# 実行環境プロファイル（人間の .zprofile 相当）も読む。**鍵より後**に読むのは、' \
    '# 人間が明示的に書いたほうを勝たせるためである（`profile.ts` と同じ順序）。' \
    '# Bash 経由なら BASH_ENV で既に読まれているので、番人が二度読みを止める。' \
    'p="${ALTEROID_PROFILE_FILE:-/run/alteroid/profile/profile.sh}"' \
    '# 本文の標準出力は stderr へ寄せる（gh の出力に混ぜない）。' \
    'if [ -r "$p" ]; then . "$p" >&2 || true; fi' \
    'exec /usr/bin/gh "$@"' \
    > /usr/local/bin/gh; \
  chmod 0755 /usr/local/bin/gh; \
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
COPY apps/daemon/package.json apps/daemon/
COPY apps/runner/package.json apps/runner/
COPY apps/cli/package.json apps/cli/
RUN pnpm install --prod --frozen-lockfile

COPY --from=build /app/packages/core/dist packages/core/dist
COPY --from=build /app/packages/storage-fs/dist packages/storage-fs/dist
COPY --from=build /app/packages/storage-pg/dist packages/storage-pg/dist
COPY --from=build /app/apps/daemon/dist apps/daemon/dist
COPY --from=build /app/apps/runner/dist apps/runner/dist
COPY --from=build /app/apps/cli/dist apps/cli/dist

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
  && chown -R node:node /data /app

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
