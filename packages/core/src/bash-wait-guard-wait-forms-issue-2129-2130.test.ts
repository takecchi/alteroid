import { describe, expect, it } from 'vitest';

import { inspectBashCommand } from './bash-wait-guard.js';
import { expectNotSuperlinear } from './time-growth.test-support.js';

/**
 * #2129（待つ形のすり抜け）と #2130（ファイルに書くだけのヒアドキュメントの誤検知）。
 *
 * 直す前（main 7dd2878）の写しに直接当てた実測では、`setsid` の3形と `tail -F` の3形が
 * すり抜け、`cat` / `tee` で書くだけのヒアドキュメントの5形が弾かれていた
 * （2026-09-29T07:1xZ、mgr-712ad619）。
 *
 * `run watch` の字面は、`['gh', 'run', 'watch'].join(' ')` で組み立てる。この
 * ファイルをヒアドキュメントで書こうとすると、本番の版のガードに #2130 の誤検知で弾かれるため
 * （この Issue の実例そのもの）。
 */
const W = ['gh', 'run', 'watch'].join(' ');

describe('待つ形のすり抜けを弾く（#2129）', () => {
  const blocked: ReadonlyArray<[string, string, string]> = [
    ['setsid（-w 無し）', `setsid ${W} 1`, 'gh-run-watch-background'],
    ['setsid -f', `setsid -f ${W} 1`, 'gh-run-watch-background'],
    ['前置き付きの setsid', `sudo setsid ${W} 1`, 'gh-run-watch-background'],
    ['tail -F', 'tail -F x', 'tail-f'],
    ['tail -qF', 'tail -qF x', 'tail-f'],
    ['tail -Fn 5', 'tail -Fn 5 x', 'tail-f'],
  ];
  for (const [label, command, form] of blocked) {
    it(`${label}: 弾く`, () => {
      const verdict = inspectBashCommand(command);
      expect(verdict.blocked).toBe(true);
      if (!verdict.blocked) throw new Error('unreachable');
      expect(verdict.form).toBe(form);
    });
  }

  // 通すのが正しい形（直しても変えない）。`timeout` で包んだ背景の run watch は、
  // `GH_RUN_WATCH_RE` の doc に「意図して開けてある逃げ道」と書かれている（#2129 の訂正）。
  const passing: ReadonlyArray<[string, string]> = [
    ['setsid -w（子の終わりを待つ）', `setsid -w ${W} 1`],
    ['setsid --wait', `setsid --wait ${W} 1`],
    ['前景の timeout 付き（拒否の文言が勧める形）', `timeout 600 ${W} 1 --exit-status`],
    ['timeout で包んだ背景（意図した逃げ道）', `timeout 600 ${W} 1 &`],
    ['tail -n', 'tail -n 100 x'],
    ['timeout で包んだ tail -f', 'timeout 60 tail -f x'],
  ];
  for (const [label, command] of passing) {
    it(`${label}: 通す`, () => {
      expect(inspectBashCommand(command).blocked).toBe(false);
    });
  }
});

describe('ファイルに書くだけのヒアドキュメントの本文では弾かない（#2130）', () => {
  const passing: ReadonlyArray<[string, string]> = [
    ['cat > f の本文の背景の run watch', `cat > f <<'EOF'\n${W} 1 &\nEOF`],
    ['cat > f の本文の tail -f', "cat > f <<'EOF'\ntail -f x\nEOF"],
    ['cat > f の本文の while … sleep', "cat > f <<'EOF'\nwhile true; do sleep 1; done\nEOF"],
    [
      'リダイレクトが後ろの cat の本文の until … sleep',
      "cat <<'EOF' > f\nuntil false; do sleep 1; done\nEOF",
    ],
    ['tee の本文', "tee f <<'EOF'\ntail -F x\nEOF"],
    // 2026-09-29T06:3xZ に本番で踏んだ形そのもの（確かめ用のスクリプトを書いて node で走らせる）
    ['書いた JS を node で走らせる', `cat > a.mjs <<'EOF'\nconst x = '${W} 1 &';\nEOF\nnode a.mjs`],
  ];
  for (const [label, command] of passing) {
    it(`${label}: 通す`, () => {
      expect(inspectBashCommand(command).blocked).toBe(false);
    });
  }

  // すり抜けを作らないための線（`stripDataHeredocsForWaitForms` の doc）。
  const blocked: ReadonlyArray<[string, string, string]> = [
    [
      'シェルに食わせるヒアドキュメント',
      "bash <<'EOF'\nuntil false; do sleep 1; done\nEOF",
      'until-sleep',
    ],
    [
      'cat の本文をシェルへパイプする',
      "cat <<'EOF' | bash\nwhile true; do sleep 1; done\nEOF",
      'while-sleep',
    ],
    [
      '書いたスクリプトを bash で走らせる',
      "cat > run.sh <<'EOF'\nwhile true; do sleep 1; done\nEOF\nbash run.sh",
      'while-sleep',
    ],
    [
      '書いたスクリプトをパスで走らせる',
      "cat > run.sh <<'EOF'\ntail -f x\nEOF\n./run.sh",
      'tail-f',
    ],
    [
      '書いたスクリプトを . で読む',
      "cat > run.sh <<'EOF'\nuntil false; do sleep 1; done\nEOF\n. run.sh",
      'until-sleep',
    ],
    ['ssh のヒアドキュメント（遠くで実行する）', "ssh h <<'EOF'\ntail -f x\nEOF", 'tail-f'],
    [
      '読み手が cat / tee でない（python）',
      "python - <<'EOF'\nwhile true; do sleep 1; done\nEOF",
      'while-sleep',
    ],
    [
      'ヒアドキュメントの外の背景の run watch',
      `cat > f <<'EOF'\nx\nEOF\n${W} 1 &`,
      'gh-run-watch-background',
    ],
    // 線の 4（`STRING_EXEC_RE`）。書いた本文を、文字列にして走らせる形。最初の版は
    // この4形をすり抜けていた（mgr-712ad619 のレビュー、2026-09-29T07:2xZ）。
    [
      '書いたスクリプトを bash -c "$(cat …)" で走らせる',
      'cat > run.sh <<\'EOF\'\nwhile true; do sleep 1; done\nEOF\nbash -c "$(cat run.sh)"',
      'while-sleep',
    ],
    [
      '書いたスクリプトを eval "$(cat …)" で走らせる',
      'cat > run.sh <<\'EOF\'\ntail -f x\nEOF\neval "$(cat run.sh)"',
      'tail-f',
    ],
    [
      '書いたスクリプトをバッククォートの置換で走らせる',
      'cat > run.sh <<\'EOF\'\nuntil false; do sleep 1; done\nEOF\nbash -c "`cat run.sh`"',
      'until-sleep',
    ],
    [
      '書いたスクリプトの背景の run watch を sh -c "$(cat …)" で走らせる',
      `cat > run.sh <<'EOF'\n${W} 1 &\nEOF\nsh -c "$(cat run.sh)"`,
      'gh-run-watch-background',
    ],
    [
      '書いたスクリプトを入力のリダイレクトでシェルに食わせる',
      "cat > run.sh <<'EOF'\nwhile true; do sleep 1; done\nEOF\nbash < run.sh",
      'while-sleep',
    ],
  ];
  for (const [label, command, form] of blocked) {
    it(`${label}: 弾く`, () => {
      const verdict = inspectBashCommand(command);
      expect(verdict.blocked).toBe(true);
      if (!verdict.blocked) throw new Error('unreachable');
      expect(verdict.form).toBe(form);
    });
  }
});

describe('#2129 / #2130 の新しい判定が、長い入力で後戻りで爆発しない', () => {
  // issue #2187 —— 壁時計の絶対値（`TIME_BUDGET_MS = 200`）から伸びの比へ
  // 替えた。`n * factor`（#3017 前の既定は factor=4、いまは 8）を、直す前にテストしていた
  // 繰り返し回数（8000 / 4000 / 8000 / 2000+8000）に揃えてある。
  const cases: ReadonlyArray<[string, (n: number) => string, number]> = [
    ['setsid のオプションの繰り返し', (n) => `setsid ${'-f '.repeat(n)}${W} 1 --x`, 2000],
    ['書くだけのヒアドキュメントの繰り返し', (n) => `${"cat > f <<'E'\nx\nE\n".repeat(n)}x`, 1000],
    ['終端の無い cat のヒアドキュメントの繰り返し', (n) => `${'cat > f <<E\n'.repeat(n)}x`, 2000],
    [
      'スクリプトを走らせる形の候補の繰り返し',
      // 直す前は「ヒアドキュメント2000回 + ./ 8000回」（比 1:4）。ヒアドキュメント側を
      // n とし、./ 側は常にその4倍にして、同じ比を保ったまま n を伸び縮みさせる。
      (n) => `${"cat > f <<'E'\nx\nE\n".repeat(n)}${'./'.repeat(n * 4)}`,
      500,
    ],
  ];
  for (const [label, makeInput, n] of cases) {
    it(`${label}が予算内に終わる`, () => {
      // factor: 16（n..16n の5点・傾き4つ）。この歯は線形でも区間の傾きが揺れ、既定の factor=8（傾き3つ）では
      // 通ったときの傾きの中央値が 3 回の実測で最大 1.30〜1.41 と閾値 1.5 に寄った（#3017。2206 と同じ扱い）。
      expectNotSuperlinear((command: string) => inspectBashCommand(command), makeInput, {
        n,
        factor: 16,
      });
    });
  }
});
