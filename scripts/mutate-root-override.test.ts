import { execFileSync, spawnSync } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import { describe, expect, it } from 'vitest';

import { makeTempDirSync } from '../vitest.tmpdir.js';

import { gitChildEnv } from './git-child-env.js';
import { mutateCliChildEnv } from './mutate-cli-child-env.js';
import {
  BACKUP_DIR,
  DEFAULT_ROOT,
  HarnessError,
  MARKER_PATH,
  readRootArg,
  ROOT,
  setRootOverride,
  // @ts-expect-error -- 素の .mjs（型宣言を持たない変異試験ハーネス）を読む
} from '../.claude/skills/mutation-testing/mutate-core.mjs';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const REPO_ROOT = path.resolve(__dirname, '..');
const MUTATE_CLI = path.join(REPO_ROOT, '.claude/skills/mutation-testing/mutate.mjs');

function runCli(args: string[]) {
  return spawnSync('node', [MUTATE_CLI, ...args], {
    cwd: REPO_ROOT,
    encoding: 'utf8',
    env: mutateCliChildEnv(),
  });
}

function makeTmpGitRepo(): string {
  const dir = makeTempDirSync('mutate-root-override-');
  execFileSync('git', ['init', '-q'], { cwd: dir, env: gitChildEnv() });
  execFileSync('git', ['config', 'user.email', 'test@example.com'], {
    cwd: dir,
    env: gitChildEnv(),
  });
  execFileSync('git', ['config', 'user.name', 'test'], { cwd: dir, env: gitChildEnv() });
  fs.writeFileSync(path.join(dir, 'target.txt'), 'hello world\n');
  execFileSync('git', ['add', 'target.txt'], { cwd: dir, env: gitChildEnv() });
  execFileSync('git', ['commit', '-q', '-m', 'init'], { cwd: dir, env: gitChildEnv() });
  return dir;
}

// 本物の REPO_ROOT を見ず、ハーネスを使い捨てツリーへ写してそのコピー側の CLI を測る: REPO_ROOT は共有資源で、外部が印を置いたり消したりするとテストが何も壊していないのに落ちる（TOCTOU）ため。
function makeIsolatedHarnessCopy(prefix: string) {
  const harnessRoot = makeTempDirSync(prefix);
  const srcDir = path.join(REPO_ROOT, '.claude/skills/mutation-testing');
  const destDir = path.join(harnessRoot, '.claude/skills/mutation-testing');
  fs.mkdirSync(destDir, { recursive: true });
  for (const file of ['mutate.mjs', 'mutate-core.mjs', 'mutate-selftest.mjs']) {
    fs.copyFileSync(path.join(srcDir, file), path.join(destDir, file));
  }
  return {
    harnessRoot,
    cli: path.join(destDir, 'mutate.mjs'),
    markerPath: path.join(harnessRoot, 'MUTATION-IN-PROGRESS.json'),
  };
}

function runIsolatedCli(harness: { cli: string; harnessRoot: string }, args: string[]) {
  return spawnSync('node', [harness.cli, ...args], {
    cwd: harness.harnessRoot,
    encoding: 'utf8',
    env: mutateCliChildEnv(),
  });
}

describe('mutate-core: readRootArg（--root の argv 解析）', () => {
  it('--root が無ければ undefined を返す（呼び出し側は override しない）', () => {
    expect(readRootArg([])).toBeUndefined();
    expect(readRootArg(['--spec', 'x.json'])).toBeUndefined();
  });

  it('--root <path> を読む', () => {
    expect(readRootArg(['--root', '/tmp/probe'])).toBe('/tmp/probe');
  });

  it('他の引数と混ざっていても読める', () => {
    expect(readRootArg(['--spec', 'x.json', '--root', '/tmp/probe'])).toBe('/tmp/probe');
  });

  it('--root に値が無ければ HarnessError（読む前に落ちる。何も上書きしない）', () => {
    expect(() => readRootArg(['--root'])).toThrow(HarnessError);
  });
});

// 失敗系を成功系より前に置く: `ROOT` は module scope の可変状態で、先に成功させると以降のテストが上書き後の値を見るため。

describe('mutate-core: setRootOverride は不正な --root を fail-closed で拒否する', () => {
  it('空文字を拒否し、ROOT/MARKER_PATH/BACKUP_DIR のどれも書き換えない', () => {
    expect(() => setRootOverride('')).toThrow(HarnessError);
    expect(ROOT).toBe(DEFAULT_ROOT);
    expect(MARKER_PATH).toBe(path.join(DEFAULT_ROOT, 'MUTATION-IN-PROGRESS.json'));
    expect(BACKUP_DIR).toBe(path.join(DEFAULT_ROOT, '.mutation-testing', 'backups'));
  });

  it('存在しないパスを拒否する', () => {
    expect(() => setRootOverride('/nonexistent/mutate-root-override-probe')).toThrow(/存在しない/);
    expect(ROOT).toBe(DEFAULT_ROOT);
  });

  it('ディレクトリでないパス（このテストファイル自身）を拒否する', () => {
    expect(() => setRootOverride(__filename)).toThrow(/ディレクトリでない/);
    expect(ROOT).toBe(DEFAULT_ROOT);
  });
});

// ROOT・MARKER_PATH・BACKUP_DIR の3つを個別に検査する: ROOT だけを見ると、印や控えが古い ROOT のままの欠陥を見逃すため。

describe('mutate-core: setRootOverride は ROOT/MARKER_PATH/BACKUP_DIR の3つをまとめて差し替える', () => {
  it('成功すると3つとも新しい ROOT から作り直される', () => {
    const tmp = makeTempDirSync('mutate-root-override-pure-');
    const result = setRootOverride(tmp);
    const resolvedTmp = path.resolve(tmp);

    expect(ROOT).toBe(resolvedTmp);
    expect(MARKER_PATH).toBe(path.join(resolvedTmp, 'MUTATION-IN-PROGRESS.json'));
    expect(BACKUP_DIR).toBe(path.join(resolvedTmp, '.mutation-testing', 'backups'));

    expect(result).toEqual({
      root: resolvedTmp,
      markerPath: path.join(resolvedTmp, 'MUTATION-IN-PROGRESS.json'),
      backupDir: path.join(resolvedTmp, '.mutation-testing', 'backups'),
    });

    expect(DEFAULT_ROOT).toBe(REPO_ROOT);
    expect(ROOT).not.toBe(DEFAULT_ROOT);
  });
});

// 実プロセスとして起こす: `mutate.mjs` はモジュール末尾で無条件に `main()` を呼び、import すると `process.argv` 次第でテストプロセスごと `exit()` するため。

describe('mutate.mjs CLI: --root（回帰・上書き・fail-closed・実効 ROOT の出力）', () => {
  it('歯2（回帰）: --root を渡さないと、既定の ROOT（このリポジトリ）のまま動く', () => {
    const result = runCli(['status']);
    expect(result.status === 0 || result.status === 2).toBe(true);
    expect(result.stdout).toContain(`ROOT: ${REPO_ROOT}`);
    expect(result.stdout).toContain('既定。--root は渡されていない');
  });

  it('歯4: --root を渡さないときも実効 ROOT が出力に出る（既定であることが読める）', () => {
    const result = runCli(['status']);
    expect(result.stdout).toMatch(/^ROOT: /m);
  });

  it('歯4: --root を渡すと、実効 ROOT がその上書き先として出力に出る', () => {
    const tmp = makeTempDirSync('mutate-root-override-cli-');
    const result = runCli(['status', '--root', tmp]);
    const resolvedTmp = path.resolve(tmp);
    expect(result.stdout).toContain(`ROOT: ${resolvedTmp}`);
    expect(result.stdout).toContain('--root で上書き');
    expect(result.stdout).toContain(`既定は ${REPO_ROOT}`);
  });

  it('歯3: 存在しない --root は fail-closed になる（exit 非0）', () => {
    const result = runCli(['status', '--root', '/nonexistent/mutate-root-override-cli-probe']);
    expect(result.status).toBe(1);
    expect(result.stdout + result.stderr).toContain('存在しない');
  });

  it('歯3: ディレクトリでない --root は fail-closed になる（exit 非0）', () => {
    const result = runCli(['status', '--root', __filename]);
    expect(result.status).toBe(1);
    expect(result.stdout + result.stderr).toContain('ディレクトリでない');
  });

  it('歯1: --root <path> を渡すと apply/restore が MARKER_PATH / BACKUP_DIR も含めてそのツリーを使う', () => {
    const harness = makeIsolatedHarnessCopy('mutate-root-override-harness-');
    const tmp = makeTmpGitRepo();
    const specPath = path.join(tmp, 'spec.json');
    fs.writeFileSync(
      specPath,
      JSON.stringify({
        id: 'root-override-probe',
        file: 'target.txt',
        from: 'hello',
        to: 'HELLO',
        expect: 1,
        target: null,
        mustFail: ['root-override-probe はこの歯で judge を呼ばない（apply/restore のみを測る）'],
      }),
    );

    const applyResult = runIsolatedCli(harness, ['apply', '--spec', specPath, '--root', tmp]);
    expect(applyResult.status).toBe(0);

    expect(fs.readFileSync(path.join(tmp, 'target.txt'), 'utf8')).toBe('HELLO world\n');
    expect(fs.existsSync(path.join(tmp, 'MUTATION-IN-PROGRESS.json'))).toBe(true);
    expect(
      fs.existsSync(path.join(tmp, '.mutation-testing', 'backups', 'root-override-probe.bak')),
    ).toBe(true);

    expect(fs.existsSync(harness.markerPath)).toBe(false);

    const restoreResult = runIsolatedCli(harness, ['restore', '--root', tmp]);
    expect(restoreResult.status).toBe(0);
    expect(fs.readFileSync(path.join(tmp, 'target.txt'), 'utf8')).toBe('hello world\n');
    expect(fs.existsSync(path.join(tmp, 'MUTATION-IN-PROGRESS.json'))).toBe(false);

    expect(fs.existsSync(harness.markerPath)).toBe(false);
  });

  it('歯1b（#1705 追加、消される向き）: このコピーの既定 ROOT にあらかじめ印の形のファイルが在っても、--root <tmp> の apply/restore はそれへ1バイトも触れない', () => {
    // 既定 ROOT に印の形のファイルをあらかじめ置く: 何も無い場所から「無い」ままだと、誰かが印を消してしまう欠陥があっても観測に現れないため。
    const harness = makeIsolatedHarnessCopy('mutate-root-override-harness-erase-');
    const preplacedMarkerContent = '{"probe":"mutate-root-override-preexisting-marker"}\n';
    fs.writeFileSync(harness.markerPath, preplacedMarkerContent);

    const tmp = makeTmpGitRepo();
    const specPath = path.join(tmp, 'spec.json');
    fs.writeFileSync(
      specPath,
      JSON.stringify({
        id: 'root-override-erase-probe',
        file: 'target.txt',
        from: 'hello',
        to: 'HELLO',
        expect: 1,
        target: null,
        mustFail: [
          'root-override-erase-probe はこの歯で judge を呼ばない（apply/restore のみを測る）',
        ],
      }),
    );

    const applyResult = runIsolatedCli(harness, ['apply', '--spec', specPath, '--root', tmp]);
    expect(applyResult.status).toBe(0);
    expect(fs.readFileSync(harness.markerPath, 'utf8')).toBe(preplacedMarkerContent);

    const restoreResult = runIsolatedCli(harness, ['restore', '--root', tmp]);
    expect(restoreResult.status).toBe(0);
    expect(fs.readFileSync(harness.markerPath, 'utf8')).toBe(preplacedMarkerContent);
  });
});
