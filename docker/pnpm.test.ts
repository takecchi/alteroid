// pnpm の入口の包み（`docker/pnpm`。#5009）の歯。本物の corepack は起こさず、PATH の先頭に置いた偽物が「どこで・どの引数で」起こされたかを出す
import { execFileSync } from 'node:child_process';
import { chmodSync, mkdirSync, realpathSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

import { describe, expect, it } from 'vitest';

import { makeTempDirSync } from '../vitest.tmpdir.js';

const SCRIPT = join(dirname(fileURLToPath(import.meta.url)), 'pnpm');

function setup(label: string): { root: string; repo: string; run: (args: string[]) => string } {
  const root = realpathSync(makeTempDirSync(`docker-pnpm-${label}.`));
  const bin = join(root, 'bin');
  mkdirSync(bin);
  writeFileSync(
    join(bin, 'corepack'),
    ['#!/bin/sh', 'printf "CWD:%s\\n" "$(pwd)"', 'printf "ARGS:%s\\n" "$*"', 'exit 0', ''].join(
      '\n',
    ),
  );
  chmodSync(join(bin, 'corepack'), 0o755);
  const repo = join(root, 'repo');
  mkdirSync(repo);
  const elsewhere = join(root, 'elsewhere');
  mkdirSync(elsewhere);
  const run = (args: string[]): string =>
    execFileSync(SCRIPT, args, {
      cwd: elsewhere,
      env: { PATH: `${bin}:/usr/bin:/bin` },
      encoding: 'utf8',
    });
  return { root, repo, run };
}

describe('pnpm の入口: -C / --dir の絶対パスへ移ってから corepack を起こす（#5009）', () => {
  it('⭐ -C <絶対パス> なら、そのディレクトリで corepack pnpm を起こし、引数はそのまま渡す', () => {
    const { repo, run } = setup('c');
    const out = run(['-C', repo, 'install', '--frozen-lockfile']);
    expect(out).toContain(`CWD:${repo}\n`);
    expect(out).toContain(`ARGS:pnpm -C ${repo} install --frozen-lockfile\n`);
  });

  it('--dir=<絶対パス> と -C<絶対パス>（くっつけた形）も同じく移る', () => {
    const { repo, run } = setup('dir');
    expect(run([`--dir=${repo}`, 'test'])).toContain(`CWD:${repo}\n`);
    expect(run([`-C${repo}`, 'test'])).toContain(`CWD:${repo}\n`);
    expect(run(['--dir', repo, 'test'])).toContain(`CWD:${repo}\n`);
  });

  it('指定が無い・相対パス・無いディレクトリのときは移らない（今どおり）', () => {
    const { root, run } = setup('stay');
    const elsewhere = join(root, 'elsewhere');
    expect(run(['--version'])).toContain(`CWD:${elsewhere}\n`);
    expect(run(['-C', 'repo', 'test'])).toContain(`CWD:${elsewhere}\n`);
    expect(run(['-C', join(root, 'no-such-dir'), 'test'])).toContain(`CWD:${elsewhere}\n`);
  });
});
