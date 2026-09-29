import { describe, expect, it } from 'vitest';

import {
  BASH_TOOL_DEFAULT_TIMEOUT_MS,
  BASH_TOOL_MAX_TIMEOUT_MS,
  BASH_TOOL_TIMEOUT_MARGIN_MS,
  commandTimeoutTotalMs,
  describeBashToolTimeoutRaise,
  planBashToolTimeoutRaise,
} from './bash-tool-timeout.js';

describe('commandTimeoutTotalMs — コマンドの中の timeout の合計', () => {
  const cases: ReadonlyArray<[string, string, number | null]> = [
    ['秒（単位なし）', 'timeout 300 pnpm test', 300_000],
    ['秒（s）', 'timeout 45s pnpm test', 45_000],
    ['分（小数）', 'timeout 1.5m pnpm test', 90_000],
    ['時', 'timeout 2h make', 7_200_000],
    ['日', 'timeout 1d make', 86_400_000],
    ['先頭が . の小数', 'timeout .5m x', 30_000],
    ['&& で2つ（順に走るので合計）', 'timeout 300 pnpm build && timeout 200 pnpm test', 500_000],
    ['; と改行', 'timeout 10 a; timeout 20 b\ntimeout 30 c', 60_000],
    ['cd の後ろ', 'cd packages/core && timeout 600 pnpm exec vitest run', 600_000],
    ['-k のオプション付き', 'timeout -k 5 300 pnpm test', 300_000],
    ['-s のオプション付き', 'timeout -s KILL 300 pnpm test', 300_000],
    ['長いオプション付き', 'timeout --signal=KILL --preserve-status 300 pnpm test', 300_000],
    ['値を取らない短いフラグ付き', 'timeout -v 300 pnpm test', 300_000],
    ['サブシェルの中', '(timeout 120 a)', 120_000],
    ['timeout が無い', 'pnpm test', null],
    ['語の途中の timeout は拾わない', 'mytimeout 300 x', null],
    ['継続時間に語がくっついた形は拾わない', 'timeout 300pnpm', null],
  ];
  for (const [label, command, expected] of cases) {
    it(`${label}: ${command}`, () => {
      expect(commandTimeoutTotalMs(command)).toBe(expected);
    });
  }

  it('timeout 0（寿命なし）を含めば Infinity', () => {
    expect(commandTimeoutTotalMs('timeout 0 pnpm test')).toBe(Infinity);
  });

  it('長い繰り返しでも後戻りで爆発しない', () => {
    const command = `${'timeout -k 5 -v '.repeat(5000)}x`;
    const start = performance.now();
    commandTimeoutTotalMs(command);
    expect(performance.now() - start).toBeLessThan(200);
  });
});

describe('planBashToolTimeoutRaise — ツールの timeout 引数を引き上げる計画', () => {
  it('引数が未指定で、コマンドの中の timeout が既定を超えるなら引き上げる（合計 + 余裕）', () => {
    expect(planBashToolTimeoutRaise({ command: 'timeout 300 pnpm test' })).toEqual({
      fromMs: undefined,
      toMs: 300_000 + BASH_TOOL_TIMEOUT_MARGIN_MS,
      commandTimeoutTotalMs: 300_000,
    });
  });

  it('引数が足りなければ、渡された値から引き上げる', () => {
    expect(
      planBashToolTimeoutRaise({ command: 'timeout 300 pnpm test', timeout: 120_000 }),
    ).toEqual({
      fromMs: 120_000,
      toMs: 310_000,
      commandTimeoutTotalMs: 300_000,
    });
  });

  it('上限（600000ms）を超えては引き上げない', () => {
    expect(planBashToolTimeoutRaise({ command: 'timeout 900 pnpm test' })?.toMs).toBe(
      BASH_TOOL_MAX_TIMEOUT_MS,
    );
    expect(planBashToolTimeoutRaise({ command: 'timeout 595 pnpm test' })?.toMs).toBe(
      BASH_TOOL_MAX_TIMEOUT_MS,
    );
  });

  it('timeout 0（寿命なし）は上限まで引き上げ、合計は「無し」と名乗る', () => {
    expect(planBashToolTimeoutRaise({ command: 'timeout 0 pnpm test' })).toEqual({
      fromMs: undefined,
      toMs: BASH_TOOL_MAX_TIMEOUT_MS,
      commandTimeoutTotalMs: undefined,
    });
  });

  it('引数が既に十分なら何もしない（下げる向きには書き換えない）', () => {
    expect(
      planBashToolTimeoutRaise({ command: 'timeout 300 pnpm test', timeout: 600_000 }),
    ).toBeUndefined();
    expect(
      planBashToolTimeoutRaise({ command: 'timeout 300 pnpm test', timeout: 310_000 }),
    ).toBeUndefined();
  });

  it('コマンドの中の timeout が既定に収まるなら何もしない', () => {
    // 60秒 + 余裕10秒 = 70秒 < 既定120秒
    expect(planBashToolTimeoutRaise({ command: 'timeout 60 pnpm test' })).toBeUndefined();
    expect(
      planBashToolTimeoutRaise({
        command: `timeout ${(BASH_TOOL_DEFAULT_TIMEOUT_MS - BASH_TOOL_TIMEOUT_MARGIN_MS) / 1000} x`,
      }),
    ).toBeUndefined();
  });

  it('コマンドの中に timeout が無ければ何もしない', () => {
    expect(planBashToolTimeoutRaise({ command: 'pnpm test' })).toBeUndefined();
  });

  it('run_in_background の呼び出しには触らない（背景ではツールは待たない）', () => {
    expect(
      planBashToolTimeoutRaise({ command: 'timeout 300 pnpm test', run_in_background: true }),
    ).toBeUndefined();
  });

  it('command が文字列でなければ何もしない', () => {
    expect(planBashToolTimeoutRaise({ command: 123 })).toBeUndefined();
  });

  it('timeout 引数が数でない・0以下なら、既定とみなして比べる', () => {
    expect(
      planBashToolTimeoutRaise({ command: 'timeout 300 x', timeout: '600000' })?.fromMs,
    ).toBeUndefined();
    expect(planBashToolTimeoutRaise({ command: 'timeout 300 x', timeout: 0 })?.toMs).toBe(310_000);
    expect(planBashToolTimeoutRaise({ command: 'timeout 300 x', timeout: Number.NaN })?.toMs).toBe(
      310_000,
    );
  });

  // 構文（引用符）は解かない。空白の後ろなら引用符の中の字面も数えるが、
  // 引き上げる向きにしか働かない（待てる時間が延びるだけ）。引用符の直後の
  // `timeout` は、手前の条件（行頭・空白・演算子・括弧）に当たらないので数えない。
  it('引用符の中でも空白の後ろの timeout は数える（構文は解かない）', () => {
    expect(planBashToolTimeoutRaise({ command: 'echo "a timeout 300 x"' })?.toMs).toBe(310_000);
  });

  it('引用符の直後の timeout は数えない', () => {
    expect(planBashToolTimeoutRaise({ command: 'echo "timeout 300 x"' })).toBeUndefined();
  });
});

describe('describeBashToolTimeoutRaise — 打った側へ伝える一文', () => {
  it('引き上げた値・元の値・なぜ・次からどうするか を含む', () => {
    const text = describeBashToolTimeoutRaise({
      fromMs: undefined,
      toMs: 310_000,
      commandTimeoutTotalMs: 300_000,
    });
    expect(text).toContain('310000ms');
    expect(text).toContain('未指定');
    expect(text).toContain('子プロセスの寿命');
    expect(text).toContain('600000 以下');
  });

  it('timeout 0 のときは「寿命なし」と名乗る', () => {
    const text = describeBashToolTimeoutRaise({
      fromMs: 120_000,
      toMs: BASH_TOOL_MAX_TIMEOUT_MS,
      commandTimeoutTotalMs: undefined,
    });
    expect(text).toContain('120000ms');
    expect(text).toContain('寿命なし');
  });
});
