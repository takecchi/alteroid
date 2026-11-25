import { describe, expect, it } from 'vitest';

import { PEER_CREDITS_RETRY_MS, PeerCreditsHold } from './peer-credits-hold.js';

const T0 = Date.parse('2026-11-25T07:55:00Z');
const ORIGINAL = 'Your workspace is out of credits. Add credits to continue.';

describe('PeerCreditsHold: 残高切れで閉じる状態', () => {
  it('エピソードの最初の hold だけがクローンへ知らせる（閉じ直しでは知らせない）', () => {
    const hold = new PeerCreditsHold();
    expect(hold.hold('codex', ORIGINAL, T0)).toEqual({ notify: true });
    expect(hold.hold('codex', ORIGINAL, T0 + 1000)).toEqual({ notify: false });
  });

  it('reopenDue は開き直しの時刻を過ぎたものだけ外すが、エピソードは続き、次の hold は知らせない', () => {
    const hold = new PeerCreditsHold();
    hold.hold('codex', ORIGINAL, T0);
    expect(hold.reopenDue(T0 + PEER_CREDITS_RETRY_MS - 1)).toBe(false);
    expect(hold.closed()).toHaveLength(1);
    expect(hold.reopenDue(T0 + PEER_CREDITS_RETRY_MS)).toBe(true);
    expect(hold.closed()).toEqual([]);
    expect(hold.hold('codex', ORIGINAL, T0 + PEER_CREDITS_RETRY_MS + 5)).toEqual({ notify: false });
  });

  it('nextReopenAt は閉じているものの最短の開き直しの時刻を返し、無ければ undefined', () => {
    const hold = new PeerCreditsHold();
    expect(hold.nextReopenAt()).toBeUndefined();
    hold.hold('codex', ORIGINAL, T0);
    expect(hold.nextReopenAt()).toBe(T0 + PEER_CREDITS_RETRY_MS);
    hold.reopenDue(T0 + PEER_CREDITS_RETRY_MS);
    expect(hold.nextReopenAt()).toBeUndefined();
  });

  it('succeeded でエピソードが終わり、閉じていれば外れ、次の hold はまた知らせる', () => {
    const hold = new PeerCreditsHold();
    expect(hold.succeeded('codex')).toBe(false);
    hold.hold('codex', ORIGINAL, T0);
    expect(hold.succeeded('codex')).toBe(true);
    expect(hold.closed()).toEqual([]);
    expect(hold.hold('codex', ORIGINAL, T0 + 10)).toEqual({ notify: true });
  });

  it('開き直した後に成功しても、エピソードが終わって次の hold は知らせる', () => {
    const hold = new PeerCreditsHold();
    hold.hold('codex', ORIGINAL, T0);
    hold.reopenDue(T0 + PEER_CREDITS_RETRY_MS);
    expect(hold.succeeded('codex')).toBe(true);
    expect(hold.hold('codex', ORIGINAL, T0 + PEER_CREDITS_RETRY_MS + 5)).toEqual({ notify: true });
  });

  it('reset は閉じている状態もエピソードも終え、あれば true を返す', () => {
    const hold = new PeerCreditsHold();
    expect(hold.reset()).toBe(false);
    hold.hold('codex', ORIGINAL, T0);
    expect(hold.reset()).toBe(true);
    expect(hold.closed()).toEqual([]);
    expect(hold.hold('codex', ORIGINAL, T0 + 10)).toEqual({ notify: true });
  });

  it('closed() の理由に、原文と、断られた時刻と、開き直す時刻（ISO UTC）が載る', () => {
    const hold = new PeerCreditsHold();
    hold.hold('codex', ORIGINAL, T0);
    const [entry] = hold.closed();
    expect(entry?.provider).toBe('codex');
    expect(entry?.reason).toBe(
      `残高切れで閉じている（2026-11-25T07:55:00Z に Codex が「${ORIGINAL}」で断った）。` +
        '人間が Codex のワークスペースに残高を足すまで通らない。' +
        '2026-11-25T08:25:00Z 以降に1度開き直して試す（資格を置き直しても開き直す）',
    );
  });

  it('長い原文は 200 字で切る', () => {
    const hold = new PeerCreditsHold();
    hold.hold('codex', 'x'.repeat(500), T0);
    const reason = hold.closed()[0]?.reason ?? '';
    expect(reason).toContain(`${'x'.repeat(200)}…`);
    expect(reason).not.toContain('x'.repeat(201));
  });
});
