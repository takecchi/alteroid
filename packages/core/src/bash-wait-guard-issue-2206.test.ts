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
  // 比が 10 を超えた（t(1000)=1.02ms, t(4000)=10.65ms, 比 10.48）。
  //
  // **n は 16000 に固定し、助けに倍にさせない（#3017）。** 以前は 8000 から始めて、t(n) が 5ms に
  // 届くまで助けが 64000 まで倍にしていた。そうすると大きいほうは 256000 回の繰り返し（約 1MB の
  // 文字列）になり、手元の実測で 64000→256000 の時間が約 6.8 倍（入力は 4 倍）、
  // CI（run 37343538584）では 3 ラウンドとも比 10.1〜10.2 で揃って落ちた。実装は線形である
  // （256000→1024000 は約 3.2 倍に戻る。2乗なら 16 倍のまま）。大きい文字列が CPU のキャッシュと
  // 若い世代の GC に収まらなくなる段差が、64000→256000 の間に在るだけである。
  // 手元の実測（5回、最小値、ms）: n=16000 は 3.4、n=64000 は 13.2 で、比は約 3.9。
  // t(16000) は約 3.4ms あり、分母は 1ms の下限の 3 倍を超える。2乗なら比は約 16 のままなので、
  // maxRatio=10 は動かさず、陰性対照（下）が 2乗を落とすことを確かめる。
  const N = 16000;
  const options = { minSmallMs: 2, maxScale: 1 } as const;
  const cases: ReadonlyArray<[string, (n: number) => string, number]> = [
    ['引用符の繰り返し', (n) => `${T} ${'"-n" '.repeat(n)}x`, N],
    ['バックスラッシュの繰り返し', (n) => `${T} ${'\\-n '.repeat(n)}x`, N],
  ];
  for (const [label, makeInput, n] of cases) {
    it(`${label}が線形に終わる`, () => {
      expectNotSuperlinear((command: string) => inspectBashCommand(command), makeInput, {
        n,
        ...options,
      });
    });
  }

  // 陰性対照（#3017）: 出発点・倍加を上のとおりに絞っても、本物の `inspectBashCommand` を入力の長さに
  // 比例する回数だけ走らせる（= 2乗にした）関数は、実時間のままで落ちる。
  it('陰性対照: 同じ設定で、2乗にした関数は落ちる', () => {
    const quadratic = (command: string): void => {
      const calls = Math.ceil(command.length / 16000);
      for (let i = 0; i < calls; i += 1) inspectBashCommand(command);
    };
    expect(() =>
      expectNotSuperlinear(quadratic, (n) => `${T} ${'\\-n '.repeat(n)}x`, { n: N, ...options }),
    ).toThrow(/2乗以上の後戻り/);
  });
});
