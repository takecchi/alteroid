import { describe, expect, it } from 'vitest';

import { findHeredocs, HEREDOC_RE, inspectBashCommand, stripHeredocs } from './bash-wait-guard.js';
import { expectNotSuperlinear } from './time-growth.test-support.js';

/**
 * issue #2115 —— ヒアドキュメントを探すのを、正規表現（`HEREDOC_RE`）から
 * `findHeredocs`（終端の行を語ごとに索引して二分探索する形）に替えた。
 *
 * **出力を1文字も変えていないこと**を、元の正規表現を託宣として突き合わせて確かめる
 * （AGENTS.md「テストを弱めずに直す」の「テスト可能にするための構造変更」と同じ条件）。
 * 託宣は、元の実装そのもの（`command.replace(HEREDOC_RE, …)`）である。
 */
function stripHeredocsByRegex(command: string): string {
  return command.replace(new RegExp(HEREDOC_RE.source, 'g'), (matched) =>
    matched.replace(/[^\n]/g, ' '),
  );
}

/** 再現できる乱数（xorshift32）。種を固定して、落ちたら同じ入力を作り直せるようにする。 */
function prng(seed: number): () => number {
  let x = seed >>> 0 || 1;
  return () => {
    x ^= x << 13;
    x >>>= 0;
    x ^= x >>> 17;
    x ^= x << 5;
    x >>>= 0;
    return x / 0x1_0000_0000;
  };
}

/** ヒアドキュメントの癖を踏みやすい部品。 */
const PIECES = [
  'cat ',
  'bash ',
  '<<',
  '<<-',
  '<< ',
  "'",
  '"',
  'EOF',
  'EOFX',
  'E',
  'EO',
  'X',
  '\n',
  '\n',
  '\n',
  ' ',
  '\t',
  ';',
  '|',
  '&',
  ')',
  'x',
  '_a',
  '1',
  'gh pr merge 1 -d',
  'echo hi',
];

function randomCommand(next: () => number): string {
  const length = 1 + Math.floor(next() * 24);
  let out = '';
  for (let i = 0; i < length; i += 1) out += PIECES[Math.floor(next() * PIECES.length)] ?? '';
  return out;
}

describe('findHeredocs / stripHeredocs —— 元の HEREDOC_RE と同じ一致（issue #2115）', () => {
  const handPicked = [
    "cat > f <<'EOF'\ngh pr merge 1 -d\nEOF",
    'cat <<EOF\nx\nEOF\necho after',
    'cat <<E\nE', // 空の本文は、元の正規表現では一致しない（癖をそのまま写す）
    'cat <<E\n\nE',
    'cat <<EOFX\nbody\nEOF\nrest', // 引用符の無い語は、短く読み直して閉じうる
    "cat <<'EOFX'\nbody\nEOF\nrest", // 引用符付きは読み直さない
    'cat <<-EOF\n\tbody\n\tEOF',
    'cat <<EOF\nno terminator',
    'cat <<A\nx\nA\ncat <<B\ny\nB',
    'cat <<A\nbash <<B\ngh\nB\nA',
    'x <<EOF\nEOF;y\nEOF',
    'cat <<EOF\nEOFX\nEOF',
    'cat << "E"\nq\nE|z',
  ];
  for (const command of handPicked) {
    it(`手で選んだ形: ${JSON.stringify(command)}`, () => {
      expect(stripHeredocs(command)).toBe(stripHeredocsByRegex(command));
    });
  }

  it('乱数で作った 20000 通りの入力で、元の正規表現と1文字も違わない', () => {
    const next = prng(20_115);
    const mismatches: string[] = [];
    for (let i = 0; i < 20_000; i += 1) {
      const command = randomCommand(next);
      if (stripHeredocs(command) !== stripHeredocsByRegex(command)) mismatches.push(command);
      if (mismatches.length >= 5) break;
    }
    expect(mismatches).toEqual([]);
  });

  it('本文の範囲は、一致の中の開始の行の後から終端の行の前まで', () => {
    const command = "bash <<'EOF'\ngh pr merge 1 -d\nEOF";
    const [span] = findHeredocs(command);
    expect(span).toBeDefined();
    if (span === undefined) throw new Error('unreachable');
    expect(command.slice(span.bodyStart, span.bodyEnd)).toBe('gh pr merge 1 -d');
    expect(command.slice(span.start, span.end)).toBe(command.slice(command.indexOf('<<')));
  });
});

/**
 * 時間の歯（issue #2187 で壁時計の絶対値から伸びの比へ替えた） —— 直す前は、
 * 終端の無いヒアドキュメントが並ぶと2乗になった（`'cat <<E\n'.repeat(8000)+'x'`
 * が 145.6ms、`'bash <<E\n'` は 420.7ms。mgr-712ad619 の実測
 * 2026-09-29T04:4xZ）。区切りの多い長い1行（`GH_WORD_SRC` の `\S*` が区切りを
 * 跨いで読んでいた）も同じ族の2乗だった（`'a;'.repeat(16000)` で 327.9ms）。
 *
 * `n * factor`（既定 factor=4）を、直す前にテストしていた繰り返し回数
 * （20000 / 40000）に揃えてある。
 */
describe('終端の無いヒアドキュメントと、区切りの多い長い1行で2乗にならない（issue #2115）', () => {
  const cases: ReadonlyArray<[string, (n: number) => string, boolean, number]> = [
    ['終端の無い cat <<E の繰り返し', (n) => `${'cat <<E\n'.repeat(n)}x`, false, 5000],
    ['終端の無い bash <<E の繰り返し', (n) => `${'bash <<E\n'.repeat(n)}x`, false, 5000],
    ['区切りの多い長い1行（gh pr merge を含まない）', (n) => `${'a;'.repeat(n)}x`, false, 10000],
    [
      '区切りの多い長い1行の末尾に gh pr merge --delete-branch',
      (n) => `${'a;'.repeat(n)}gh pr merge 1 --delete-branch`,
      true,
      10000,
    ],
  ];
  for (const [label, makeInput, blocked, n] of cases) {
    it(`${label}が予算内に終わる`, () => {
      // n * factor（既定4）の大きさで、直す前と同じ入力に対する blocked を確かめる。
      expect(inspectBashCommand(makeInput(n * 4)).blocked).toBe(blocked);
      expectNotSuperlinear((command: string) => inspectBashCommand(command), makeInput, { n });
    });
  }
});
