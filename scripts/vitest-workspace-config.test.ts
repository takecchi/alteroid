import { spawnSync } from 'node:child_process';
import { existsSync } from 'node:fs';
import { mkdir, rm, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import { describe, expect, it } from 'vitest';

import rootConfig from '../vitest.config.js';
import { workspaceVitestConfig } from '../vitest.workspace-config.js';

// @ts-expect-error -- 素の .mjs（型宣言を持たない）を読む。
// `check-no-env-passthrough-core.mjs` 等と同じ集合を使い、この歯自身の
// probe ファイルが「これから commit されようとしているツリー」に
// 含まれないことを、そちらと同じ仕組みで確かめる。
import { listGitScannableFiles } from './git-scannable-files-core.mjs';

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
    async () => {
      const targetPackageDir = path.join(ROOT, 'packages/api-client');

      // **置き場所は `.gitignore` 済みで、かつそのパッケージの走査範囲に入る
      // 場所にする**（#2019 / PR #2020 と同じ理由——`.gitignore` に入らない
      // 未追跡の `.test.ts` は、`pnpm test` を並べて回すと `listGitScannableFiles`
      // 〔`git ls-files -co --exclude-standard`〕で repo を走査する歯
      // （`check-no-env-passthrough` の実物の走査・`workspace-test-scripts` 等）が
      // これを拾いうる）。`packages/api-client/src/generated/` は `.gitignore`
      // で無視済み（OpenAPI 型の生成物置き場。`pnpm build` が作る）で、
      // `**/*.test.{ts,tsx}` の対象にも入る——ここへ置く。
      //
      // `vitest.tmpdir.ts` の `makeTempDir` は `os.tmpdir()` の下に作るため
      // 使えない（vitest の `test.dir`＝そのパッケージのディレクトリの外に
      // 出ると、そのパッケージの `vitest.config.ts` の include に一致せず
      // 拾われない）。
      const generatedDir = path.join(targetPackageDir, 'src/generated');
      const probeRelPath = 'src/generated/vitest-workspace-config-probe.test.ts';
      const probeAbsPath = path.join(targetPackageDir, probeRelPath);
      const probeRepoRelPath = path.relative(ROOT, probeAbsPath).split(path.sep).join('/');

      // `pnpm build` が毎回作るので通常は既に存在するが、まだ build していない
      // 環境でも動くように、無ければ作る。**後始末は「作った側が消す」**——
      // 元から在ったディレクトリは残す（`openapi.d.ts` 等、本物の生成物が
      // 入っている）。
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

        // (a) `.gitignore` 済みなので、これから commit されようとしている
        // ツリーには出ない——`check-no-env-passthrough` 等が実際に使う集合
        // （`git ls-files -co --exclude-standard`）そのもので確かめる。
        const scannable: string[] = listGitScannableFiles({ cwd: ROOT });
        expect(
          scannable,
          `probe（${probeRepoRelPath}）が git ls-files -co --exclude-standard に出た` +
            '——.gitignore が効いていない。',
        ).not.toContain(probeRepoRelPath);

        const vitestBin = path.join(ROOT, 'node_modules/.bin/vitest');
        // 親の env を丸ごとは渡さない（`scripts/check-no-env-passthrough-core.mjs`）。
        // 子（vitest 本体とその中の esbuild/rollup 等）が実際に必要とするのは
        // `PATH`（`node` 自身と、vitest が使うツールを見つけるため）だけである
        // （`scripts/mutate-cli-child-env.ts` の `mutateCliChildEnv()` と同じ形）。
        // ダミーの `GH_TOKEN` を明示で足す——本物の値は一度も登場しない。
        const result = spawnSync(vitestBin, ['run', probeRelPath, '--reporter=dot'], {
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

        expect(
          result.status,
          `子の vitest が非0で終わった。\nstdout:\n${result.stdout}\nstderr:\n${result.stderr}`,
        ).toBe(0);

        // (b) probe が実際に走ったこと（0件で緑を名乗っていないこと）を、
        // 集計行の passed 件数を読んで確かめる——「走らなかったのに exit 0」
        // という別穴（歯A の doc、`scripts/test.mjs` の歯A と同じ形）を、
        // この統合の歯自身が踏んでいないことの確認でもある。
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
