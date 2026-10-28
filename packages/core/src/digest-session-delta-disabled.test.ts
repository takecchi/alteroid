import { describe, expect, it } from 'vitest';

import { DigestSessionDelta } from './digest-session-delta.js';

// DigestSessionDelta({ disabled: true }) = ALTEROID_TOKEN_SAVING_FOLD_FIXED_TEXT が無効（既定）のときの形。
// どの口も、2回目以降も全文を返し、控えを持たない。

const PARAGRAPH = `${'同じ段落の本文。'.repeat(40)}`;
const REF = '（参照）';

function build(disabled: boolean): DigestSessionDelta {
  return new DigestSessionDelta({ disabled });
}

describe('DigestSessionDelta: 畳みを切った形', () => {
  it('⭐ fixed: 確定の後も全文（有効なら2回目は参照）', () => {
    const on = build(false);
    expect(on.fixed('a', 'FULL', REF)).toBe('FULL');
    on.commit();
    expect(on.fixed('a', 'FULL', REF)).toBe(REF);

    const off = build(true);
    expect(off.fixed('a', 'FULL', REF)).toBe('FULL');
    off.commit();
    expect(off.fixed('a', 'FULL', REF)).toBe('FULL');
  });

  it('⭐ fixedInTurn: 2回目も全文（有効なら参照）', () => {
    const on = build(false);
    on.fixedInTurn('a', 'FULL', REF);
    expect(on.fixedInTurn('a', 'FULL', REF)).toBe(REF);

    const off = build(true);
    off.fixedInTurn('a', 'FULL', REF);
    expect(off.fixedInTurn('a', 'FULL', REF)).toBe('FULL');
  });

  it('⭐ foldParagraphs: 同じ長い段落も全文（有効なら参照）', () => {
    const on = build(false);
    on.foldParagraphs(PARAGRAPH);
    on.commit();
    expect(on.foldParagraphs(PARAGRAPH)).not.toBe(PARAGRAPH);

    const off = build(true);
    off.foldParagraphs(PARAGRAPH);
    off.commit();
    expect(off.foldParagraphs(PARAGRAPH)).toBe(PARAGRAPH);
  });

  it('⭐ requestSeenAt: 同じ依頼でも null（全文を出す）', () => {
    const now = new Date();
    const on = build(false);
    expect(on.requestSeenAt('timer', 'x', now)).toBeNull();
    on.commit();
    expect(on.requestSeenAt('timer', 'x', now)).not.toBeNull();

    const off = build(true);
    expect(off.requestSeenAt('timer', 'x', now)).toBeNull();
    off.commit();
    expect(off.requestSeenAt('timer', 'x', now)).toBeNull();
  });

  it('⭐ reportShown / reportShownAt: 全文を出した控えを持たない', () => {
    const text = 'r'.repeat(2000);
    const now = new Date();
    const on = build(false);
    on.reportShown('m1', text, now);
    on.commit();
    expect(on.reportShownAt('m1', text)).not.toBeNull();

    const off = build(true);
    off.reportShown('m1', text, now);
    off.commit();
    expect(off.reportShownAt('m1', text)).toBeNull();
  });

  it('⭐ renderDigest: 同じ要約は2回目も節ごと全文', () => {
    const digest = ['## 状況', '- a', '', '## 使った分', '- b', ''].join('\n');
    const now = new Date();
    const on = build(false);
    on.renderDigest(digest, now);
    on.commit();
    expect(on.renderDigest(digest, now).text).not.toBe(digest);

    const off = build(true);
    expect(off.renderDigest(digest, now).text).toBe(digest);
    off.commit();
    const second = off.renderDigest(digest, now);
    expect(second.text).toBe(digest);
    expect(second.fullChars).toBe(digest.length);
  });

  it('foldStandingRows: 入力をそのまま返す', () => {
    const digest = '## 状況\n- a\n';
    expect(build(true).foldStandingRows(digest)).toBe(digest);
  });

  it('isLean は常に false、exportState は空の控え、importState は何も起こさない', () => {
    const off = build(true);
    expect(off.isLean()).toBe(false);
    off.fixed('a', 'FULL', REF);
    off.commit();
    const state = off.exportState();
    const on = build(false);
    on.fixed('a', 'FULL', REF);
    on.commit();
    const enabledState = on.exportState();

    const restored = build(true);
    restored.importState(enabledState);
    expect(restored.fixed('a', 'FULL', REF)).toBe('FULL');
    expect(JSON.stringify(state)).not.toBe(JSON.stringify(enabledState));
  });
});
