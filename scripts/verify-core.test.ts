import { execFileSync } from 'node:child_process';
import { mkdtemp, rm, writeFile, mkdir, chmod, symlink, unlink } from 'node:fs/promises';
import { writeFileSync, statSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';

import { afterEach, describe, expect, it } from 'vitest';

// @ts-expect-error -- 素の .mjs（型宣言を持たない build 用スクリプト）を読む
import {
  classifyTest,
  decideSkip,
  envForStep,
  fingerprint,
  recordPathFor,
  splitVerifyArgs,
  STEPS,
  testRan,
} from './verify-core.mjs';

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

  /**
   * #327: `verify.mjs` の `runTest` が子の stdout と stderr を1本の `output` へ
   * 多重化していたせいで、改行で終わらない書き込みの直後に集計行が来ると `^`
   * アンカーが当たらず「走っていない」に化けうる（`#326` が実在する書き手）。
   *
   * **直したのは `verify.mjs`（stdout と stderr を別々に溜め、`testRan` には
   * stdout だけを渡す）側であって、この `testRan` 自体のアンカーではない。**
   * ここではそのことを固定する — `testRan` はこの形の「食われた」文字列を
   * 依然として `false`（＝ 集計行が無い＝走っていない）と読む。これは仕様の
   * 後退ではなく、**この判定が緩んでいないことの回帰確認**である。
   * `verify.mjs` 側で stdout/stderr を分けてさえいれば、この文字列そのものが
   * `testRan` へ渡ることは無い（実測は `runTest` の doc に書いてある）。
   */
  it('改行に食われて集計行が行頭に無い形は、依然として「走っていない」と読む（#327）', () => {
    const eaten =
      // **改行が無いのは意図である。** stdout（改行で終わらない書き込み。#326）と
      // stderr（別プロセスからの1行）が同じ `output` へ多重化されたときの実測の形
      // （Issue #327 本文）を再現している — `Test Files` の直前に `\n` が無い。
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

  /**
   * #392: `testRan` が ANSI エスケープを剥がさずに照合していたせいで、色が付いた
   * 集計行では完走して緑でも「1本も走っていない」（`not-run`、exit 3）に化けていた。
   *
   * ## フィクスチャの出所（本物のバイトか、組み立てた文字列か）
   *
   * **本物のバイトである。** 下の2行は `scripts/test-guard-core.test.ts`（#311 / PR #355、
   * 逐語は `grep -n 'ANSI エスケープで色付けされた集計行も読める' scripts/test-guard-core.test.ts`）
   * および `scripts/mutate-core-strip-ansi.test.ts`（#372 / PR #374。`COLORED_FILES_LINE` /
   * `COLORED_TESTS_LINE`）が固定しているものと**1バイトも違わないことを、この PR の
   * 作業で実測して突き合わせてから**使っている（3ファイルの該当リテラルをソース
   * レベルで比較し、完全一致を確認した）。**独立な3箇所目が同じバイト列を基準に
   * 置く形である** —— 「3つが一致した」ことは正しさの証明にはならない（この
   * 一致だけを見る歯は、3つとも同じように壊れる形を捕まえられない。下の
   * `scripts/mutate-core-strip-ansi.test.ts` の doc を参照）ので、基準そのものは
   * 元の2ファイルの doc が持つ実測（vitest 4.1.10 自身のフォーマッタ呼び出し、
   * および GitHub Actions の raw log archive）に置いている。
   */
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

  /**
   * #392（探す語を緩めない）。`scripts/mutate-core-strip-ansi.test.ts` の
   * `DECOY_OUTPUT` と同じ形 —— `Files changed: 3` / `Tests: none` はどちらも
   * `Test Files` / `Tests\s+` の厳密な形には当たらない。ANSI を剥がす変更で
   * 探す語のほうまで緩めていないことを固定する（#374 が実際に踏んだ「歯が無い」
   * 穴と同じ穴を、ここで最初から塞ぐ）。
   */
  it('紛らわしい行（Files changed: / Tests: none）を集計行と読まない', () => {
    const decoy = 'Files changed: 3\nTests: none\nError: write EPIPE\n';
    expect(testRan(decoy)).toBe(false);
  });
});

/**
 * #362: `pnpm verify -- <引数>` の宛先の歯。
 *
 * **いちばん大事な保証はここ**: `--workspace-concurrency` は **build の手順の env** へ
 * 行き、**`pnpm test` の引数には1つも残らない。** 欠陥はまさにその形だった —
 * `passthrough` が `runTest` にしか届いていなかったので、build へ渡したつもりの
 * 並列度が `pnpm test --workspace-concurrency=2` として test のほうへ付いていた。
 *
 * **既定を持たないことも固定する。** 渡さなければ `undefined` で、env は1文字も
 * 増えない（`verify.mjs` の doc「数を持たず、渡せる口だけを開ける」）。
 *
 * **`--maxWorkers=4` が test 側に残ることも一緒に測る。** 片方だけ測ると、
 * 「全部 build へ移す」実装が緑になる。
 */
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
