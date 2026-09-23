import { describe, expect, it } from 'vitest';

import {
  JOURNAL_FOLD_IDLE_GAP_MS,
  JOURNAL_FOLD_MAX_SPAN_MS,
  JOURNAL_FOLD_MAX_SUPPRESSED,
  JournalFoldWindow,
  foldedRunText,
} from './journal-fold.js';

/**
 * 時計は注入する（`Date.now()` を掴まない）。**窓の境界を1ミリ秒単位で
 * 動かすので、偽の時計でないと境界の歯が書けない。**
 */
const T0 = Date.parse('2026-09-23T00:00:00.000Z');

const SIG = '[mgr-a] 枠から追い返された（five_hour）。この枠ではもう通らない。';
const OTHER = '[mgr-b] 枠から追い返された（five_hour）。この枠ではもう通らない。';

describe('JournalFoldWindow — 1件目は必ず書く（追記専用の契約）', () => {
  it('最初の観測は書く。要約は出ない', () => {
    const fold = new JournalFoldWindow();
    expect(fold.observe(SIG, SIG, T0)).toEqual({ write: true });
  });

  it('⭐ 同じ署名の2件目以降は書かない —— ここが行数を減らす本体', () => {
    const fold = new JournalFoldWindow();
    fold.observe(SIG, SIG, T0);
    expect(fold.observe(SIG, SIG, T0 + 5_000)).toEqual({ write: false });
    expect(fold.observe(SIG, SIG, T0 + 10_000)).toEqual({ write: false });
  });

  it('署名が変わると、前の連なりの要約を吐いてから新しい1件目を書く', () => {
    const fold = new JournalFoldWindow();
    fold.observe(SIG, SIG, T0);
    fold.observe(SIG, SIG, T0 + 5_000);
    fold.observe(SIG, SIG, T0 + 8_000);

    const verdict = fold.observe(OTHER, OTHER, T0 + 9_000);
    expect(verdict.write).toBe(true);
    expect(verdict.flush).toEqual({
      signature: SIG,
      text: SIG,
      suppressed: 2,
      firstAt: new Date(T0 + 5_000).toISOString(),
      lastAt: new Date(T0 + 8_000).toISOString(),
    });
  });

  it('畳んでいないのに署名が変わっただけなら、要約は出ない（空の要約を書かない）', () => {
    const fold = new JournalFoldWindow();
    fold.observe(SIG, SIG, T0);
    expect(fold.observe(OTHER, OTHER, T0 + 1_000)).toEqual({ write: true });
  });
});

describe('JournalFoldWindow — 刻みは時間と件数の両方で掛ける', () => {
  it('⭐ 件数の上限に達したら、そこで要約を吐いて数え直す', () => {
    const fold = new JournalFoldWindow({ maxSuppressed: 3 });
    fold.observe(SIG, SIG, T0);
    expect(fold.observe(SIG, SIG, T0 + 1).write).toBe(false);
    expect(fold.observe(SIG, SIG, T0 + 2).flush).toBeUndefined();

    const third = fold.observe(SIG, SIG, T0 + 3);
    expect(third.write).toBe(false);
    expect(third.flush?.suppressed).toBe(3);

    // 数え直しているので、次の1件では吐かない
    expect(fold.observe(SIG, SIG, T0 + 4).flush).toBeUndefined();
  });

  it('⭐ 総経過の上限に達したら、件数が少なくても途中経過を吐く', () => {
    const fold = new JournalFoldWindow({ idleGapMs: 10_000, maxSpanMs: 1_000 });
    fold.observe(SIG, SIG, T0);
    expect(fold.observe(SIG, SIG, T0 + 100).flush).toBeUndefined();

    const spanned = fold.observe(SIG, SIG, T0 + 1_100);
    expect(spanned.write).toBe(false);
    expect(spanned.flush?.suppressed).toBe(2);
    expect(spanned.flush?.firstAt).toBe(new Date(T0 + 100).toISOString());
    expect(spanned.flush?.lastAt).toBe(new Date(T0 + 1_100).toISOString());
  });

  it('総経過で吐いた後は起点が進む（吐きっぱなしにならない）', () => {
    const fold = new JournalFoldWindow({ idleGapMs: 10_000, maxSpanMs: 1_000 });
    fold.observe(SIG, SIG, T0);
    expect(fold.observe(SIG, SIG, T0 + 1_000).flush?.suppressed).toBe(1);
    // 起点が T0+1_000 へ進んでいるので、すぐ次では吐かない
    expect(fold.observe(SIG, SIG, T0 + 1_100).flush).toBeUndefined();
  });

  it('⛔ 既定値は「落ちたときに失う量」に上限を付けている', () => {
    expect(JOURNAL_FOLD_IDLE_GAP_MS).toBe(60_000);
    expect(JOURNAL_FOLD_MAX_SPAN_MS).toBe(5 * 60_000);
    expect(JOURNAL_FOLD_MAX_SUPPRESSED).toBe(100);
  });
});

describe('JournalFoldWindow — 🔴 間の空いた本物の再発は畳まない', () => {
  it('⭐ 直前の観測から空きが十分あれば、署名が同じでも書く', () => {
    const fold = new JournalFoldWindow({ idleGapMs: 60_000 });
    expect(fold.observe(SIG, SIG, T0).write).toBe(true);
    // 8秒後の反復 ＝ 畳む
    expect(fold.observe(SIG, SIG, T0 + 8_000).write).toBe(false);
    // 10分後の再発 ＝ 別の出来事として書く
    const again = fold.observe(SIG, SIG, T0 + 600_000);
    expect(again.write).toBe(true);
    expect(again.flush?.suppressed).toBe(1);
  });

  it('⭐ 枠が「閉じ→開き→閉じ」と動いた形（同じ本文が間を空けて2度）', () => {
    // usageTransitionOf は**縁でしか発火しない**ので、日誌へ来る時点で
    // 2件とも本物の遷移である。⟹ 空きで切れていれば、2行とも残る。
    const fold = new JournalFoldWindow({ idleGapMs: 1_000 });
    expect(fold.observe(SIG, SIG, T0).write).toBe(true);
    expect(fold.observe(SIG, SIG, T0 + 5_000).write).toBe(true);
  });
});

describe('JournalFoldWindow — 止まるときに吐き出す', () => {
  it('flush() は開いている連なりを吐く', () => {
    const fold = new JournalFoldWindow();
    fold.observe(SIG, SIG, T0);
    fold.observe(SIG, SIG, T0 + 1_000);
    expect(fold.flush()?.suppressed).toBe(1);
  });

  it('畳んでいないときの flush() は何も吐かない（空の要約を書かない）', () => {
    const fold = new JournalFoldWindow();
    expect(fold.flush()).toBeUndefined();
    fold.observe(SIG, SIG, T0);
    expect(fold.flush()).toBeUndefined();
  });

  it('flush() は二度呼んでも二重に吐かない', () => {
    const fold = new JournalFoldWindow();
    fold.observe(SIG, SIG, T0);
    fold.observe(SIG, SIG, T0 + 1_000);
    expect(fold.flush()?.suppressed).toBe(1);
    expect(fold.flush()).toBeUndefined();
  });
});

describe('JournalFoldWindow — 安全側へ倒れること', () => {
  it('⭐ 2つの合図が交互に来ると、どちらも畳まれない（書く側へ倒れる）', () => {
    const fold = new JournalFoldWindow();
    for (let i = 0; i < 5; i += 1) {
      expect(fold.observe(SIG, SIG, T0 + i * 2).write).toBe(true);
      expect(fold.observe(OTHER, OTHER, T0 + i * 2 + 1).write).toBe(true);
    }
  });

  it('本文は「いちばん新しいもの」を要約に載せる', () => {
    const fold = new JournalFoldWindow();
    fold.observe(SIG, '古い本文', T0);
    fold.observe(SIG, '新しい本文', T0 + 1_000);
    expect(fold.flush()?.text).toBe('新しい本文');
  });
});

describe('foldedRunText — 要約の1行だけで読み切れること', () => {
  const run = {
    signature: SIG,
    text: SIG,
    suppressed: 161,
    firstAt: '2026-09-19T23:30:00.000Z',
    lastAt: '2026-09-20T03:30:00.000Z',
  };

  it('⭐ 畳んだ本文そのものを載せる（別の場所を探させない）', () => {
    expect(foldedRunText(run)).toContain(SIG);
  });

  it('⭐ 「1回目は直前に在る」と明記する —— 起きた回数の誤読を防ぐ', () => {
    const text = foldedRunText(run);
    expect(text).toContain('1回目はこの直前に書いてある');
    expect(text).toContain('1 + 161');
  });

  it('畳んだ件数と、最初と最後の時刻を載せる', () => {
    const text = foldedRunText(run);
    expect(text).toContain('161');
    expect(text).toContain('2026-09-19T23:30:00.000Z');
    expect(text).toContain('2026-09-20T03:30:00.000Z');
  });
});
