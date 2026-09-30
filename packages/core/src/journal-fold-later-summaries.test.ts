import { describe, expect, it } from 'vitest';

import { JournalFoldWindow, foldedRunText } from './journal-fold.js';

const T0 = Date.parse('2026-09-23T00:00:00.000Z');
const SIG = '[mgr-a] 枠から追い返された（five_hour）。この枠ではもう通らない。';

/** 件数の上限 3 で、途中の要約を2本と、止めるときの1本を吐かせる（起きた回数は 1 + 3 + 3 + 2 = 9）。 */
function threeSummaries(): string[] {
  const fold = new JournalFoldWindow({ maxSuppressed: 3 });
  const texts: string[] = [];
  for (let i = 0; i < 9; i += 1) {
    const verdict = fold.observe(SIG, SIG, T0 + i * 1_000);
    if (verdict.flush !== undefined) texts.push(foldedRunText(verdict.flush));
  }
  const last = fold.flush();
  if (last !== undefined) texts.push(foldedRunText(last));
  return texts;
}

describe('日誌の畳み — 途中の要約の後の要約は「1 + N」を名乗らない（#2496）', () => {
  it('⭐ 1本目は今までどおり「1回目は直前に書いてある、1 + N」', () => {
    const [first] = threeSummaries();
    expect(first).toContain('1回目はこの直前に書いてある');
    expect(first).toContain('1 + 3 ');
  });

  it('⭐ 2本目以降は「直前」「1 + N」を名乗らず、前の要約の後のさらに N 回と書く', () => {
    const [, second, third] = threeSummaries();
    expect(second).not.toContain('1回目はこの直前に書いてある');
    expect(second).not.toContain('1 + 3 ');
    expect(second).toContain('2 本目');
    expect(second).toContain('さらに 3 回');
    expect(third).not.toContain('1回目はこの直前に書いてある');
    expect(third).not.toContain('1 + 2 ');
    expect(third).toContain('3 本目');
    expect(third).toContain('さらに 2 回');
  });

  it('⭐ 通算が正しく読める（起きた回数は 1 + 3 + 3 + 2 = 9）', () => {
    const [, second, third] = threeSummaries();
    expect(second).toContain('通算は 1 + 6 回');
    expect(third).toContain('通算は 1 + 8 回');
  });

  it('連なりが閉じたら数え直す（次の連なりの1本目は今までどおり）', () => {
    const fold = new JournalFoldWindow({ maxSuppressed: 2 });
    for (let i = 0; i < 3; i += 1) fold.observe(SIG, SIG, T0 + i * 1_000);
    const other = '[mgr-b] 別の合図';
    fold.observe(other, other, T0 + 10_000);
    fold.observe(other, other, T0 + 11_000);
    const text = foldedRunText(fold.flush()!);
    expect(text).toContain('1 + 1 ');
    expect(text).toContain('1回目はこの直前に書いてある');
  });
});
