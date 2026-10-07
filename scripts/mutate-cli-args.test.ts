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
    expect(classifyCliArgs('apply', ['--spec=s.json'])).toEqual({
      kind: 'unknown-args',
      unknown: ['--spec=s.json'],
    });
    expect(classifyCliArgs('restore', ['--plan', 'p.json'])).toEqual({
      kind: 'unknown-args',
      unknown: ['--plan', 'p.json'],
    });
    expect(classifyCliArgs('status', ['extra'])).toEqual({
      kind: 'unknown-args',
      unknown: ['extra'],
    });
    expect(classifyCliArgs('status', ['--root', '--weird-path'])).toEqual({ kind: 'pass' });
  });

  it('サブコマンドが無い・知らないサブコマンドは pass（従来どおり default 節が扱う）', () => {
    expect(classifyCliArgs(undefined, [])).toEqual({ kind: 'pass' });
    expect(classifyCliArgs('nope', ['--x'])).toEqual({ kind: 'pass' });
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

// `pnpm-workspace.yaml` を置く: `pnpm` が上へ遡って本物のリポジトリで全体テストを起こさないようにするため。
function makeFakeRoot(): string {
  const dir = makeTempDirSync('mutate-cli-args-');
  fs.writeFileSync(
    path.join(dir, 'package.json'),
    JSON.stringify({
      name: 'mutate-cli-args-fake-root',
      private: true,
      // `node -e` にしない: ハーネスが後ろへ足す `--maxWorkers=…` などを node 自身が知らない option として断り、印を書く前に落ちるため。
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
    // `--root` を渡す: 渡さないと `run` は本物の repo root を向き、下の「RAN が無い」が回帰しても常に真になるため。
    const result = runCli([
      'run',
      '--plan',
      path.join(root, 'no-such-plan.json'),
      '--help',
      '--root',
      root,
    ]);
    expect(result.status).toBe(0);
    expect(result.stdout).toContain('使い方: node mutate.mjs');
    expect(fs.existsSync(path.join(root, 'RAN'))).toBe(false);
  });

  it('（対照）偽の root で baseline を正しい引数で打つと、実際にテストを起こす', () => {
    const root = makeFakeRoot();
    runCli(['baseline', '--max-workers', '1', '--root', root]);
    expect(fs.existsSync(path.join(root, 'RAN'))).toBe(true);
  });
});
