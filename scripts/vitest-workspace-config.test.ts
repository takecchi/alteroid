import { spawnSync } from 'node:child_process';
import { existsSync } from 'node:fs';
import { mkdir, rm, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import { describe, expect, it } from 'vitest';

import rootConfig from '../vitest.config.js';
import { workspaceVitestConfig } from '../vitest.workspace-config.js';

// @ts-expect-error -- 素の .mjs（型宣言を持たない）を読む。
import { listGitScannableFiles } from './git-scannable-files-core.mjs';

const ROOT = fileURLToPath(new URL('..', import.meta.url));

// `scripts/test.mjs` を経由せず vitest を直接起こす: 経由すると `--root=../..` を vitest へ渡すので、直接叩いた形の再現にならないため。
describe('vitest.workspace-config.ts の配線（#2157）', () => {
  it('歯A: root を repo の根に固定し、test.dir をそのパッケージへ絞り、include を1本に置き換える', () => {
    const fakeCallerUrl = new URL('../apps/cli/vitest.config.ts', import.meta.url).href;
    const config = workspaceVitestConfig(fakeCallerUrl);

    expect(config.root).toBe(ROOT);
    expect(config.test?.dir).toBe(path.join(ROOT, 'apps/cli'));
    expect(config.test?.include).toEqual(['**/*.test.{ts,tsx}']);

    // root の setupFiles / clearMocks / `~` の別名は root の vitest.config.ts から読む: ハードコードで比較すると二重管理でずれるため。
    expect(config.test?.setupFiles).toEqual(rootConfig.test?.setupFiles);
    expect(config.test?.clearMocks).toBe(rootConfig.test?.clearMocks);
    expect(config.resolve?.alias).toEqual(rootConfig.resolve?.alias);
  });

  it(
    '歯B（統合）: packages/api-client のディレクトリで vitest を直接叩いても setupFiles' +
      '（scrubSecretEnv によるダミー GH_TOKEN の除去）が効く',
    async () => {
      const targetPackageDir = path.join(ROOT, 'packages/api-client');

      // probe は `.gitignore` 済みの `src/generated/` に置く: `.gitignore` に入らない未追跡の `.test.ts` は、`pnpm test` を並べて回すと repo を走査する歯が拾うため。
      // `makeTempDir` は使わない: `os.tmpdir()` の下はパッケージの `vitest.config.ts` の include に一致しないため。
      const generatedDir = path.join(targetPackageDir, 'src/generated');
      const probeRelPath = 'src/generated/vitest-workspace-config-probe.test.ts';
      const probeAbsPath = path.join(targetPackageDir, probeRelPath);
      const probeRepoRelPath = path.relative(ROOT, probeAbsPath).split(path.sep).join('/');

      // 後始末は作った側が消す: 元から在ったディレクトリには `openapi.d.ts` 等の本物の生成物が入っているため残す。
      const generatedDirExistedBefore = existsSync(generatedDir);

      try {
        await mkdir(generatedDir, { recursive: true });
        await writeFile(
          probeAbsPath,
          [
            "import { expect, it } from 'vitest';",
            '',
            "it('GH_TOKEN はテストの前に消えている（scrubSecretEnv、#2157 の歯）', () => {",
            '  expect(process.env.GH_TOKEN).toBeUndefined();',
            '});',
            '',
          ].join('\n'),
        );

        const scannable: string[] = listGitScannableFiles({ cwd: ROOT });
        expect(
          scannable,
          `probe（${probeRepoRelPath}）が git ls-files -co --exclude-standard に出た` +
            '——.gitignore が効いていない。',
        ).not.toContain(probeRepoRelPath);

        const vitestBin = path.join(ROOT, 'node_modules/.bin/vitest');
        // 親の env を丸ごとは渡さない: 子が必要とするのは `PATH` だけで、`GH_TOKEN` はダミーを足す。
        const result = spawnSync(vitestBin, ['run', probeRelPath, '--reporter=dot'], {
          cwd: targetPackageDir,
          env: {
            PATH: process.env.PATH ?? '',
            GH_TOKEN: 'dummy-not-a-real-token',
            // 出力に ANSI の色付けを混ぜない: 下の集計行を正規表現で読むため。
            NO_COLOR: '1',
          },
          encoding: 'utf8',
        });

        expect(
          result.status,
          `子の vitest が非0で終わった。\nstdout:\n${result.stdout}\nstderr:\n${result.stderr}`,
        ).toBe(0);

        const testsLine = result.stdout.match(/Tests\s+(\d+) passed \((\d+)\)/);
        expect(testsLine, `集計行（Tests）が読めない。stdout:\n${result.stdout}`).not.toBeNull();
        const passedCount = Number(testsLine![1]);
        expect(passedCount, 'probe が0件のまま exit 0 になっている').toBeGreaterThan(0);
      } finally {
        await rm(probeAbsPath, { force: true });
        if (!generatedDirExistedBefore) {
          await rm(generatedDir, { recursive: true, force: true });
        }
      }
    },
  );
});
