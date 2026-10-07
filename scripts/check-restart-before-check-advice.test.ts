import { execFileSync } from 'node:child_process';
import { readFileSync } from 'node:fs';
import { mkdir, writeFile } from 'node:fs/promises';
import { join } from 'node:path';

import { describe, expect, it } from 'vitest';

import { makeTempDir } from '../vitest.tmpdir.js';

import { gitChildEnv } from './git-child-env.js';

// 1行に畳む: `@ts-expect-error` は次の1行にしか効かず、多行 import だと `from` の行（TS7016 が出る場所）へ届かないため。
// prettier-ignore
// @ts-expect-error -- 素の .mjs（型宣言を持たない build 用スクリプト）を読む
import { BANNED_PHRASES, CHECKER_CORE_PATH, GENERATOR_PATH, findRestartBeforeCheckAdviceHits, isExempt, listScannableSources } from './check-restart-before-check-advice-core.mjs';

import {
  listGitScannableFiles,
  // @ts-expect-error -- 素の .mjs
} from './git-scannable-files-core.mjs';

type Hit = { path: string; id: string; text: string; why: string; line: number };
type Phrase = { id: string; text: string; why: string };

describe('check-restart-before-check-advice', () => {
  const oldPhrase = (BANNED_PHRASES as Phrase[]).find((p) => p.id === 'old');
  const unifiedPlain = (BANNED_PHRASES as Phrase[]).find((p) => p.id === 'unified-plain');
  const unifiedCode = (BANNED_PHRASES as Phrase[]).find((p) => p.id === 'unified-code');

  it('3つの字面（旧字面・統一後のバッククォート無し・統一後のバッククォート有り）を見ている', () => {
    expect(oldPhrase?.text).toBe('先に manager_start で起こし直さないこと');
    expect(unifiedPlain?.text).toBe('確かめる前に manager_start で起こし直さないこと');
    expect(unifiedCode?.text).toBe('確かめる前に `manager_start` で起こし直さないこと');
  });

  it('生成元の外に旧字面（「先に…」）が在れば捕まえる（＝空振りしない）', () => {
    const hits = findRestartBeforeCheckAdviceHits([
      {
        path: 'packages/core/src/tools.ts',
        content: `const x = '${oldPhrase?.text} — 同じ仕事が2本になる。';`,
      },
    ]) as Hit[];

    expect(hits).toHaveLength(1);
    expect(hits[0]?.id).toBe('old');
    expect(hits[0]?.line).toBe(1);
  });

  it('生成元の外に統一後の字面（バッククォート無し）を直接書けば捕まえる', () => {
    const hits = findRestartBeforeCheckAdviceHits([
      {
        path: 'packages/core/src/tools.ts',
        content: `const x = '${unifiedPlain?.text} — 同じ仕事が2本になる。';`,
      },
    ]) as Hit[];

    expect(hits).toHaveLength(1);
    expect(hits[0]?.id).toBe('unified-plain');
  });

  it('生成元の外に統一後の字面（バッククォート有り）を直接書けば捕まえる', () => {
    const hits = findRestartBeforeCheckAdviceHits([
      {
        path: 'packages/core/src/situation.ts',
        content: `const LOST_NOTICE = '${unifiedCode?.text} — 同じ仕事が2本になる。';`,
      },
    ]) as Hit[];

    expect(hits).toHaveLength(1);
    expect(hits[0]?.id).toBe('unified-code');
  });

  it('生成元のファイル自身は免除される（定数も、経緯の doc の引用も、そこに在るのが正しい）', () => {
    expect(isExempt(GENERATOR_PATH)).toBe(true);

    const hits = findRestartBeforeCheckAdviceHits([
      {
        path: GENERATOR_PATH,
        content:
          `export const A = '${oldPhrase?.text}';\n` +
          `export const B = '${unifiedPlain?.text}';\n` +
          `export const C = '${unifiedCode?.text}';`,
      },
    ]) as Hit[];

    expect(hits).toEqual([]);
  });

  it('テストは免除される（助言の字面を引いて当てる側であって、配る側ではない）', () => {
    const hits = findRestartBeforeCheckAdviceHits([
      {
        path: 'packages/core/src/tools.test.ts',
        content: `expect(reply).toContain('${unifiedPlain?.text}');`,
      },
    ]) as Hit[];

    expect(hits).toEqual([]);
  });

  it('⭐ この検査自身の core は免除される（探す字面の定義を持つので、必ず全部を含む）', () => {
    expect(isExempt(CHECKER_CORE_PATH)).toBe(true);

    const hits = findRestartBeforeCheckAdviceHits([
      {
        path: CHECKER_CORE_PATH,
        content: `text: '${oldPhrase?.text}', text2: '${unifiedPlain?.text}', text3: '${unifiedCode?.text}'`,
      },
    ]) as Hit[];

    expect(hits).toEqual([]);
  });

  it('⭐ CHECKER_CORE_PATH は実在し、実際に全部の字面を含む（免除が空振りしていない）', () => {
    const content = readFileSync(new URL(`../${CHECKER_CORE_PATH}`, import.meta.url), 'utf8');

    expect(content).toContain(oldPhrase?.text);
    expect(content).toContain(unifiedPlain?.text);
    expect(content).toContain(unifiedCode?.text);
  });

  it('manager.ts の言い換えの族（貸し出しの関門）は捕まえない（偽陽性で門を腐らせない）', () => {
    const hits = findRestartBeforeCheckAdviceHits([
      {
        path: 'packages/core/src/manager.ts',
        content:
          "const y = '**新しく起こし直さないこと** — 起こし直すと同じ仕事が2本になりえます。';\n" +
          "const z = '起こし直すと続きは失われるので、ここで起こし直さないこと。';",
      },
    ]) as Hit[];

    expect(hits).toEqual([]);
  });
});

describe('check-restart-before-check-advice: listScannableSources（Issue #1817）', () => {
  async function makeRepoWithUntrackedFiles(): Promise<string> {
    const dir = await makeTempDir('check-restart-before-check-advice-1817-');
    const git = (...gitArgs: string[]) =>
      execFileSync('git', gitArgs, { cwd: dir, encoding: 'utf8', env: gitChildEnv() });
    git('init', '-q');
    git('config', 'user.email', 'test@example.invalid');
    git('config', 'user.name', 'test');
    await writeFile(join(dir, 'tracked.ts'), 'export const ok = 1;\n');
    git('add', '-A');
    git('commit', '-qm', 'init');
    await writeFile(join(dir, 'new-untracked.ts'), '// new file, not staged yet\n');
    await writeFile(join(dir, 'new-untracked.md'), '# not scanned\n');
    return dir;
  }

  it('🔴（直す前の形）: 素の `git ls-files -z` は新規ファイルを見落とす', async () => {
    const dir = await makeRepoWithUntrackedFiles();
    const oldForm = execFileSync('git', ['ls-files', '-z'], {
      cwd: dir,
      encoding: 'utf8',
      env: gitChildEnv(),
    })
      .split('\0')
      .filter((p) => p.length > 0);
    expect(oldForm).not.toContain('new-untracked.ts');
  });

  it('🟢（直した後）: listScannableSources は同じ新規ファイルを対象に入れる', async () => {
    const dir = await makeRepoWithUntrackedFiles();
    const files = listScannableSources(dir) as string[];
    expect(files).toContain('new-untracked.ts');
    expect(files).toContain('tracked.ts');
    expect(files).not.toContain('new-untracked.md');
  });
});

describe('check-restart-before-check-advice: apps/web の .tsx を走査する（Issue #1873）', () => {
  const oldPhrase = (BANNED_PHRASES as Phrase[]).find((p) => p.id === 'old');

  async function makeRepoWithTsxFile(): Promise<string> {
    const dir = await makeTempDir('check-restart-before-check-advice-1873-');
    const git = (...gitArgs: string[]) =>
      execFileSync('git', gitArgs, { cwd: dir, encoding: 'utf8', env: gitChildEnv() });
    git('init', '-q');
    git('config', 'user.email', 'test@example.invalid');
    git('config', 'user.name', 'test');
    await mkdir(join(dir, 'apps/web/app/routes'), { recursive: true });
    await writeFile(
      join(dir, 'apps/web/app/routes/manager-detail.tsx'),
      `export const Notice = () => <p>${oldPhrase?.text} — 同じ仕事が2本になる。</p>;\n`,
    );
    git('add', '-A');
    git('commit', '-qm', 'init');
    return dir;
  }

  it('🔴（直す前の形）: 拡張子フィルタを .ts/.mjs/.js に絞ると apps/web の .tsx を見落とす', async () => {
    const dir = await makeRepoWithTsxFile();
    const oldSuffixes = ['.ts', '.mjs', '.js'];
    const oldForm = (listGitScannableFiles({ cwd: dir }) as string[]).filter((path) =>
      oldSuffixes.some((suffix) => path.endsWith(suffix)),
    );
    expect(oldForm).not.toContain('apps/web/app/routes/manager-detail.tsx');

    const hits = findRestartBeforeCheckAdviceHits(
      oldForm.map((path) => ({
        path,
        content: readFileSync(join(dir, path), 'utf8'),
      })),
    ) as Hit[];
    expect(hits).toEqual([]);
  });

  it('🟢（直した後）: listScannableSources は apps/web の .tsx も対象に入れ、直書きを捕まえる', async () => {
    const dir = await makeRepoWithTsxFile();
    const files = listScannableSources(dir) as string[];
    expect(files).toContain('apps/web/app/routes/manager-detail.tsx');

    const hits = findRestartBeforeCheckAdviceHits(
      files.map((path) => ({
        path,
        content: readFileSync(join(dir, path), 'utf8'),
      })),
    ) as Hit[];
    expect(hits).toHaveLength(1);
    expect(hits[0]?.path).toBe('apps/web/app/routes/manager-detail.tsx');
    expect(hits[0]?.id).toBe('old');
  });

  it('.test.tsx は免除される（Web のテストが助言の字面を引いて当てる側であるため）', () => {
    expect(isExempt('apps/web/app/routes/manager-detail.test.tsx')).toBe(true);
  });
});
