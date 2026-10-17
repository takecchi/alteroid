// pnpm の入口の包み（`docker/pnpm`。#5009）の歯。本物の corepack は起こさず、PATH の先頭に置いた偽物が「どこで・どの引数で」起こされたかを出す
import { execFileSync } from 'node:child_process';
import { chmodSync, mkdirSync, realpathSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

import { describe, expect, it } from 'vitest';

import { makeTempDirSync } from '../vitest.tmpdir.js';

const SCRIPT = join(dirname(fileURLToPath(import.meta.url)), 'pnpm');

function setup(label: string): {
  root: string;
  repo: string;
  run: (args: string[], env?: Record<string, string>) => string;
} {
  const root = realpathSync(makeTempDirSync(`docker-pnpm-${label}.`));
  const bin = join(root, 'bin');
  mkdirSync(bin);
  writeFileSync(
    join(bin, 'corepack'),
    [
      '#!/bin/sh',
      'printf "CWD:%s\\n" "$(pwd)"',
      'printf "ARGS:%s\\n" "$*"',
      'printf "TOKIO:%s\\n" "${TOKIO_WORKER_THREADS-unset}"',
      'printf "RAYON:%s\\n" "${RAYON_NUM_THREADS-unset}"',
      'printf "ROLLDOWN:%s\\n" "${ROLLDOWN_WORKER_THREADS-unset}"',
      'printf "ROLLDOWN_BLOCKING:%s\\n" "${ROLLDOWN_MAX_BLOCKING_THREADS-unset}"',
      'printf "VITEST:%s\\n" "${VITEST_MAX_WORKERS-unset}"',
      'exit 0',
      '',
    ].join('\n'),
  );
  chmodSync(join(bin, 'corepack'), 0o755);
  const repo = join(root, 'repo');
  mkdirSync(repo);
  const elsewhere = join(root, 'elsewhere');
  mkdirSync(elsewhere);
  const run = (args: string[], env: Record<string, string> = {}): string =>
    execFileSync(SCRIPT, args, {
      cwd: elsewhere,
      env: { PATH: `${bin}:/usr/bin:/bin`, ...env },
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

describe('pnpm の入口: pnpm-native のスレッドを絞る（#5036）', () => {
  it('⭐ 未設定なら TOKIO_WORKER_THREADS と RAYON_NUM_THREADS を 2 にして corepack を起こす', () => {
    const { run } = setup('threads');
    const out = run(['--version']);
    expect(out).toContain('TOKIO:2\n');
    expect(out).toContain('RAYON:2\n');
  });

  it('担当が値を置いていれば、それに従う', () => {
    const { run } = setup('threads-own');
    const out = run(['--version'], { TOKIO_WORKER_THREADS: '8', RAYON_NUM_THREADS: '6' });
    expect(out).toContain('TOKIO:8\n');
    expect(out).toContain('RAYON:6\n');
  });
});

describe('pnpm の入口: rolldown のスレッドと vitest の worker を絞る（#5039）', () => {
  it('⭐ 未設定なら rolldown の2つを 2、VITEST_MAX_WORKERS を 4 にする', () => {
    const { run } = setup('rolldown');
    const out = run(['exec', 'vitest', 'run']);
    expect(out).toContain('ROLLDOWN:2\n');
    expect(out).toContain('ROLLDOWN_BLOCKING:2\n');
    expect(out).toContain('VITEST:4\n');
  });

  it('担当が値を置いていれば、それに従う', () => {
    const { run } = setup('rolldown-own');
    const out = run(['test'], {
      ROLLDOWN_WORKER_THREADS: '8',
      ROLLDOWN_MAX_BLOCKING_THREADS: '6',
      VITEST_MAX_WORKERS: '1',
    });
    expect(out).toContain('ROLLDOWN:8\n');
    expect(out).toContain('ROLLDOWN_BLOCKING:6\n');
    expect(out).toContain('VITEST:1\n');
  });

  it('⭐ 引数に --maxWorkers があれば VITEST_MAX_WORKERS を置かない（env は CLI を上書きするため）', () => {
    const { run } = setup('maxworkers');
    expect(run(['exec', 'vitest', 'run', '--maxWorkers=1'])).toContain('VITEST:unset\n');
    expect(run(['exec', 'vitest', 'run', '--maxWorkers', '1'])).toContain('VITEST:unset\n');
    expect(run(['test', '--', '--max-workers=2'])).toContain('VITEST:unset\n');
  });
});
