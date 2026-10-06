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
  // **助けの判定は、n, 2n, 4n, 8n の log-log の最小二乗の傾きである（#3017）。** 以前は 2 点（n と 4n）の比で判定していて、
  // 助けが入力を 64000 → 256000 まで倍にしたとき、この区間にある時間の伸びが約 6.8 倍になる段差
  // （大きい文字列が CPU のキャッシュと若い世代の GC に収まらなくなる。その前後は約 4 倍）を2点がまたぎ、
  // 線形の実装なのに CI で比 10.1〜10.2 になって落ちた（run 37343538584）。全点の傾きなら、段差は傾きを
  // 0.3〜0.4 しか押し上げない。そのため PR #3024 の固定（n=16000・maxScale: 1）は外した。
  const cases: ReadonlyArray<[string, (n: number) => string, number]> = [
    ['引用符の繰り返し', (n) => `${T} ${'"-n" '.repeat(n)}x`, 8000],
    ['バックスラッシュの繰り返し', (n) => `${T} ${'\\-n '.repeat(n)}x`, 8000],
  ];
  for (const [label, makeInput, n] of cases) {
    it(`${label}が線形に終わる`, () => {
      expectNotSuperlinear((command: string) => inspectBashCommand(command), makeInput, { n });
    });
  }

  // 陰性対照（#3713）: 確かめたいのは「検出器が超線形を捕まえる」ことで、本物の `inspectBashCommand` の
  // 速さではない。本物を入力の長さに比例する回数だけ走らせて実時間で測ると、混んだ runner では各点に乗る雑音で
  // 傾きが閾値の下へ落ち、検出器が2乗を捕まえず揺れて落ちた（PR #3665 の CI run 37522245827）。
  // そこで偽の時計を差し込み、「2乗の関数」は入力の長さ L に対して時計を (L / K) ** 2 ms だけ進めるだけにする
  // （本物は走らせない）。傾きは理論値（2。線形の対照は 1）そのものになり、実時間に左右されない。
  //
  // K は、どの点でも偽の時計の値が hardCapMs（既定 2000ms）未満に収まるように選ぶ。偽の時計の値も
  // `t >= hardCapMs` の比較には効く（vm の timeout は実時間なので割り込みは起きない）ので、超えると
  // 「hardCapMs を超えた」で投げ、傾きの経路を通らなくなる。入力は L = 4n + 4 文字ほど（n=8000 で約 32000、
  // 最大の点は 8 倍の約 256000）。K=10000 なら (L/K)**2 は最小の点で約 10ms（minSmallMs=5 を満たすので
  // n は倍にされない）、最大の点で約 655ms で、2000ms の下に収まる。
  const K = 10_000;
  const makeFakeClock = () => {
    let now = 0;
    return { now: () => now, advance: (ms: number): void => void (now += ms) };
  };
  const makeLength = (n: number): number => `${T} ${'\\-n '.repeat(n)}x`.length;

  it('陰性対照: 2乗にした関数は落ちる', () => {
    const clock = makeFakeClock();
    const run = () =>
      expectNotSuperlinear((length: number) => clock.advance((length / K) ** 2), makeLength, {
        n: 8000,
        now: clock.now,
      });
    expect(run).toThrow(/2乗以上の後戻り/);
    expect(run).not.toThrow(/hardCapMs を超えた/);
  });

  it('陰性対照の対: 線形にした関数は投げない', () => {
    const clock = makeFakeClock();
    const result = expectNotSuperlinear((length: number) => clock.advance(length / K), makeLength, {
      n: 8000,
      now: clock.now,
    });
    expect(result.slope).toBeCloseTo(1, 2);
  });
});
