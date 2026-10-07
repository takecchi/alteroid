import { execFileSync } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import { describe, expect, it } from 'vitest';

import { makeTempDirSync } from '../vitest.tmpdir.js';

import { mutateCliChildEnv } from './mutate-cli-child-env.js';
import {
  assertAggregateBlocksUnambiguous,
  countAggregateBlocks,
  decideJudgementCategory,
  HarnessError,
  parseAggregateLines,
  ROOT,
  // @ts-expect-error -- 素の .mjs（型宣言を持たない変異試験ハーネス）を読む
} from '../.claude/skills/mutation-testing/mutate-core.mjs';

const SINGLE_BLOCK_ALL_PASSED = [
  ' RUN  v4.1.10 /tmp/probe',
  '',
  ' Test Files  1 passed (1)',
  '      Tests  11 passed (11)',
  '   Start at  06:44:56',
  '   Duration  201ms',
].join('\n');

// 失敗の見出しと `FAIL` 行を持たせる: 落ちた歯の名前が取れない赤は判定を出せない（門4）ため。
const SINGLE_BLOCK_WITH_FAILURE = [
  ' RUN  v4.1.10 /tmp/probe',
  '',
  '⎯⎯⎯ Failed Tests 1 ⎯⎯⎯',
  '',
  ' FAIL  probe.test.ts > 単一ブロック > 1本だけ落ちた',
  '',
  ' Test Files  1 failed (1)',
  '      Tests  1 failed | 10 passed (11)',
  '   Start at  06:44:56',
  '   Duration  201ms',
].join('\n');

// 足場対照の差し引く集合は空にする: 集計ブロックの数え方を測るのに差し引きを混ぜないため。
const EMPTY_SCAFFOLD_CONTROL = {
  measured: true,
  failedNames: [] as string[],
  namesTrustworthy: true,
  scope: '全件',
  extraArgs: [] as string[],
};

const DECOY_LINES = ['Files changed: 3', 'Tests: none'];

const MULTI_BLOCK_FIRST_RED_LAST_GREEN = [
  ' RUN  v4.1.10 /tmp/probe (workspace package A)',
  '',
  ' Test Files  1 failed (1)',
  '      Tests  8 failed | 2 passed (10)',
  '   Start at  06:44:56',
  '   Duration  120ms',
  '',
  ...DECOY_LINES,
  '',
  ' RUN  v4.1.10 /tmp/probe (workspace package B)',
  '',
  ' Test Files  5 passed (5)',
  '      Tests  42 passed (42)',
  '   Start at  06:44:58',
  '   Duration  300ms',
].join('\n');

const MULTI_BLOCK_FIRST_GREEN_LAST_RED = [
  ' RUN  v5.0.0 /tmp/probe',
  '',
  '',
  ' Test Files  1 passed (1)',
  '      Tests  1 passed (1)',
  '   Start at  08:24:19',
  '   Duration  182ms (transform 64%, import 22%, worker 8%, tests 5%)',
  '',
  '',
  ' RUN  v5.0.0 /tmp/probe',
  '',
  ' ❯ tests-b/mul.test.js (1 test | 1 failed) 9ms',
  '   ❯ mul (1)',
  '     × multiplies two numbers 7ms',
  '',
  ' Test Files  1 failed (1)',
  '      Tests  1 failed (1)',
  '   Start at  08:24:20',
  '   Duration  202ms (transform 69%, import 16%, tests 10%, worker 5%)',
  '',
  '$ vitest run tests-a && vitest run tests-b --maxWorkers=4',
  '',
  '⎯⎯⎯⎯⎯⎯⎯ Failed Tests 1 ⎯⎯⎯⎯⎯⎯⎯',
  '',
  ' FAIL  tests-b/mul.test.js > mul > multiplies two numbers',
  'AssertionError: expected 5 to be 6 // Object.is equality',
  '',
  '- Expected',
  '+ Received',
  '',
  '- 6',
  '+ 5',
  '',
  ' ❯ tests-b/mul.test.js:6:23',
  "      4| describe('mul', () => {",
  "      5|   it('multiplies two numbers', () => {",
  '      6|     expect(mul(2, 3)).toBe(6);',
  '       |                       ^',
  '      7|   });',
  '      8| });',
  '',
  '⎯⎯⎯⎯⎯⎯⎯⎯⎯⎯⎯⎯⎯⎯⎯⎯⎯⎯⎯⎯⎯⎯⎯⎯[1/1]⎯',
  '',
  '[ELIFECYCLE] Test failed. See above for more details.',
].join('\n');

describe('mutate-core: parseAggregateLines は複数ブロックで「最後」を返す', () => {
  it('単一ブロックはこれまでどおり読める（回帰）', () => {
    const { filesLine, testsLine } = parseAggregateLines(SINGLE_BLOCK_ALL_PASSED);
    expect(filesLine).toBe('Test Files  1 passed (1)');
    expect(testsLine).toBe('Tests  11 passed (11)');
  });

  it('複数ブロックのとき、最初ではなく最後のブロックを返す', () => {
    const { filesLine, testsLine } = parseAggregateLines(MULTI_BLOCK_FIRST_RED_LAST_GREEN);
    expect(filesLine).not.toBe('Test Files  1 failed (1)');
    expect(testsLine).not.toBe('Tests  8 failed | 2 passed (10)');
    expect(filesLine).toBe('Test Files  5 passed (5)');
    expect(testsLine).toBe('Tests  42 passed (42)');
  });

  it('複数ブロックのとき、向きが逆（最初が緑・最後が赤）でも最後のブロックを返す', () => {
    const { filesLine, testsLine } = parseAggregateLines(MULTI_BLOCK_FIRST_GREEN_LAST_RED);
    expect(filesLine).not.toBe('Test Files  1 passed (1)');
    expect(testsLine).not.toBe('Tests  1 passed (1)');
    expect(filesLine).toBe('Test Files  1 failed (1)');
    expect(testsLine).toBe('Tests  1 failed (1)');
  });
});

describe('mutate-core: countAggregateBlocks の件数の数え方', () => {
  it('単一ブロックは1個（紛らわしい行が在っても増えない）', () => {
    const raw = [SINGLE_BLOCK_ALL_PASSED, ...DECOY_LINES].join('\n');
    const { filesMatches, testsMatches } = countAggregateBlocks(raw);
    expect(filesMatches).toHaveLength(1);
    expect(testsMatches).toHaveLength(1);
  });

  it('2ブロックは2個と数える', () => {
    const { filesMatches, testsMatches } = countAggregateBlocks(MULTI_BLOCK_FIRST_RED_LAST_GREEN);
    expect(filesMatches).toHaveLength(2);
    expect(testsMatches).toHaveLength(2);
    expect(filesMatches[0]).toBe('Test Files  1 failed (1)');
    expect(filesMatches.at(-1)).toBe('Test Files  5 passed (5)');
  });

  it('2ブロックは向きが逆でも2個と数える（本物の vitest ログ）', () => {
    const { filesMatches, testsMatches } = countAggregateBlocks(MULTI_BLOCK_FIRST_GREEN_LAST_RED);
    expect(filesMatches).toHaveLength(2);
    expect(testsMatches).toHaveLength(2);
    expect(filesMatches[0]).toBe('Test Files  1 passed (1)');
    expect(filesMatches.at(-1)).toBe('Test Files  1 failed (1)');
  });

  it('集計行が1つも無ければ0個', () => {
    const { filesMatches, testsMatches } = countAggregateBlocks('Error: write EPIPE');
    expect(filesMatches).toHaveLength(0);
    expect(testsMatches).toHaveLength(0);
  });
});

describe('mutate-core: assertAggregateBlocksUnambiguous', () => {
  it('単一ブロックでは何も投げない', () => {
    expect(() => assertAggregateBlocksUnambiguous(SINGLE_BLOCK_ALL_PASSED, 'test')).not.toThrow();
  });

  it('複数ブロックでは HarnessError を投げ、拒否メッセージに「なぜ」と「次に何を」が入っている', () => {
    let caught: unknown;
    try {
      assertAggregateBlocksUnambiguous(MULTI_BLOCK_FIRST_RED_LAST_GREEN, 'decideJudgementCategory');
    } catch (err) {
      caught = err;
    }
    expect(caught).toBeInstanceOf(HarnessError);
    const message = (caught as Error).message;
    // 鍵となる部分文字列だけを名指しする: 文言をまるごと固定して変更検知器にしないため。
    expect(message).toContain('複合コマンド');
    expect(message).toContain('偽の「生存」');
    expect(message).toContain('偽の「検出」');
    expect(message).toContain('次にやること');
    expect(message).toContain('Test Files');
    expect(message).toContain("spawn('vitest'");
    expect(message).toContain('decideJudgementCategory');
    expect(message).toContain('2個');
  });

  it('複数ブロックでは、向きが逆（最初が緑・最後が赤）でも HarnessError を投げる（本物の vitest ログ）', () => {
    expect(() =>
      assertAggregateBlocksUnambiguous(MULTI_BLOCK_FIRST_GREEN_LAST_RED, 'decideJudgementCategory'),
    ).toThrow(HarnessError);
  });
});

describe('mutate-core: decideJudgementCategory（判定の入口1/3）', () => {
  const artifactResultNotChecked = { artifactState: 'not-checked' };

  it('⭐ 単一ブロックのときは、これまでどおり判定できる（生存）', () => {
    const category = decideJudgementCategory(artifactResultNotChecked, {
      raw: SINGLE_BLOCK_ALL_PASSED,
      ...parseAggregateLines(SINGLE_BLOCK_ALL_PASSED),
    });
    expect(category).toBe('生存');
  });

  it('⭐ 単一ブロックのときは、これまでどおり判定できる（検出）', () => {
    const category = decideJudgementCategory(
      artifactResultNotChecked,
      {
        raw: SINGLE_BLOCK_WITH_FAILURE,
        ...parseAggregateLines(SINGLE_BLOCK_WITH_FAILURE),
        // FAIL 行と一致する census を合成して渡す: テキスト由来の落ちた歯の集合と食い違わせないため。
        census: {
          available: true,
          byName: new Map([['probe.test.ts > 単一ブロック > 1本だけ落ちた', 'failed']]),
        },
      },
      EMPTY_SCAFFOLD_CONTROL,
      ['probe.test.ts > 単一ブロック > 1本だけ落ちた'],
    );
    expect(category).toBe('検出');
  });

  it('複数ブロックのときは判定を拒む（HarnessError）', () => {
    expect(() =>
      decideJudgementCategory(artifactResultNotChecked, {
        raw: MULTI_BLOCK_FIRST_RED_LAST_GREEN,
        ...parseAggregateLines(MULTI_BLOCK_FIRST_RED_LAST_GREEN),
      }),
    ).toThrow(HarnessError);
  });

  it('複数ブロックのときは、向きが逆（最初が緑・最後が赤）でも判定を拒む（本物の vitest ログ）', () => {
    // EMPTY_SCAFFOLD_CONTROL を渡す: 渡さないと門4（足場対照が無い）で必ず HarnessError になり、門1（集計ブロックの複数性）を検証しないまま緑になるため。
    let caught: unknown;
    try {
      decideJudgementCategory(
        artifactResultNotChecked,
        {
          raw: MULTI_BLOCK_FIRST_GREEN_LAST_RED,
          ...parseAggregateLines(MULTI_BLOCK_FIRST_GREEN_LAST_RED),
        },
        EMPTY_SCAFFOLD_CONTROL,
      );
    } catch (err) {
      caught = err;
    }
    expect(caught).toBeInstanceOf(HarnessError);
    expect((caught as Error).message).toContain('複数');
    expect((caught as Error).message).toContain('decideJudgementCategory');
  });

  it('複数ブロックのとき、拒否は「集計行が見つからない」エラーとは別のメッセージである', () => {
    let message = '';
    try {
      decideJudgementCategory(artifactResultNotChecked, {
        raw: MULTI_BLOCK_FIRST_RED_LAST_GREEN,
        ...parseAggregateLines(MULTI_BLOCK_FIRST_RED_LAST_GREEN),
      });
    } catch (err) {
      message = (err as Error).message;
    }
    expect(message).not.toContain('集計行（Test Files / Tests）が見つからない');
    expect(message).toContain('複数');
  });
});

// 子プロセスとして起動する: `mutate.mjs` はモジュール末尾で無条件に `main()` を呼び、`import` するとテストプロセスを巻き込んで `process.exit()` するため。
// `PATH` の先頭に偽の `pnpm` を置く: 本物の `pnpm test` を複数ブロックの出力に誘導する手段が無いため。
describe('mutate.mjs CLI: baseline / run の先頭 baseline 確認（判定の入口2,3/3）', () => {
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

  it('baseline: 複数ブロックのとき exit 1 で拒否し、生ログが判定より前に出る', () => {
    const result = runCli(['baseline'], MULTI_BLOCK_FIRST_RED_LAST_GREEN);
    expect(result.status).toBe(1);
    const rawIdx = result.stdout.indexOf('Test Files  1 failed (1)');
    const refusalIdx = result.stdout.indexOf('判定を拒む');
    expect(rawIdx).toBeGreaterThanOrEqual(0);
    expect(refusalIdx).toBeGreaterThan(rawIdx);
    expect(result.stdout).toContain('baseline');
    expect(result.stdout).toContain('次にやること');
  });

  it('run: baseline 確認で複数ブロックのとき exit 1 で拒否する（run: baseline というラベル）', () => {
    const planPath = path.join(makeTempDirSync('mutate-plan-'), 'plan.json');
    fs.writeFileSync(planPath, '[]');
    const result = runCli(['run', '--plan', planPath], MULTI_BLOCK_FIRST_RED_LAST_GREEN);
    expect(result.status).toBe(1);
    expect(result.stdout).toContain('run: baseline');
    expect(result.stdout).toContain('次にやること');
  });
});
