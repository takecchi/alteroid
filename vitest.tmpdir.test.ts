import { existsSync, mkdirSync, rmSync, writeFileSync, readFileSync } from 'node:fs';
import { randomUUID } from 'node:crypto';
import { execFileSync } from 'node:child_process';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

import { afterAll, beforeAll, describe, expect, it } from 'vitest';

import {
  drainCreatedTempDirsForCurrentFile,
  makeTempDir,
  makeTempDirSync,
  peekCreatedTempDirsForTesting,
} from './vitest.tmpdir.js';

// このファイル自身は `mkdtemp` / `mkdtempSync` を直接呼ばない: `scripts/no-direct-mkdtemp-core.mjs` の対象はテストファイルの直接呼び出しで、helper 自身のテストがそれを踏むと本末転倒になるため。統合テストの scratch は `mkdirSync` + `randomUUID()` で作る。

const REPO_ROOT = dirname(fileURLToPath(import.meta.url));

describe('makeTempDir / makeTempDirSync（単体）', () => {
  it('makeTempDir は実在するディレクトリを作り、drain で消える', async () => {
    const dir = await makeTempDir('alteroid-vitest-tmpdir-unit-async-');
    expect(existsSync(dir)).toBe(true);

    const { dirs, kept } = await drainCreatedTempDirsForCurrentFile();
    expect(kept).toBe(false);
    expect(dirs).toContain(dir);
    expect(existsSync(dir)).toBe(false);
  });

  it('makeTempDirSync は実在するディレクトリを作り、drain で消える', async () => {
    const dir = makeTempDirSync('alteroid-vitest-tmpdir-unit-sync-');
    expect(existsSync(dir)).toBe(true);

    const { dirs, kept } = await drainCreatedTempDirsForCurrentFile();
    expect(kept).toBe(false);
    expect(dirs).toContain(dir);
    expect(existsSync(dir)).toBe(false);
  });

  it('drain した直後は記録が空になる（二重に消そうとしない）', async () => {
    await makeTempDir('alteroid-vitest-tmpdir-unit-drain-once-');
    await drainCreatedTempDirsForCurrentFile();
    expect(peekCreatedTempDirsForTesting()).toEqual([]);

    const { dirs, kept } = await drainCreatedTempDirsForCurrentFile();
    expect(dirs).toEqual([]);
    expect(kept).toBe(false);
  });

  it('ALTEROID_KEEP_TEST_TMPDIRS=1 のときは消さずに記録だけ空にする', async () => {
    const dir = await makeTempDir('alteroid-vitest-tmpdir-unit-keep-');
    const before = process.env.ALTEROID_KEEP_TEST_TMPDIRS;
    process.env.ALTEROID_KEEP_TEST_TMPDIRS = '1';
    try {
      const { dirs, kept } = await drainCreatedTempDirsForCurrentFile();
      expect(kept).toBe(true);
      expect(dirs).toContain(dir);
      expect(existsSync(dir)).toBe(true);
      expect(peekCreatedTempDirsForTesting()).toEqual([]);
    } finally {
      if (before === undefined) delete process.env.ALTEROID_KEEP_TEST_TMPDIRS;
      else process.env.ALTEROID_KEEP_TEST_TMPDIRS = before;
      rmSync(dir, { recursive: true, force: true });
    }
  });
});

describe('beforeAll で作って複数の it が読む形（単体、drain は最後に手動で呼ぶ）', () => {
  let dir = '';

  beforeAll(async () => {
    dir = await makeTempDir('alteroid-vitest-tmpdir-unit-beforeall-');
    writeFileSync(join(dir, 'marker.txt'), 'ok');
  });

  it('1本目の it から読める', () => {
    expect(existsSync(join(dir, 'marker.txt'))).toBe(true);
  });

  it('2本目の it からも読める（afterEach では消えていない証拠）', () => {
    expect(existsSync(join(dir, 'marker.txt'))).toBe(true);
  });

  afterAll(async () => {
    expect(existsSync(dir)).toBe(true);
    const { dirs } = await drainCreatedTempDirsForCurrentFile();
    expect(dirs).toContain(dir);
    expect(existsSync(dir)).toBe(false);
  });
});

// 実際に子プロセスとして別の vitest 実行を起こし、終わった後に外側から「もう無い」ことを確認する: このファイル自身の `afterAll` は `vitest.setup.ts` の `afterAll` より先に走るため、ファイル内では検証できない。
// scratch は repo の中の `.scratch/` の下に作る: `os.tmpdir()` の下だと `vitest` の bare import が node_modules を解決できず、根の直下の `.vitest-*` は git に無視されておらず、同時に走る `check-no-env-passthrough` が一時の `.test.ts` を拾って落ちるため。
describe('統合: 本物の vitest.setup.ts 経由で、ファイルの最後に消えることを確かめる', () => {
  let scratchRoot = '';

  beforeAll(() => {
    scratchRoot = join(REPO_ROOT, '.scratch', `vitest-tmpdir-itest-${randomUUID()}`);
    mkdirSync(scratchRoot, { recursive: true });
  });

  afterAll(() => {
    if (scratchRoot) rmSync(scratchRoot, { recursive: true, force: true });
  });

  it(
    'beforeAll で作った2つの一時ディレクトリは、ファイル内では読めて、' +
      'ファイルの実行が終わった後には両方とも消えている。他方のファイルの' +
      'ぶんは互いに巻き込まない',
    () => {
      const manifestA = join(scratchRoot, 'manifest-a.json');
      const manifestB = join(scratchRoot, 'manifest-b.json');
      writeFileSync(join(scratchRoot, 'fixture-a.test.ts'), buildFixture(manifestA, 'a'));
      writeFileSync(join(scratchRoot, 'fixture-b.test.ts'), buildFixture(manifestB, 'b'));
      writeFileSync(join(scratchRoot, 'vitest.config.ts'), buildFixtureConfig());

      const vitestBin = join(REPO_ROOT, 'node_modules', '.bin', 'vitest');
      execFileSync(vitestBin, ['run', '--root', scratchRoot], {
        cwd: scratchRoot,
        stdio: 'pipe',
        timeout: 60_000,
        // 子の vitest が要るのは `PATH` だけにする: 絞らずに渡すと、`isSecretEnvName` の規則に当たらず外されなかった変数がそのまま子の `process.env` に残るため。
        env: { PATH: process.env.PATH ?? '' },
      });

      const manifestAContent = JSON.parse(readFileSync(manifestA, 'utf8')) as { dir: string };
      const manifestBContent = JSON.parse(readFileSync(manifestB, 'utf8')) as { dir: string };

      expect(manifestAContent.dir).not.toBe(manifestBContent.dir);
      expect(existsSync(manifestAContent.dir)).toBe(false);
      expect(existsSync(manifestBContent.dir)).toBe(false);
    },
  );
});

function buildFixtureConfig(): string {
  const setupPath = join(REPO_ROOT, 'vitest.setup.ts').replace(/\\/g, '/');
  return [
    "import { defineConfig } from 'vitest/config';",
    '',
    'export default defineConfig({',
    '  test: {',
    `    setupFiles: [${JSON.stringify(setupPath)}],`,
    "    include: ['*.test.ts'],",
    '  },',
    '});',
    '',
  ].join('\n');
}

function buildFixture(manifestPath: string, label: string): string {
  const helperPath = join(REPO_ROOT, 'vitest.tmpdir.js').replace(/\\/g, '/');
  return [
    "import { existsSync, writeFileSync } from 'node:fs';",
    "import { beforeAll, expect, it } from 'vitest';",
    `import { makeTempDir } from ${JSON.stringify(helperPath)};`,
    '',
    'let dir = "";',
    '',
    'beforeAll(async () => {',
    `  dir = await makeTempDir('alteroid-vitest-tmpdir-itest-${label}-');`,
    `  writeFileSync(${JSON.stringify(manifestPath)}, JSON.stringify({ dir }));`,
    '});',
    '',
    `it('${label}: beforeAll が作った直後は存在する', () => {`,
    '  expect(existsSync(dir)).toBe(true);',
    '});',
    '',
    `it('${label}: 2本目の it からも読める', () => {`,
    '  expect(existsSync(dir)).toBe(true);',
    '});',
    '',
  ].join('\n');
}
