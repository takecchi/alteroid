import { fileURLToPath } from 'node:url';

import { defineConfig } from 'vitest/config';

export default defineConfig({
  resolve: {
    alias: {
      // apps/web だけが使う別名。**アプリ側の vite.config.ts は tsconfig の paths から
      // 解いている**が、ここ（リポジトリ共通の vitest）はそれを読まないので同じ対応を置く。
      // 他のワークスペースは `~/` を使わないので、共通に置いても衝突しない。
      '~': fileURLToPath(new URL('./apps/web/app', import.meta.url)),
    },
  },
  test: {
    include: [
      'packages/*/src/**/*.test.ts',
      'apps/*/src/**/*.test.ts',
      // apps/web は react-router の作法で `app/` に置く（`src/` ではない）。
      // 画面を描いて試すものだけ `.tsx`（各ファイルの先頭で jsdom を指定する）。
      'apps/*/app/**/*.test.{ts,tsx}',
    ],
  },
});
