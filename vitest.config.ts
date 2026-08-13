import { defineConfig } from 'vitest/config';

export default defineConfig({
  test: {
    // railway/ はパッケージではないが、置く変数の割り振り（役ごとにどの鍵が渡るか）は
    // 静かにずれても動作が正常に見えるので、ここで固定する
    include: ['packages/*/src/**/*.test.ts', 'apps/*/src/**/*.test.ts', 'railway/**/*.test.ts'],
  },
});
