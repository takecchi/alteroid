import { execFileSync } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import { describe, expect, it } from 'vitest';

import { makeTempDirSync } from '../vitest.tmpdir.js';

import { mutateCliChildEnv } from './mutate-cli-child-env.js';
import {
  assertNoUnhandledErrorsLine,
  decideJudgementCategory,
  HarnessError,
  parseAggregateLines,
  parseErrorsLine,
  ROOT,
  // @ts-expect-error -- 素の .mjs（型宣言を持たない変異試験ハーネス）を読む
} from '../.claude/skills/mutation-testing/mutate-core.mjs';

// `exitCode` を見ない: 見ると test-guard-core の歯A/B/C が付ける専用の終了コードを「検出」に化けさせない、という既存の非対称性を壊すため。
// 門の位置は門1の直後・門3より前: 「すべて緑なら生存」の早期リターンより前に置かないと、緑に見える壊れた走行を素通しするため。

const CLEAN_OUTPUT = [
  ' RUN  v4.1.10 /tmp/probe',
  '',
  ' Test Files  1 passed (1)',
  '      Tests  11 passed (11)',
  '   Start at  06:44:56',
  '   Duration  201ms',
].join('\n');

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

  it('本物の vitest ログ（Errors 行あり、集計行は緑）では判定を拒む——集計行の緑だけで「生存」にしない', () => {
    expect(() =>
      decideJudgementCategory(artifactResultNotChecked, {
        raw: REAL_MICROTASK_THROW,
        ...parseAggregateLines(REAL_MICROTASK_THROW),
      }),
    ).toThrow(HarnessError);
  });

  it('test-guard の意図的な赤（歯B）は門2 を素通りする——門2 は歯Bの専用 exit を巻き込まない', () => {
    const category = decideJudgementCategory(artifactResultNotChecked, {
      raw: REAL_GUARD_B_SKIP,
      ...parseAggregateLines(REAL_GUARD_B_SKIP),
    });
    expect(category).toBe('生存');
  });
});

describe('mutate.mjs CLI: baseline / run の Errors 行チェック（門2）', () => {
  const MUTATE_JS = fileURLToPath(
    new URL('../.claude/skills/mutation-testing/mutate.mjs', import.meta.url),
  );
  function makeFakePnpmDir(outputText: string): string {
    const dir = makeTempDirSync('fake-pnpm-');
    const scriptPath = path.join(dir, 'pnpm');
    const content = `#!/usr/bin/env node\nprocess.stdout.write(${JSON.stringify(outputText)});\nprocess.exit(0);\n`;
    fs.writeFileSync(scriptPath, content, { mode: 0o755 });
    return dir;
  }

  function buildRunCliEnv(fakeDir: string): NodeJS.ProcessEnv {
    const base = mutateCliChildEnv();
    return { ...base, PATH: `${fakeDir}:${base.PATH ?? ''}` };
  }

  function runCli(
    args: string[],
    fakePnpmOutput: string,
  ): { status: number | null; stdout: string; stderr: string } {
    const fakeDir = makeFakePnpmDir(fakePnpmOutput);
    const env = buildRunCliEnv(fakeDir);
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

  it('親の process.env にある偽の値は、子へ渡す env に含まれない（#1854）', () => {
    const key = 'ALTEROID_TEST_FAKE_1854';
    const before = process.env[key];
    process.env[key] = 'not-a-real-value';
    try {
      const env = buildRunCliEnv(makeFakePnpmDir(''));
      expect(env).not.toHaveProperty(key);
    } finally {
      if (before === undefined) delete process.env[key];
      else process.env[key] = before;
    }
  });

  it('baseline: Errors 行があるとき exit 1 で拒否し、「ベースライン成立。」と名乗らない', () => {
    const result = runCli(['baseline'], REAL_MICROTASK_THROW);
    expect(result.status).toBe(1);
    expect(result.stdout).not.toContain('ベースライン成立。');
    expect(result.stdout).toContain('baseline');
    expect(result.stdout).toContain('次にやること');
  });

  it('run: baseline 確認で Errors 行があるとき exit 1 で拒否する', () => {
    const planPath = path.join(makeTempDirSync('mutate-plan-'), 'plan.json');
    fs.writeFileSync(planPath, '[]');
    const result = runCli(['run', '--plan', planPath], REAL_SETTIMEOUT_REJECT);
    expect(result.status).toBe(1);
    expect(result.stdout).toContain('run: baseline');
    expect(result.stdout).toContain('次にやること');
  });
});

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
