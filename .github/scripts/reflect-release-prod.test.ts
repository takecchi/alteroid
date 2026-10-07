// 偽の git は置かず、本物の git とローカルの bare リポジトリ（`origin.git`）を使う: 「push が実際に起きたか」は bare リポジトリの `hooks/pre-receive` で確かめる（対象が git 自身のため）。
// `git clone --no-local` を使う: ローカルパスへの clone は既定でオブジェクトをハードリンクし、`actions/checkout@v4` が作る浅い clone を再現できないため。
import { execFileSync } from 'node:child_process';
import { chmodSync, existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';

import { makeTempDirSync } from '../../vitest.tmpdir.js';

import { gitChildEnv } from './git-child-env.js';

const SCRIPT = join(dirname(fileURLToPath(import.meta.url)), 'reflect-release-prod.sh');

// git の呼び出しに毎回 `-c user.*` を渡す: この環境にグローバル設定が無く、渡さないと commit が落ちるため。
const GIT_IDENTITY = ['-c', 'user.email=reflect-test@example.com', '-c', 'user.name=Reflect Test'];

function git(cwd: string, args: string[]): string {
  return execFileSync('git', [...GIT_IDENTITY, ...args], {
    cwd,
    encoding: 'utf8',
    env: gitChildEnv(),
  });
}

function initOrigin(root: string): string {
  const originPath = join(root, 'origin.git');
  git(root, ['init', '--bare', '-q', originPath]);
  const hooksDir = join(originPath, 'hooks');
  mkdirSync(hooksDir, { recursive: true });
  const hook = join(hooksDir, 'pre-receive');
  writeFileSync(hook, '#!/usr/bin/env bash\necho pushed >> "${PUSH_LOG:-/dev/null}"\n');
  chmodSync(hook, 0o755);
  return originPath;
}

function initSeed(root: string, commitCount: number): { seedPath: string; shas: string[] } {
  const seedPath = join(root, 'seed');
  mkdirSync(seedPath);
  git(seedPath, ['init', '-q']);
  git(seedPath, ['checkout', '-q', '-b', 'main']);
  const shas: string[] = [];
  for (let i = 1; i <= commitCount; i++) {
    writeFileSync(join(seedPath, 'file.txt'), `content ${i}\n`);
    git(seedPath, ['add', '.']);
    git(seedPath, ['commit', '-q', '-m', `commit ${i}`]);
    shas.push(git(seedPath, ['rev-parse', 'HEAD']).trim());
  }
  return { seedPath, shas };
}

function cloneShallow(originPath: string, root: string): string {
  const workdir = join(root, 'work');
  git(root, ['clone', '--no-local', '-q', '--depth', '1', '--branch', 'main', originPath, workdir]);
  return workdir;
}

function remoteRef(originPath: string, ref: string): string {
  try {
    return execFileSync('git', ['--git-dir', originPath, 'rev-parse', ref], {
      encoding: 'utf8',
      env: gitChildEnv(),
    }).trim();
  } catch {
    return '';
  }
}

type Result = { exitCode: number; stdout: string; stderr: string };

function runReflect(
  workdir: string,
  env: NodeJS.ProcessEnv,
  options: { allowFailure?: boolean } = {},
): Result {
  let exitCode = 0;
  let stdout: string;
  let stderr = '';
  try {
    stdout = execFileSync(SCRIPT, [], {
      cwd: workdir,
      env,
      encoding: 'utf8',
      stdio: ['ignore', 'pipe', 'pipe'],
    });
  } catch (e) {
    const err = e as { status?: number; stdout?: Buffer | string; stderr?: Buffer | string };
    exitCode = err.status ?? 1;
    stdout = err.stdout?.toString() ?? '';
    stderr = err.stderr?.toString() ?? '';
    if (!options.allowFailure) {
      // 落ちた理由（stderr）を握り潰さない: CI でだけ落ちたときに手掛かりが無くなるため。
      throw new Error(`reflect-release-prod.sh が ${exitCode} で終わった\n${stderr}`, {
        cause: e,
      });
    }
  }
  return { exitCode, stdout, stderr };
}

function baseEnv(root: string): NodeJS.ProcessEnv {
  return {
    PATH: process.env.PATH ?? '',
    GITHUB_STEP_SUMMARY: join(root, 'summary.txt'),
    PUSH_LOG: join(root, 'push.log'),
  };
}

function outcomeLines(output: string): string[] {
  return [...output.matchAll(/^=== 反映結果: .+ ===$/gm)].map((m) => m[0]);
}

type ScenarioKind = 'missing' | 'no-diff' | 'ancestor' | 'diverged';

type ScenarioSetup = {
  root: string;
  originPath: string;
  seedPath: string;
  mainSha: string;
  prodShaBefore: string;
};

function buildScenario(kind: ScenarioKind): ScenarioSetup {
  const root = makeTempDirSync('reflect-release-prod-test.');
  const originPath = initOrigin(root);
  const { seedPath, shas } = initSeed(root, 3);
  git(seedPath, ['remote', 'add', 'origin', originPath]);
  git(seedPath, ['push', '-q', 'origin', 'main']);
  const mainSha = shas[shas.length - 1];
  if (mainSha === undefined) {
    throw new Error('initSeed が shas を1件も返さなかった');
  }

  let prodShaBefore = '';
  switch (kind) {
    case 'missing':
      break;
    case 'no-diff':
      git(seedPath, ['push', '-q', 'origin', 'main:refs/heads/release/prod']);
      prodShaBefore = mainSha;
      break;
    case 'ancestor': {
      const firstSha = shas[0];
      if (firstSha === undefined) {
        throw new Error('initSeed が shas を1件も返さなかった');
      }
      prodShaBefore = firstSha;
      git(seedPath, ['push', '-q', 'origin', `${prodShaBefore}:refs/heads/release/prod`]);
      break;
    }
    case 'diverged':
      git(seedPath, ['checkout', '-q', '--orphan', 'stray']);
      git(seedPath, ['rm', '-rf', '-q', '.']);
      writeFileSync(join(seedPath, 'stray.txt'), 'stray\n');
      git(seedPath, ['add', '.']);
      git(seedPath, ['commit', '-q', '-m', 'main に無いコミット']);
      prodShaBefore = git(seedPath, ['rev-parse', 'stray']).trim();
      git(seedPath, ['push', '-q', '-f', 'origin', 'stray:refs/heads/release/prod']);
      break;
  }

  return { root, originPath, seedPath, mainSha, prodShaBefore };
}

function runScenario(kind: ScenarioKind) {
  const setup = buildScenario(kind);
  const workdir = cloneShallow(setup.originPath, setup.root);
  const result = runReflect(workdir, baseEnv(setup.root));
  return { ...setup, workdir, result };
}

describe('release/prod が remote に無いとき (#1)', () => {
  it('main の SHA を指す release/prod が新しく作られ、0 で終わる', () => {
    const s = runScenario('missing');

    expect(s.result.exitCode).toBe(0);
    // push が起きた側も見る: フックが実際に火を噴くことを別の経路で確かめないと、差分なしの検査は PUSH_LOG が渡らなくても・フックに実行ビットが無くても「無い」で通ってしまうため。
    expect(existsSync(join(s.root, 'push.log'))).toBe(true);
    expect(remoteRef(s.originPath, 'refs/heads/release/prod')).toBe(s.mainSha);

    const lines = outcomeLines(s.result.stdout);
    expect(lines).toHaveLength(1);
    expect(lines[0]).toContain('反映した');
  });
});

describe('release/prod が main と一致（差分なし）のとき (#2, #6)', () => {
  it('push が起きず、0 で終わり、「差分なし」の1行が出て、summary にも書かれる', () => {
    const s = runScenario('no-diff');

    expect(s.result.exitCode).toBe(0);
    expect(existsSync(join(s.root, 'push.log'))).toBe(false);
    expect(remoteRef(s.originPath, 'refs/heads/release/prod')).toBe(s.mainSha);

    const lines = outcomeLines(s.result.stdout);
    expect(lines).toHaveLength(1);
    expect(lines[0]).toContain('差分なし');

    const summary = readFileSync(join(s.root, 'summary.txt'), 'utf8');
    expect(summary.trim().length).toBeGreaterThan(0);
  });
});

describe('release/prod が main の祖先（数コミット遅れ）のとき (#3)', () => {
  it('main の SHA まで進み、0 で終わる', () => {
    const s = runScenario('ancestor');

    expect(s.result.exitCode).toBe(0);
    expect(existsSync(join(s.root, 'push.log'))).toBe(true);
    expect(remoteRef(s.originPath, 'refs/heads/release/prod')).toBe(s.mainSha);

    const lines = outcomeLines(s.result.stdout);
    expect(lines).toHaveLength(1);
    expect(lines[0]).toContain('反映した');
    expect(lines[0]).toContain(s.prodShaBefore);
  });
});

describe('release/prod が main から分岐しているとき (#4)', () => {
  it('main の SHA へ force で上書きされ、0 で終わる', () => {
    const s = runScenario('diverged');

    expect(s.result.exitCode).toBe(0);
    expect(existsSync(join(s.root, 'push.log'))).toBe(true);
    expect(remoteRef(s.originPath, 'refs/heads/release/prod')).toBe(s.mainSha);

    const lines = outcomeLines(s.result.stdout);
    expect(lines).toHaveLength(1);
    expect(lines[0]).toContain('反映した');
    expect(lines[0]).toContain(s.prodShaBefore);
  });
});

describe('=== 反映結果: 行の性質 (#5)', () => {
  it('差分なし（#2）と分岐の上書き（#4）とで文言が違う', () => {
    const noDiff = runScenario('no-diff');
    const diverged = runScenario('diverged');

    const msgNoDiff = outcomeLines(noDiff.result.stdout)[0];
    const msgDiverged = outcomeLines(diverged.result.stdout)[0];

    expect(msgNoDiff).toContain('差分なし');
    expect(msgDiverged).toContain('反映した');
    expect(msgNoDiff).not.toBe(msgDiverged);
  });
});

describe('壊れて判定に到達しなかったとき (#7)', () => {
  // origin remote が無い状態を「壊れた」の代表にする: git を PATH から外すより再現が安定するため。
  it('origin remote が無いと、非0で終わり、それでも「=== 反映結果:」の行が出る', () => {
    const root = makeTempDirSync('reflect-release-prod-test.');
    const originPath = initOrigin(root);
    const { seedPath } = initSeed(root, 1);
    git(seedPath, ['remote', 'add', 'origin', originPath]);
    git(seedPath, ['push', '-q', 'origin', 'main']);
    const workdir = cloneShallow(originPath, root);
    git(workdir, ['remote', 'remove', 'origin']);

    const result = runReflect(workdir, baseEnv(root), { allowFailure: true });

    expect(result.exitCode).not.toBe(0);
    expect(outcomeLines(result.stdout + result.stderr)).toHaveLength(1);
  });
});
