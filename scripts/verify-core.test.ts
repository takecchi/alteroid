import { execFileSync } from 'node:child_process';
import { mkdtemp, rm, writeFile, mkdir, chmod, symlink, unlink } from 'node:fs/promises';
import { writeFileSync, statSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';

import { afterEach, describe, expect, it } from 'vitest';

// @ts-expect-error -- 素の .mjs（型宣言を持たない build 用スクリプト）を読む
import { classifyTest, decideSkip, fingerprint, recordPathFor, testRan } from './verify-core.mjs';

/**
 * `pnpm verify` の「無料で返す」判定の歯。
 *
 * **2本を別々に置くのは意図である。**
 *
 * - **歯①（動いたら緑を名乗らない）だけ**だと、「常に走る」実装が緑になる。
 *   それは安全だが**通し直しが無料でなくなる** ＝ 直そうとしている当の問題
 *   （打ち直しを思い出せない）が残る
 * - **歯②（動いていなければ緑を名乗る）だけ**だと、「常に無料で返す」実装が緑になる。
 *   それは**検証を一度も走らせない**
 *
 * **片方だけでは受け取れない、というのが依頼者の条件だった。**
 */
describe('pnpm verify — 通し直しを無料にする判定', () => {
  const made: string[] = [];

  afterEach(async () => {
    for (const dir of made.splice(0)) await rm(dir, { recursive: true, force: true });
  });

  /** commit が1つある使い捨ての git リポジトリ。 */
  async function makeRepo(): Promise<string> {
    const dir = await mkdtemp(join(tmpdir(), 'verify-core-'));
    made.push(dir);
    const git = (...args: string[]) => execFileSync('git', args, { cwd: dir, encoding: 'utf8' });
    git('init', '-q');
    git('config', 'user.email', 'test@example.invalid');
    git('config', 'user.name', 'test');
    await writeFile(join(dir, 'a.txt'), 'one\n');
    git('add', '-A');
    git('commit', '-qm', 'init');
    return dir;
  }

  const record = (dir: string) => join(dir, '.git', 'alteroid-verify.json');
  const save = (dir: string, fp: string) =>
    writeFileSync(record(dir), JSON.stringify({ fingerprint: fp, at: '2026-08-22T00:00:00.000Z' }));

  it('歯②: ツリーが動いていなければ、無料で返す（緑を名乗る）', async () => {
    const dir = await makeRepo();
    const fp = fingerprint(dir) as string;
    expect(fp).not.toBeNull();
    save(dir, fp);

    const decided = decideSkip({ repo: dir, recordPath: record(dir) });
    expect(decided.skip).toBe(true);
    expect(decided.reason).toBe('unchanged');
    // 領収書に載せる時刻が読めていること（**畳んだと記録に残す**ため）。
    expect(decided.at).toBe('2026-08-22T00:00:00.000Z');
  });

  it('歯①: ツリーが動いたら、緑を名乗らない', async () => {
    const dir = await makeRepo();
    save(dir, fingerprint(dir) as string);

    // **追跡ファイルを1文字動かす。**
    await writeFile(join(dir, 'a.txt'), 'two\n');
    expect(decideSkip({ repo: dir, recordPath: record(dir) })).toMatchObject({
      skip: false,
      reason: 'changed',
    });
  });

  it('未追跡のファイルが増えただけでも、緑を名乗らない', async () => {
    const dir = await makeRepo();
    save(dir, fingerprint(dir) as string);

    // **追跡だけを見ていると、新しく足したファイルが指紋から漏れる。**
    // それは「一式を通した後に新しいファイルを足した」を素通りさせる。
    await writeFile(join(dir, 'b.txt'), 'new\n');
    expect(decideSkip({ repo: dir, recordPath: record(dir) })).toMatchObject({ skip: false });
  });

  it('ignore されているものは指紋に入らない（node_modules で毎回走らない）', async () => {
    const dir = await makeRepo();
    await writeFile(join(dir, '.gitignore'), 'ignored/\n');
    execFileSync('git', ['add', '-A'], { cwd: dir });
    execFileSync('git', ['commit', '-qm', 'ignore'], { cwd: dir });
    save(dir, fingerprint(dir) as string);

    await mkdir(join(dir, 'ignored'), { recursive: true });
    await writeFile(join(dir, 'ignored', 'x'), 'noise\n');
    expect(decideSkip({ repo: dir, recordPath: record(dir) })).toMatchObject({ skip: true });
  });

  it('記録が無い・壊れている・--force のときは、必ず走る側へ倒す', async () => {
    const dir = await makeRepo();

    // 記録が無い
    expect(decideSkip({ repo: dir, recordPath: record(dir) })).toMatchObject({
      skip: false,
      reason: 'no-record',
    });

    // 記録が壊れている（**読めない記録を信じない**）
    writeFileSync(record(dir), '{ this is not json');
    expect(decideSkip({ repo: dir, recordPath: record(dir) })).toMatchObject({
      skip: false,
      reason: 'broken-record',
    });

    // --force（一致していても走る）
    save(dir, fingerprint(dir) as string);
    expect(decideSkip({ repo: dir, recordPath: record(dir), force: true })).toMatchObject({
      skip: false,
      reason: 'force',
    });
  });

  it('記録の置き場が取れない器でも、走る側へ倒す', async () => {
    const dir = await makeRepo();
    // `recordPathFor` が null を返した場合（**「判定できない」を「変わっていない」へ
    // 倒さない**）。
    expect(decideSkip({ repo: dir, recordPath: null })).toMatchObject({
      skip: false,
      reason: 'no-record-path',
    });
  });

  it('git リポジトリでなければ指紋を取れず、走る側へ倒す', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'verify-core-bare-'));
    made.push(dir);
    expect(fingerprint(dir)).toBeNull();
    expect(decideSkip({ repo: dir, recordPath: join(dir, 'nope.json') })).toMatchObject({
      skip: false,
      reason: 'no-fingerprint',
    });
  });

  /**
   * **ここから下は、いちど嘘をついた形の歯である。**
   *
   * どれも「git は差分として見せるのに、指紋は動かない」＝ **検証が落ちるはずのツリーを
   * 「変わっていない」と言って畳む**形だった。歯が無かったので実装が通ってしまった。
   */
  describe('git が差分として見せるものは、必ず指紋を動かす', () => {
    it('HEAD が動いたら、作業ツリーが同じでも緑を名乗らない', async () => {
      const dir = await makeRepo();
      save(dir, fingerprint(dir) as string);

      // 作業ツリーは1バイトも動かさず、commit だけ積み直す。
      // **`HEAD` を指紋から外しても他の歯は全部緑になる**ので、ここで押さえる
      // （`openapi` の検査は `HEAD` との差分を見るので、`HEAD` が動けば結果が変わりうる）。
      execFileSync('git', ['commit', '-q', '--amend', '-m', 'amended'], { cwd: dir });
      expect(decideSkip({ repo: dir, recordPath: record(dir) })).toMatchObject({
        skip: false,
        reason: 'changed',
      });
    });

    it('実行ビットを立てただけでも、緑を名乗らない', async () => {
      const dir = await makeRepo();
      save(dir, fingerprint(dir) as string);

      // 中身は1バイトも変えない。**モードだけ**変える。
      await chmod(join(dir, 'a.txt'), 0o755);
      // git は差分として見せる（前提の確認）。
      expect(() => execFileSync('git', ['diff', '--quiet', 'HEAD'], { cwd: dir })).toThrow();
      expect(decideSkip({ repo: dir, recordPath: record(dir) })).toMatchObject({ skip: false });
    });

    it('symlink の行き先を差し替えただけでも、緑を名乗らない', async () => {
      const dir = await makeRepo();
      await writeFile(join(dir, 'b.txt'), 'one\n'); // a.txt と**同じ中身**
      await symlink('a.txt', join(dir, 'link'));
      execFileSync('git', ['add', '-A'], { cwd: dir });
      execFileSync('git', ['commit', '-qm', 'link'], { cwd: dir });
      save(dir, fingerprint(dir) as string);

      // 行き先を差し替える。**中身は同じ**なので、symlink を追いかける実装だと気づけない。
      await unlink(join(dir, 'link'));
      await symlink('b.txt', join(dir, 'link'));
      expect(statSync(join(dir, 'link')).isFile()).toBe(true); // 追えば中身は同じ
      expect(decideSkip({ repo: dir, recordPath: record(dir) })).toMatchObject({ skip: false });
    });

    it('追跡ファイルを消したら、緑を名乗らない', async () => {
      const dir = await makeRepo();
      save(dir, fingerprint(dir) as string);
      await unlink(join(dir, 'a.txt'));
      expect(decideSkip({ repo: dir, recordPath: record(dir) })).toMatchObject({ skip: false });
    });

    it('中身の境界を長さで作る（違うツリーが同じ指紋にならない）', async () => {
      // **前の版はここで衝突していた。** 区切り（NUL）だけで境界を作ると、ファイルの
      // 中身が区切りごと偽装できる ＝ **1つのファイルが「2つのファイル」に化ける。**
      //
      // 下の細工は、畳まれるバイト列を
      //     zz\0 100644\0 <中身>\0
      // から
      //     zz\0 100644\0 \0 zzz\0 100644\0 \0
      // へ一致させる（＝「空の `zz` と空の `zzz`」と同じ形にする）。名前を `zz` / `zzz`
      // にしてあるのは、並びの最後に来て隣り合う必要があるからである。
      //
      // **この歯は、いちど生存した。** 当初は「NUL 1個を含む1ファイル」で書いていたが、
      // 指紋にモードが入った副作用で、そのバイト列だけは偶然分かれていた。**変異試験で
      // 生き残ったので、狙い直してある**（歯が緑だった理由が、意図した理由ではなかった）。
      const dir = await makeRepo();
      const payload = Buffer.from([
        0x00, 0x7a, 0x7a, 0x7a, 0x00, 0x31, 0x30, 0x30, 0x36, 0x34, 0x34, 0x00,
      ]); // \0 z z z \0 1 0 0 6 4 4 \0

      await writeFile(join(dir, 'zz'), payload);
      const one = fingerprint(dir) as string;

      await writeFile(join(dir, 'zz'), '');
      await writeFile(join(dir, 'zzz'), '');
      const two = fingerprint(dir) as string;

      expect(one).not.toBe(two);
    });
  });

  /**
   * 記録の置き場を git 自身に聞く歯。
   *
   * **`<repo>/.git` を組み立てる形は、`git worktree` の作業ツリーで `ENOTDIR` になる。**
   * 一式が全部通った**後**に落ちるので、通ったのに「落ちた」と見え、しかも記録が
   * 永久に残らない ＝ 通し直しが一度も無料にならない。
   */
  describe('記録の置き場', () => {
    it('git worktree の作業ツリーでは .git がファイルなので、git に聞いて実体を取る', async () => {
      const dir = await makeRepo();
      const linked = join(dir, '..', `linked-${Date.now()}`);
      execFileSync('git', ['worktree', 'add', '-q', linked, '-b', 'wt'], { cwd: dir });
      made.push(linked);

      // 前提: `.git` はディレクトリではなくファイルである。
      expect(statSync(join(linked, '.git')).isFile()).toBe(true);

      const resolved = recordPathFor(linked) as string;
      expect(resolved).not.toBeNull();
      // 実体の git ディレクトリ側を指していること（`<worktree>/.git/…` ではない）。
      expect(statSync(dirname(resolved)).isDirectory()).toBe(true);

      // **そこへ実際に書けること。** これが前の版で落ちていた1手である。
      expect(() => writeFileSync(resolved, '{}\n')).not.toThrow();
    });

    it('git リポジトリでなければ置き場を返さない', async () => {
      const dir = await mkdtemp(join(tmpdir(), 'verify-core-nogit-'));
      made.push(dir);
      expect(recordPathFor(dir)).toBeNull();
    });
  });
});

/**
 * テストの結末の読み方の歯。
 *
 * **これは `verify.mjs` の中に在って、歯を当てられなかった。** この PR の看板
 * （「走っていない」を3つ目の状態にする）が、まさにテストの無い側に置かれている形
 * だった。**テストが書けない構造は、テストが無いのと同じ**（`AGENTS.md`）。
 */
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
    // 器が混んで fork pool が EPIPE で死ぬ形。**exit 1 なのに走っていない。**
    expect(classifyTest({ status: 1, signal: null, output: 'write EPIPE\n' })).toMatchObject({
      state: 'not-run',
    });
  });

  it('signal で殺されたら「判定できない」— 「走っていない」へ倒さない', () => {
    // **ここを not-run に倒すと、「並列度を下げて取り直せ」という効かない助言が出る。**
    // 原因が混雑ではないので、読んだ人はそれを繰り返すことになる。
    const killed = classifyTest({ status: null, signal: 'SIGTERM', output: summary });
    expect(killed.state).toBe('undecidable');
    expect(killed.state).not.toBe('not-run');
    // 要約の行が出ていたかどうかは、判断の材料として残す（捨てない）。
    expect(killed.ran).toBe(true);

    // 要約が無いまま殺された場合も「判定できない」（**「走っていない」と断定しない**）。
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
});
