/**
 * 変異ハーネスの CLI が、サブコマンドの読まない引数を黙って無視しないことの歯（#2106）。
 *
 * **踏んだ形。** `node mutate.mjs baseline --help` は使い方を出さずに `pnpm test` の
 * 全体を起こしていた——各 `cmd*` は自分の読む引数だけを `indexOf` で拾い、残りを
 * 無視していたからである。作業者が使い方を確かめるつもりで長い処理を起こし、止める
 * ためにプロセスを kill していた（2026-09-29 に2回）。
 *
 * 判定は `mutate-core.mjs` の `classifyCliArgs`（純関数）に置き、`mutate.mjs` の
 * `main()` がサブコマンドを呼ぶ前に通す。ここでは (1) 純関数の分岐と (2) 実際に CLI を
 * 起こして「何も走らなかった」ことの両方を測る。(2) は、`test` を打つと印のファイルを
 * 書くだけの偽の root を `--root` に渡し、**印が書かれないこと**で確かめる——本物の
 * 全体テストを起こさずに、回帰したら必ず印が残る形である。
 */
import { spawnSync } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import { describe, expect, it } from 'vitest';

import { makeTempDirSync } from '../vitest.tmpdir.js';

import { mutateCliChildEnv } from './mutate-cli-child-env.js';
import {
  CLI_COMMAND_ARGS,
  classifyCliArgs,
  cliUsageText,
  // @ts-expect-error -- 素の .mjs（型宣言を持たない変異試験ハーネス）を読む
} from '../.claude/skills/mutation-testing/mutate-core.mjs';

/** `CLI_COMMAND_ARGS` の1件の形（`.mjs` は型を持たないので、ここで読む分だけ書く）。 */
type CommandArgs = { bool: string[]; value: string[] };

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const REPO_ROOT = path.resolve(__dirname, '..');
const MUTATE_CLI = path.join(REPO_ROOT, '.claude/skills/mutation-testing/mutate.mjs');

describe('classifyCliArgs（#2106）', () => {
  it('--help / -h はサブコマンドの前でも後ろでも help', () => {
    expect(classifyCliArgs('--help', [])).toEqual({ kind: 'help' });
    expect(classifyCliArgs('-h', [])).toEqual({ kind: 'help' });
    expect(classifyCliArgs('help', [])).toEqual({ kind: 'help' });
    expect(classifyCliArgs('baseline', ['--help'])).toEqual({ kind: 'help' });
    expect(classifyCliArgs('run', ['--plan', 'p.json', '-h'])).toEqual({ kind: 'help' });
    expect(classifyCliArgs('apply', ['--spec', 's.json', '--root', '/x', '--help'])).toEqual({
      kind: 'help',
    });
  });

  it('各サブコマンドが読む引数だけなら pass', () => {
    expect(classifyCliArgs('status', [])).toEqual({ kind: 'pass' });
    expect(classifyCliArgs('status', ['--root', '/x'])).toEqual({ kind: 'pass' });
    expect(classifyCliArgs('baseline', ['--max-workers', '2', '--allow-existing-marker'])).toEqual({
      kind: 'pass',
    });
    expect(classifyCliArgs('baseline', ['--max-workers=2'])).toEqual({ kind: 'pass' });
    expect(classifyCliArgs('apply', ['--spec', 's.json', '--root', '/x'])).toEqual({
      kind: 'pass',
    });
    expect(classifyCliArgs('restore', ['--restore-from-marker'])).toEqual({ kind: 'pass' });
    expect(
      classifyCliArgs('run', ['--plan', 'p.json', '--max-workers=1', '--allow-existing-marker']),
    ).toEqual({ kind: 'pass' });
    expect(classifyCliArgs('selftest', ['--scenario', 'all'])).toEqual({ kind: 'pass' });
  });

  it('サブコマンドが読まない引数は名指しして unknown-args（値として読まれる要素は数えない）', () => {
    expect(classifyCliArgs('baseline', ['--maxWorkers=2'])).toEqual({
      kind: 'unknown-args',
      unknown: ['--maxWorkers=2'],
    });
    // `--spec` は `indexOf` の完全一致でしか読まれないので `=` の形は読まれない
    expect(classifyCliArgs('apply', ['--spec=s.json'])).toEqual({
      kind: 'unknown-args',
      unknown: ['--spec=s.json'],
    });
    // 他のサブコマンドの引数も知らない引数である
    expect(classifyCliArgs('restore', ['--plan', 'p.json'])).toEqual({
      kind: 'unknown-args',
      unknown: ['--plan', 'p.json'],
    });
    expect(classifyCliArgs('status', ['extra'])).toEqual({
      kind: 'unknown-args',
      unknown: ['extra'],
    });
    // `--root` の値は引数として数えない
    expect(classifyCliArgs('status', ['--root', '--weird-path'])).toEqual({ kind: 'pass' });
  });

  it('サブコマンドが無い・知らないサブコマンドは pass（従来どおり default 節が扱う）', () => {
    expect(classifyCliArgs(undefined, [])).toEqual({ kind: 'pass' });
    expect(classifyCliArgs('nope', ['--x'])).toEqual({ kind: 'pass' });
    // prototype のキーをサブコマンドとして取り違えない
    expect(classifyCliArgs('toString', ['--x'])).toEqual({ kind: 'pass' });
  });

  it('使い方の本文は CLI_COMMAND_ARGS の全サブコマンドと全引数を名指しする', () => {
    const text = cliUsageText();
    for (const [name, spec] of Object.entries(CLI_COMMAND_ARGS as Record<string, CommandArgs>)) {
      expect(text).toContain(`  ${name}`);
      for (const flag of [...spec.bool, ...spec.value]) expect(text).toContain(flag);
    }
    expect(text).toContain('--root');
  });
});

/**
 * `test` を打つと `RAN` というファイルを書くだけの偽の root（`ran.cjs`）。`pnpm-workspace.yaml` を
 * 置くのは、`pnpm` が上へ遡って本物のリポジトリで全体テストを起こさないようにするため
 * （#2106 の再現で、`package.json` の無い root を渡したら実際にそうなりかけた）。
 */
function makeFakeRoot(): string {
  const dir = makeTempDirSync('mutate-cli-args-');
  fs.writeFileSync(
    path.join(dir, 'package.json'),
    JSON.stringify({
      name: 'mutate-cli-args-fake-root',
      private: true,
      // `node -e` にすると、ハーネスが後ろへ足す `--maxWorkers=…` などを node 自身が
      // 知らない option として断り、印を書く前に落ちる。引数を読まないファイルにする。
      scripts: { test: 'node ran.cjs' },
    }),
  );
  fs.writeFileSync(path.join(dir, 'ran.cjs'), "require('fs').writeFileSync('RAN', '');\n");
  fs.writeFileSync(path.join(dir, 'pnpm-workspace.yaml'), 'packages: []\n');
  return dir;
}

function runCli(args: string[]) {
  return spawnSync('node', [MUTATE_CLI, ...args], {
    cwd: REPO_ROOT,
    encoding: 'utf8',
    env: mutateCliChildEnv(),
    timeout: 60_000,
  });
}

describe('mutate.mjs の CLI は、--help と知らない引数では何も走らせない（#2106）', () => {
  it('baseline --help は使い方を出して exit 0、テストを起こさない', () => {
    const root = makeFakeRoot();
    const result = runCli(['baseline', '--help', '--root', root]);
    expect(result.status).toBe(0);
    expect(result.stdout).toContain('使い方: node mutate.mjs');
    expect(result.stdout).not.toContain('── baseline ──');
    expect(fs.existsSync(path.join(root, 'RAN'))).toBe(false);
  });

  it('baseline に知らない引数を渡すと、名指しして exit 1、テストを起こさない', () => {
    const root = makeFakeRoot();
    const result = runCli(['baseline', '--maxWorkers=2', '--root', root]);
    expect(result.status).toBe(1);
    expect(result.stdout).toContain('"--maxWorkers=2"');
    expect(result.stdout).not.toContain('── baseline ──');
    expect(fs.existsSync(path.join(root, 'RAN'))).toBe(false);
  });

  it('run --plan <p> --help も同じく何も走らせない', () => {
    const root = makeFakeRoot();
    const result = runCli(['run', '--plan', path.join(root, 'no-such-plan.json'), '--help']);
    expect(result.status).toBe(0);
    expect(result.stdout).toContain('使い方: node mutate.mjs');
    expect(fs.existsSync(path.join(root, 'RAN'))).toBe(false);
  });

  it('（対照）偽の root で baseline を正しい引数で打つと、実際にテストを起こす', () => {
    // この対照が緑であることが、上の3本の「RAN が無い」を意味のある観測にする——
    // 偽の root が壊れていて何を渡しても走らないなら、上の3本は何も測っていない。
    const root = makeFakeRoot();
    runCli(['baseline', '--max-workers', '1', '--root', root]);
    expect(fs.existsSync(path.join(root, 'RAN'))).toBe(true);
  });
});
