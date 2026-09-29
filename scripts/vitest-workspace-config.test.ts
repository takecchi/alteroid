import { spawnSync } from 'node:child_process';
import { rm, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import { describe, expect, it } from 'vitest';

import rootConfig from '../vitest.config.js';
import { workspaceVitestConfig } from '../vitest.workspace-config.js';

const ROOT = fileURLToPath(new URL('..', import.meta.url));

/**
 * #2157: パッケージのディレクトリで vitest を**直接**叩いても
 * （`cd apps/daemon && pnpm exec vitest run <file>` / `pnpm --filter <pkg>
 * exec vitest run <file>`。`scripts/test.mjs` を経由しない）、root の
 * `vitest.config.ts` が持つもの（`setupFiles` / `clearMocks: false` / `~`
 * の別名）が効くようにした。この歯は2枚に分かれている。
 *
 * - **歯A（配線・純粋関数）**: `workspaceVitestConfig()` が返す設定の形を
 *   直接見る。速く・決定的。
 * - **歯B（統合）**: 本物の `vitest` バイナリを、実在するパッケージ
 *   （`packages/api-client`。全ワークスペース中もっとも軽い——2ファイル・
 *   10テスト）のディレクトリを cwd にして直接起こし、`setupFiles`
 *   （`scrubSecretEnv`）が実際に効くこと——ダミーの `GH_TOKEN` が消えている
 *   こと——を確かめる。`scripts/test.mjs` は経由しない（経由すると
 *   `--root=../..` を vitest へ渡すので、そもそも直接叩いた形の再現に
 *   ならない）。
 */
describe('vitest.workspace-config.ts の配線（#2157）', () => {
  it('歯A: root を repo の根に固定し、test.dir をそのパッケージへ絞り、include を1本に置き換える', () => {
    // `apps/cli/vitest.config.ts` から呼ばれた体で試す——ファイルは読まない
    // （`workspaceVitestConfig` は import.meta.url の文字列だけを見る純粋関数）。
    const fakeCallerUrl = new URL('../apps/cli/vitest.config.ts', import.meta.url).href;
    const config = workspaceVitestConfig(fakeCallerUrl);

    expect(config.root).toBe(ROOT);
    expect(config.test?.dir).toBe(path.join(ROOT, 'apps/cli'));
    expect(config.test?.include).toEqual(['**/*.test.{ts,tsx}']);

    // root の setupFiles / clearMocks / `~` の別名は、ハードコードで比較せず
    // root の vitest.config.ts 自身から読む——二重管理でずれないようにする
    // （`scripts/workspace-test-scripts.test.ts` が include を読む形と同じ作法）。
    expect(config.test?.setupFiles).toEqual(rootConfig.test?.setupFiles);
    expect(config.test?.clearMocks).toBe(rootConfig.test?.clearMocks);
    expect(config.resolve?.alias).toEqual(rootConfig.resolve?.alias);
  });

  it(
    '歯B（統合）: packages/api-client のディレクトリで vitest を直接叩いても setupFiles' +
      '（scrubSecretEnv によるダミー GH_TOKEN の除去）が効く',
    () => {
      const targetPackageDir = path.join(ROOT, 'packages/api-client');
      // 対象パッケージの本来のテスト一式には含めない（実装の保証ではなく
      // 配線の歯なので）。この it() の実行中だけ実在し、`finally` で必ず消す
      // ——`vitest.tmpdir.ts` の `makeTempDir` は `os.tmpdir()` の下に作るため
      // 使えない（vitest の `test.dir`＝そのパッケージのディレクトリの外に
      // 出ると、そのパッケージの `vitest.config.ts` の include に一致せず
      // 拾われない）。
      const probeRelPath = 'src/__vitest-workspace-config-probe.generated.test.ts';
      const probeAbsPath = path.join(targetPackageDir, probeRelPath);

      return writeFile(
        probeAbsPath,
        [
          "import { expect, it } from 'vitest';",
          '',
          "it('GH_TOKEN はテストの前に消えている（scrubSecretEnv、#2157 の歯）', () => {",
          '  expect(process.env.GH_TOKEN).toBeUndefined();',
          '});',
          '',
        ].join('\n'),
      )
        .then(() => {
          const vitestBin = path.join(ROOT, 'node_modules/.bin/vitest');
          // 親の env を丸ごとは渡さない（`scripts/check-no-env-passthrough-core.mjs`）。
          // 子（vitest 本体とその中の esbuild/rollup 等）が実際に必要とするのは
          // `PATH`（`node` 自身と、vitest が使うツールを見つけるため）だけである
          // （`scripts/mutate-cli-child-env.ts` の `mutateCliChildEnv()` と同じ形）。
          // ダミーの `GH_TOKEN` を明示で足す——本物の値は一度も登場しない。
          return spawnSync(vitestBin, ['run', probeRelPath, '--reporter=dot'], {
            cwd: targetPackageDir,
            env: {
              PATH: process.env.PATH ?? '',
              GH_TOKEN: 'dummy-not-a-real-token',
              // 出力に ANSI の色付けを混ぜない——下の集計行の正規表現一致を
              // 素の文字列だけで判定できるようにする。
              NO_COLOR: '1',
            },
            encoding: 'utf8',
          });
        })
        .finally(() => rm(probeAbsPath, { force: true }))
        .then((result) => {
          expect(
            result.status,
            `子の vitest が非0で終わった。\nstdout:\n${result.stdout}\nstderr:\n${result.stderr}`,
          ).toBe(0);
          expect(result.stdout).toMatch(/Tests\s+1 passed \(1\)/);
        });
    },
  );
});
