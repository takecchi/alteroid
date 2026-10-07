import { execFileSync } from 'node:child_process';
import { mkdir, readFile, writeFile, cp } from 'node:fs/promises';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

import { describe, expect, it } from 'vitest';

import { makeTempDir } from '../../../vitest.tmpdir.js';

import { gitChildEnv } from './git-child-env.test-support.js';


const here = dirname(fileURLToPath(import.meta.url));
const realScriptPath = join(here, '..', 'scripts', 'write-canon.mjs');
const realDocsDir = join(here, '..', '..', '..', 'docs');
const CANON_FILES = ['north_star.md', 'PRD.md', 'architecture.md'];

async function runIsolated(options: {
  env?: NodeJS.ProcessEnv;
  git?: boolean;
  root?: string;
}): Promise<{ revision: string; source: string; builtAt: string }> {
  const root = options.root ?? (await makeTempDir('write-canon-'));

  const scriptDir = join(root, 'packages', 'core', 'scripts');
  const docsDir = join(root, 'docs');
  await mkdir(scriptDir, { recursive: true });
  await mkdir(docsDir, { recursive: true });

  await cp(realScriptPath, join(scriptDir, 'write-canon.mjs'));
  for (const file of CANON_FILES) {
    await cp(join(realDocsDir, file), join(docsDir, file));
  }

  if (options.git) {
    const run = (args: string[]): void => {
      execFileSync('git', args, { cwd: root, stdio: 'ignore', env: gitChildEnv() });
    };
    run(['init', '-q']);
    run(['config', 'user.email', 'write-canon-test@example.com']);
    run(['config', 'user.name', 'write-canon-test']);
    run(['add', '.']);
    run(['commit', '-q', '-m', 'seed']);
  }

  const env: NodeJS.ProcessEnv = { ...gitChildEnv() };
  if (options.env) Object.assign(env, options.env);

  execFileSync(process.execPath, [join(scriptDir, 'write-canon.mjs')], {
    cwd: root,
    env,
    stdio: 'pipe',
  });

  const generated = await readFile(
    join(root, 'packages', 'core', 'src', 'generated', 'canon.ts'),
    'utf8',
  );
  const revisionMatch = /export const CANON_REVISION = "([^"]*)";/.exec(generated);
  const sourceMatch = /export const CANON_REVISION_SOURCE = "([^"]*)";/.exec(generated);
  const builtAtMatch = /export const CANON_BUILT_AT = "([^"]*)";/.exec(generated);
  const revision = revisionMatch?.[1];
  const source = sourceMatch?.[1];
  const builtAt = builtAtMatch?.[1];
  if (revision === undefined || source === undefined) {
    throw new Error(`生成物に CANON_REVISION / CANON_REVISION_SOURCE が無い:\n${generated}`);
  }
  if (builtAt === undefined) {
    throw new Error(`生成物に CANON_BUILT_AT が無い:\n${generated}`);
  }
  return { revision, source, builtAt };
}

describe('write-canon.mjs の版の出所判定', () => {
  it('ALTEROID_BUILD_REV あり → source は build、値はそのまま焼かれる', async () => {
    const fakeSha = 'a'.repeat(40);
    const { revision, source } = await runIsolated({
      env: { ALTEROID_BUILD_REV: fakeSha },
      git: false,
    });

    expect(revision).toBe(fakeSha);
    expect(source).toBe('build');
  });

  it('ALTEROID_BUILD_REV 無し・git 作業ツリー有り → source は workspace、値は実際の HEAD のフル sha', async () => {
    const { revision, source } = await runIsolated({ git: true });

    expect(source).toBe('workspace');
    expect(revision).toMatch(/^[0-9a-f]{40}$/);
  });

  it('ALTEROID_BUILD_REV 無し・git 作業ツリーでもない → 両方とも空文字（プレースホルダにしない）', async () => {
    const { revision, source } = await runIsolated({ git: false });

    expect(revision).toBe('');
    expect(source).toBe('');
  });

  it('⭐ 隔離した作業ツリーの祖先ディレクトリが git 作業ツリーでも、隔離した作業ツリー自身に .git が無ければ空文字のまま（#1843: TMPDIR が作業ツリーの中にあると起きていた ascension を、TMPDIR に依らず固定する）', async () => {
    const outer = await makeTempDir('write-canon-outer-');
    const runOuterGit = (args: string[]): void => {
      execFileSync('git', args, { cwd: outer, stdio: 'ignore', env: gitChildEnv() });
    };
    runOuterGit(['init', '-q']);
    runOuterGit(['config', 'user.email', 'write-canon-outer-test@example.com']);
    runOuterGit(['config', 'user.name', 'write-canon-outer-test']);
    await writeFile(join(outer, 'seed.txt'), 'x\n', 'utf8');
    runOuterGit(['add', '.']);
    runOuterGit(['commit', '-q', '-m', 'outer seed']);

    const nestedRoot = join(outer, 'nested', 'isolated-root');
    await mkdir(nestedRoot, { recursive: true });

    const { revision, source } = await runIsolated({ git: false, root: nestedRoot });

    expect(revision).toBe('');
    expect(source).toBe('');
  });
});

describe('write-canon.mjs が焼く CANON_BUILT_AT', () => {
  it('git 作業ツリーの有無や ALTEROID_BUILD_REV の有無に関わらず、常に妥当な ISO8601 (UTC) が焼かれる', async () => {
    const before = Date.now();
    const { builtAt } = await runIsolated({ git: false });
    const after = Date.now();

    expect(builtAt.length).toBeGreaterThan(0);
    expect(builtAt).toMatch(/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/);
    const parsed = Date.parse(builtAt);
    expect(Number.isNaN(parsed)).toBe(false);
    expect(parsed).toBeGreaterThanOrEqual(before);
    expect(parsed).toBeLessThanOrEqual(after);
  });

  it('ALTEROID_BUILD_REV があっても無くても、焼かれる時刻は変わらず取れる（リビジョンの出所とは独立した軸）', async () => {
    const withEnv = await runIsolated({ env: { ALTEROID_BUILD_REV: 'a'.repeat(40) }, git: false });
    const withoutEnv = await runIsolated({ git: false });

    expect(Number.isNaN(Date.parse(withEnv.builtAt))).toBe(false);
    expect(Number.isNaN(Date.parse(withoutEnv.builtAt))).toBe(false);
  });
});
