import { describe, expect, it } from 'vitest';

import { inspectBashCommand } from './bash-wait-guard.js';
import { expectNotSuperlinear } from './time-growth.test-support.js';

/**
 * Issue #2206 —— 追従読みのガードが、フラグを引用符で囲んだ・エスケープした形を見落としていた。
 * bash は引用を外してから argv にするので、下の「弾く」はどれも `tail -f x` と同じく追従する。
 * 直す前（main ad8f7b44）は、下の「弾く」のすべてが `blocked: false` だった
 * （2026-09-29T15:3xZ に #2206 の本文で実測、19:1xZ に同じ結果を再確認）。
 *
 * `tail` の字面は組み立てる（本番の版のガードが、このファイルを打つ Bash の呼び出しを弾くため）。
 */
const T = ['ta', 'il'].join('');

describe('追従読みのガードは、引用符・エスケープで包んだフラグも弾く（#2206）', () => {
  const blocked: ReadonlyArray<[string, string]> = [
    ['二重引用符の -f', `${T} "-f" x`],
    ['単一引用符の -f', `${T} '-f' x`],
    ['二重引用符の --follow', `${T} "--follow" x`],
    ['フラグの文字だけを引用符で', `${T} -"f" x`],
    ['バックスラッシュでエスケープ', `${T} \\-f x`],
    ['二重引用符の -F', `${T} "-F" x`],
    ['ほかのフラグの後ろ', `${T} -n1 "-f" x`],
    ['ANSI-C 引用', `${T} $'-f' x`],
    ['コマンド名を割って引用', `"ta"il -f x`],
  ];
  for (const [label, command] of blocked) {
    it(`${label}: 弾く`, () => {
      const verdict = inspectBashCommand(command);
      expect(verdict.blocked).toBe(true);
      if (!verdict.blocked) throw new Error('unreachable');
      expect(verdict.form).toBe('tail-f');
    });
  }

  const passing: ReadonlyArray<[string, string]> = [
    ['引用符で包んだ -n', `${T} "-n" 1 x`],
    ['引用符で包んだファイル名', `${T} -n 5 "x -f.log"`],
    // 引用符の中の空白を `_` へ替えないと、引用を外した写しが `x -f` の2語になって弾いてしまう形
    ['引用符の中の最後が -f のファイル名', `${T} -n 5 "x -f"`],
    ['単一引用符の中の最後が -f のファイル名', `${T} -n 5 'x -f'`],
    // `tail -n 20 "my -f file"` のように、空白と ` -f ` を含むファイル名を引用符で包んだ形は、
    // 直す前から弾いている（引用符の中も生のまま見る元の写しの判定が当たる。`bash -c "tail -f x"`
    // を弾くために要る判定なので、この Issue では変えない）。引用を外した写しのほうは、引用符の中の
    // 空白を `_` へ替えるので、この形を新しく弾く原因にはならない。
    // #2195 で通すようにした誤検知の形は、通ったまま
    ['commit メッセージの中', `git commit -m "use ${T} -f x.log"`],
    ['Issue の本文の中', `gh issue comment 1 --body "run ${T} '-f' x.log"`],
    ['echo の引数', `echo '${T} "-f" x.log'`],
  ];
  for (const [label, command] of passing) {
    it(`${label}: 通す`, () => {
      expect(inspectBashCommand(command).blocked).toBe(false);
    });
  }
});

describe('引用を外した写しの判定が、長い入力で2乗にならない（#2206）', () => {
  // 出発点の n は、線形の実装でも t(n) が数 ms になる大きさに選ぶ（#2333）。
  // n=1000 では t(n) が手元で約 0.5ms、CI で約 1ms しかなく、分母が 0.1ms ぶれるだけで
  // 比が 10 を超えた（t(1000)=1.02ms, t(4000)=10.65ms, 比 10.48）。助けは、ウォームアップの
  // 2回が 5ms 以上だと n を倍にしないので、出発点そのものを上げておく。
  // n=8000 なら t(n) は手元で約 3.4ms（助けが倍にすれば 16000 で約 6.7ms）。
  const cases: ReadonlyArray<[string, (n: number) => string, number]> = [
    ['引用符の繰り返し', (n) => `${T} ${'"-n" '.repeat(n)}x`, 8000],
    ['バックスラッシュの繰り返し', (n) => `${T} ${'\\-n '.repeat(n)}x`, 8000],
  ];
  for (const [label, makeInput, n] of cases) {
    it(`${label}が線形に終わる`, () => {
      expectNotSuperlinear((command: string) => inspectBashCommand(command), makeInput, { n });
    });
  }
});
