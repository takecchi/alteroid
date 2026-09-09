/**
 * `.github/scripts/verify-for-sdk-pr.sh` を固定する。
 *
 * **本物の git を使う。偽物は pnpm だけ**（`update-claude-sdk.test.ts` と同じ方針）。
 * `openapi` 門は `git diff --exit-code HEAD -- apps/daemon/openapi.json` を回す
 * ので、git を偽物にすると測れるものが「呼ばれたか」だけになり、「差分の有無を
 * 正しく判定できているか」が測れなくなる。実物の一時 repo で測る。
 *
 * **偽の pnpm は「呼ばれた引数を記録するだけ」の記録係。** どの gate を落とすかは
 * `FAKE_PNPM_FAIL_STEP`（サブコマンド名。空白区切りで複数指定できる。例: `typecheck lint`）、
 * 終了コードは `FAKE_PNPM_FAIL_CODE`（既定 1）でテストが指定する。指定したサブコマンド
 * だけ非0行の出力を吐いてその code で落ち、それ以外は1行の成功出力を返す。
 * pnpm 自身の実際のビルド・lint・test ロジックは一切持たない。
 *
 * ## ⚠️ この歯が測っているものと、測っていないもの
 *
 * **本体は、スクリプトが `STEPS` の9本を回すことを、実際に走らせた出力
 * （`verify.md`）から測る。** ソースを読んで数えてはいない。
 *
 * **それとは別に、末尾の `describe('ワークフローからの配線')` が
 * `update-claude-sdk.yml` に `run:` の1行が在ることを見ている。⚠️ こちらは
 * 「書いてある」を見ているだけで、「呼ばれた」は測っていない。**
 * 固定文字列の有無を見るだけなので黙って壊れることはない（1行が消えても別の
 * スクリプトへ差し替えられても落ちる）が、**ステップが `if:` の条件で実行され
 * ない形に変わった場合は、この歯は何も言わない。** そこは測れていない。
 */
import { execFileSync, spawnSync } from 'node:child_process';
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

import { STEPS } from '../../scripts/verify-core.mjs';

const SCRIPTS_DIR = dirname(fileURLToPath(import.meta.url));
const SCRIPT = join(SCRIPTS_DIR, 'verify-for-sdk-pr.sh');

/** この環境にグローバル設定（`~/.gitconfig`）が無い前提で、git 操作には
 * `-c user.email=...` / `-c user.name=...` を明示で渡す
 * （`update-claude-sdk.test.ts` の `GIT_IDENTITY` と同じ理由）。 */
const GIT_IDENTITY = ['-c', 'user.email=verify-test@example.com', '-c', 'user.name=Verify Test'];

function git(cwd: string, args: string[]): string {
  return execFileSync('git', [...GIT_IDENTITY, ...args], { cwd, encoding: 'utf8' });
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

/** `$GITHUB_OUTPUT` に書かれた `key=value` 行を Record にする。 */
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

/** `verify.md` の見出し行（`### \`<name>\` — <status>`）から門の名前だけを、
 * 出た順のまま抜く。**左辺（比較対象）はスクリプトの実行の出力であって、
 * ソースを読んで数えたものではない**（依頼の要件そのもの）。 */
function extractGateNamesFromVerifyMd(verifyMd: string): string[] {
  const names: string[] = [];
  for (const line of verifyMd.split('\n')) {
    const m = /^### `([^`]+)` — /.exec(line);
    if (m) names.push(m[1]);
  }
  return names;
}

/** 偽の pnpm。呼ばれたサブコマンドを `FAKE_PNPM_LOG` へ1行ずつ記録するだけ。
 * `FAKE_PNPM_FAIL_STEP` と一致するサブコマンドだけ非0行を吐いて exit 1、
 * それ以外は1行の成功出力を返す。pnpm 自体のビルド・lint 等のロジックは
 * 一切持たない。 */
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

/** repo を作り、`apps/daemon/openapi.json` を追跡下に置いて1コミットする
 * （`openapi` 門が `git diff --exit-code HEAD -- apps/daemon/openapi.json` を
 * 見るため、この repo は openapi 門の判定対象そのものでもある）。 */
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
  const root = mkdtempSync(join(tmpdir(), 'verify-for-sdk-pr-test.'));
  const repoPath = initRepo(root);
  const fakePnpm = join(root, 'fake-pnpm.sh');
  writeFakePnpm(fakePnpm);
  const fakeBin = join(root, 'fake-bin');
  mkdirSync(fakeBin);
  // 呼ばれる名前は素の `pnpm`（スクリプト自身が `pnpm` を直接呼ぶ実装のため、
  // `PNPM=` のような差し替え口ではなく PATH 上の `pnpm` そのものを差し替える）。
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
    // fakeBin を先頭に置き、本物の git はそのまま PATH の後段から使わせる。
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
    // **左辺は実行結果（verify.md）から抜いたもの。右辺は STEPS を import したもの。**
    // どちらもソースを目視で数えていない。
    expect(names).toEqual(STEPS.map((step) => step.name));

    const out = parseGithubOutput(s.outputFile);
    expect(out.ok).toBe('true');
  });

  it('openapi 以外の8本が pnpm を、この順序で呼ぶ（偽 pnpm の呼び出しログで測る）', () => {
    const s = setup();

    const result = run(s);

    expect(result.exitCode).toBe(0);
    const calls = readFileSync(s.pnpmLog, 'utf8')
      .split('\n')
      .filter((l) => l.length > 0);
    const expectedPnpmSteps = STEPS.filter((step) => step.cmd === 'pnpm').map(
      (step) => step.args[0],
    );
    expect(calls).toEqual(expectedPnpmSteps);
    // openapi は git 門なので pnpm には現れない。
    expect(calls).not.toContain('diff');
  });

  it('1本落ちたとき ok=false になり、その門の tail が40行になる（成功した門は10行のまま）', () => {
    const s = setup();

    const result = run(s, { FAKE_PNPM_FAIL_STEP: 'lint', FAKE_PNPM_FAIL_LINES: '45' });

    expect(result.exitCode).toBe(0); // このスクリプト自体は `set +e` で最後まで走り切る
    const out = parseGithubOutput(s.outputFile);
    expect(out.ok).toBe('false');

    const verifyMd = readVerifyMd(s);
    // 落ちた門（lint）の見出しと tail 40 行の注記
    const lintSection = verifyMd.slice(verifyMd.indexOf('### `lint`'));
    expect(lintSection).toContain('**失敗**');
    expect(lintSection).toContain('末尾 40 行');
    const lintBodyLines = lintSection.split('\n').filter((l) => l.startsWith('    fail line'));
    expect(lintBodyLines).toHaveLength(40);
    // 45行中、末尾40行なので "fail line 6" から "fail line 45" までが残る
    expect(lintBodyLines[0]).toContain('fail line 6 ');
    expect(lintBodyLines[lintBodyLines.length - 1]).toContain('fail line 45 ');

    // 成功した門（build）は10行tailのまま
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
    // 9本すべてが「OK」の見出しになっている
    const verifyMd = readVerifyMd(s);
    const okCount = verifyMd.split('\n').filter((l) => /^### `[^`]+` — OK$/.test(l)).length;
    expect(okCount).toBe(STEPS.length);
  });

  /**
   * 落ちた門の名前を要約として先頭に出すこと。
   *
   * **なぜ数ではなく名前か。** `open-claude-sdk-pr.sh` は `SDK_VERIFY_OK != 'true'` の
   * 一値で PR を draft にする。その1つの値は「9本のどれかが本当に落ちた」と
   * 「`openapi.json` が変わっただけ」という**性質の違う状態を1つに潰している**。
   * 本文に門の名前が出ていれば、draft を受け取った人がその場で見分けられる。
   * **「1本落ちた」という数だけでは、また潰れる。**
   */
  describe('落ちた門の要約（draft の理由が本文から読めること）', () => {
    it('落ちた門を、数ではなく名前と終了コードで先頭に出す', () => {
      const s = setup();

      run(s, { FAKE_PNPM_FAIL_STEP: 'lint', FAKE_PNPM_FAIL_CODE: '2' });

      expect(readVerifyMd(s).split('\n')[0]).toBe('**落ちた門: `lint`（exit 2）**');
    });

    it('⚠️ 2本落ちれば2本とも名前が出る（「2本落ちた」に潰さない）', () => {
      const s = setup();

      run(s, { FAKE_PNPM_FAIL_STEP: 'typecheck lint', FAKE_PNPM_FAIL_CODE: '3' });

      // 並びは STEPS の順（typecheck が先）。区切りは ` / `。
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
      // initRepo の時点で HEAD と作業ツリーは一致している（差分無し）

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
      // git diff の生出力（差分そのもの）が残っている
      expect(openapiSection).toContain('openapi.json');
    });
  });
});

/**
 * ワークフローからこのスクリプトへの配線。
 *
 * **⚠️ ここだけは「実行の出力」ではなく設定（YAML の文字列）を読んでいる。**
 * 上の本体（`verify.md` を数える歯）とは種類が違うので、describe を分けてある。
 *
 * **それでも置くのは、穴が塞がるからではなく、穴が小さくなるからである。**
 * `run:` の1行が消えるか別のスクリプトへ差し替えられれば、9本を回す本体の歯は
 * 何も言わない（そちらはスクリプト単体を測っているので、呼ばれなくなっても緑）。
 * ここで固定文字列の有無を見ておけば、その2つは落ちる。
 *
 * **⚠️ 残る穴を名乗っておく。** `if: steps.update.outputs.changed == 'true'` の
 * 条件が変わってステップが実行されなくなった場合、`run:` の1行は在るままなので
 * **この歯は何も言わない。** 正規表現で YAML を解釈しないのは意図である
 * （書き方が変わったときに黙って壊れる測り方を、この repo は他所でも避けている）。
 */
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
