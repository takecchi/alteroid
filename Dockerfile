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
COPY apps/cli/package.json apps/cli/
RUN pnpm install --frozen-lockfile

COPY . .
RUN pnpm build


FROM node:22-bookworm-slim AS runtime

# マネージャーが人間と同じ手つきで作業するための素の道具
RUN apt-get update \
  && apt-get install -y --no-install-recommends ca-certificates git ripgrep curl \
  && rm -rf /var/lib/apt/lists/*

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
COPY apps/cli/package.json apps/cli/
RUN pnpm install --prod --frozen-lockfile

COPY --from=build /app/packages/core/dist packages/core/dist
COPY --from=build /app/packages/storage-fs/dist packages/storage-fs/dist
COPY --from=build /app/packages/storage-pg/dist packages/storage-pg/dist
COPY --from=build /app/apps/daemon/dist apps/daemon/dist
COPY --from=build /app/apps/cli/dist apps/cli/dist

# `docker compose exec app alteroid chat` で入れるようにする。CLI はデーモンへの
# 薄いクライアントであり、コンテナの中から脳に接続する手段である。
RUN ln -sf /app/apps/cli/dist/index.js /usr/local/bin/alteroid \
  && chmod +x /app/apps/cli/dist/index.js /app/apps/daemon/dist/index.js

# 人格データの置き場（pg 構成では state だけがここに残る）と、マネージャーの
# 作業ディレクトリ。**別々に持つ。** 記憶と実プロジェクトを同じ場所に置くと、
# マネージャーの作業が記憶の隣で行われることになる。
ENV ALTEROID_HOME=/data/alteroid
ENV ALTEROID_WORKSPACE=/workspace
RUN mkdir -p /data/alteroid /workspace \
  && chown -R node:node /data /workspace /app

# 待ち受けは 127.0.0.1 のまま（既定）。コンテナの外から叩きたい場合は
# ALTEROID_BIND を開けたうえで、手前に境界（認証・トンネル）を置くこと。
ENV ALTEROID_PORT=4517

USER node

CMD ["node", "apps/daemon/dist/index.js"]
