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

/**
 * `vitest.tmpdir.ts`（#1436 案B）の歯。
 *
 * **このファイル自身は `mkdtemp` / `mkdtempSync` を直接呼ばない** —
 * `scripts/no-direct-mkdtemp-core.mjs` の対象になるのはテストファイルの
 * 直接呼び出しであり、helper 自身のテストがそれを踏むと本末転倒になる。
 * 統合テスト（下の describe）が repo 直下に scratch を作る箇所は、
 * `mkdtemp` ではなく `mkdirSync` + `randomUUID()` で衝突しないディレクトリ名
 * を組み立てている（一意性の作り方が違うだけで、目的は同じ）。
 */

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

    // 記録が空の状態で drain してもエラーにならず、空を返す。
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
      expect(existsSync(dir)).toBe(true); // 消えていない
      expect(peekCreatedTempDirsForTesting()).toEqual([]); // 記録は空になる
    } finally {
      if (before === undefined) delete process.env.ALTEROID_KEEP_TEST_TMPDIRS;
      else process.env.ALTEROID_KEEP_TEST_TMPDIRS = before;
      // 残す口のテストなので、自分の後始末は自分でする（他の担い手の /tmp を汚さない）。
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
    // 実運用では vitest.setup.ts の afterAll が消す。ここでは単体テストとして
    // 明示的に drain を呼び、「最後まで生きていたこと」と「呼べば消えること」の
    // 両方をこの describe の中だけで確認する。
    expect(existsSync(dir)).toBe(true);
    const { dirs } = await drainCreatedTempDirsForCurrentFile();
    expect(dirs).toContain(dir);
    expect(existsSync(dir)).toBe(false);
  });
});

/**
 * ## 統合テスト — 実際に「テストファイルの最後」で消えることを、本物の
 * vitest.setup.ts 経由で確かめる。
 *
 * 上の単体テストは `drainCreatedTempDirsForCurrentFile` を自分で呼んでいるが、
 * 実運用でそれを呼ぶのは `vitest.setup.ts` の `afterAll` であり、この
 * ファイル自身では検証できない（このファイル自身の `afterAll` は当の
 * `vitest.setup.ts` の `afterAll` より先に走ってしまうため——ここが実測の
 * 対象そのもの）。だから実際に子プロセスとして別の vitest 実行を1回起こし、
 * その実行が終わった**後**に、外側であるこのプロセスから「もう無い」ことを
 * 確認する。
 *
 * scratch は repo 直下（`REPO_ROOT` 配下）に作る —— `vitest` / `vitest/config`
 * の bare import が node_modules を祖先方向へ解決できるようにするため
 * （`os.tmpdir()` の下だと祖先に node_modules が無く解決に失敗する）。
 * ディレクトリ名は `mkdtemp` を使わず `randomUUID()` で組み立てる（doc 冒頭
 * の注記のとおり）。
 */
describe('統合: 本物の vitest.setup.ts 経由で、ファイルの最後に消えることを確かめる', () => {
  let scratchRoot = '';

  beforeAll(() => {
    scratchRoot = join(REPO_ROOT, `.vitest-tmpdir-itest-${randomUUID()}`);
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
      // 2つの独立したフィクスチャファイルを同時に走らせ、「自分のファイルの
      // afterAll だけが自分のファイルの分を消し、隣のファイルの分を巻き込まない」
      // ことを、実際の2プロセス分離ではなく1回の vitest run の中の2ファイルで
      // 確かめる（pool=forks / isolate=true はこの repo の既定のまま——
      // vitest.config.ts を上書きしない）。
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
      });

      const manifestAContent = JSON.parse(readFileSync(manifestA, 'utf8')) as { dir: string };
      const manifestBContent = JSON.parse(readFileSync(manifestB, 'utf8')) as { dir: string };

      expect(manifestAContent.dir).not.toBe(manifestBContent.dir);
      // 子プロセスの実行そのものは緑だった（フィクスチャの it が
      // 「beforeAll で作った直後は存在する」ことを内側から assert しており、
      // execFileSync が例外を投げなかった時点でそれは通っている）。
      // ここで見るのは「ファイルの実行が終わった後の状態」——外側のこの
      // プロセスから、もう存在しないことを確認する。
      expect(existsSync(manifestAContent.dir)).toBe(false);
      expect(existsSync(manifestBContent.dir)).toBe(false);
    },
  );
});

/** フィクスチャの vitest.config.ts。本物の repo 設定を丸ごとは読み込まず、
 * `setupFiles` と `include` だけを持つ最小の構成にする——歯や他の設定を
 * 子プロセス側に持ち込む必要は無い。`vitest.setup.ts` は本物（`REPO_ROOT`
 * のもの）をそのまま再利用し、`drainCreatedTempDirsForCurrentFile` の配線を
 * 二重管理しない。 */
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

/** フィクスチャのテストファイル本体。`beforeAll` で1つ作り、複数の `it` が
 * 読み、マニフェストへパスを書き出す。作った後で自分では消さない——
 * `vitest.setup.ts`（本物）の `afterAll` が消すことを検証したいので、消して
 * しまうと何も測れなくなる。 */
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
