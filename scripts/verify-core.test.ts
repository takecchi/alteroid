import { execFileSync, spawnSync } from 'node:child_process';
import { mkdtemp, rm, writeFile, mkdir, chmod, symlink, unlink } from 'node:fs/promises';
import { writeFileSync, readFileSync, statSync, copyFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

import { afterEach, describe, expect, it } from 'vitest';

import {
  classifyTest,
  classifyTestScope,
  decideRecord,
  decideSkip,
  envForStep,
  fingerprint,
  recordFor,
  recordPathFor,
  splitVerifyArgs,
  STEPS,
  testRan,
  // @ts-expect-error -- 素の .mjs（型宣言を持たない build 用スクリプト）を読む
} from './verify-core.mjs';

/** このテストファイル自身のディレクトリ（`scripts/`）。C5 の統合の歯が
 * `verify.mjs` / `verify-core.mjs` を一時 repo へコピーするために使う。 */
const SCRIPTS_DIR = dirname(fileURLToPath(import.meta.url));

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
  /** 記録の日付は固定（`'2026-08-22'`）にしてある。**実行日（壁時計）に依存させない
   * ため** — Issue #1191 で `decideSkip` に `today` を足した後、`saved.fingerprint`
   * が一致していても `saved.day` が呼び出し側の `today` と一致しなければ
   * `stale-day` になる。だからこの固定日を使う歯は、`decideSkip` を呼ぶ側でも
   * 同じ `today: '2026-08-22'` を明示して「指紋も日も一致している」状態を作る。 */
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
    expect(decideSkip({ repo: dir, recordPath: record(dir), today: '2026-08-22' })).toMatchObject({
      skip: true,
    });
  });

  /**
   * Issue #1191（②）: 指紋が一致していても、**記録した日（`day`）が今日と違えば
   * 走る**。C4 の本体。
   */
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
      save(dir, fp, '2026-08-21'); // 記録は8/21、今日は8/22 のつもり
      expect(decideSkip({ repo: dir, recordPath: record(dir), today: '2026-08-22' })).toMatchObject(
        // **判定に使った today も返す。** 呼ぶ側が表示のために現在時刻を引き直すと、
        // 真夜中を跨いだ瞬間に「判定が使った日」と「表示した日」が食い違いうる
        // （判定は正しいまま、出力だけが嘘になる形）。
        { skip: false, reason: 'stale-day', day: '2026-08-21', today: '2026-08-22' },
      );
    });

    it('記録が旧形式（day を持たない）→ skip:false, reason:stale-day（安全側）', async () => {
      const dir = await makeRepo();
      const fp = fingerprint(dir) as string;
      // 旧形式そのもの（`day` フィールドが無い）。
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
      // today を明示しない呼び出し。既定引数が実際の今日（UTC）を作っていること。
      expect(decideSkip({ repo: dir, recordPath: record(dir) })).toMatchObject({
        skip: true,
        reason: 'unchanged',
      });
    });
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
   * 逐語は `grep -Fn -- 'ANSI エスケープで色付けされた集計行も読める' scripts/test-guard-core.test.ts`）
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

/**
 * `recordFor`（Issue #1191）: 書き込む記録そのものの組み立て。
 *
 * **`at` と `day` が同じ `now` から作られることを1箇所で保証する**歯。2箇所で
 * 別々に `new Date()` を呼ぶ実装に戻すと、ミリ秒単位でずれた瞬間から `at` と
 * `day` が作られうる（`at` が前日の23:59:59.999、`day` が当日、のような形）。
 */
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
});

/**
 * `classifyTestScope`（Issue #1191）: `pnpm test` へ渡る引数（`passthrough`）が
 * 実行範囲を絞り込む形かどうかの判定。
 *
 * **C1 の本体。** `TEST_ARGS_THAT_DO_NOT_NARROW` に載っている形（値の有無を含む）
 * だけを「絞り込まない」側へ倒し、それ以外はすべて絞り込みとして扱う
 * （許可リストである理由は `verify-core.mjs` の `TEST_ARGS_THAT_DO_NOT_NARROW`
 * の doc: 知らない引数は安全側＝絞り込む側へ倒す）。
 */
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
    // `-t` は許可リストに無いので、値らしき次要素も飛ばさず両方 narrowing に入る
    // （どちらも「絞り込みかもしれないもの」として扱う——安全側）。
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

  /**
   * **陰性対照（測っていない軸）。** `classifyTestScope` は引数の**形**だけを見る
   * ——実在しないパスでも「絞り込みの形」として扱う。**実際に絞り込みが効いたか
   * （vitest が何本選んだか）はこの関数の責務ではなく、測っていない**
   * （`verify-core.mjs` の `classifyTestScope` の doc に明記）。
   */
  it('陰性対照: 存在しないパスでも形だけで not full と判定する（実際に絞り込みが効くかは見ていない）', () => {
    expect(classifyTestScope(['does/not/exist.test.ts'])).toEqual({
      full: false,
      narrowing: ['does/not/exist.test.ts'],
    });
  });
});

/**
 * `decideRecord`（Issue #1191）: 全体の成功記録を書いてよいかの判定。
 *
 * 優先順位（`moved` → `narrowed` → `no-record-path` → `ok`）を固定する。
 */
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

/**
 * **統合の歯（Issue #1191, C5）。** 本物の `scripts/verify.mjs` を子プロセスで
 * 走らせる——ここまでの単体の歯（`classifyTestScope` / `decideRecord` /
 * `decideSkip` の `today`）は、**それぞれ正しくても `verify.mjs` の配線が
 * 間違っていれば元の欠陥のまま**である。実際、元の欠陥は「判定関数が無い」
 * のではなく「`verify.mjs` が `passthrough` を記録に一切渡していない」
 * 配線の穴だった。単体の歯だけでは、この配線の穴を検出できない。
 *
 * `pnpm` / `git` / `build` を本物では動かさない——**遅い上に、この歯が
 * 測りたいのは「絞り込み」と「日付」の配線であって、各手順の中身ではない。**
 * `pnpm` は偽物（`fake-bin/pnpm`）に差し替え、`build` 等はすべて即 exit 0、
 * `test` のときだけ vitest の集計行を出す。
 */
describe('pnpm verify — 統合の歯（Issue #1191, C5）', () => {
  const made: string[] = [];

  afterEach(async () => {
    for (const dir of made.splice(0)) await rm(dir, { recursive: true, force: true });
  });

  /** 使い捨ての git リポジトリ（`verify.mjs` / `verify-core.mjs` のコピー込み）。 */
  async function makeE2eRepo(): Promise<string> {
    const dir = await mkdtemp(join(tmpdir(), 'verify-e2e-repo-'));
    made.push(dir);
    const git = (...args: string[]) => execFileSync('git', args, { cwd: dir, encoding: 'utf8' });
    git('init', '-q');
    git('config', 'user.email', 'test@example.invalid');
    git('config', 'user.name', 'test');
    await mkdir(join(dir, 'scripts'), { recursive: true });
    // **`verify.mjs` は自分の `import.meta.url` から REPO を決める**ので、
    // コピーすればこの一時ディレクトリが対象になる（`verify.mjs` 冒頭の
    // `const REPO = dirname(dirname(fileURLToPath(import.meta.url)));`）。
    copyFileSync(join(SCRIPTS_DIR, 'verify.mjs'), join(dir, 'scripts', 'verify.mjs'));
    copyFileSync(join(SCRIPTS_DIR, 'verify-core.mjs'), join(dir, 'scripts', 'verify-core.mjs'));
    await writeFile(join(dir, 'a.txt'), 'one\n');
    git('add', '-A');
    git('commit', '-qm', 'init');
    return dir;
  }

  /** 偽の `pnpm`（別ディレクトリ。**repo の外**——さもないと呼び出しの記録
   * ファイル自身が repo の指紋に混ざり、毎回ツリーが「動いた」ことになる）。 */
  async function makeFakePnpm(): Promise<{ toolsDir: string; logPath: string; binDir: string }> {
    const toolsDir = await mkdtemp(join(tmpdir(), 'verify-e2e-tools-'));
    made.push(toolsDir);
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

  function runVerify(repoDir: string, binDir: string, logPath: string, args: string[]) {
    return spawnSync('node', [join(repoDir, 'scripts', 'verify.mjs'), ...args], {
      cwd: repoDir,
      env: { ...process.env, PATH: binDir + ':' + process.env.PATH, FAKE_PNPM_LOG: logPath },
      // ⛔ 'inherit' にしないこと — vitest.setup.ts の歯（本物の stdout へ
      // 直書きしたテストを赤にする）を避けるため、必ず 'pipe' で受ける。
      stdio: 'pipe',
      encoding: 'utf8',
    });
  }

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

    // **記録が作られていないこと**が本体である。
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

    // **記録の day だけを過去へ書き換える。** ツリーは1バイトも動かしていない
    // （fingerprint は不変のまま）。実行日を確実に過去にするため、固定の
    // 日付（実行日が絶対に追い付かない過去）を使う——「昨日」の計算は UTC の
    // 日跨ぎの実装ミスに弱いので避ける。
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

  it('openapi の手順（git diff）は、一時 repo に対象パスが無くても 0 で通る', async () => {
    // 上の4本すべてがここを暗黙に通っているが、**明示で確かめる**
    // （依頼の「念のため生出力で確かめること」に対応）。
    const repoDir = await makeE2eRepo();
    const { binDir, logPath } = await makeFakePnpm();
    writeFileSync(logPath, '');
    const result = runVerify(repoDir, binDir, logPath, []);
    expect(result.status, result.stdout + result.stderr).toBe(0);
    expect(result.stdout).not.toContain('!! openapi');
  });
});
