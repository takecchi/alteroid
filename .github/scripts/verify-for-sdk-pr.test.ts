// 本物の git を使い、偽物は pnpm だけにする: git を偽物にすると測れるものが「呼ばれたか」だけになり、差分の有無を正しく判定できているかが測れなくなるため。
import { execFileSync, spawnSync } from 'node:child_process';
import { chmodSync, existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';

import { makeTempDirSync } from '../../vitest.tmpdir.js';

// @ts-expect-error -- 素の .mjs（型宣言を持たない build 用スクリプト）を読む
import { STEPS } from '../../scripts/verify-core.mjs';

import { gitChildEnv } from './git-child-env.js';

type Step = { name: string; cmd: string; args: string[] };

const SCRIPTS_DIR = dirname(fileURLToPath(import.meta.url));
const SCRIPT = join(SCRIPTS_DIR, 'verify-for-sdk-pr.sh');

// git 操作に `-c user.*` を明示で渡す: この環境にグローバル設定（`~/.gitconfig`）が無いため。
const GIT_IDENTITY = ['-c', 'user.email=verify-test@example.com', '-c', 'user.name=Verify Test'];

function git(cwd: string, args: string[]): string {
  return execFileSync('git', [...GIT_IDENTITY, ...args], {
    cwd,
    encoding: 'utf8',
    env: gitChildEnv(),
  });
}

type Result = { exitCode: number; stdout: string; stderr: string };

function runScript(cwd: string, env: NodeJS.ProcessEnv): Result {
  const proc = spawnSync(SCRIPT, [], {
    cwd,
    env,
    encoding: 'utf8',
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  if (proc.error) throw proc.error;
  return { exitCode: proc.status ?? 1, stdout: proc.stdout ?? '', stderr: proc.stderr ?? '' };
}

function parseGithubOutput(path: string): Record<string, string> {
  if (!existsSync(path)) return {};
  const out: Record<string, string> = {};
  for (const line of readFileSync(path, 'utf8').split('\n')) {
    if (!line) continue;
    const idx = line.indexOf('=');
    if (idx === -1) continue;
    out[line.slice(0, idx)] = line.slice(idx + 1);
  }
  return out;
}

function extractGateNamesFromVerifyMd(verifyMd: string): string[] {
  const names: string[] = [];
  for (const line of verifyMd.split('\n')) {
    const m = /^### `([^`]+)` — /.exec(line);
    if (m && m[1] !== undefined) names.push(m[1]);
  }
  return names;
}

function writeFakePnpm(path: string): void {
  writeFileSync(
    path,
    `#!/usr/bin/env bash
set -euo pipefail
sub="\${1:-}"
printf '%s\\n' "$sub" >> "\${FAKE_PNPM_LOG:?FAKE_PNPM_LOG が要る}"
for f in \${FAKE_PNPM_FAIL_STEP:-}; do
  if [ "$sub" = "$f" ]; then
    n="\${FAKE_PNPM_FAIL_LINES:-45}"
    for i in $(seq 1 "$n"); do
      echo "fail line $i for $sub"
    done
    exit "\${FAKE_PNPM_FAIL_CODE:-1}"
  fi
done
echo "ok output for $sub"
`,
  );
  chmodSync(path, 0o755);
}

function initRepo(root: string): string {
  const repoPath = join(root, 'repo');
  mkdirSync(join(repoPath, 'apps', 'daemon'), { recursive: true });
  git(root, ['init', '-q', repoPath]);
  writeFileSync(join(repoPath, 'apps', 'daemon', 'openapi.json'), '{"openapi":"3.1.0"}\n');
  writeFileSync(join(repoPath, 'other.txt'), 'original\n');
  git(repoPath, ['add', '.']);
  git(repoPath, ['commit', '-q', '-m', 'init']);
  return repoPath;
}

function setup() {
  const root = makeTempDirSync('verify-for-sdk-pr-test.');
  const repoPath = initRepo(root);
  const fakePnpm = join(root, 'fake-pnpm.sh');
  writeFakePnpm(fakePnpm);
  const fakeBin = join(root, 'fake-bin');
  mkdirSync(fakeBin);
  // PATH 上の `pnpm` そのものを差し替える: スクリプトが `pnpm` を直接呼び、`PNPM=` のような差し替え口が無いため。
  writeFileSync(join(fakeBin, 'pnpm'), readFileSync(fakePnpm));
  chmodSync(join(fakeBin, 'pnpm'), 0o755);
  const runnerTemp = join(root, 'runner-temp');
  mkdirSync(runnerTemp);
  const pnpmLog = join(root, 'pnpm-calls.log');
  const outputFile = join(runnerTemp, 'github-output.txt');
  return { root, repoPath, fakeBin, runnerTemp, pnpmLog, outputFile };
}

function run(s: ReturnType<typeof setup>, extraEnv: NodeJS.ProcessEnv = {}): Result {
  return runScript(s.repoPath, {
    PATH: `${s.fakeBin}:${process.env.PATH ?? ''}`,
    HOME: process.env.HOME ?? '',
    RUNNER_TEMP: s.runnerTemp,
    GITHUB_OUTPUT: s.outputFile,
    FAKE_PNPM_LOG: s.pnpmLog,
    ...extraEnv,
  });
}

function readVerifyMd(s: ReturnType<typeof setup>): string {
  return readFileSync(join(s.runnerTemp, 'verify.md'), 'utf8');
}

describe('verify-for-sdk-pr.sh', () => {
  it('全部通ったとき、verify.md の見出しから抜いた門の名前と順序が STEPS と一致する', () => {
    const s = setup();

    const result = run(s);

    expect(result.exitCode).toBe(0);
    const verifyMd = readVerifyMd(s);
    const names = extractGateNamesFromVerifyMd(verifyMd);
    expect(names).toEqual((STEPS as Step[]).map((step) => step.name));

    const out = parseGithubOutput(s.outputFile);
    expect(out.ok).toBe('true');
  });

  it('openapi 以外の12本が pnpm を、この順序で呼ぶ（偽 pnpm の呼び出しログで測る）', () => {
    const s = setup();

    const result = run(s);

    expect(result.exitCode).toBe(0);
    const calls = readFileSync(s.pnpmLog, 'utf8')
      .split('\n')
      .filter((l) => l.length > 0);
    const expectedPnpmSteps = (STEPS as Step[])
      .filter((step) => step.cmd === 'pnpm')
      // `?? ''` で黙って通さず、非 undefined だけを残す: undefined の要素が紛れ込んだらここで検出したいため。
      .map((step) => step.args[0])
      .filter((arg): arg is string => arg !== undefined);
    expect(calls).toEqual(expectedPnpmSteps);
    expect(calls).not.toContain('diff');
  });

  it('1本落ちたとき ok=false になり、その門の tail が40行になる（成功した門は10行のまま）', () => {
    const s = setup();

    const result = run(s, { FAKE_PNPM_FAIL_STEP: 'lint', FAKE_PNPM_FAIL_LINES: '45' });

    expect(result.exitCode).toBe(0);
    const out = parseGithubOutput(s.outputFile);
    expect(out.ok).toBe('false');

    const verifyMd = readVerifyMd(s);
    const lintSection = verifyMd.slice(verifyMd.indexOf('### `lint`'));
    expect(lintSection).toContain('**失敗**');
    expect(lintSection).toContain('末尾 40 行');
    const lintBodyLines = lintSection.split('\n').filter((l) => l.startsWith('    fail line'));
    expect(lintBodyLines).toHaveLength(40);
    expect(lintBodyLines[0]).toContain('fail line 6 ');
    expect(lintBodyLines[lintBodyLines.length - 1]).toContain('fail line 45 ');

    const buildSection = verifyMd.slice(
      verifyMd.indexOf('### `build`'),
      verifyMd.indexOf('### `web-bundle-node-traces`'),
    );
    expect(buildSection).toContain('OK');
    expect(buildSection).toContain('末尾 10 行');
  });

  it('全部通れば ok=true になる（失敗を指定しない既定の run() と同じだが、明示的に確かめる）', () => {
    const s = setup();

    const result = run(s);

    expect(result.exitCode).toBe(0);
    const out = parseGithubOutput(s.outputFile);
    expect(out.ok).toBe('true');
    const verifyMd = readVerifyMd(s);
    const okCount = verifyMd.split('\n').filter((l) => /^### `[^`]+` — OK$/.test(l)).length;
    expect(okCount).toBe(STEPS.length);
  });

  // 落ちた門は数ではなく名前で出す: `open-claude-sdk-pr.sh` は `SDK_VERIFY_OK != 'true'` の一値で PR を draft にし、「どれかが本当に落ちた」と「`openapi.json` が変わっただけ」が1つに潰れるため。
  describe('落ちた門の要約（draft の理由が本文から読めること）', () => {
    it('落ちた門を、数ではなく名前と終了コードで先頭に出す', () => {
      const s = setup();

      run(s, { FAKE_PNPM_FAIL_STEP: 'lint', FAKE_PNPM_FAIL_CODE: '2' });

      expect(readVerifyMd(s).split('\n')[0]).toBe('**落ちた門: `lint`（exit 2）**');
    });

    it('⚠️ 2本落ちれば2本とも名前が出る（「2本落ちた」に潰さない）', () => {
      const s = setup();

      run(s, { FAKE_PNPM_FAIL_STEP: 'typecheck lint', FAKE_PNPM_FAIL_CODE: '3' });

      expect(readVerifyMd(s).split('\n')[0]).toBe(
        '**落ちた門: `typecheck`（exit 3） / `lint`（exit 3）**',
      );
    });

    it('git 門（openapi）が落ちたときも名前で出る（pnpm 門だけの仕掛けになっていない）', () => {
      const s = setup();
      writeFileSync(join(s.repoPath, 'apps', 'daemon', 'openapi.json'), '{"openapi":"3.1.1"}\n');

      run(s);

      expect(readVerifyMd(s).split('\n')[0]).toBe('**落ちた門: `openapi`（exit 1）**');
    });

    it('全部通れば本数を名乗る（STEPS の本数と一致すること）', () => {
      const s = setup();

      run(s);

      expect(readVerifyMd(s).split('\n')[0]).toBe(`**${STEPS.length}本すべて通った。**`);
    });
  });

  describe('openapi 門（本物の git で測る）', () => {
    it('apps/daemon/openapi.json に HEAD との差分が無ければ通る', () => {
      const s = setup();

      const result = run(s);

      expect(result.exitCode).toBe(0);
      const verifyMd = readVerifyMd(s);
      const openapiSection = verifyMd.slice(
        verifyMd.indexOf('### `openapi`'),
        verifyMd.indexOf('### `sdk-quotes`'),
      );
      expect(openapiSection).toContain('OK');
      expect(openapiSection).not.toContain('**失敗**');
    });

    it('apps/daemon/openapi.json に HEAD との差分があれば落ちる（ok=false）', () => {
      const s = setup();
      writeFileSync(join(s.repoPath, 'apps', 'daemon', 'openapi.json'), '{"openapi":"3.1.1"}\n');

      const result = run(s);

      expect(result.exitCode).toBe(0);
      const out = parseGithubOutput(s.outputFile);
      expect(out.ok).toBe('false');
      const verifyMd = readVerifyMd(s);
      const openapiSection = verifyMd.slice(
        verifyMd.indexOf('### `openapi`'),
        verifyMd.indexOf('### `sdk-quotes`'),
      );
      expect(openapiSection).toContain('**失敗**');
      expect(openapiSection).toContain(
        '実行: `git diff --exit-code HEAD -- apps/daemon/openapi.json`',
      );
      expect(openapiSection).toContain('openapi.json');
    });
  });
});

// 正規表現で YAML を解釈せず固定文字列の有無を見る: 書き方が変わったときに黙って壊れる測り方を避けるため。
describe('ワークフローからの配線', () => {
  const WORKFLOW = join(SCRIPTS_DIR, '..', 'workflows', 'update-claude-sdk.yml');

  it('update-claude-sdk.yml が verify-for-sdk-pr.sh を `run:` で呼んでいる', () => {
    const yml = readFileSync(WORKFLOW, 'utf8');
    expect(yml).toContain('run: ./.github/scripts/verify-for-sdk-pr.sh');
  });

  it('⚠️ 生 bash が戻っていない（`for cmd in …` を YAML へ書き戻すと、歯の届かない所へ判断が帰る）', () => {
    const yml = readFileSync(WORKFLOW, 'utf8');
    expect(yml).not.toContain('for cmd in');
  });
});
