import { describe, expect, it } from 'vitest';

import { inspectBashCommand } from './bash-wait-guard.js';

/**
 * `flock` の前置きのオプションと、`flock <file> -c <文字列>` の形（mgr-712ad619、
 * 2026-09-29T06:2xZ。`FLOCK_PREFIX_SRC` / `FLOCK_DASH_C_RE` の doc）。
 *
 * 直す前（main 494776b）は、オプションの無い `flock /tmp/l gh pr merge 1 -d` だけを
 * 弾き、下の10形はすべて `blocked: false` だった（写しに直接当てた実測）。
 */
describe('gh-pr-merge-delete-branch: flock のオプションと -c の形を弾く', () => {
  const blocked: ReadonlyArray<[string, string]> = [
    ['値を取らない -n', 'flock -n /tmp/l gh pr merge 1 -d'],
    ['値を取らないフラグを重ねる', 'flock -x -n /tmp/l gh pr merge 1 -d'],
    ['値を取る -w', 'flock -w 5 /tmp/l gh pr merge 1 -d'],
    ['値を取る --timeout（空白区切り）', 'flock --timeout 5 /tmp/l gh pr merge 1 -d'],
    ['値を取る --timeout（= 区切り）', 'flock --timeout=5 /tmp/l gh pr merge 1 -d'],
    ['値を取る -E と -n', 'flock -E 3 -n /tmp/l gh pr merge 1 -d'],
    ['長い値なしフラグ', 'flock --nonblock /tmp/l gh pr merge 1 -d'],
    ['-c の単一引用符', "flock /tmp/l -c 'gh pr merge 1 -d'"],
    ['-c の二重引用符', 'flock -n /tmp/l -c "gh pr merge 1 -d"'],
    ['--command', "flock -n /tmp/l --command 'gh pr merge 1 -d'"],
    // 値の位置の語が - で始まる誤った書き方も読み飛ばす（すり抜けの向きに倒さない）
    ['値を取る -w の値が - で始まる', 'flock -w -n /tmp/l gh pr merge 1 -d'],
  ];
  for (const [label, command] of blocked) {
    it(`${label}: 弾く`, () => {
      const verdict = inspectBashCommand(command);
      expect(verdict.blocked).toBe(true);
      if (!verdict.blocked) throw new Error('unreachable');
      expect(verdict.form).toBe('gh-pr-merge-delete-branch');
    });
  }

  it('オプションの無い flock <file>（直す前から弾いていた形）: 弾く', () => {
    expect(inspectBashCommand('flock /tmp/l gh pr merge 1 -d').blocked).toBe(true);
  });

  const passing: ReadonlyArray<[string, string]> = [
    ['-d が無い', 'flock -n /tmp/l gh pr merge 1 --squash'],
    ['gh が echo の引数', 'flock /tmp/l echo gh pr merge 1 -d'],
    ['-c の中身に gh pr merge が無い', "flock /tmp/l -c 'echo hi'"],
  ];
  for (const [label, command] of passing) {
    it(`${label}: 通す`, () => {
      expect(inspectBashCommand(command).blocked).toBe(false);
    });
  }
});

/**
 * 時間の歯。オプションの2つの読み方が再合流すると指数になる（PR #2080 の実例）。値は `-` で
 * 始まらず、値を取らない側は値を取る名前を否定の先読みで除いてあるので、1つの語の読み方は
 * 1通りに決まる。
 *
 * `'sudo ' + '-u flock '.repeat(n)` は、直す前は2乗で伸びていた（n=2000 で 224.5ms・
 * n=8000 で 3445.4ms。mgr-712ad619 の実測 2026-09-29T06:2xZ）。ファイルの位置引数を
 * `-` で始まらない語に絞ったので、`-u` をファイルとして読む分かれ道が無くなり、線形になった。
 */
describe('gh-pr-merge-delete-branch: flock のオプションの繰り返しが長くても後戻りで爆発しない', () => {
  const TIME_BUDGET_MS = 200;
  const cases: ReadonlyArray<[string, string]> = [
    ['値を取らないフラグの繰り返し', `flock ${'-n '.repeat(8000)}x`],
    ['= 付きの長いオプションの繰り返し', `flock ${'--timeout=5 '.repeat(8000)}x`],
    ['値の位置に - で始まる語が続く繰り返し（短い）', `flock ${'-w '.repeat(40)}x`],
    ['値の位置に - で始まる語が続く繰り返し（長い）', `flock ${'-w '.repeat(8000)}x`],
    ['-c の繰り返し', `${'flock f -c '.repeat(8000)}x`],
    ['sudo -u flock の繰り返し（直す前は2乗）', `sudo ${'-u flock '.repeat(8000)}x`],
  ];
  for (const [label, command] of cases) {
    it(`${label}が予算内に終わる`, () => {
      const start = performance.now();
      const verdict = inspectBashCommand(command);
      const elapsedMs = performance.now() - start;
      expect(verdict.blocked).toBe(false);
      expect(elapsedMs).toBeLessThan(TIME_BUDGET_MS);
    });
  }
});
