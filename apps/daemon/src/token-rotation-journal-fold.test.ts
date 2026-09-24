import type { TokenRotationEntry } from '@alteroid/core';
import { describe, expect, it } from 'vitest';

import {
  TOKEN_ROTATION_JOURNAL_FOLD_IDLE_GAP_MS,
  TOKEN_ROTATION_JOURNAL_FOLD_MAX_SPAN_MS,
  TokenRotationJournalFold,
  tokenRotationFoldSignature,
} from './token-rotation-journal-fold.js';
import { TOKEN_WATCH_TICK_MS } from './token-watch.js';

/**
 * `TokenRotationJournalFold`（issue #1311 段B）。
 *
 * **時計は注入する**（`journal-fold.test.ts` と同じ理由 —— 窓の境界を
 * ミリ秒単位で動かすので、偽の時計でないと境界の歯が書けない）。
 */
const T0 = Date.parse('2026-09-23T00:00:00.000Z');

/** 本番で実際に反復した本文の形（`exhausted`、いちばん早く戻る時刻が同じ）。 */
function exhaustedEntry(earliestAt: string): TokenRotationEntry {
  return {
    type: 'token_rotation',
    event: 'exhausted',
    signal: 'reached',
    tokenId: 'tok-a',
    label: '「予備」',
    earliestAt,
    text:
      `認証トークン: **回せなかった**（reached）。全部冷却中である。` +
      `いちばん早く戻るのは ${earliestAt}`,
  };
}

describe('TokenRotationJournalFold — 1件目は必ず書く（追記専用の契約）', () => {
  it('最初の観測は書く。要約は出ない', () => {
    const fold = new TokenRotationJournalFold();
    const entry = exhaustedEntry('2026-09-23T05:00:00.000Z');
    expect(fold.observe(entry, T0)).toEqual({ write: true });
  });
});

describe('TokenRotationJournalFold — 60秒 tick の同一本文を畳む（本題）', () => {
  it('⭐ 同じ本文が60秒間隔でN回来ても、日誌へ書くのは1件目だけ（write:false が続く）', () => {
    const fold = new TokenRotationJournalFold();
    const entry = exhaustedEntry('2026-09-23T05:00:00.000Z');

    expect(fold.observe(entry, T0)).toEqual({ write: true });
    // tick は60秒ごと。既定の JOURNAL_FOLD_IDLE_GAP_MS（60秒）のままだと、
    // ここで「途切れた」と誤判定されて毎回書かれてしまう
    // （token-rotation-journal-fold.ts の doc の本題）。
    for (let i = 1; i <= 10; i += 1) {
      const verdict = fold.observe(entry, T0 + i * TOKEN_WATCH_TICK_MS);
      expect(verdict).toEqual({ write: false });
    }
  });

  it('本文が変われば（例: earliestAt が動いた）必ず書く。畳んだ連なりの要約が先に出る', () => {
    const fold = new TokenRotationJournalFold();
    const entry = exhaustedEntry('2026-09-23T05:00:00.000Z');

    fold.observe(entry, T0);
    fold.observe(entry, T0 + TOKEN_WATCH_TICK_MS);
    fold.observe(entry, T0 + 2 * TOKEN_WATCH_TICK_MS);

    const changed = exhaustedEntry('2026-09-23T06:00:00.000Z');
    const verdict = fold.observe(changed, T0 + 3 * TOKEN_WATCH_TICK_MS);

    expect(verdict.write).toBe(true);
    expect(verdict.summary).toBeDefined();
    // **畳んだ連なりの構造欄（event/signal/tokenId/earliestAt 等）を引き継ぐ。**
    expect(verdict.summary?.event).toBe('exhausted');
    expect(verdict.summary?.tokenId).toBe('tok-a');
    expect(verdict.summary?.earliestAt).toBe('2026-09-23T05:00:00.000Z');
    // **畳んだ本文そのものを含む**（foldedRunText の契約）。
    expect(verdict.summary?.text).toContain('同じ合図が続いたので畳んだ');
    expect(verdict.summary?.text).toContain(entry.text);
    expect(verdict.summary?.text).toContain('2回目以降を 2 回ぶん');
  });

  it('間が idleGap 以上空いたら、同じ本文でも「途切れた」として必ず書く（間の空いた本物の再発）', () => {
    const fold = new TokenRotationJournalFold();
    const entry = exhaustedEntry('2026-09-23T05:00:00.000Z');

    fold.observe(entry, T0);
    const idleAfter = T0 + TOKEN_ROTATION_JOURNAL_FOLD_IDLE_GAP_MS;
    const verdict = fold.observe(entry, idleAfter);
    expect(verdict.write).toBe(true);
    // 直前の連なりは1件（suppressed 0件）なので、要約は出ない
    // （journal-fold.ts の snapshot: suppressed<=0 は要約を作らない）。
    expect(verdict.summary).toBeUndefined();
  });

  it('idleGap 未満ならまだ畳む（60秒 tick の2〜3回ぶんはまだ同じ連なり）', () => {
    const fold = new TokenRotationJournalFold();
    const entry = exhaustedEntry('2026-09-23T05:00:00.000Z');

    fold.observe(entry, T0);
    const justBefore = T0 + TOKEN_ROTATION_JOURNAL_FOLD_IDLE_GAP_MS - 1;
    expect(fold.observe(entry, justBefore)).toEqual({ write: false });
  });
});

describe('TokenRotationJournalFold — 件数・総経過の上限', () => {
  it('総経過の上限（60分）に達したら、そこで要約を吐いて数え直す', () => {
    const fold = new TokenRotationJournalFold({
      maxSpanMs: TOKEN_ROTATION_JOURNAL_FOLD_MAX_SPAN_MS,
    });
    const entry = exhaustedEntry('2026-09-23T05:00:00.000Z');

    fold.observe(entry, T0);
    const verdicts: ReturnType<TokenRotationJournalFold['observe']>[] = [];
    // 60秒おきに観測を続け、60分（=60回）に達したところで打ち切りが起きる
    // （境界は `atMs - spanFromMs >= maxSpanMs` なので、ちょうど60回目で
    // 発火する ── 61回まで回して、その1回を必ず含める）。
    for (let i = 1; i <= 61; i += 1) {
      verdicts.push(fold.observe(entry, T0 + i * TOKEN_WATCH_TICK_MS));
    }
    // **どこかで必ず打ち切りが起きる**（write:false かつ要約付き）。idleGap
    // （150秒）より短い60秒刻みなので、打ち切りの契機は総経過の上限だけである。
    const spanned = verdicts.filter((v) => v.summary !== undefined);
    expect(spanned).toHaveLength(1);
    expect(spanned[0]?.write).toBe(false);
  });
});

describe('TokenRotationJournalFold — 止まるときに畳み残しを吐き出す', () => {
  it('flush() は開いている連なりの要約を返す。1件しか無ければ何も返さない', () => {
    const fold = new TokenRotationJournalFold();
    const entry = exhaustedEntry('2026-09-23T05:00:00.000Z');
    fold.observe(entry, T0);
    // 1件目しか無い（suppressed 0件）ので、要約は無い ——
    // 「1件目は observe の時点で既に書かれている」ので消えるものが無い。
    expect(fold.flush()).toBeUndefined();
  });

  it('畳んだ連なりが在れば flush() で要約が出る（止まったときに失うのは畳んだ件数だけ）', () => {
    const fold = new TokenRotationJournalFold();
    const entry = exhaustedEntry('2026-09-23T05:00:00.000Z');
    fold.observe(entry, T0);
    fold.observe(entry, T0 + TOKEN_WATCH_TICK_MS);
    fold.observe(entry, T0 + 2 * TOKEN_WATCH_TICK_MS);

    const flushed = fold.flush();
    expect(flushed).toBeDefined();
    expect(flushed?.event).toBe('exhausted');
    expect(flushed?.text).toContain('2回目以降を 2 回ぶん');
  });
});

describe('TokenRotationJournalFold — 署名は event と text の完全一致', () => {
  it('event が同じでも text が1文字違えば別の連なり（畳まない）', () => {
    const fold = new TokenRotationJournalFold();
    const a = exhaustedEntry('2026-09-23T05:00:00.000Z');
    const b: TokenRotationEntry = { ...a, text: `${a.text}!` };

    expect(tokenRotationFoldSignature(a)).not.toBe(tokenRotationFoldSignature(b));
    fold.observe(a, T0);
    // 1文字違うので「署名が変わった」扱い ⟹ 必ず書く。
    expect(fold.observe(b, T0 + 1_000)).toEqual({ write: true });
  });

  it('text が同じでも event が違えば別の連なり（畳まない）', () => {
    const fold = new TokenRotationJournalFold();
    const a: TokenRotationEntry = {
      type: 'token_rotation',
      event: 'exhausted',
      text: '同じ本文',
    };
    const b: TokenRotationEntry = { ...a, event: 'not_rotated' };

    expect(tokenRotationFoldSignature(a)).not.toBe(tokenRotationFoldSignature(b));
    fold.observe(a, T0);
    expect(fold.observe(b, T0 + 1_000)).toEqual({ write: true });
  });
});
