import { describe, expect, it } from 'vitest';

import {
  findUnboundedCFors,
  findUntilWhileLoops,
  inspectBashCommand,
  LOOP_RE,
} from './bash-wait-guard.js';

/**
 * #2181 —— `until` / `while` の判定を、正規表現（`LOOP_RE`）から `findUntilWhileLoops`
 * （`do` / `done` の語の位置を索引して二分探索する形）に替えた。**一致を1文字も変えていない
 * こと**を、元の正規表現を託宣として突き合わせて確かめる（PR #2121 のヒアドキュメントと同じ形）。
 *
 * このファイルはヒアドキュメントで書けない（本文のループの字面が本番の版のガードに弾かれる。
 * #2130）。
 */
function loopsByRegex(command: string) {
  const re = new RegExp(LOOP_RE.source, 'g');
  const out: { keyword: string; cond: string; body: string; index: number }[] = [];
  let m: RegExpExecArray | null;
  while ((m = re.exec(command)) !== null) {
    out.push({ keyword: m[1] ?? '', cond: m[2] ?? '', body: m[3] ?? '', index: m.index });
  }
  return out;
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

const PIECES = [
  'while',
  'until',
  ' ',
  ' ',
  ';',
  '\n',
  'do',
  'done',
  'doing',
  'undone',
  'x',
  'true',
  'sleep 1',
  '/tmp/done',
  '|',
  '&',
  'while_',
  '_do',
  'do_',
  'dox',
  'echo',
  '"',
  "'",
];

function randomCommand(next: () => number): string {
  const length = 1 + Math.floor(next() * 20);
  let out = '';
  for (let i = 0; i < length; i += 1) out += PIECES[Math.floor(next() * PIECES.length)] ?? '';
  return out;
}

describe('findUntilWhileLoops —— 元の LOOP_RE と同じ一致（#2181）', () => {
  const handPicked = [
    'until false; do sleep 1; done',
    'while true; do sleep 1; done; while x; do y; done',
    'while a; do while b; do c; done; done',
    'if [ -f /tmp/done ]; then break; fi; done',
    'while x; do echo doing; echo undone; done',
    'while x; do y',
    'while x; y; done',
    'until\nfalse\ndo\nsleep 1\ndone',
    'while x;do sleep 1;done',
    'echo while; do x; done',
  ];
  for (const command of handPicked) {
    it(`手で選んだ形: ${JSON.stringify(command)}`, () => {
      expect(findUntilWhileLoops(command)).toEqual(loopsByRegex(command));
    });
  }

  it('乱数で作った 20000 通りの入力で、元の正規表現と一致する', () => {
    const next = prng(21_181);
    const mismatches: string[] = [];
    for (let i = 0; i < 20_000; i += 1) {
      const command = randomCommand(next);
      if (JSON.stringify(findUntilWhileLoops(command)) !== JSON.stringify(loopsByRegex(command))) {
        mismatches.push(command);
      }
      if (mismatches.length >= 5) break;
    }
    expect(mismatches).toEqual([]);
  });
});

describe('条件の無い C 形式の for を弾く（teto の判断、#2179 の「残す」）', () => {
  const blocked: ReadonlyArray<[string, string]> = [
    ['for ((;;))', 'for ((;;)); do sleep 5; done'],
    ['節の間に空白', 'for (( ; ; )); do sleep 5; done'],
    ['初期化と増分だけ在る', 'for ((i=0;;i++)); do sleep 5; done'],
    ['条件が 0 でない定数', 'for ((;1;)); do sleep 5; done'],
    ['{ …; } の本体', 'for ((;;)) { sleep 5; }'],
    ['複数行', 'for ((;;))\ndo\n  gh run view 1\n  sleep 30\ndone'],
    ['bash -c の中', "bash -c 'for ((;;)); do sleep 5; done'"],
  ];
  for (const [label, command] of blocked) {
    it(`${label}: 弾く`, () => {
      const verdict = inspectBashCommand(command);
      expect(verdict.blocked).toBe(true);
      if (!verdict.blocked) throw new Error('unreachable');
      expect(verdict.form).toBe('for-sleep');
      expect(verdict.reason).toContain('timeout');
    });
  }

  // 誤検知の対照（teto の指定で、必ず残す）
  const passing: ReadonlyArray<[string, string]> = [
    ['条件の有る C 形式の for', 'for ((i=0;i<5;i++)); do sleep 1; done'],
    ['条件が 0 の定数', 'for ((;0;)); do sleep 1; done'],
    ['リストを回す for', 'for i in $(seq 1 5); do sleep 1; done'],
    ['リストを回す for（列挙）', 'for f in a b c; do sleep 1; done'],
    ['本体に break が在る', 'for ((;;)); do sleep 1; if [ -f x ]; then break; fi; done'],
    ['本体にカウンタ比較が在る', 'for ((;;)); do sleep 1; ((n++)); done'],
    ['sleep の無いビジーループ', 'for ((;;)); do echo busy; done'],
    ['timeout で包まれている', 'timeout 60 bash -c "for ((;;)); do sleep 1; done"'],
    ['引用符の中の字面（echo の引数）', 'echo "for ((;;))"'],
  ];
  for (const [label, command] of passing) {
    it(`${label}: 通す`, () => {
      expect(inspectBashCommand(command).blocked).toBe(false);
    });
  }

  it('findUnboundedCFors は、条件の有る for を候補に入れない', () => {
    expect(findUnboundedCFors('for ((i=0;i<5;i++)); do sleep 1; done')).toEqual([]);
    expect(findUnboundedCFors('for ((;;)); do sleep 1; done')).toHaveLength(1);
  });
});

/**
 * 時間の歯。直す前は、閉じていない `while x; do` の繰り返しで3乗に近く遅くなった（200回で
 * 44.6ms、400回で 344.3ms、4000回で 120 秒を超えた。mgr-712ad619 の実測 2026-09-29T12:1xZ）。
 * 直した後は4000回で 7.4ms。
 */
describe('待つループの判定が、閉じていない繰り返しで後戻りで爆発しない（#2181）', () => {
  const TIME_BUDGET_MS = 200;
  const cases: ReadonlyArray<[string, string]> = [
    ['閉じていない while の繰り返し（400回。直す前は 344.3ms）', `${'while x; do '.repeat(400)}x`],
    ['閉じていない while の繰り返し（4000回）', `${'while x; do '.repeat(4000)}x`],
    ['閉じていない until の繰り返し', `${'until x; do '.repeat(4000)}x`],
    ['閉じていない C 形式の for の繰り返し', `${'for ((;;)); do '.repeat(4000)}x`],
    ['閉じていない C 形式の for（{ の本体）の繰り返し', `${'for ((;;)) { '.repeat(4000)}x`],
  ];
  for (const [label, command] of cases) {
    it(`${label}が予算内に終わる`, () => {
      const start = performance.now();
      inspectBashCommand(command);
      expect(performance.now() - start).toBeLessThan(TIME_BUDGET_MS);
    });
  }
});
