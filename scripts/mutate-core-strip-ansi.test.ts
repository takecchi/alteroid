import { describe, expect, it } from 'vitest';

import {
  assertAggregateBlocksUnambiguous as harnessAssertAggregateBlocksUnambiguous,
  HarnessError,
  parseAggregateLines as harnessParseAggregateLines,
  stripAnsi,
  // @ts-expect-error -- 素の .mjs（型宣言を持たない変異試験ハーネス）を読む
} from '../.claude/skills/mutation-testing/mutate-core.mjs';
// @ts-expect-error -- 素の .mjs（型宣言を持たない test-guard の中核）を読む
import { parseAggregateLines as guardParseAggregateLines } from './test-guard-core.mjs';
// @ts-expect-error -- 素の .mjs（型宣言を持たない build 用スクリプト）を読む
import { testRan as verifyTestRan } from './verify-core.mjs';

const ESC = '\x1b';
const COLORED_FILES_LINE = `${ESC}[2m Test Files ${ESC}[22m ${ESC}[1m${ESC}[32m130 passed${ESC}[39m${ESC}[22m${ESC}[90m (130)${ESC}[39m`;
const COLORED_TESTS_LINE = `${ESC}[2m      Tests ${ESC}[22m ${ESC}[1m${ESC}[32m2493 passed${ESC}[39m${ESC}[22m${ESC}[90m (2493)${ESC}[39m`;
const COLORED_OUTPUT = [
  ` ${ESC}[32m✓${ESC}[39m scripts/mutate-max-workers.test.ts ${ESC}[2m(11 tests)${ESC}[22m`,
  '',
  COLORED_FILES_LINE,
  COLORED_TESTS_LINE,
  `${ESC}[2m   Start at ${ESC}[22m 06:44:56`,
  `${ESC}[2m   Duration ${ESC}[22m 201ms`,
].join('\n');

const PLAIN_OUTPUT = [
  ' RUN  v4.1.10 /tmp/mgr-6ff7ba34/pr372',
  '',
  ' Test Files  1 passed (1)',
  '      Tests  11 passed (11)',
  '   Start at  06:44:56',
  '   Duration  201ms',
].join('\n');

const NO_SUMMARY_OUTPUT = [
  ' RUN  v4.1.10 /tmp/mgr-6ff7ba34/pr372',
  '',
  'Error: write EPIPE',
  '    at afterWriteDispatched (node:internal/stream_base_commons:159:15)',
].join('\n');

const DECOY_OUTPUT = [
  ' RUN  v4.1.10 /workspace/alteroid',
  '',
  'Files changed: 3',
  'Tests: none',
  'Error: write EPIPE',
].join('\n');

describe('mutate-core: stripAnsi / parseAggregateLines (#372)', () => {
  it('色付きの生バイトでも集計行を読める（filesLine / testsLine が null にならない）', () => {
    const { filesLine, testsLine } = harnessParseAggregateLines(COLORED_OUTPUT);
    expect(filesLine).not.toBeNull();
    expect(testsLine).not.toBeNull();
    expect(filesLine).toBe('Test Files  130 passed (130)');
    expect(testsLine).toBe('Tests  2493 passed (2493)');
  });

  it('剥がした後の文字列に ANSI エスケープが1文字も残らない', () => {
    const plain = stripAnsi(COLORED_OUTPUT);
    const escapeCount = [...plain].filter((ch) => ch === '\x1b').length;
    expect(escapeCount).toBe(0);
    expect(plain).toContain(' Test Files  130 passed (130)');
    expect(plain).toContain('      Tests  2493 passed (2493)');
  });

  it('返す集計行そのものにもエスケープが残らない（行の中ほどの色も剥がれている）', () => {
    const { filesLine, testsLine } = harnessParseAggregateLines(COLORED_OUTPUT);
    expect(filesLine).not.toContain('\x1b');
    expect(testsLine).not.toContain('\x1b');
  });

  it('色が付いていない入力も、これまでどおり読める（回帰）', () => {
    const { filesLine, testsLine } = harnessParseAggregateLines(PLAIN_OUTPUT);
    expect(filesLine).toBe('Test Files  1 passed (1)');
    expect(testsLine).toBe('Tests  11 passed (11)');
  });

  // ANSI を剥がしても探す語（`Test Files` / `Tests`）は緩めない: 緩むと「1本も走っていない」を検出する仕組みが壊れ、`write EPIPE` で1本も走らなかった回が「走って通った」に化けるため。
  it('集計行が本当に無い入力では、剥がしても null のままである', () => {
    expect(harnessParseAggregateLines(NO_SUMMARY_OUTPUT)).toEqual({
      filesLine: null,
      testsLine: null,
    });
  });

  it('色付きでも、集計行が無ければ null のままである', () => {
    const coloredButNoSummary = `${ESC}[31mError: write EPIPE${ESC}[39m\n${ESC}[2m   Duration ${ESC}[22m 201ms`;
    expect(harnessParseAggregateLines(coloredButNoSummary)).toEqual({
      filesLine: null,
      testsLine: null,
    });
  });

  it('`Files` / `Tests` を含むだけの行を集計行と読まない（探す語を緩めていない）', () => {
    expect(harnessParseAggregateLines(DECOY_OUTPUT)).toEqual({
      filesLine: null,
      testsLine: null,
    });
  });

  it('紛らわしい行が先に在っても、本物の集計行のほうを読む', () => {
    const decoyThenReal = [DECOY_OUTPUT, COLORED_FILES_LINE, COLORED_TESTS_LINE].join('\n');
    expect(harnessParseAggregateLines(decoyThenReal)).toEqual({
      filesLine: 'Test Files  130 passed (130)',
      testsLine: 'Tests  2493 passed (2493)',
    });
  });

  it('片方だけ出ている場合、出ているほうだけを読み、もう片方は null にする', () => {
    const onlyFiles = `${COLORED_FILES_LINE}\n${ESC}[2m   Duration ${ESC}[22m 201ms`;
    const { filesLine, testsLine } = harnessParseAggregateLines(onlyFiles);
    expect(filesLine).toBe('Test Files  130 passed (130)');
    expect(testsLine).toBeNull();
  });
});

// 共有の出所（他を import する形）を作らない: ハーネスは依存なし・ビルド不要が要件で、壊れた repo でこそ使う道具を `scripts/` の配置に結びつけないため。
// 3箇所から同じ正規表現リテラルを読んで `toEqual` で比べない: 比較の両側が同じ経路で同じ値へ強制されると恒真になるため。同じ入力を3つ全部へ通した出力を測る。
// 下の `it.each` に複数集計ブロックの入力を足さない: 3箇所は複数ブロックに対して意図して食い違っており、足すと突き合わせが落ちるため。
describe('集計行の判定: 単一ブロック相当の入力では3箇所の実装が食い違わないこと (#372 / #355 / #392)', () => {
  const hasSummary = (result: { filesLine: string | null; testsLine: string | null }) =>
    result.filesLine !== null && result.testsLine !== null;

  it.each([
    ['色付きの生バイト', COLORED_OUTPUT],
    ['色の付いていない出力', PLAIN_OUTPUT],
    ['集計行が1つも無い出力', NO_SUMMARY_OUTPUT],
    ['紛らわしい行のみ（探す語を緩めたら当たる形）', DECOY_OUTPUT],
    ['空文字列', ''],
  ])('%s を3箇所へ通すと、同じ集計行が返る', (_name, input) => {
    const harness = harnessParseAggregateLines(input);
    const guard = guardParseAggregateLines(input);
    expect(guard).toEqual(harness);
    expect(verifyTestRan(input)).toBe(hasSummary(harness));
    expect(verifyTestRan(input)).toBe(hasSummary(guard));
  });

  it('集計行が無い入力では、3箇所とも「無い」を返す（1箇所だけが「何でも読める」に倒れない）', () => {
    const expected = { filesLine: null, testsLine: null };
    expect(harnessParseAggregateLines(NO_SUMMARY_OUTPUT)).toEqual(expected);
    expect(guardParseAggregateLines(NO_SUMMARY_OUTPUT)).toEqual(expected);
    expect(verifyTestRan(NO_SUMMARY_OUTPUT)).toBe(false);
  });

  it('色付きの生バイトでは、3箇所とも本物の集計行を認識する（全部 false/null で「一致」しない）', () => {
    const harness = harnessParseAggregateLines(COLORED_OUTPUT);
    const guard = guardParseAggregateLines(COLORED_OUTPUT);
    // 一致だけを測ると「全部 null」でも緑になるため、中身も名指しする。
    expect(harness.filesLine).toBe('Test Files  130 passed (130)');
    expect(harness.testsLine).toBe('Tests  2493 passed (2493)');
    expect(guard).toEqual(harness);
    expect(verifyTestRan(COLORED_OUTPUT)).toBe(true);
  });
});

const MULTI_BLOCK_FIRST_THEN_SECOND = [
  ' RUN  v4.1.10 /tmp/probe (workspace package A)',
  '',
  ' Test Files  1 passed (1)',
  '      Tests  3 passed (3)',
  '   Start at  06:44:56',
  '   Duration  50ms',
  '',
  ' RUN  v4.1.10 /tmp/probe (workspace package B)',
  '',
  ' Test Files  9 passed (9)',
  '      Tests  99 passed (99)',
  '   Start at  06:44:58',
  '   Duration  120ms',
].join('\n');

// `test-guard-core.mjs` / `verify-core.mjs` は「最初」を返す実装のままにする: 複数の集計ブロックが届く経路がいまの構造には無いため。届く経路ができたら、歯を消さず先に到達可能性を測り直す。
describe('複数の集計ブロックを含む入力: 3箇所がどう食い違うか（意図した範囲限定の差を歯で固定する）', () => {
  it('mutate-core.mjs の parseAggregateLines は最後のブロックを返す', () => {
    const { filesLine, testsLine } = harnessParseAggregateLines(MULTI_BLOCK_FIRST_THEN_SECOND);
    expect(filesLine).not.toBe('Test Files  1 passed (1)');
    expect(testsLine).not.toBe('Tests  3 passed (3)');
    expect(filesLine).toBe('Test Files  9 passed (9)');
    expect(testsLine).toBe('Tests  99 passed (99)');
  });

  it('mutate-core.mjs は assertAggregateBlocksUnambiguous で複数ブロックの判定そのものを拒む', () => {
    expect(() =>
      harnessAssertAggregateBlocksUnambiguous(MULTI_BLOCK_FIRST_THEN_SECOND, 'test'),
    ).toThrow(HarnessError);
  });

  it('test-guard-core.mjs の parseAggregateLines は最初のブロックを返す（harness の「最後」と食い違う）', () => {
    const { filesLine, testsLine } = guardParseAggregateLines(MULTI_BLOCK_FIRST_THEN_SECOND);
    expect(filesLine).toBe('Test Files  1 passed (1)');
    expect(testsLine).toBe('Tests  3 passed (3)');
    expect(guardParseAggregateLines(MULTI_BLOCK_FIRST_THEN_SECOND)).not.toEqual(
      harnessParseAggregateLines(MULTI_BLOCK_FIRST_THEN_SECOND),
    );
  });

  it('verify-core.mjs の testRan はブロックが何個あっても答えが変わらない（真偽値しか返さないので「最初/最後」の区別を持たない）', () => {
    expect(verifyTestRan(MULTI_BLOCK_FIRST_THEN_SECOND)).toBe(true);
    expect(verifyTestRan(MULTI_BLOCK_FIRST_THEN_SECOND)).toBe(verifyTestRan(PLAIN_OUTPUT));
  });
});
