import { availableParallelism } from 'node:os';
import { fileURLToPath } from 'node:url';

import { defineConfig } from 'vitest/config';

// `--maxWorkers` を渡さなかったときの worker 数に上限を置く: 共有 runner の器では既定が 31 になり、CPU を取り合って非同期の表示の待ちが既定の上限に届き、落ちるテストが回ごとに変わるため。`--maxWorkers=<n>` を渡せばそちらが優先される。
export const MAX_WORKERS_CAP = 4;

export function defaultMaxWorkers(parallelism: number = availableParallelism()): number {
  return Math.min(MAX_WORKERS_CAP, Math.max(parallelism - 1, 1));
}

export default defineConfig({
  resolve: {
    alias: {
      '~': fileURLToPath(new URL('./apps/web/app', import.meta.url)),
      '@': fileURLToPath(new URL('./packages/ui/src', import.meta.url)),
    },
  },
  test: {
    setupFiles: ['./vitest.setup.ts'],
    globalSetup: ['./vitest.global-setup.ts'],
    // `clearMocks` は `false` に固定する: vitest 5 の既定 `true` だと各テストの前に呼び出し履歴が消え、テストの始まる前に起きた呼び出しを `not.toHaveBeenCalled()` が見なくなるため。`true` へ移すなら `not.toHaveBeenCalled` 系を数え直してから別の変更で入れる。
    clearMocks: false,
    maxWorkers: defaultMaxWorkers(),
    include: [
      '*.test.ts',
      'packages/*/src/**/*.test.ts',
      'packages/*/src/**/*.test.tsx',
      'apps/*/src/**/*.test.ts',
      'apps/*/app/**/*.test.{ts,tsx}',
      'railway/**/*.test.ts',
      '.github/scripts/**/*.test.ts',
      'scripts/**/*.test.ts',
      'docker/**/*.test.ts',
    ],
  },
});
