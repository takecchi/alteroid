/**
 * `docker/runner-extra`（runner の器へのビルド時の追加層）を固定する。
 *
 * **本物の apt には一切触れない。** `ALTEROID_EXTRA_APT_GET` で偽の apt-get に
 * 差し替え、呼ばれた引数を1呼び出し1行でファイルへ記録して確かめる。
 * 環境は `process.env` を継がず、呼び出しごとに丸ごと組み立てて渡す
 * （`docker/gh.test.ts` と同じ型）。
 *
 * 「弾くべきもの」と「通すべきもの」を対で置く。
 */
import { spawnSync } from 'node:child_process';
import {
  chmodSync,
  existsSync,
  mkdirSync,
  readdirSync,
  readFileSync,
  writeFileSync,
} from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

import { describe, expect, it } from 'vitest';

import { makeTempDirSync } from '../vitest.tmpdir.js';

const SCRIPT = join(dirname(fileURLToPath(import.meta.url)), 'runner-extra');

type Result = {
  exitCode: number;
  stdout: string;
  stderr: string;
  aptCalls: string[];
  root: string;
};

function run(extra: Record<string, string>): Result {
  const root = makeTempDirSync('docker-runner-extra-test.');
  const log = join(root, 'apt-calls.log');
  const fakeApt = join(root, 'fake-apt-get');
  writeFileSync(fakeApt, ['#!/bin/sh', `printf '%s\\n' "$*" >> '${log}'`, 'exit 0', ''].join('\n'));
  chmodSync(fakeApt, 0o755);

  const lists = join(root, 'apt-lists');
  mkdirSync(lists);
  writeFileSync(join(lists, 'stale'), 'x');
  const r = spawnSync('/bin/sh', [SCRIPT], {
    env: {
      PATH: '/usr/bin:/bin',
      ALTEROID_EXTRA_APT_GET: fakeApt,
      // 本物の /var/lib/apt/lists に触らない。
      ALTEROID_EXTRA_APT_LISTS: lists,
      ...extra,
    },
    encoding: 'utf8',
  });
  const aptCalls = existsSync(log)
    ? readFileSync(log, 'utf8')
        .split('\n')
        .filter((l) => l !== '')
    : [];
  return {
    exitCode: r.status ?? 1,
    stdout: r.stdout,
    stderr: r.stderr,
    aptCalls,
    listsLeft: readdirSync(lists),
  };
}

describe('両方が空', () => {
  it.each([
    ['変数が無い', {}],
    ['空文字', { ALTEROID_EXTRA_APT_PACKAGES: '', ALTEROID_EXTRA_SETUP: '' }],
    ['空白と改行だけのパッケージ', { ALTEROID_EXTRA_APT_PACKAGES: ' \n\t ' }],
  ])('%s: apt は呼ばれず 0 で抜ける', (_label, env) => {
    const r = run(env);
    expect(r.exitCode).toBe(0);
    expect(r.aptCalls).toEqual([]);
    // 何もしない: リストにも触れない。
    expect(r.listsLeft).toEqual(['stale']);
  });
});

describe('正しいパッケージ名（通す）', () => {
  it('hello / libwebkit2gtk-4.1-dev / g++ は update と install が期待の引数で呼ばれる', () => {
    const r = run({ ALTEROID_EXTRA_APT_PACKAGES: 'hello libwebkit2gtk-4.1-dev\ng++' });
    expect(r.exitCode).toBe(0);
    expect(r.aptCalls).toEqual([
      'update',
      'install -y --no-install-recommends hello libwebkit2gtk-4.1-dev g++',
    ]);
    // 基底の流儀どおり、apt のリストは層に残さない。
    expect(r.listsLeft).toEqual([]);
  });

  it('1つだけでも通る', () => {
    const r = run({ ALTEROID_EXTRA_APT_PACKAGES: 'hello' });
    expect(r.exitCode).toBe(0);
    expect(r.aptCalls).toEqual(['update', 'install -y --no-install-recommends hello']);
  });
});

describe('不正なパッケージ名（弾く）', () => {
  it.each([['-o'], ['foo;rm'], ['Foo'], ['../x'], ['*'], ['$(id)'], ['-y']])(
    '%s は名前を出して非0で落ち、apt は呼ばれない',
    (bad) => {
      const r = run({ ALTEROID_EXTRA_APT_PACKAGES: bad });
      expect(r.exitCode).not.toBe(0);
      expect(r.stderr).toContain(bad);
      expect(r.aptCalls).toEqual([]);
    },
  );

  it('正しい名前に混ざった1つの不正でも、何もインストールしない', () => {
    const r = run({ ALTEROID_EXTRA_APT_PACKAGES: 'hello -o Dir::Etc=/x g++' });
    expect(r.exitCode).not.toBe(0);
    expect(r.aptCalls).toEqual([]);
  });

  it('不正なパッケージがあれば SETUP も走らない', () => {
    const root = makeTempDirSync('docker-runner-extra-nosetup.');
    const out = join(root, 'ran.txt');
    const r = run({
      ALTEROID_EXTRA_APT_PACKAGES: 'Foo',
      ALTEROID_EXTRA_SETUP: `touch '${out}'`,
    });
    expect(r.exitCode).not.toBe(0);
    expect(existsSync(out)).toBe(false);
  });
});

describe('SETUP', () => {
  it('パッケージが空でも SETUP は走り、apt は呼ばれない', () => {
    const r = run({ ALTEROID_EXTRA_SETUP: 'echo setup-ran' });
    expect(r.exitCode).toBe(0);
    expect(r.stdout).toContain('setup-ran');
    expect(r.aptCalls).toEqual([]);
  });

  it('パッケージのインストールの後に走る', () => {
    const root = makeTempDirSync('docker-runner-extra-order.');
    const out = join(root, 'order.txt');
    const r = run({
      ALTEROID_EXTRA_APT_PACKAGES: 'hello',
      ALTEROID_EXTRA_SETUP: `printf 'setup\\n' > '${out}'`,
    });
    expect(r.exitCode).toBe(0);
    expect(r.aptCalls).toHaveLength(2);
    expect(readFileSync(out, 'utf8')).toBe('setup\n');
  });

  it('SETUP の失敗は非0（ビルド失敗）になる', () => {
    const r = run({ ALTEROID_EXTRA_SETUP: 'exit 7' });
    expect(r.exitCode).not.toBe(0);
  });

  it('SETUP は sh -eu で走る（途中の失敗で止まり、未定義変数も失敗にする）', () => {
    const a = run({ ALTEROID_EXTRA_SETUP: 'false\necho after' });
    expect(a.exitCode).not.toBe(0);
    expect(a.stdout).not.toContain('after');
    const b = run({ ALTEROID_EXTRA_SETUP: 'echo "$UNDEFINED_VAR_XYZ"' });
    expect(b.exitCode).not.toBe(0);
  });
});
