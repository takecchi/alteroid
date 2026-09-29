import path from 'node:path';
import { fileURLToPath } from 'node:url';

import { defineConfig, type ViteUserConfig } from 'vitest/config';

import rootConfig from './vitest.config.js';

/**
 * 各ワークスペース（`apps/*` / `packages/*`）の `vitest.config.ts` から呼ぶ
 * ための共通の1か所（#2157）。**写しを並べない**——中身は各ワークスペース側で
 * `workspaceVitestConfig(import.meta.url)` の1行だけになる。
 *
 * ## これが要る理由
 *
 * パッケージのディレクトリで vitest を**直接**叩くと（`cd apps/daemon &&
 * pnpm exec vitest run <file>` / `pnpm --filter <pkg> exec vitest run <file>`）、
 * それまで `apps/*` / `packages/*` のどこにも `vitest.config.*` が無かったため、
 * root の `vitest.config.ts` が一切効かなかった（#2157）——`setupFiles`
 * （`scrubSecretEnv` による秘密の env の除去・stdout 直書きを検出する歯・
 * 一時ディレクトリの後始末）も `clearMocks: false` も `~` の別名も掛からず、
 * **静かに軽い挙動へ倒れて緑になっていた**。`apps/web` だけは
 * `apps/web/vite.config.ts`（React Router プラグイン入り）を代わりに拾って
 * しまい、逆にうるさく落ちていた（`Error: React Router Vite plugin can't
 * detect preamble`）。
 *
 * vitest は設定ファイルを探すとき **`vitest.config.*` を `vite.config.*` より
 * 先に**（`root`＝このファイルの探索基点で）見る。各ワークスペースに
 * `vitest.config.ts` を置くだけで、`apps/web` が `vite.config.ts` を拾って
 * しまう経路も同時に断たれる——中身が何であってもよく、**存在すること自体**が
 * 効く。
 *
 * 各ワークスペースの `package.json` の `test` script（`node
 * ../../scripts/test.mjs --root=../.. --scope=…`）は `--root=../..` を
 * vitest へ渡しており、vitest はその
 * `--root` を設定ファイルの探索基点にも使う。**このファイルを足しても
 * `--root=../..` 付きの呼び出しは変わらない**——探索基点が repo の根のまま
 * なので、そちらは今までどおり root の `vitest.config.ts` を見つける
 * （このワークスペース側の `vitest.config.ts` は素通りされる）。実測は
 * `.claude/skills/test-in-chunks/SKILL.md`。
 *
 * ## `root` と `test.dir` の役割を分ける
 *
 * - **`root: repoRoot`** — `vitest.setup.ts` を含む `setupFiles` の相対パス
 *   （root の `vitest.config.ts` の `'./vitest.setup.ts'`）や `resolve.alias`
 *   の基準を、root から直接叩いたときと揃える。副作用として `RUN` 行に出る
 *   ディレクトリも repo の根になる。
 * - **`test.dir: packageDir`** — vitest は `config.dir`（無ければ
 *   `config.root`）を「`include` を glob するときの cwd」として使う
 *   （`vitest/dist/chunks/index.*.js` の `config.dir || config.root`。実測は
 *   `.claude/skills/test-in-chunks/SKILL.md`）。`root` を repo の根へ固定した
 *   まま `dir` だけをそのパッケージのディレクトリへ絞ることで、**走査対象を
 *   そのパッケージだけに限る**——root の8パターンをそのまま持ち込むと
 *   （`test.dir` は変えず `root` だけ変える形だと）他パッケージの
 *   テストまで拾ってしまうため、`include` は `dir` からの相対 glob
 *   （`'**\/*.test.{ts,tsx}'`）1本に置き換える。この1本は `src/` にも
 *   `app/`（apps/web）にも共通に効く——ディレクトリ名を個別に知る必要が無い。
 *
 * `include` は `mergeConfig`（vite）を使わず素の spread で上書きする——
 * `mergeConfig` は配列を**連結**するため、root の8パターン＋この1パターンに
 * なってしまい、絞り込みにならない。
 */
export function workspaceVitestConfig(importMetaUrl: string): ViteUserConfig {
  const repoRoot = fileURLToPath(new URL('.', import.meta.url));
  const packageDir = path.dirname(fileURLToPath(importMetaUrl));

  // `defineConfig(...)` で包む——TS6 は `declaration: true` の下で、この
  // 関数の戻り値の型を構造的に推論しようとすると vitest/vite の内部（非
  // export）の型（`BaseOptions` 等）まで辿ってしまい `TS2883` / `TS4058` で
  // 落ちる。`defineConfig` 自身が持つ名前付きの戻り値の型
  // （`ViteUserConfig`。vitest/vite が公開している）を経由させることで、
  // 構造的な推論をさせない。
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
