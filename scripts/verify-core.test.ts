import { execFileSync, spawnSync } from 'node:child_process';
import { rm, writeFile, mkdir, chmod, symlink, unlink, readFile, readdir } from 'node:fs/promises';
import { writeFileSync, readFileSync, statSync, copyFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

import { describe, expect, it } from 'vitest';

import { makeTempDir } from '../vitest.tmpdir.js';

import { gitChildEnv } from './git-child-env.js';
import {
  classifyTest,
  classifyTestScope,
  decideRecord,
  decideSkip,
  envForStep,
  fingerprint,
  hasSkipWorktreeOrAssumeUnchanged,
  recordFor,
  recordPathFor,
  splitVerifyArgs,
  STEPS,
  testRan,
  writeTreeFor,
  // @ts-expect-error -- 素の .mjs（型宣言を持たない build 用スクリプト）を読む
} from './verify-core.mjs';

const SCRIPTS_DIR = dirname(fileURLToPath(import.meta.url));

// 動いたら緑を名乗らない歯と動いていなければ緑を名乗る歯を別々に置く: 前者だけだと「常に走る」実装が、後者だけだと「常に無料で返す」実装が緑になるため。
describe('pnpm verify — 通し直しを無料にする判定', () => {
  async function makeRepo(): Promise<string> {
    const dir = await makeTempDir('verify-core-');
    const git = (...args: string[]) =>
      execFileSync('git', args, { cwd: dir, encoding: 'utf8', env: gitChildEnv() });
    git('init', '-q');
    git('config', 'user.email', 'test@example.invalid');
    git('config', 'user.name', 'test');
    await writeFile(join(dir, 'a.txt'), 'one\n');
    git('add', '-A');
    git('commit', '-qm', 'init');
    return dir;
  }

  const record = (dir: string) => join(dir, '.git', 'alteroid-verify.json');
  // 記録の日付は固定する: 実行日（壁時計）に依存させないため。この固定日を使う歯は `decideSkip` にも同じ `today: '2026-08-22'` を渡す。
  const save = (dir: string, fp: string, day = '2026-08-22') =>
    writeFileSync(
      record(dir),
      JSON.stringify({ fingerprint: fp, at: '2026-08-22T00:00:00.000Z', day }),
    );

  it('歯②: ツリーが動いていなければ、無料で返す（緑を名乗る）', async () => {
    const dir = await makeRepo();
    const fp = fingerprint(dir) as string;
    expect(fp).not.toBeNull();
    save(dir, fp);

    const decided = decideSkip({ repo: dir, recordPath: record(dir), today: '2026-08-22' });
    expect(decided.skip).toBe(true);
    expect(decided.reason).toBe('unchanged');
    expect(decided.at).toBe('2026-08-22T00:00:00.000Z');
  });

  it('歯①: ツリーが動いたら、緑を名乗らない', async () => {
    const dir = await makeRepo();
    save(dir, fingerprint(dir) as string);

    await writeFile(join(dir, 'a.txt'), 'two\n');
    expect(decideSkip({ repo: dir, recordPath: record(dir) })).toMatchObject({
      skip: false,
      reason: 'changed',
    });
  });

  it('未追跡のファイルが増えただけでも、緑を名乗らない', async () => {
    const dir = await makeRepo();
    save(dir, fingerprint(dir) as string);

    await writeFile(join(dir, 'b.txt'), 'new\n');
    expect(decideSkip({ repo: dir, recordPath: record(dir) })).toMatchObject({ skip: false });
  });

  it('ignore されているものは指紋に入らない（node_modules で毎回走らない）', async () => {
    const dir = await makeRepo();
    await writeFile(join(dir, '.gitignore'), 'ignored/\n');
    execFileSync('git', ['add', '-A'], { cwd: dir, env: gitChildEnv() });
    execFileSync('git', ['commit', '-qm', 'ignore'], { cwd: dir, env: gitChildEnv() });
    save(dir, fingerprint(dir) as string);

    await mkdir(join(dir, 'ignored'), { recursive: true });
    await writeFile(join(dir, 'ignored', 'x'), 'noise\n');
    expect(decideSkip({ repo: dir, recordPath: record(dir), today: '2026-08-22' })).toMatchObject({
      skip: true,
    });
  });

  describe('指紋が一致していても、記録した日が違えば畳まない（Issue #1191）', () => {
    it('指紋も日も一致（対照）→ skip:true', async () => {
      const dir = await makeRepo();
      const fp = fingerprint(dir) as string;
      save(dir, fp, '2026-08-22');
      expect(decideSkip({ repo: dir, recordPath: record(dir), today: '2026-08-22' })).toMatchObject(
        { skip: true, reason: 'unchanged' },
      );
    });

    it('指紋は一致・日が違う（昨日）→ skip:false, reason:stale-day', async () => {
      const dir = await makeRepo();
      const fp = fingerprint(dir) as string;
      save(dir, fp, '2026-08-21');
      expect(decideSkip({ repo: dir, recordPath: record(dir), today: '2026-08-22' })).toMatchObject(
        { skip: false, reason: 'stale-day', day: '2026-08-21', today: '2026-08-22' },
      );
    });

    it('記録が旧形式（day を持たない）→ skip:false, reason:stale-day（安全側）', async () => {
      const dir = await makeRepo();
      const fp = fingerprint(dir) as string;
      writeFileSync(
        record(dir),
        JSON.stringify({ fingerprint: fp, at: '2026-08-22T00:00:00.000Z' }),
      );
      expect(decideSkip({ repo: dir, recordPath: record(dir), today: '2026-08-22' })).toMatchObject(
        { skip: false, reason: 'stale-day' },
      );
    });

    it('day が文字列でない（壊れた形）も stale-day へ倒す', async () => {
      const dir = await makeRepo();
      const fp = fingerprint(dir) as string;
      writeFileSync(
        record(dir),
        JSON.stringify({ fingerprint: fp, at: '2026-08-22T00:00:00.000Z', day: 20260822 }),
      );
      expect(decideSkip({ repo: dir, recordPath: record(dir), today: '2026-08-22' })).toMatchObject(
        { skip: false, reason: 'stale-day' },
      );
    });

    it('指紋が違えば、日が一致していても changed のまま（day は指紋一致の後にしか見ない）', async () => {
      const dir = await makeRepo();
      save(dir, fingerprint(dir) as string, '2026-08-22');
      await writeFile(join(dir, 'a.txt'), 'two\n');
      expect(decideSkip({ repo: dir, recordPath: record(dir), today: '2026-08-22' })).toMatchObject(
        { skip: false, reason: 'changed' },
      );
    });

    it('today の既定引数は呼ぶたびに UTC の今日を作る（I/O 層でだけ new Date() を呼ぶ約束の確認）', async () => {
      const dir = await makeRepo();
      const fp = fingerprint(dir) as string;
      const today = new Date().toISOString().slice(0, 10);
      save(dir, fp, today);
      expect(decideSkip({ repo: dir, recordPath: record(dir) })).toMatchObject({
        skip: true,
        reason: 'unchanged',
      });
    });
  });

  it('記録が無い・壊れている・--force のときは、必ず走る側へ倒す', async () => {
    const dir = await makeRepo();

    expect(decideSkip({ repo: dir, recordPath: record(dir) })).toMatchObject({
      skip: false,
      reason: 'no-record',
    });

    writeFileSync(record(dir), '{ this is not json');
    expect(decideSkip({ repo: dir, recordPath: record(dir) })).toMatchObject({
      skip: false,
      reason: 'broken-record',
    });

    save(dir, fingerprint(dir) as string);
    expect(decideSkip({ repo: dir, recordPath: record(dir), force: true })).toMatchObject({
      skip: false,
      reason: 'force',
    });
  });

  it('記録の置き場が取れない器でも、走る側へ倒す', async () => {
    const dir = await makeRepo();
    expect(decideSkip({ repo: dir, recordPath: null })).toMatchObject({
      skip: false,
      reason: 'no-record-path',
    });
  });

  it('git リポジトリでなければ指紋を取れず、走る側へ倒す', async () => {
    const dir = await makeTempDir('verify-core-bare-');
    expect(fingerprint(dir)).toBeNull();
    expect(decideSkip({ repo: dir, recordPath: join(dir, 'nope.json') })).toMatchObject({
      skip: false,
      reason: 'no-fingerprint',
    });
  });

  describe('git が差分として見せるものは、必ず指紋を動かす', () => {
    it('HEAD が動いたら、作業ツリーが同じでも緑を名乗らない', async () => {
      const dir = await makeRepo();
      save(dir, fingerprint(dir) as string);

      execFileSync('git', ['commit', '-q', '--amend', '-m', 'amended'], {
        cwd: dir,
        env: gitChildEnv(),
      });
      expect(decideSkip({ repo: dir, recordPath: record(dir) })).toMatchObject({
        skip: false,
        reason: 'changed',
      });
    });

    it('実行ビットを立てただけでも、緑を名乗らない', async () => {
      const dir = await makeRepo();
      save(dir, fingerprint(dir) as string);

      await chmod(join(dir, 'a.txt'), 0o755);
      expect(() =>
        execFileSync('git', ['diff', '--quiet', 'HEAD'], { cwd: dir, env: gitChildEnv() }),
      ).toThrow();
      expect(decideSkip({ repo: dir, recordPath: record(dir) })).toMatchObject({ skip: false });
    });

    it('symlink の行き先を差し替えただけでも、緑を名乗らない', async () => {
      const dir = await makeRepo();
      await writeFile(join(dir, 'b.txt'), 'one\n');
      await symlink('a.txt', join(dir, 'link'));
      execFileSync('git', ['add', '-A'], { cwd: dir, env: gitChildEnv() });
      execFileSync('git', ['commit', '-qm', 'link'], { cwd: dir, env: gitChildEnv() });
      save(dir, fingerprint(dir) as string);

      await unlink(join(dir, 'link'));
      await symlink('b.txt', join(dir, 'link'));
      expect(statSync(join(dir, 'link')).isFile()).toBe(true);
      expect(decideSkip({ repo: dir, recordPath: record(dir) })).toMatchObject({ skip: false });
    });

    it('追跡ファイルを消したら、緑を名乗らない', async () => {
      const dir = await makeRepo();
      save(dir, fingerprint(dir) as string);
      await unlink(join(dir, 'a.txt'));
      expect(decideSkip({ repo: dir, recordPath: record(dir) })).toMatchObject({ skip: false });
    });

    it('中身の境界を長さで作る（違うツリーが同じ指紋にならない）', async () => {
      // 名前を `zz` / `zzz` にする: 畳まれるバイト列が「空の `zz` と空の `zzz`」と一致するには、並びの最後で隣り合う必要があるため。
      const dir = await makeRepo();
      const payload = Buffer.from([
        0x00, 0x7a, 0x7a, 0x7a, 0x00, 0x31, 0x30, 0x30, 0x36, 0x34, 0x34, 0x00,
      ]);

      await writeFile(join(dir, 'zz'), payload);
      const one = fingerprint(dir) as string;

      await writeFile(join(dir, 'zz'), '');
      await writeFile(join(dir, 'zzz'), '');
      const two = fingerprint(dir) as string;

      expect(one).not.toBe(two);
    });
  });

  describe('記録の置き場', () => {
    it('git worktree の作業ツリーでは .git がファイルなので、git に聞いて実体を取る', async () => {
      const dir = await makeRepo();
      const linked = join(dir, '..', `linked-${Date.now()}`);
      execFileSync('git', ['worktree', 'add', '-q', linked, '-b', 'wt'], {
        cwd: dir,
        env: gitChildEnv(),
      });
      // `linked` は `git worktree add` が作り helper の管理外なので、ここだけ自前で片付ける。
      try {
        expect(statSync(join(linked, '.git')).isFile()).toBe(true);

        const resolved = recordPathFor(linked) as string;
        expect(resolved).not.toBeNull();
        expect(statSync(dirname(resolved)).isDirectory()).toBe(true);

        expect(() => writeFileSync(resolved, '{}\n')).not.toThrow();
      } finally {
        await rm(linked, { recursive: true, force: true });
      }
    });

    it('git リポジトリでなければ置き場を返さない', async () => {
      const dir = await makeTempDir('verify-core-nogit-');
      expect(recordPathFor(dir)).toBeNull();
    });
  });
});

describe('pnpm verify — テストの結末は4つある', () => {
  const summary = ' Test Files  1 passed (1)\n      Tests  3 passed (3)\n';

  it('走って通った / 走って落ちた', () => {
    expect(classifyTest({ status: 0, signal: null, output: summary })).toMatchObject({
      state: 'passed',
    });
    expect(classifyTest({ status: 1, signal: null, output: summary })).toMatchObject({
      state: 'failed',
      code: 1,
    });
  });

  it('要約の行が無ければ「走っていない」（落ちたのではない）', () => {
    expect(classifyTest({ status: 1, signal: null, output: 'write EPIPE\n' })).toMatchObject({
      state: 'not-run',
    });
  });

  it('signal で殺されたら「判定できない」— 「走っていない」へ倒さない', () => {
    const killed = classifyTest({ status: null, signal: 'SIGTERM', output: summary });
    expect(killed.state).toBe('undecidable');
    expect(killed.state).not.toBe('not-run');
    expect(killed.ran).toBe(true);

    expect(classifyTest({ status: null, signal: 'SIGKILL', output: '' })).toMatchObject({
      state: 'undecidable',
      ran: false,
    });
  });

  it('status が無ければ「判定できない」（0 へ倒さない）', () => {
    expect(classifyTest({ status: null, signal: null, output: summary })).toMatchObject({
      state: 'undecidable',
    });
  });

  it('testRan は2つの行の両方を要求する', () => {
    expect(testRan(summary)).toBe(true);
    expect(testRan(' Test Files  1 passed (1)\n')).toBe(false);
    expect(testRan('      Tests  3 passed (3)\n')).toBe(false);
    expect(testRan('')).toBe(false);
  });

  it('改行に食われて集計行が行頭に無い形は、依然として「走っていない」と読む（#327）', () => {
    const eaten =
      '（日誌を 0 件遡り、この会話の先頭まで届いた）alteroid: 台帳を記録できませんでした' +
      ' Test Files  1 passed (1)\n' +
      '      Tests  3 passed (3)\n';
    expect(testRan(eaten)).toBe(false);
    expect(classifyTest({ status: 0, signal: null, output: eaten })).toMatchObject({
      state: 'not-run',
    });
  });

  it('本当に走っていない形（集計行そのものが無い）は false のまま', () => {
    const noSummary =
      '\n=== test: pnpm test\n' +
      'stub("./target.js") が呼ばれていません\n' +
      'AssertionError: expected 1 to be 0\n';
    expect(testRan(noSummary)).toBe(false);
    expect(classifyTest({ status: 1, signal: null, output: noSummary })).toMatchObject({
      state: 'not-run',
    });
  });

  it('「Test Files」という語が文中に出てくるだけでは true にならない（偽陽性に耐える）', () => {
    const mentionOnly =
      'このテストは Test Files と Tests の行を読む testRan() の歯を確かめる。\n' +
      '実際の集計行はまだ出ていない。\n';
    expect(testRan(mentionOnly)).toBe(false);
  });

  it('ANSI エスケープで色付けされた集計行も読める（#392、本物のバイトで固定）', () => {
    const ESC = '\x1b';
    const colored =
      `${ESC}[2m Test Files ${ESC}[22m ${ESC}[1m${ESC}[32m130 passed${ESC}[39m${ESC}[22m${ESC}[90m (130)${ESC}[39m\n` +
      `${ESC}[2m      Tests ${ESC}[22m ${ESC}[1m${ESC}[32m2493 passed${ESC}[39m${ESC}[22m${ESC}[90m (2493)${ESC}[39m\n`;
    expect(testRan(colored)).toBe(true);
    expect(classifyTest({ status: 0, signal: null, output: colored })).toMatchObject({
      state: 'passed',
    });
  });

  it('色が付いていても、集計行そのものが無ければ false のまま（「剥がせば何でも読める」に緩めない）', () => {
    const ESC = '\x1b';
    const coloredButNoSummary = `${ESC}[31mError: write EPIPE${ESC}[39m\n${ESC}[2m   Duration ${ESC}[22m 201ms\n`;
    expect(testRan(coloredButNoSummary)).toBe(false);
    expect(classifyTest({ status: 0, signal: null, output: coloredButNoSummary })).toMatchObject({
      state: 'not-run',
    });
  });

  it('紛らわしい行（Files changed: / Tests: none）を集計行と読まない', () => {
    const decoy = 'Files changed: 3\nTests: none\nError: write EPIPE\n';
    expect(testRan(decoy)).toBe(false);
  });
});

// `--maxWorkers=4` が test 側に残ることも一緒に測る: 片方だけ測ると「全部 build へ移す」実装が緑になるため。
describe('pnpm verify — 引数の宛先（#362）', () => {
  const buildStep = (STEPS as { name: string }[]).find((s) => s.name === 'build');
  const testStep = (STEPS as { name: string }[]).find((s) => s.name === 'test');

  it('手順の実物に build と test が在る（この describe の測定対象そのもの）', () => {
    expect(buildStep, 'STEPS に build の手順が無い').toBeDefined();
    expect(testStep, 'STEPS に test の手順が無い').toBeDefined();
  });

  it('= の形（--workspace-concurrency=<n>）を読む', () => {
    expect(
      splitVerifyArgs(['--workspace-concurrency=2']).workspaceConcurrency,
      '= の形の --workspace-concurrency が読めていない（静かに undefined へ落ちる形）',
    ).toBe(2);
  });

  it('空白区切りの形（--workspace-concurrency <n>）を読む', () => {
    expect(
      splitVerifyArgs(['--workspace-concurrency', '2']).workspaceConcurrency,
      '空白区切りの --workspace-concurrency が読めていない',
    ).toBe(2);
  });

  it('渡さなければ undefined を返す（既定を持たない）', () => {
    expect(
      splitVerifyArgs([]).workspaceConcurrency,
      '引数が空なのに既定の数を持っている',
    ).toBeUndefined();
    expect(
      splitVerifyArgs(['--', '--maxWorkers=4', '--force']).workspaceConcurrency,
      '他の引数だけを渡したのに workspace-concurrency が付いた',
    ).toBeUndefined();
  });

  it('0以下の値は拒否する', () => {
    expect(
      () => splitVerifyArgs(['--workspace-concurrency=0']),
      '0 を黙って受けている（拒否せず既定へ倒していないか）',
    ).toThrow(/1以上の整数/);
    expect(
      () => splitVerifyArgs(['--workspace-concurrency', '-1']),
      '負の数を黙って受けている',
    ).toThrow(/1以上の整数/);
  });

  it('整数でない値は拒否する', () => {
    expect(
      () => splitVerifyArgs(['--workspace-concurrency=1.5']),
      '小数を黙って受けている',
    ).toThrow(/1以上の整数/);
    expect(
      () => splitVerifyArgs(['--workspace-concurrency=abc']),
      '数でない値を黙って受けている',
    ).toThrow(/1以上の整数/);
    expect(
      () => splitVerifyArgs(['--workspace-concurrency']),
      '値の無い --workspace-concurrency を黙って受けている',
    ).toThrow(/1以上の整数/);
  });

  it('--workspace-concurrency を渡しても --maxWorkers=4 は test 側に残る（両方渡せる）', () => {
    expect(
      splitVerifyArgs(['--', '--maxWorkers=4', '--workspace-concurrency=2']).passthrough,
      'test へ渡る引数から --maxWorkers=4 が消えている',
    ).toEqual(['--maxWorkers=4']);
  });

  it('--workspace-concurrency は test 側の passthrough に入らない（= の形）', () => {
    expect(
      splitVerifyArgs(['--workspace-concurrency=2']).passthrough,
      '--workspace-concurrency が pnpm test の引数に残っている（#362 の欠陥そのもの）',
    ).toEqual([]);
  });

  it('--workspace-concurrency は値の側も test へ漏らさない（空白区切りの形）', () => {
    expect(
      splitVerifyArgs(['--workspace-concurrency', '2']).passthrough,
      '空白区切りの値（裸の数字）が pnpm test の引数に残っている',
    ).toEqual([]);
  });

  it('build の手順の env に PNPM_CONFIG_WORKSPACE_CONCURRENCY が入る', () => {
    const env = envForStep(buildStep, { workspaceConcurrency: 2, baseEnv: { PATH: '/usr/bin' } });
    expect(
      env.PNPM_CONFIG_WORKSPACE_CONCURRENCY,
      'build の手順へ渡る env に並列度が入っていない',
    ).toBe('2');
    expect(env.PATH, '元の env が落ちている').toBe('/usr/bin');
  });

  it('渡さなければ build の手順の env に足さない（既定を持たない）', () => {
    const baseEnv = { PATH: '/usr/bin' };
    const env = envForStep(buildStep, { workspaceConcurrency: undefined, baseEnv });
    expect(
      'PNPM_CONFIG_WORKSPACE_CONCURRENCY' in env,
      '渡していないのに env へ並列度が足された',
    ).toBe(false);
    expect(env, '渡していないのに env が作り替えられた').toBe(baseEnv);
  });

  it('test の手順の env には足さない（build 以外の宛先へ漏らさない）', () => {
    const env = envForStep(testStep, { workspaceConcurrency: 2, baseEnv: { PATH: '/usr/bin' } });
    expect(
      'PNPM_CONFIG_WORKSPACE_CONCURRENCY' in env,
      'test の手順の env に並列度が漏れている',
    ).toBe(false);
  });
});

describe('recordFor（Issue #1191）: 記録の組み立て', () => {
  it('day は at の日付部分と一致する', () => {
    const now = new Date('2026-09-16T23:59:59.999Z');
    const rec = recordFor('abc123', now);
    expect(rec).toEqual({
      fingerprint: 'abc123',
      at: '2026-09-16T23:59:59.999Z',
      day: rec.at.slice(0, 10),
    });
    expect(rec.day).toBe('2026-09-16');
  });

  it('境界: UTC で日をまたぐ瞬間でも day は at から一貫して切り出される', () => {
    const now = new Date('2026-09-17T00:00:00.000Z');
    const rec = recordFor('xyz', now);
    expect(rec.day).toBe(rec.at.slice(0, 10));
    expect(rec.day).toBe('2026-09-17');
  });

  it('既定引数は new Date() を呼ぶ（呼び出し時点の day を返す）', () => {
    const before = new Date().toISOString().slice(0, 10);
    const rec = recordFor('fp');
    expect(rec.day).toBe(before);
  });

  it('tree を渡さなければ記録に tree が含まれない（既存の呼び出しを壊さない）', () => {
    const now = new Date('2026-09-27T00:00:00.000Z');
    const rec = recordFor('abc123', now);
    expect(rec).toEqual({
      fingerprint: 'abc123',
      at: '2026-09-27T00:00:00.000Z',
      day: '2026-09-27',
    });
    expect('tree' in rec).toBe(false);
  });

  it('tree を渡すと記録に tree として足される', () => {
    const now = new Date('2026-09-27T00:00:00.000Z');
    const rec = recordFor('abc123', now, 'deadbeef');
    expect(rec).toEqual({
      fingerprint: 'abc123',
      at: '2026-09-27T00:00:00.000Z',
      day: '2026-09-27',
      tree: 'deadbeef',
    });
  });
});

describe('writeTreeFor（Issue #1763・#1192 の N7）', () => {
  async function makeRepo(): Promise<string> {
    const dir = await makeTempDir('write-tree-for-');
    const git = (...args: string[]) =>
      execFileSync('git', args, { cwd: dir, encoding: 'utf8', env: gitChildEnv() });
    git('init', '-q');
    git('config', 'user.email', 'test@example.invalid');
    git('config', 'user.name', 'test');
    await writeFile(join(dir, 'a.txt'), 'one\n');
    git('add', '-A');
    git('commit', '-qm', 'init');
    return dir;
  }

  it('追跡ファイルだけの状態では、commit した tree と一致する', async () => {
    const dir = await makeRepo();
    const headTree = execFileSync('git', ['rev-parse', 'HEAD^{tree}'], {
      cwd: dir,
      encoding: 'utf8',
      env: gitChildEnv(),
    }).trim();

    const tree = writeTreeFor(dir);
    expect(tree).toBe(headTree);
  });

  it('未追跡のファイルを拾う（fingerprint が漏らさないのと同じ範囲）', async () => {
    const dir = await makeRepo();
    const before = writeTreeFor(dir);

    await writeFile(join(dir, 'untracked.txt'), 'new\n');
    const after = writeTreeFor(dir);

    expect(after).not.toBe(before);
  });

  it('.gitignore されたファイルは拾わない（fingerprint の --exclude-standard と同じ範囲）', async () => {
    const dir = await makeRepo();
    await writeFile(join(dir, '.gitignore'), 'ignored/\n');
    execFileSync('git', ['add', '-A'], { cwd: dir, env: gitChildEnv() });
    execFileSync('git', ['commit', '-qm', 'add gitignore'], { cwd: dir, env: gitChildEnv() });

    const before = writeTreeFor(dir);
    await mkdir(join(dir, 'ignored'), { recursive: true });
    await writeFile(join(dir, 'ignored', 'x'), 'noise\n');
    const after = writeTreeFor(dir);

    expect(after).toBe(before);
  });

  it('追跡済みで .gitignore にも当たるファイルは拾う（fingerprint の ls-files -c と同じ範囲。Issue #1785）', async () => {
    const dir = await makeRepo();
    await writeFile(join(dir, 'tracked-but-ignored.txt'), 'original content\n');
    execFileSync('git', ['add', '-A'], { cwd: dir, env: gitChildEnv() });
    execFileSync('git', ['commit', '-qm', 'track before ignoring'], {
      cwd: dir,
      env: gitChildEnv(),
    });
    await writeFile(join(dir, '.gitignore'), 'tracked-but-ignored.txt\n');
    execFileSync('git', ['add', '-A'], { cwd: dir, env: gitChildEnv() });
    execFileSync('git', ['commit', '-qm', 'ignore the already-tracked file'], {
      cwd: dir,
      env: gitChildEnv(),
    });

    const tree = writeTreeFor(dir) as string;
    expect(tree).not.toBeNull();
    const paths = execFileSync('git', ['ls-tree', '-r', '--name-only', tree], {
      cwd: dir,
      encoding: 'utf8',
      env: gitChildEnv(),
    })
      .split('\n')
      .filter(Boolean);
    expect(paths).toContain('tracked-but-ignored.txt');

    const headTree = execFileSync('git', ['rev-parse', 'HEAD^{tree}'], {
      cwd: dir,
      encoding: 'utf8',
      env: gitChildEnv(),
    }).trim();
    expect(tree).toBe(headTree);
  });

  it('本物の index を動かさない（git diff --cached が空のまま）', async () => {
    const dir = await makeRepo();
    await writeFile(join(dir, 'untracked.txt'), 'new\n');

    writeTreeFor(dir);

    const staged = execFileSync('git', ['diff', '--cached', '--name-only'], {
      cwd: dir,
      encoding: 'utf8',
      env: gitChildEnv(),
    });
    expect(staged.trim()).toBe('');
    const status = execFileSync('git', ['status', '--porcelain'], {
      cwd: dir,
      encoding: 'utf8',
      env: gitChildEnv(),
    });
    expect(status).toContain('?? untracked.txt');
  });

  it('本物の作業ツリーを動かさない（呼んだ前後でファイルの中身が変わらない）', async () => {
    const dir = await makeRepo();
    const before = await readFile(join(dir, 'a.txt'), 'utf8');

    writeTreeFor(dir);

    const after = await readFile(join(dir, 'a.txt'), 'utf8');
    expect(after).toBe(before);
  });

  it('呼ぶたびに一時 index ファイルを片付ける（残り続けない）', async () => {
    const dir = await makeRepo();
    writeTreeFor(dir);
    writeTreeFor(dir);

    const gitDirEntries = await readdir(join(dir, '.git'));
    const leftoverTempIndexes = gitDirEntries.filter((name) =>
      name.startsWith('alteroid-verify-index.'),
    );
    expect(leftoverTempIndexes).toEqual([]);
  });

  it('git repo でなければ null（判定できないを都合よく倒さない）', async () => {
    const dir = await makeTempDir('write-tree-for-not-a-repo-');
    expect(writeTreeFor(dir)).toBeNull();
  });

  it('追跡ファイルに skip-worktree を立てただけで、作業ツリーを変えていなくても writeTreeFor は null を返す', async () => {
    const dir = await makeRepo();
    execFileSync('git', ['update-index', '--skip-worktree', 'a.txt'], {
      cwd: dir,
      env: gitChildEnv(),
    });

    expect(writeTreeFor(dir)).toBeNull();
  });

  it('追跡ファイルに assume-unchanged を立てただけで、作業ツリーを変えていなくても writeTreeFor は null を返す', async () => {
    const dir = await makeRepo();
    execFileSync('git', ['update-index', '--assume-unchanged', 'a.txt'], {
      cwd: dir,
      env: gitChildEnv(),
    });

    expect(writeTreeFor(dir)).toBeNull();
  });

  it('🔴 帰結の再現: skip-worktree を立てて作業ツリーだけ書き換えても、fingerprint は変化を畳む（writeTreeFor 側が null で守っていなければ「静かな一致」が起きた場面）', async () => {
    const dir = await makeRepo();
    execFileSync('git', ['update-index', '--skip-worktree', 'a.txt'], {
      cwd: dir,
      env: gitChildEnv(),
    });

    const fpBefore = fingerprint(dir);
    await writeFile(join(dir, 'a.txt'), 'CHANGED after skip-worktree\n');
    const fpAfter = fingerprint(dir);

    expect(fpAfter).not.toBe(fpBefore);
  });

  it('印が無ければ null 化しない（過剰に判定できない側へ倒していないことの対照）', async () => {
    const dir = await makeRepo();
    await writeFile(join(dir, 'a.txt'), 'plain edit, no flags\n');
    expect(writeTreeFor(dir)).not.toBeNull();
  });
});

describe('hasSkipWorktreeOrAssumeUnchanged（Issue #1785 レビュー）', () => {
  it('行が無ければ false', () => {
    expect(hasSkipWorktreeOrAssumeUnchanged('')).toBe(false);
  });

  it('通常のタグ（大文字 H・キャッシュ済み）だけなら false', () => {
    expect(hasSkipWorktreeOrAssumeUnchanged('H a.txt\nH b.txt\n')).toBe(false);
  });

  it('skip-worktree（先頭が大文字 S）があれば true', () => {
    expect(hasSkipWorktreeOrAssumeUnchanged('H a.txt\nS b.txt\n')).toBe(true);
  });

  it('assume-unchanged（先頭が英小文字）があれば true', () => {
    expect(hasSkipWorktreeOrAssumeUnchanged('H a.txt\nh b.txt\n')).toBe(true);
  });

  it('末尾の空行を誤検出しない', () => {
    expect(hasSkipWorktreeOrAssumeUnchanged('H a.txt\n')).toBe(false);
  });
});

describe('classifyTestScope（Issue #1191）: 絞り込みかどうかの判定', () => {
  it('引数なし → full', () => {
    expect(classifyTestScope([])).toEqual({ full: true, narrowing: [] });
  });

  it('--maxWorkers=4（= の形）→ full', () => {
    expect(classifyTestScope(['--maxWorkers=4'])).toEqual({ full: true, narrowing: [] });
  });

  it('--maxWorkers 4（空白区切り、値を1要素飛ばす）→ full', () => {
    expect(classifyTestScope(['--maxWorkers', '4'])).toEqual({ full: true, narrowing: [] });
  });

  it('--reporter verbose（値ありの別フラグ）→ full', () => {
    expect(classifyTestScope(['--reporter', 'verbose'])).toEqual({ full: true, narrowing: [] });
  });

  it('テストファイルのパス → not full（narrowing に入る）', () => {
    expect(classifyTestScope(['scripts/x.test.ts'])).toEqual({
      full: false,
      narrowing: ['scripts/x.test.ts'],
    });
  });

  it('-t 名前（vitest の名前フィルタ）→ not full', () => {
    const result = classifyTestScope(['-t', '名前']);
    expect(result.full).toBe(false);
    expect(result.narrowing).toContain('-t');
  });

  it('--maxWorkers=4 とパス指定の組み合わせ → not full（許可された引数は narrowing に混ざらない）', () => {
    expect(classifyTestScope(['--maxWorkers=4', 'scripts/x.test.ts'])).toEqual({
      full: false,
      narrowing: ['scripts/x.test.ts'],
    });
  });

  it('--changed（絞り込みの一種）→ not full', () => {
    expect(classifyTestScope(['--changed'])).toEqual({ full: false, narrowing: ['--changed'] });
  });

  it('--bail=1 → not full', () => {
    expect(classifyTestScope(['--bail=1'])).toEqual({ full: false, narrowing: ['--bail=1'] });
  });

  it('陰性対照: 存在しないパスでも形だけで not full と判定する（実際に絞り込みが効くかは見ていない）', () => {
    expect(classifyTestScope(['does/not/exist.test.ts'])).toEqual({
      full: false,
      narrowing: ['does/not/exist.test.ts'],
    });
  });

  it('--reporter --changed（値必須フラグの直後の絞り込みフラグを飲まない）→ not full（#1273）', () => {
    expect(classifyTestScope(['--reporter', '--changed'])).toEqual({
      full: false,
      narrowing: ['--changed'],
    });
  });

  it('--maxWorkers --changed（同上、別の値必須フラグ）→ not full（#1273）', () => {
    expect(classifyTestScope(['--maxWorkers', '--changed'])).toEqual({
      full: false,
      narrowing: ['--changed'],
    });
  });

  it('--reporter --bail=1（飲み込まれる側が = 付きでも残す）→ not full（#1273）', () => {
    expect(classifyTestScope(['--reporter', '--bail=1'])).toEqual({
      full: false,
      narrowing: ['--bail=1'],
    });
  });

  it('--reporter -t foo は -t 自身が narrowing に残る（偶然ではなく理由が正しい）（#1273）', () => {
    expect(classifyTestScope(['--reporter', '-t', 'foo'])).toEqual({
      full: false,
      narrowing: ['-t', 'foo'],
    });
  });

  it('--maxWorkers 4 --reporter verbose（-で始まらない値は従来どおり飲む）→ full（#1273）', () => {
    expect(classifyTestScope(['--maxWorkers', '4', '--reporter', 'verbose'])).toEqual({
      full: true,
      narrowing: [],
    });
  });

  it('--reporter が末尾（飲む値が無い）→ full。例外を投げない（#1273）', () => {
    expect(classifyTestScope(['--reporter'])).toEqual({ full: true, narrowing: [] });
    expect(classifyTestScope(['--maxWorkers'])).toEqual({ full: true, narrowing: [] });
  });

  it('--reporter --changed は decideRecord が narrowed で記録を拒む（#1273）', () => {
    const scope = classifyTestScope(['--reporter', '--changed']);
    expect(decideRecord({ scope, moved: false, recordPath: '/tmp/record.json' })).toEqual({
      record: false,
      reason: 'narrowed',
      narrowing: ['--changed'],
    });
  });
});

describe('decideRecord（Issue #1191）: 全体の成功記録を書いてよいか', () => {
  const fullScope = { full: true, narrowing: [] as string[] };
  const narrowScope = { full: false, narrowing: ['scripts/x.test.ts'] };

  it('絞った（narrowed）→ record:false', () => {
    expect(
      decideRecord({ scope: narrowScope, moved: false, recordPath: '/tmp/x.json' }),
    ).toMatchObject({ record: false, reason: 'narrowed', narrowing: ['scripts/x.test.ts'] });
  });

  it('走行中にツリーが動いた（moved）→ record:false（絞っていなくても）', () => {
    expect(
      decideRecord({ scope: fullScope, moved: true, recordPath: '/tmp/x.json' }),
    ).toMatchObject({ record: false, reason: 'tree-moved' });
  });

  it('moved が narrowed より優先される（両方真なら tree-moved）', () => {
    expect(
      decideRecord({ scope: narrowScope, moved: true, recordPath: '/tmp/x.json' }),
    ).toMatchObject({ record: false, reason: 'tree-moved' });
  });

  it('記録の置き場が取れない（recordPath が null）→ record:false', () => {
    expect(decideRecord({ scope: fullScope, moved: false, recordPath: null })).toMatchObject({
      record: false,
      reason: 'no-record-path',
    });
  });

  it('full かつ動いていない → record:true（キャッシュが死んでいないことの対照）', () => {
    expect(
      decideRecord({ scope: fullScope, moved: false, recordPath: '/tmp/x.json' }),
    ).toMatchObject({ record: true, reason: 'ok' });
  });
});

// `pnpm` / `git` / `build` を本物では動かさず偽の `pnpm` に差し替える: 遅い上に、測りたいのは「絞り込み」と「日付」の配線であって各手順の中身ではないため。
describe('pnpm verify — 統合の歯（Issue #1191, C5）', () => {
  async function makeE2eRepo(): Promise<string> {
    const dir = await makeTempDir('verify-e2e-repo-');
    const git = (...args: string[]) =>
      execFileSync('git', args, { cwd: dir, encoding: 'utf8', env: gitChildEnv() });
    git('init', '-q');
    git('config', 'user.email', 'test@example.invalid');
    git('config', 'user.name', 'test');
    await mkdir(join(dir, 'scripts'), { recursive: true });
    copyFileSync(join(SCRIPTS_DIR, 'verify.mjs'), join(dir, 'scripts', 'verify.mjs'));
    copyFileSync(join(SCRIPTS_DIR, 'verify-core.mjs'), join(dir, 'scripts', 'verify-core.mjs'));
    await writeFile(join(dir, 'a.txt'), 'one\n');
    git('add', '-A');
    git('commit', '-qm', 'init');
    return dir;
  }

  // 偽の `pnpm` は repo の外に置く: 呼び出しの記録ファイルが repo の指紋に混ざると、毎回ツリーが「動いた」ことになるため。
  async function makeFakePnpm(): Promise<{ toolsDir: string; logPath: string; binDir: string }> {
    const toolsDir = await makeTempDir('verify-e2e-tools-');
    const binDir = join(toolsDir, 'bin');
    await mkdir(binDir, { recursive: true });
    const logPath = join(toolsDir, 'pnpm-calls.log');
    const script =
      '#!/usr/bin/env node\n' +
      "const fs = require('node:fs');\n" +
      'const logPath = process.env.FAKE_PNPM_LOG;\n' +
      "fs.appendFileSync(logPath, JSON.stringify(process.argv.slice(2)) + '\\n');\n" +
      "if (process.argv[2] === 'test') {\n" +
      "  process.stdout.write('\\n RUN  v0.0.0 (fake)\\n\\n' +\n" +
      "    ' Test Files  1 passed (1)\\n' +\n" +
      "    '      Tests  1 passed (1)\\n');\n" +
      '}\n' +
      'process.exit(0);\n';
    writeFileSync(join(binDir, 'pnpm'), script);
    await chmod(join(binDir, 'pnpm'), 0o755);
    return { toolsDir, logPath, binDir };
  }

  // 子の env は `PATH` と偽の `pnpm` が読む `FAKE_PNPM_LOG` だけにする: 親の env を丸ごと渡さず、`verify.mjs` / `verify-core.mjs` が実際に読む鍵に絞るため。
  function buildRunVerifyEnv(binDir: string, logPath: string): NodeJS.ProcessEnv {
    return { PATH: binDir + ':' + (process.env.PATH ?? ''), FAKE_PNPM_LOG: logPath };
  }

  function runVerify(repoDir: string, binDir: string, logPath: string, args: string[]) {
    return spawnSync('node', [join(repoDir, 'scripts', 'verify.mjs'), ...args], {
      cwd: repoDir,
      env: buildRunVerifyEnv(binDir, logPath),
      // 'inherit' にしない: vitest.setup.ts の歯が本物の stdout への直書きを赤にするため、必ず 'pipe' で受ける。
      stdio: 'pipe',
      encoding: 'utf8',
    });
  }

  it('親の process.env にある偽の値は、子へ渡す env に含まれない（#1854）', () => {
    const key = 'ALTEROID_TEST_FAKE_1854';
    const before = process.env[key];
    process.env[key] = 'not-a-real-value';
    try {
      const env = buildRunVerifyEnv('/fake/bin/dir', '/fake/log/path');
      expect(env).not.toHaveProperty(key);
    } finally {
      if (before === undefined) delete process.env[key];
      else process.env[key] = before;
    }
  });

  const recordPath = (repoDir: string) => join(repoDir, '.git', 'alteroid-verify.json');
  const logLines = (logPath: string) => readFileSync(logPath, 'utf8').split('\n').filter(Boolean);

  it('A（絞った）: 記録を作らない。次も必ず走る', async () => {
    const repoDir = await makeE2eRepo();
    const { binDir, logPath } = await makeFakePnpm();
    writeFileSync(logPath, '');

    const result = runVerify(repoDir, binDir, logPath, ['some.test.ts']);
    expect(result.status, result.stdout + result.stderr).toBe(0);
    expect(result.stdout).toContain('実行範囲を絞ったので');

    const calls = logLines(logPath);
    expect(calls.some((line) => JSON.parse(line).includes('some.test.ts'))).toBe(true);
    expect(calls.some((line) => JSON.parse(line)[0] === 'test')).toBe(true);

    expect(() => readFileSync(recordPath(repoDir))).toThrow();
  });

  it('B（絞らない）: 記録を作る。day を持つ（対照）', async () => {
    const repoDir = await makeE2eRepo();
    const { binDir, logPath } = await makeFakePnpm();
    writeFileSync(logPath, '');

    const result = runVerify(repoDir, binDir, logPath, []);
    expect(result.status, result.stdout + result.stderr).toBe(0);
    expect(result.stdout).toContain('verify: recorded');

    const saved = JSON.parse(readFileSync(recordPath(repoDir), 'utf8'));
    expect(saved.fingerprint).toEqual(expect.any(String));
    expect(saved.day).toBe(new Date().toISOString().slice(0, 10));
  });

  it('C（B の直後にもう1回）: skipped が出る（対照）', async () => {
    const repoDir = await makeE2eRepo();
    const { binDir, logPath } = await makeFakePnpm();
    writeFileSync(logPath, '');

    const first = runVerify(repoDir, binDir, logPath, []);
    expect(first.status, first.stdout + first.stderr).toBe(0);

    const second = runVerify(repoDir, binDir, logPath, []);
    expect(second.status, second.stdout + second.stderr).toBe(0);
    expect(second.stdout).toContain('skipped');
  });

  it('D（B の記録の day を昨日へ書き換えてもう1回）: skipped が出ず、実際に走る', async () => {
    const repoDir = await makeE2eRepo();
    const { binDir, logPath } = await makeFakePnpm();
    writeFileSync(logPath, '');

    const first = runVerify(repoDir, binDir, logPath, []);
    expect(first.status, first.stdout + first.stderr).toBe(0);
    const callsAfterFirst = logLines(logPath).length;
    expect(callsAfterFirst).toBeGreaterThan(0);

    // 「昨日」を計算せず固定の過去日を使う: UTC の日跨ぎの実装ミスに弱いため。
    const saved = JSON.parse(readFileSync(recordPath(repoDir), 'utf8'));
    writeFileSync(recordPath(repoDir), JSON.stringify({ ...saved, day: '2000-01-01' }, null, 2));

    const second = runVerify(repoDir, binDir, logPath, []);
    expect(second.status, second.stdout + second.stderr).toBe(0);
    expect(second.stdout).not.toContain('skipped');
    expect(second.stdout).toContain('記録された日=2000-01-01');

    const callsAfterSecond = logLines(logPath).length;
    expect(
      callsAfterSecond,
      '記録の day が古いのに、実際には走っていない（pnpm-calls.log が伸びていない）',
    ).toBeGreaterThan(callsAfterFirst);
  });

  it('E（A の直後に通常実行）: 絞った成功は再利用されない — 2回目が省略されずに走る', async () => {
    const repoDir = await makeE2eRepo();
    const { binDir, logPath } = await makeFakePnpm();
    writeFileSync(logPath, '');

    const first = runVerify(repoDir, binDir, logPath, ['some.test.ts']);
    expect(first.status, first.stdout + first.stderr).toBe(0);
    const callsAfterFirst = logLines(logPath).length;

    const second = runVerify(repoDir, binDir, logPath, []);
    expect(second.status, second.stdout + second.stderr).toBe(0);
    expect(
      second.stdout,
      '絞った実行の成功が再利用され、通常実行が省略された（"skipped" が出ている）',
    ).not.toContain('skipped');

    const callsAfterSecond = logLines(logPath).length;
    expect(
      callsAfterSecond,
      '2回目の通常実行で、偽 pnpm の呼び出しログが伸びていない（実際には走っていない）',
    ).toBeGreaterThan(callsAfterFirst);

    const secondCalls = logLines(logPath)
      .slice(callsAfterFirst)
      .map((line) => JSON.parse(line) as string[]);
    const secondTestCall = secondCalls.find((args) => args[0] === 'test');
    expect(
      secondTestCall,
      '2回目の呼び出しに test の手順が無い（本当に走ったか判定できない）',
    ).toBeDefined();
    expect(
      secondTestCall ?? [],
      '1回目の絞り込み（some.test.ts）が2回目の test 呼び出しへ引き継がれている',
    ).not.toContain('some.test.ts');
  });

  it('openapi の手順（git diff）は、一時 repo に対象パスが無くても 0 で通る', async () => {
    const repoDir = await makeE2eRepo();
    const { binDir, logPath } = await makeFakePnpm();
    writeFileSync(logPath, '');
    const result = runVerify(repoDir, binDir, logPath, []);
    expect(result.status, result.stdout + result.stderr).toBe(0);
    expect(result.stdout).not.toContain('!! openapi');
  });
});
