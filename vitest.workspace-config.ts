import path from 'node:path';
import { fileURLToPath } from 'node:url';

import { defineConfig, type ViteUserConfig } from 'vitest/config';

import rootConfig from './vitest.config.js';

// `root` は repo の根へ固定し、`test.dir` だけをパッケージのディレクトリへ絞る: `include` は `config.dir || config.root` を cwd に glob されるので、root のパターンをそのまま持ち込むと他パッケージのテストまで拾うため。
// 各ワークスペースに `vitest.config.ts` を置く: vitest は `vitest.config.*` を `vite.config.*` より先に探すので、`apps/web` が `vite.config.ts`（React Router プラグイン入り）を拾う経路も断てるため。
// `include` は `mergeConfig` を使わず素の spread で上書きする: `mergeConfig` は配列を連結し、root の8パターン＋この1パターンになって絞り込みにならないため。
export function workspaceVitestConfig(importMetaUrl: string): ViteUserConfig {
  const repoRoot = fileURLToPath(new URL('.', import.meta.url));
  const packageDir = path.dirname(fileURLToPath(importMetaUrl));

  // `defineConfig(...)` で包む: TS6 は `declaration: true` の下で戻り値の型を構造的に推論すると vitest/vite の内部の型（`BaseOptions` 等）まで辿り、`TS2883` / `TS4058` で落ちるため。
  return defineConfig({
    ...rootConfig,
    root: repoRoot,
    test: {
      ...rootConfig.test,
      dir: packageDir,
      include: ['**/*.test.{ts,tsx}'],
    },
  });
}
