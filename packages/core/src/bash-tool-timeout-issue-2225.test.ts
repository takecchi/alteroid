import { readFileSync } from 'node:fs';

import { describe, expect, it } from 'vitest';

import {
  BASH_TOOL_MAX_TIMEOUT_MS,
  BASH_TOOL_TIMEOUT_MARGIN_MS,
  commandTimeoutTotalMs,
  describeBashToolTimeoutRaise,
  planBashToolTimeoutRaise,
  TEST_DEADLINE_KILL_GRACE_MS,
} from './bash-tool-timeout.js';

/**
 * Issue #2225 —— ツールの `timeout` 引数の引き上げ（#2094）が、`scripts/test.mjs` の
 * `--deadline-seconds=<n>`（PR #2142）を読まなかった。スキル（test-in-chunks）は外側の
 * `timeout` の代わりにこちらを勧めているので、スキルのとおりに打つと既定の 120 秒で背景へ
 * 回された。直す前（main 14f0ec6b）は `--deadline-seconds=300` だけの形で
 * `commandTimeoutTotalMs` が null、`planBashToolTimeoutRaise` が undefined だった
 * （C の実測、#2225 の本文）。
 */
const GRACE = TEST_DEADLINE_KILL_GRACE_MS;

describe('commandTimeoutTotalMs — --deadline-seconds も寿命として数える（#2225）', () => {
  const cases: ReadonlyArray<[string, string, number | null]> = [
    [
      '= 形（スキルの形）',
      'cd packages/core && pnpm test -- --shard=1/8 --deadline-seconds=300 --maxWorkers=2',
      300_000 + GRACE,
    ],
    ['空白区切り', 'pnpm test -- --deadline-seconds 300 --reporter=dot', 300_000 + GRACE],
    ['文字列の終わり', 'pnpm test -- --deadline-seconds=45', 45_000 + GRACE],
    ['直後に ;', 'pnpm test -- --deadline-seconds=45; echo done', 45_000 + GRACE],
    ['直後に |', 'pnpm test -- --deadline-seconds=45 | tail -5', 45_000 + GRACE],
    [
      '&& で2つ（順に走るので合計）',
      'pnpm test -- --deadline-seconds=100 && pnpm test -- --deadline-seconds=200',
      300_000 + 2 * GRACE,
    ],
    [
      'timeout と一緒（合計。多めに数える向き）',
      'timeout 60 pnpm build && pnpm test -- --deadline-seconds=200',
      60_000 + 200_000 + GRACE,
    ],
    // test.mjs が vitest を起こす前に断る（exit 9）形は、寿命として数えない
    ['0 は数えない', 'pnpm test -- --deadline-seconds=0', null],
    ['小数は数えない', 'pnpm test -- --deadline-seconds=1.5', null],
    ['値が無い', 'pnpm test -- --deadline-seconds', null],
    ['語の途中は拾わない', 'pnpm test -- --no--deadline-seconds=300', null],
    ['くっついた語は拾わない', 'pnpm test -- --deadline-seconds=300x', null],
  ];
  for (const [label, command, expected] of cases) {
    it(`${label}: ${JSON.stringify(command)} → ${expected}`, () => {
      expect(commandTimeoutTotalMs(command)).toBe(expected);
    });
  }
});

describe('planBashToolTimeoutRaise — スキルのとおりに打った形も引き上げる（#2225）', () => {
  it('--deadline-seconds=300 だけの形を、timeout 300 と同じ向きに引き上げる', () => {
    const plan = planBashToolTimeoutRaise({
      command: 'cd packages/core && pnpm test -- --shard=1/8 --deadline-seconds=300 --maxWorkers=2',
    });
    expect(plan).toEqual({
      fromMs: undefined,
      toMs: 300_000 + GRACE + BASH_TOOL_TIMEOUT_MARGIN_MS,
      commandTimeoutTotalMs: 300_000 + GRACE,
    });
  });

  it('上限（600000ms）を超える締め切りは、上限まで', () => {
    const plan = planBashToolTimeoutRaise({ command: 'pnpm test -- --deadline-seconds=900' });
    expect(plan?.toMs).toBe(BASH_TOOL_MAX_TIMEOUT_MS);
  });

  it('ツールの timeout 引数が既に足りていれば、書き換えない', () => {
    const plan = planBashToolTimeoutRaise({
      command: 'pnpm test -- --deadline-seconds=300',
      timeout: 600_000,
    });
    expect(plan).toBeUndefined();
  });

  it('背景の呼び出しは、書き換えない', () => {
    const plan = planBashToolTimeoutRaise({
      command: 'pnpm test -- --deadline-seconds=300',
      run_in_background: true,
    });
    expect(plan).toBeUndefined();
  });

  it('打った側へ伝える一文は、--deadline-seconds も寿命だと書く', () => {
    const plan = planBashToolTimeoutRaise({ command: 'pnpm test -- --deadline-seconds=300' });
    if (plan === undefined) throw new Error('引き上げるはず');
    expect(describeBashToolTimeoutRaise(plan)).toContain('--deadline-seconds');
  });
});

describe('TEST_DEADLINE_KILL_GRACE_MS は scripts/test.mjs の猶予と同じ値（#2225）', () => {
  it('scripts/test.mjs の DEADLINE_KILL_GRACE_MS と一致する', () => {
    const source = readFileSync(new URL('../../../scripts/test.mjs', import.meta.url), 'utf8');
    const match = /const DEADLINE_KILL_GRACE_MS = ([\d_]+);/.exec(source);
    expect(match, 'scripts/test.mjs に DEADLINE_KILL_GRACE_MS の定義が見つからない').not.toBeNull();
    expect(Number((match?.[1] ?? '').replace(/_/g, ''))).toBe(TEST_DEADLINE_KILL_GRACE_MS);
  });
});
