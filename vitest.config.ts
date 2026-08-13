import { defineConfig } from 'vitest/config';

export default defineConfig({
  test: {
    include: [
      'packages/*/src/**/*.test.ts',
      'apps/*/src/**/*.test.ts',
      // apps/web は react-router の作法で `app/` に置く（`src/` ではない）。
      'apps/*/app/**/*.test.ts',
    ],
  },
});
