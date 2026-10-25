import { fileURLToPath } from 'node:url';

import { defineConfig } from 'vitest/config';

const repo = (path: string) => fileURLToPath(new URL(`../../${path}`, import.meta.url));

// リポジトリの検査（root の vitest.config.ts の `include`）に掛からない場所で、測りだけを vitest（TS の変換と workspace の解決のため）で走らせる。
// root の setupFiles（環境変数の掃除・一時ディレクトリの掃除）は使わない: 測りの接続先は環境変数 BENCH_PG_URL で渡す。
// workspace の package は root の依存ではないので別名で解く: storage-pg と daemon は src（この枝の現物）、core は build 済みの dist（`pnpm --filter @alteroid/core build`）。
export default defineConfig({
  root: repo(''),
  resolve: {
    alias: [
      { find: '@alteroid/storage-pg', replacement: repo('packages/storage-pg/src/index.ts') },
      { find: '@alteroid/core', replacement: repo('packages/core/dist/index.js') },
    ],
  },
  test: {
    include: ['bench/conversations-list/*.bench.ts'],
    testTimeout: 3_600_000,
    hookTimeout: 3_600_000,
    fileParallelism: false,
    maxWorkers: 1,
    reporters: ['verbose'],
    disableConsoleIntercept: true,
  },
});
