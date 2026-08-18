/**
 * `.github/scripts/reflect-release-prod.sh` を固定する。
 *
 * 本物の push が GitHub Actions から6時間ごとに起きるスクリプトなので、手で走らせて
 * 確かめるのは危ない。**偽の git は置かない。** 本物の git と、ローカルの bare
 * リポジトリ（`origin.git`）を使う。ネットワークには一切触らない —
 * ローカルパスは git にとって立派な remote であり、`file://` を挟む必要は無い。
 *
 * **`git clone --no-local` を使う。** ローカルパスへの clone は既定でオブジェクトを
 * 丸ごとハードリンクする（`--local` が暗黙で効く）ので、`actions/checkout@v4` が
 * 実際に作る**浅い** clone を再現できない。`--no-local --depth 1 --branch main` で
 * checkout の既定を模す。
 *
 * **「push が実際に起きたか」も本物の git の機能で確かめる。** bare リポジトリの
 * `hooks/pre-receive` に push を1行記録させるだけで、fake CLI を挟まずに
 * 「差分なしのときに push しない」を検証できる（`railway/setup.test.ts` は偽の
 * `railway` CLI を PATH に置く手法を使っているが、ここは対象が git 自身なので、
 * 偽物ではなく git 標準の hook で代える）。
 *
 * git の呼び出しには毎回 `-c user.email` / `-c user.name` を渡す。この環境に
 * グローバル設定が無いので、渡さないと commit がそこで落ちる。
 */
import { execFileSync } from 'node:child_process';
import {
  chmodSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';

const SCRIPT = join(dirname(fileURLToPath(import.meta.url)), 'reflect-release-prod.sh');

/** この環境にグローバル設定が無いので、commit するたびに明示で渡す。 */
const GIT_IDENTITY = ['-c', 'user.email=reflect-test@example.com', '-c', 'user.name=Reflect Test'];

function git(cwd: string, args: string[]): string {
  return execFileSync('git', [...GIT_IDENTITY, ...args], { cwd, encoding: 'utf8' });
}

/**
 * bare な origin を1つ作る。`hooks/pre-receive` は push が来るたびに
 * `$PUSH_LOG`（未設定なら `/dev/null`）へ1行足すだけ — 「push が起きたか」を
 * スクリプトの外から観測する唯一の手段である。
 */
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

/** `main` に N個のコミットを積んだ非 bare の作業ツリー（push 元）を作る。 */
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

/** `actions/checkout@v4` の既定（浅い・単一ブランチ）を模した clone。 */
function cloneShallow(originPath: string, root: string): string {
  const workdir = join(root, 'work');
  git(root, ['clone', '--no-local', '-q', '--depth', '1', '--branch', 'main', originPath, workdir]);
  return workdir;
}

/** origin 側の ref を読む。無ければ空文字（`git ls-remote` が空を返すのと同じ扱い）。 */
function remoteRef(originPath: string, ref: string): string {
  try {
    return execFileSync('git', ['--git-dir', originPath, 'rev-parse', ref], {
      encoding: 'utf8',
    }).trim();
  } catch {
    return '';
  }
}

type Result = { exitCode: number; stdout: string; stderr: string };

/** `reflect-release-prod.sh` を作業ツリーの中で走らせ、出力と終了状態を返す。 */
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
      // 落ちた理由（stderr）を握り潰すと、CI でだけ落ちたときに手掛かりが無くなる
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

/** `=== 反映結果: ... ===` の行だけを取り出す。何行出たかも呼び出し側が見られるようにする。 */
function outcomeLines(output: string): string[] {
  return [...output.matchAll(/^=== 反映結果: .+ ===$/gm)].map((m) => m[0]);
}

type ScenarioKind = 'missing' | 'no-diff' | 'ancestor' | 'diverged';

type ScenarioSetup = {
  root: string;
  originPath: string;
  seedPath: string;
  mainSha: string;
  /** シナリオ実行前の release/prod の SHA。まだ無ければ空文字。 */
  prodShaBefore: string;
};

/**
 * 表の1〜4行目に対応する状況を、本物の git 操作で作る。
 *
 * - missing  : release/prod がまだ無い
 * - no-diff  : release/prod == main
 * - ancestor : release/prod が main の祖先（3コミット中の最初の1つ）
 * - diverged : release/prod が main と共通の祖先すら持たない（main に無いコミット）
 */
function buildScenario(kind: ScenarioKind): ScenarioSetup {
  const root = mkdtempSync(join(tmpdir(), 'reflect-release-prod-test.'));
  const originPath = initOrigin(root);
  const { seedPath, shas } = initSeed(root, 3);
  git(seedPath, ['remote', 'add', 'origin', originPath]);
  git(seedPath, ['push', '-q', 'origin', 'main']);
  const mainSha = shas[shas.length - 1];

  let prodShaBefore = '';
  switch (kind) {
    case 'missing':
      break;
    case 'no-diff':
      git(seedPath, ['push', '-q', 'origin', 'main:refs/heads/release/prod']);
      prodShaBefore = mainSha;
      break;
    case 'ancestor':
      prodShaBefore = shas[0];
      git(seedPath, ['push', '-q', 'origin', `${prodShaBefore}:refs/heads/release/prod`]);
      break;
    case 'diverged':
      // main と共通の祖先を持たない orphan branch を作り、それを release/prod へ置く
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
    // pre-receive フックは push が来たときだけ push.log を作る。無い＝push しなかった証拠
    expect(existsSync(join(s.root, 'push.log'))).toBe(false);
    expect(remoteRef(s.originPath, 'refs/heads/release/prod')).toBe(s.mainSha);

    const lines = outcomeLines(s.result.stdout);
    expect(lines).toHaveLength(1);
    expect(lines[0]).toContain('差分なし');

    // #6: GITHUB_STEP_SUMMARY にも1行書かれる
    const summary = readFileSync(join(s.root, 'summary.txt'), 'utf8');
    expect(summary.trim().length).toBeGreaterThan(0);
  });
});

describe('release/prod が main の祖先（数コミット遅れ）のとき (#3)', () => {
  it('main の SHA まで進み、0 で終わる', () => {
    const s = runScenario('ancestor');

    expect(s.result.exitCode).toBe(0);
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
    // --force-with-lease が効いていることの確認：non-fast-forward でも上書きされる
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
  // これがこのスクリプトでいちばん大事な性質である。**沈黙が「差分なし」と
  // 「壊れた」の両方を意味する形を作らない**ため、trap の default outcome が
  // ここでも1行出すことを確かめる。origin remote が無い状態を「壊れた」の
  // 代表として使う（git を PATH から外すより再現が安定する）。
  it('origin remote が無いと、非0で終わり、それでも「=== 反映結果:」の行が出る', () => {
    const root = mkdtempSync(join(tmpdir(), 'reflect-release-prod-test.'));
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
