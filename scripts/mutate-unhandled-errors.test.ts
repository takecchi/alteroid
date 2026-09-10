import { execFileSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import { afterEach, describe, expect, it } from 'vitest';

// @ts-expect-error -- 素の .mjs（型宣言を持たない変異試験ハーネス）を読む
import {
  assertNoUnhandledErrorsLine,
  decideJudgementCategory,
  HarnessError,
  parseAggregateLines,
  parseErrorsLine,
  ROOT,
} from '../.claude/skills/mutation-testing/mutate-core.mjs';

/**
 * `.claude/skills/mutation-testing/mutate-core.mjs` の `decideJudgementCategory` が
 * `testResult.exitCode` を1文字も見ない欠陥（意図的な設計。`scripts/test-guard-core.mjs`
 * の doc — `grep -Fn -- '変異試験ハーネスとの関係' scripts/test-guard-core.mjs`）の、
 * 見落とされていた裏側の歯。
 *
 * **欠陥の機構**: vitest は「テストは全部通った後に、未処理の例外/rejection
 * （`queueMicrotask` の中で投げられた例外・拾われなかった Promise の reject）が
 * 起きた」場合、`Test Files` / `Tests` の集計行を完全に緑のまま保ち、`Errors  N
 * error(s)` という3本目の集計行だけを足して exit 1 で終える。`decideJudgementCategory`
 * は集計行の文字列（`passed` / `failed` の有無）だけで判定するので、この `Errors`
 * 行を見ないと「生存」（実際には走行そのものが壊れている）を静かに返す。
 * `cmdBaseline` に至っては「ベースライン成立。」と exit 0 で名乗ってしまい、以降の
 * 全工程が成立していない土台の上に載る。
 *
 * **直し方**: `assertAggregateBlocksUnambiguous`（門1）と同じ作法で、`Errors` 行の
 * 存在そのものを理由に拒む純関数（`assertNoUnhandledErrorsLine`）を足し、
 * `assertAggregateBlocksUnambiguous` と同じ4つの呼び出し元
 * （`decideJudgementCategory` / `足場対照` / `mutate.mjs` の `cmdBaseline` /
 * `cmdRun` の baseline 確認）から呼ぶ。**`exitCode` は1文字も見ない** —— 見る形に
 * すると `scripts/test-guard-core.mjs` の歯A/B/Cが付ける専用の終了コードを
 * 「検出」に化けさせない、という既存の非対称性そのものを壊すことになる
 * （`grep -Fn -- '変異試験ハーネスとの関係' scripts/test-guard-core.mjs`）。
 *
 * **門の位置**: 門1（集計ブロックの複数性）の直後・門3（`testsRanCleanly`。
 * 旧門2）より前——`decideJudgementCategory` の「すべて緑なら生存」という早期
 * リターンより前に置かないと、緑に見える壊れた走行を素通しすることになる。
 */

/** 集計行だけを持つ、`Errors` 行の無い普通の緑（`SINGLE_BLOCK_ALL_PASSED` と同じ形）。 */
const CLEAN_OUTPUT = [
  ' RUN  v4.1.10 /tmp/probe',
  '',
  ' Test Files  1 passed (1)',
  '      Tests  11 passed (11)',
  '   Start at  06:44:56',
  '   Duration  201ms',
].join('\n');

/**
 * 紛らわしい行。`scripts/mutate-core-strip-ansi.test.ts` の `DECOY_OUTPUT` /
 * `scripts/mutate-aggregate-blocks.test.ts` の `DECOY_LINES` と同じ狙い——
 * 探す語を緩めていないことを確かめる。
 * - `Errors: none` —— コロン付きの散文。`Errors` の直後が空白ではなくコロンなので
 *   `Errors\s+` に一致しない。
 * - `Type Errors  no errors` —— typecheck が有効なときに vitest 自身が出す別の
 *   集計行（`reportTestSummary` の `padSummaryTitle("Type Errors")`）。行頭直後が
 *   `Type` であって `Errors` ではないので一致しない。
 * - 散文中の小文字 `errors` —— 行頭に無いので一致しない。
 */
const DECOY_LINES = [
  'Errors: none',
  ' Type Errors  no errors',
  'This run produced 0 errors overall, see the summary above.',
];

describe('mutate-core: parseErrorsLine', () => {
  it('Errors 行が無ければ null', () => {
    expect(parseErrorsLine(CLEAN_OUTPUT)).toBeNull();
  });

  it('紛らわしい行では発火しない（Errors: none / Type Errors / 散文の errors）', () => {
    const raw = [CLEAN_OUTPUT, '', ...DECOY_LINES].join('\n');
    expect(parseErrorsLine(raw)).toBeNull();
  });

  it('本物の vitest ログ（queueMicrotask 内の例外）で Errors 行を拾う', () => {
    expect(parseErrorsLine(REAL_MICROTASK_THROW)).toBe('Errors  1 error');
  });

  it('本物の vitest ログ（setTimeout 内の unhandled rejection）で Errors 行を拾う', () => {
    expect(parseErrorsLine(REAL_SETTIMEOUT_REJECT)).toBe('Errors  1 error');
  });

  it('test-guard の意図的な赤（it.skip 検出、exit 4）には Errors 行が無い', () => {
    // 歯B（無条件 skip の検出）は test.mjs が vitest の外側で追加のメッセージと
    // 専用 exit を出す形であって、vitest 自身の集計ブロックへは1行も足さない。
    expect(parseErrorsLine(REAL_GUARD_B_SKIP)).toBeNull();
  });
});

describe('mutate-core: assertNoUnhandledErrorsLine', () => {
  it('Errors 行が無ければ何も投げない', () => {
    expect(() => assertNoUnhandledErrorsLine(CLEAN_OUTPUT, 'test')).not.toThrow();
  });

  it('test-guard の意図的な赤（歯B、exit 4）では投げない——意図的な赤を巻き込まない対照', () => {
    expect(() => assertNoUnhandledErrorsLine(REAL_GUARD_B_SKIP, 'test')).not.toThrow();
  });

  it('本物の vitest ログ（queueMicrotask 内の例外）で HarnessError を投げ、拒否メッセージに「なぜ」と「次に何を」が入っている', () => {
    let caught: unknown;
    try {
      assertNoUnhandledErrorsLine(REAL_MICROTASK_THROW, 'decideJudgementCategory');
    } catch (err) {
      caught = err;
    }
    expect(caught).toBeInstanceOf(HarnessError);
    const message = (caught as Error).message;
    expect(message).toContain('decideJudgementCategory');
    expect(message).toContain('Errors');
    expect(message).toContain('exitCode');
    expect(message).toContain('次にやること');
    expect(message).toContain('Unhandled Errors');
  });

  it('本物の vitest ログ（setTimeout 内の unhandled rejection）でも HarnessError を投げる', () => {
    expect(() => assertNoUnhandledErrorsLine(REAL_SETTIMEOUT_REJECT, 'baseline')).toThrow(
      HarnessError,
    );
  });
});

describe('mutate-core: decideJudgementCategory（門2 — Errors 行）', () => {
  const artifactResultNotChecked = { artifactState: 'not-checked' };

  it('⭐ Errors 行が無ければこれまでどおり判定できる（生存、回帰）', () => {
    const category = decideJudgementCategory(artifactResultNotChecked, {
      raw: CLEAN_OUTPUT,
      ...parseAggregateLines(CLEAN_OUTPUT),
    });
    expect(category).toBe('生存');
  });

  /**
   * これが本題である。集計行だけを見れば `Test Files 1 passed (1)` /
   * `Tests 1 passed (1)` で「すべて緑」に見える——もし門2 が無ければ
   * `testsAllPassed(testResult) === true` で早期に `生存` を返してしまう
   * （`exitCode` を見ない設計なので、実際に本物の vitest がこの走行を
   * exit 1 で終えていることに気づけない）。
   */
  it('本物の vitest ログ（Errors 行あり、集計行は緑）では判定を拒む——集計行の緑だけで「生存」にしない', () => {
    expect(() =>
      decideJudgementCategory(artifactResultNotChecked, {
        raw: REAL_MICROTASK_THROW,
        ...parseAggregateLines(REAL_MICROTASK_THROW),
      }),
    ).toThrow(HarnessError);
  });

  it('test-guard の意図的な赤（歯B）は門2 を素通りする——門2 は歯Bの専用 exit を巻き込まない', () => {
    // 歯Bのメッセージ自体は `Test Files` / `Tests` の外側にあるので
    // `testsAllPassed` は true になる（集計行だけを見れば緑）。門2 が歯Bの
    // 意図的な赤を誤って拒まないことを確かめる——ここでは門2 の直後の分岐
    // （`testsAllPassed`）まで到達し、`生存` を返すことまで確認する。
    const category = decideJudgementCategory(artifactResultNotChecked, {
      raw: REAL_GUARD_B_SKIP,
      ...parseAggregateLines(REAL_GUARD_B_SKIP),
    });
    expect(category).toBe('生存');
  });
});

/**
 * `mutate.mjs` の CLI 層（`cmdBaseline` / `cmdRun`）を子プロセスとして実際に
 * 起動し、`pnpm` を偽物へ差し替えて `Errors` 行を含む出力を返させる。
 * `scripts/mutate-aggregate-blocks.test.ts` の同名の describe と同じ作法
 * （理由もそちらの doc を参照）。
 */
describe('mutate.mjs CLI: baseline / run の Errors 行チェック（門2）', () => {
  const MUTATE_JS = fileURLToPath(
    new URL('../.claude/skills/mutation-testing/mutate.mjs', import.meta.url),
  );
  const tempDirs: string[] = [];

  afterEach(() => {
    while (tempDirs.length > 0) {
      const dir = tempDirs.pop();
      if (dir) fs.rmSync(dir, { recursive: true, force: true });
    }
  });

  function makeFakePnpmDir(outputText: string): string {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'fake-pnpm-'));
    tempDirs.push(dir);
    const scriptPath = path.join(dir, 'pnpm');
    const content = `#!/usr/bin/env node\nprocess.stdout.write(${JSON.stringify(outputText)});\nprocess.exit(0);\n`;
    fs.writeFileSync(scriptPath, content, { mode: 0o755 });
    return dir;
  }

  function runCli(
    args: string[],
    fakePnpmOutput: string,
  ): { status: number | null; stdout: string; stderr: string } {
    const fakeDir = makeFakePnpmDir(fakePnpmOutput);
    const env = { ...process.env, PATH: `${fakeDir}:${process.env.PATH ?? ''}` };
    try {
      const stdout = execFileSync('node', [MUTATE_JS, ...args], {
        cwd: ROOT,
        encoding: 'utf8',
        env,
      });
      return { status: 0, stdout, stderr: '' };
    } catch (err) {
      const e = err as { status: number | null; stdout?: string; stderr?: string };
      return { status: e.status, stdout: e.stdout ?? '', stderr: e.stderr ?? '' };
    }
  }

  it('baseline: Errors 行があるとき exit 1 で拒否し、「ベースライン成立。」と名乗らない', () => {
    // ⚠️ ここが偽陽性の実測——劣化前のこの1行が示す事実そのものが、この歯の
    // 存在理由である（コーディネーターが挙げた実測「cmdBaseline相当 ->
    // 『ベースライン成立。』(exit 0) ← 実際の exitCode は 1」の再現条件）。
    const result = runCli(['baseline'], REAL_MICROTASK_THROW);
    expect(result.status).toBe(1);
    expect(result.stdout).not.toContain('ベースライン成立。');
    expect(result.stdout).toContain('baseline');
    expect(result.stdout).toContain('次にやること');
  });

  it('run: baseline 確認で Errors 行があるとき exit 1 で拒否する', () => {
    const planPath = path.join(fs.mkdtempSync(path.join(os.tmpdir(), 'mutate-plan-')), 'plan.json');
    tempDirs.push(path.dirname(planPath));
    fs.writeFileSync(planPath, '[]');
    const result = runCli(['run', '--plan', planPath], REAL_SETTIMEOUT_REJECT);
    expect(result.status).toBe(1);
    expect(result.stdout).toContain('run: baseline');
    expect(result.stdout).toContain('次にやること');
  });
});

// ── 本物の vitest ログ（フィクスチャ定義。ファイル末尾に置く——上の
//    describe より先に読みたいのは実装との対応関係のほうなので） ──────

/**
 * **出所**: 別の作業者が本物の vitest 5.0.0 で採取した生ログ
 * （`/home/worker/mgr-f9b32deb/w3/logs/case1-microtask-throw.raw.log`。
 * `queueMicrotask` の中で例外を投げるテストを走らせたもの。テスト自身は
 * 通っている——`Test Files 1 passed (1)` / `Tests 1 passed (1)`——が、
 * その後に未処理の例外が拾われ `Errors  1 error` が足され、vitest は exit 1
 * で終える（`/home/worker/mgr-f9b32deb/w3/logs/case1-microtask-throw.exit` が
 * `exit=1` を記録している）。
 *
 * **変えた場所は1箇所だけ——`RUN` 行にある絶対パスを `/tmp/probe` に置換した**
 * （元は `/home/worker/mgr-f9b32deb/w3/scratch`。既存フィクスチャの `/tmp/probe`
 * という流儀に揃えた）。**それ以外は1文字も変えていない** ——
 * `⎯⎯⎯ Unhandled Errors ⎯⎯⎯` の節見出し、`Uncaught Exception` の節、
 * スタックトレース、集計行の並びを含め、採取した生ログのままである。
 */
const REAL_MICROTASK_THROW = [
  '',
  ' RUN  v5.0.0 /tmp/probe',
  '',
  '⎯⎯⎯⎯⎯⎯ Unhandled Errors ⎯⎯⎯⎯⎯⎯',
  '',
  'Vitest caught 1 unhandled error during the test run.',
  'This might cause false positive tests. Resolve unhandled errors to make sure your tests are not affected.',
  '',
  '⎯⎯⎯⎯⎯ Uncaught Exception ⎯⎯⎯⎯⎯',
  'Error: boom - thrown from a microtask scheduled during a passing test',
  ' ❯ case1-unhandled-rejection/a.test.ts:5:11',
  "      3| it('passes but leaves a microtask rejection behind', () => {",
  '      4|   queueMicrotask(() => {',
  "      5|     throw new Error('boom - thrown from a microtask scheduled during a…",
  '       |           ^',
  '      6|   });',
  '      7|   expect(1 + 1).toBe(2);',
  ' ❯ node:internal/process/task_queues:149:7',
  ' ❯ AsyncResource.runInAsyncScope node:async_hooks:214:14',
  ' ❯ AsyncResource.runMicrotask node:internal/process/task_queues:146:8',
  ' ❯ processTicksAndRejections node:internal/process/task_queues:103:5',
  '',
  'This error originated in "case1-unhandled-rejection/a.test.ts" test file. It doesn\'t mean the error was thrown inside the file itself, but while it was running.',
  'The last test to run before this error was "passes but leaves a microtask rejection behind". This means either:',
  '- the error was thrown while Vitest was running this test, or',
  '- the error was thrown after the test completed, and this was the most recent test at that point.',
  '⎯⎯⎯⎯⎯⎯⎯⎯⎯⎯⎯⎯⎯⎯⎯⎯⎯⎯⎯⎯⎯⎯⎯⎯⎯⎯⎯⎯⎯⎯',
  '',
  '',
  ' Test Files  1 passed (1)',
  '      Tests  1 passed (1)',
  '     Errors  1 error',
  '   Start at  08:31:57',
  '   Duration  163ms (transform 56%, import 26%, tests 9%, worker 8%)',
  '',
  '',
].join('\n');

/**
 * **出所**: 同じ作業者が本物の vitest 5.0.0 で採取した生ログ
 * （`/home/worker/mgr-f9b32deb/w3/logs/case1b-settimeout-reject.raw.log`。
 * `setTimeout` の中で Promise を reject するテストを走らせたもの。節見出しが
 * `Unhandled Rejection`（`REAL_MICROTASK_THROW` は `Uncaught Exception`）——
 * vitest が区別する2つの未処理エラーの形のうち、もう一方を固定する。
 * テスト自身は通っている——`Test Files 1 passed (1)` / `Tests 2 passed (2)`。
 *
 * **変えた場所は1箇所だけ——`RUN` 行にある絶対パスを `/tmp/probe` に置換した**
 * （元は `/home/worker/mgr-f9b32deb/w3/scratch`）。それ以外は1文字も変えていない。
 */
const REAL_SETTIMEOUT_REJECT = [
  '',
  ' RUN  v5.0.0 /tmp/probe',
  '',
  '⎯⎯⎯⎯⎯⎯ Unhandled Errors ⎯⎯⎯⎯⎯⎯',
  '',
  'Vitest caught 1 unhandled error during the test run.',
  'This might cause false positive tests. Resolve unhandled errors to make sure your tests are not affected.',
  '',
  '⎯⎯⎯⎯ Unhandled Rejection ⎯⎯⎯⎯⎯',
  'Error: boom - unhandled rejection from setTimeout(20ms)',
  ' ❯ Timeout._onTimeout case1b-settimeout-reject/b.test.ts:5:20',
  "      3| it('passes but a setTimeout reject fires 20ms later', () => {",
  '      4|   setTimeout(() => {',
  "      5|     Promise.reject(new Error('boom - unhandled rejection from setTimeo…",
  '       |                    ^',
  '      6|   }, 20);',
  '      7|   expect(1 + 1).toBe(2);',
  ' ❯ listOnTimeout node:internal/timers:585:17',
  ' ❯ processTimers node:internal/timers:521:7',
  '',
  'This error originated in "case1b-settimeout-reject/b.test.ts" test file. It doesn\'t mean the error was thrown inside the file itself, but while it was running.',
  'The last test to run before this error was "a second test that keeps the worker alive a bit longer". This means either:',
  '- the error was thrown while Vitest was running this test, or',
  '- the error was thrown after the test completed, and this was the most recent test at that point.',
  '⎯⎯⎯⎯⎯⎯⎯⎯⎯⎯⎯⎯⎯⎯⎯⎯⎯⎯⎯⎯⎯⎯⎯⎯⎯⎯⎯⎯⎯⎯',
  '',
  '',
  ' Test Files  1 passed (1)',
  '      Tests  2 passed (2)',
  '     Errors  1 error',
  '   Start at  08:32:09',
  '   Duration  384ms (tests 75%, transform 20%, import 4%, worker 1%)',
  '',
  '',
].join('\n');

/**
 * **出所**: 別の作業者が採取した本物のログ
 * （`/home/worker/mgr-f9b32deb/w3/logs/case-guard-B-skip.raw.log`。
 * `pnpm test` が `scripts/test-guard-core.mjs` の歯B（無条件の `it.skip` を
 * 静的走査で検出）に引っかかって exit 4 で終える形。`Test Files` /
 * `Tests` の集計行は完全に緑（`1 passed (1)` / `6 passed | 1 skipped (7)`）で、
 * `Errors` 行は無い——歯A/B/Cは vitest の外側（`test.mjs`）が追加のメッセージと
 * 専用 exit を出す形であって、vitest 自身の集計ブロックへは1行も足さない。
 * **門2 が歯Bの意図的な赤を誤って拒まないことの対照フィクスチャ**として使う。
 *
 * **変えた場所は1箇所だけ——`RUN` 行にある絶対パスを `/tmp/probe` に置換した**
 * （元は `/home/worker/mgr-f9b32deb/w3/repo`）。それ以外は1文字も変えていない
 * ——先頭の `$ node ./scripts/test.mjs` の行、歯Bのメッセージ、
 * `[ELIFECYCLE]` 行を含め、採取した生ログのままである。
 */
const REAL_GUARD_B_SKIP = [
  '$ node ./scripts/test.mjs',
  '',
  ' RUN  v4.1.10 /tmp/probe',
  '',
  '',
  ' Test Files  1 passed (1)',
  '      Tests  6 passed | 1 skipped (7)',
  '   Start at  08:36:44',
  '   Duration  313ms (transform 43ms, setup 36ms, import 26ms, tests 107ms, environment 0ms)',
  '',
  '',
  'test-guard: ソースの側 — 無条件の静的 skip が 1 件見つかった:',
  '  scripts/check-tracked-nul-bytes.test.ts:43  it.skip',
  '',
  '戻し忘れなら消す。意図的に止めたいなら skipIf で条件を書くか、消して Issue にする。',
  '[ELIFECYCLE] Test failed. See above for more details.',
  '',
].join('\n');
