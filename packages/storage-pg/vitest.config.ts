import { defineConfig, mergeConfig } from 'vitest/config';

import { workspaceVitestConfig } from '../../vitest.workspace-config.js';

// 試験1本の既定の上限を 30 秒にする（vitest の既定は 5 秒）。実物の PostgreSQL の CI（`storage-pg を本物の PostgreSQL で`）では、
// 手元の数倍かかる（#6784: 手元 780ms の契約の試験が 5779ms で落ちた）。試験ごとの明示の上限（このパッケージでは 30_000 が最も多い）を
// 足し忘れた新しい試験が、同じ形で落ちないようにする。pin は `src/test-timeout-pin.test.ts`。
export default mergeConfig(
  workspaceVitestConfig(import.meta.url),
  defineConfig({ test: { testTimeout: 30_000 } }),
);
