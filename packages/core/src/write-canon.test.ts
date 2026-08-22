import { execFileSync } from 'node:child_process';
import { mkdir, mkdtemp, readFile, rm, cp } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

import { afterEach, describe, expect, it } from 'vitest';

/**
 * `packages/core/scripts/write-canon.mjs` の版の出所判定
 * （`ALTEROID_BUILD_REV` 有り → `'build'` / 無し・git 作業ツリー有り →
 * `'workspace'` / どちらも無し → `''`）を、**実際に走るスクリプトそのもの**
 * を子プロセスで動かして固定する。
 *
 * **ロジックを切り出さない理由。** `revision()` はスクリプト内部の関数で、
 * `.mjs` は素の Node スクリプトなので TS の import を素通りできない
 * （`write-canon.mjs` は `pnpm build` の最初の一歩として tsup より前に走る —
 * `packages/core/package.json` の `build` スクリプト参照）。切り出して import
 * 可能な形にすると、「実際にビルドで走る経路」と「テストが読む経路」が
 * 分かれてしまい、切り出したコードが本物とずれても気づけなくなる
 * （AGENTS.md「テストが書けない構造」の条件——出力・挙動を変えずに切り出す、が
 * ここでは満たせない）。だから**子プロセスとして実際に起動し、生成された
 * `canon.ts` を読む**形にする。
 *
 * **本物の `packages/core/src/generated/canon.ts` には触らない。** スクリプトを
 * 隔離した一時ディレクトリへコピーし、そこで走らせる——`repoRoot` はスクリプト
 * 自身のファイル位置から算出される（`import.meta.url` 基準）ので、コピー先でも
 * 独立して動く。本物のツリーへ書けば、並行して走る他のテスト（`self.test.ts` 等、
 * `generated/canon.ts` を import するもの）と competing writes になる。
 */

const here = dirname(fileURLToPath(import.meta.url));
const realScriptPath = join(here, '..', 'scripts', 'write-canon.mjs');
const realDocsDir = join(here, '..', '..', '..', 'docs');
const CANON_FILES = ['north_star.md', 'PRD.md', 'architecture.md', 'roadmap.md'];

const tmpDirs: string[] = [];

afterEach(async () => {
  await Promise.all(tmpDirs.splice(0).map((dir) => rm(dir, { recursive: true, force: true })));
});

/** 隔離された1本の checkout を用意し、write-canon.mjs を走らせて生成物を読む。 */
async function runIsolated(options: {
  env?: NodeJS.ProcessEnv;
  git?: boolean;
}): Promise<{ revision: string; source: string }> {
  const root = await mkdtemp(join(tmpdir(), 'write-canon-'));
  tmpDirs.push(root);

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
      execFileSync('git', args, { cwd: root, stdio: 'ignore' });
    };
    run(['init', '-q']);
    run(['config', 'user.email', 'write-canon-test@example.com']);
    run(['config', 'user.name', 'write-canon-test']);
    run(['add', '.']);
    run(['commit', '-q', '-m', 'seed']);
  }

  // **`ALTEROID_BUILD_REV` は明示的に消してから積み直す。** 呼び出し元プロセス
  // （vitest 自身）の環境にたまたま乗っていたら、`git` 経路を試すテストが静かに
  // `build` へ倒れる。
  const env: NodeJS.ProcessEnv = { ...process.env };
  delete env.ALTEROID_BUILD_REV;
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
  const revision = revisionMatch?.[1];
  const source = sourceMatch?.[1];
  if (revision === undefined || source === undefined) {
    throw new Error(`生成物に CANON_REVISION / CANON_REVISION_SOURCE が無い:\n${generated}`);
  }
  return { revision, source };
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
    // 「フル40桁・source が workspace」だけを見る——固定の期待 sha は無い
    // （`runIsolated` が毎回新しい隔離リポジトリへ commit するので、値は
    // 実行のたびに違う。それでよい：見たいのは形であって特定の値ではない）。
    const { revision, source } = await runIsolated({ git: true });

    expect(source).toBe('workspace');
    expect(revision).toMatch(/^[0-9a-f]{40}$/);
  });

  it('ALTEROID_BUILD_REV 無し・git 作業ツリーでもない → 両方とも空文字（プレースホルダにしない）', async () => {
    const { revision, source } = await runIsolated({ git: false });

    // **本体はここ。** 「取れなかった」ときに空文字以外の何か（'unknown' 等）へ
    // 化けていないことを明示する。
    expect(revision).toBe('');
    expect(source).toBe('');
  });
});
