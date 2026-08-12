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
COPY apps/daemon/package.json apps/daemon/
COPY apps/runner/package.json apps/runner/
COPY apps/cli/package.json apps/cli/
RUN pnpm install --frozen-lockfile

COPY . .
RUN pnpm build


FROM node:22-bookworm-slim AS runtime

# マネージャーが人間と同じ手つきで作業するための素の道具（runner で使う）
RUN apt-get update \
  && apt-get install -y --no-install-recommends ca-certificates git ripgrep curl jq \
  && rm -rf /var/lib/apt/lists/*

# GitHub CLI。**人間の Claude Code には `gh` がある**ので、ここに無いと
# 「PR を出す」が層を下りた瞬間にできなくなる — それは仕様ではなくバグである
# （north_star 禁止1）。apt の bookworm には入っていないので公式リリースから取る。
ARG GH_VERSION=2.97.0
ARG TARGETARCH
RUN set -eux; \
  arch="${TARGETARCH:-amd64}"; \
  case "$arch" in \
    amd64 | arm64) ;; \
    *) echo "gh: 未対応のアーキテクチャ $arch" >&2; exit 1 ;; \
  esac; \
  dir="gh_${GH_VERSION}_linux_${arch}"; \
  curl -fsSL "https://github.com/cli/cli/releases/download/v${GH_VERSION}/${dir}.tar.gz" -o /tmp/gh.tgz; \
  tar -xzf /tmp/gh.tgz -C /tmp; \
  install -m 0755 "/tmp/${dir}/bin/gh" /usr/local/bin/gh; \
  rm -rf /tmp/gh.tgz "/tmp/${dir}"; \
  gh --version

# git の資格情報は `gh` から借りる（人間が `gh auth setup-git` でやることと同じ）。
# **鍵をイメージに焼かない。** ここにあるのは経路だけで、実際の鍵は runner の
# 環境変数（`GH_TOKEN`）から来る。トークンが無ければこのヘルパーは何も返さず、
# git は「資格情報が無い」として次へ進むだけである（公開リポジトリの clone は通る）。
RUN git config --system credential.https://github.com.helper '!gh auth git-credential'

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
USER node

# 同じ像から2つの役を起こす（compose が command で選ぶ）:
#   デーモン: node apps/daemon/dist/index.js   ← 記憶ストアの鍵を持つ
#   runner  : node apps/runner/dist/index.js   ← **鍵を持たない**。SDK を隔離して走らせる
CMD ["node", "apps/daemon/dist/index.js"]
