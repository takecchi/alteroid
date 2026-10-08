import { describe, expect, it } from 'vitest';

import { findHeredocs, HEREDOC_RE, inspectBashCommand, stripHeredocs } from './bash-wait-guard.js';
import { expectNotSuperlinear } from './time-growth.test-support.js';

function stripHeredocsByRegex(command: string): string {
  return command.replace(new RegExp(HEREDOC_RE.source, 'g'), (matched) =>
    matched.replace(/[^\n]/g, ' '),
  );
}

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
    'cat <<E\nE',
    'cat <<E\n\nE',
    'cat <<EOFX\nbody\nEOF\nrest',
    "cat <<'EOFX'\nbody\nEOF\nrest",
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

describe('終端の無いヒアドキュメントと、区切りの多い長い1行で2乗にならない（issue #2115）', () => {
  const cases: ReadonlyArray<[string, (n: number) => string, boolean, number]> = [
    ['終端の無い cat <<E の繰り返し', (n) => `${'cat <<E\n'.repeat(n)}x`, false, 5000],
    ['終端の無い bash <<E の繰り返し', (n) => `${'bash <<E\n'.repeat(n)}x`, false, 5000],
    ['区切りの多い長い1行', (n) => `${'a;'.repeat(n)}x`, false, 10000],
  ];
  for (const [label, makeInput, blocked, n] of cases) {
    it(`${label}が予算内に終わる`, () => {
      expect(inspectBashCommand(makeInput(n * 4)).blocked).toBe(blocked);
      expectNotSuperlinear((command: string) => inspectBashCommand(command), makeInput, { n });
    }, 30_000);
  }
});
