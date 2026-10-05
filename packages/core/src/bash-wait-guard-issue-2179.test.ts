import { describe, expect, it } from 'vitest';

import { inspectBashCommand } from './bash-wait-guard.js';
import { expectNotSuperlinear } from './time-growth.test-support.js';

/**
 * Issue #2179 —— bash が1つのコマンドとして実行する形を、ガードが区切り方の読み違いで
 * 見落としていた。直す前（main 6c30e1d）は、下の「弾く」のうち、`timeout 60 \` の1形と
 * ヒアドキュメントの罠の1形を除いて、すべて `blocked: false` だった（写しに直接当てた実測、
 * 2026-09-29T12:0xZ）。
 *
 * `run watch` の字面は組み立てる（このファイルをヒアドキュメントで書くと、本番の版のガードに
 * 誤検知で弾かれるため。#2130）。
 */
const W = ['gh', 'run', 'watch'].join(' ');

describe('{ …; } & と coproc で背景へ置いた run watch を弾く（#2179 B）', () => {
  const blocked: ReadonlyArray<[string, string]> = [
    ['{ …; } &', `{ ${W} 1; } &`],
    ['グループの途中の run watch', `{ echo a; ${W} 1; } &`],
    ['入れ子のグループの外側だけが背景', `{ { ${W} 1; }; } &`],
    ['coproc', `coproc ${W} 1`],
    ['名前付きの coproc', `coproc W { ${W} 1; }`],
  ];
  for (const [label, command] of blocked) {
    it(`${label}: 弾く`, () => {
      const verdict = inspectBashCommand(command);
      expect(verdict.blocked).toBe(true);
      if (!verdict.blocked) throw new Error('unreachable');
      expect(verdict.form).toBe('gh-run-watch-background');
    });
  }

  const passing: ReadonlyArray<[string, string]> = [
    ['前景のグループ', `{ ${W} 1; }`],
    ['グループの後ろが &&', `{ ${W} 1; } && echo done`],
    ['グループの後ろのリダイレクトとパイプ', `{ ${W} 1; } 2>&1 | tee log`],
    ['${x} の展開の後ろ', `echo \${x}; ${W} 1`],
    ['前景の timeout 付き', `timeout 600 ${W} 1 --exit-status`],
  ];
  for (const [label, command] of passing) {
    it(`${label}: 通す`, () => {
      expect(inspectBashCommand(command).blocked).toBe(false);
    });
  }
});

describe('#2179 の判定が、長い入力で後戻りで爆発しない', () => {
  // issue #2187 —— 壁時計の絶対値（`TIME_BUDGET_MS = 200`）から伸びの比へ
  // 替えた。`n * factor`（既定 factor=4）を、直す前にテストしていた
  // 繰り返し回数（5000 / 4000 / 8000）に揃えてある。
  const cases: ReadonlyArray<[string, (n: number) => string, number]> = [
    ['深い入れ子のグループ', (n) => `{ ${'{ '.repeat(n)}${W} 1; ${'}; '.repeat(n)}} &`, 1250],
    ['行の継続の繰り返し', (n) => `${'gh pr merge 1 \\\n'.repeat(n)}x`, 1000],
    ['開いたままの { の繰り返し', (n) => `${'{ '.repeat(n)}${W} 1`, 2000],
  ];
  for (const [label, makeInput, n] of cases) {
    it(`${label}が予算内に終わる`, () => {
      expectNotSuperlinear((command: string) => inspectBashCommand(command), makeInput, { n });
    });
  }
});
