import { describe, expect, it } from 'vitest';

import { matchNoticeResetAgainstPool } from './token-reset-match.js';
import { cooldownSourceSchema, type AgentToken } from './token-pool.js';

/**
 * **Issue #914 オーナー提案(2)**: 429 の文言に含まれる `resets` 時刻を、降りた
 * 鍵の `cooldownUntil`（＝権威ある値のときは `resetsAt` そのもの）と突き合わせて
 * 「世代ずれ」と名指しする。
 *
 * ## ここが固定するもの
 *
 * 1. ⭐ 降りた鍵の `cooldownUntil` と一致 ⟹ `'stale'`（世代ずれ）
 * 2. ⚠️ 陰性対照: 現役の鍵の `cooldownUntil` と一致 ⟹ `'active'`（待てば戻る。
 *    世代ずれではない）
 * 3. ⚠️ 陰性対照: どの鍵とも一致しない ⟹ `undefined`
 * 4. ⚠️ 陰性対照: 文言から時刻が読めない ⟹ `undefined`（「分からない」を
 *    症状へ倒さない）
 * 5. ⚠️ 推測（`notice_text` / `default`）の `cooldownUntil` は比べない——
 *    数値が一致していても `undefined`（偶然一致のリスク。この module の doc）
 * 6. `activeTokenId` が無ければ常に `undefined`
 */

/** 実測（#914 の 2026-09-14T20:19Z のコメント）を模した文言。9:30am (Asia/Tokyo) = 00:30Z。 */
const NOTICE_TEXT = "You've hit your session limit · resets 9:30am (Asia/Tokyo)";
/** 文言を受け取った時刻。次に来る 00:30Z は 2026-09-15T00:30:00.000Z。 */
const AT = Date.parse('2026-09-14T20:19:00.000Z');
/** 上の文言が指す絶対時刻（分の頭に揃っている）。 */
const TARGET = Date.parse('2026-09-15T00:30:00.000Z');

function tokenOf(overrides: Partial<AgentToken> & Pick<AgentToken, 'id'>): AgentToken {
  return {
    label: overrides.id,
    order: 0,
    ...overrides,
  };
}

describe('Issue #914 提案(2): 429文言のresets時刻とプールのcooldownUntilの突き合わせ', () => {
  it('⭐ 降りた鍵のcooldownUntilと一致したら「世代ずれ」(stale)と名指しする', () => {
    const dropped = tokenOf({ id: 'tok-08', cooldownUntil: TARGET, cooldownSource: 'quota_reset' });
    const active = tokenOf({ id: 'tok-09' }); // 現役は新品。cooldownUntil を持たない。
    const result = matchNoticeResetAgainstPool(NOTICE_TEXT, 'tok-09', [dropped, active], {
      at: AT,
    });
    expect(result).toBe('stale');
  });

  it('⚠️ 陰性対照: 現役のcooldownUntilと一致したら「待てば戻る」(active)——世代ずれではない', () => {
    const active = tokenOf({ id: 'tok-09', cooldownUntil: TARGET, cooldownSource: 'quota_reset' });
    const other = tokenOf({
      id: 'tok-08',
      cooldownUntil: TARGET + 60_000 * 999,
      cooldownSource: 'quota_reset',
    });
    const result = matchNoticeResetAgainstPool(NOTICE_TEXT, 'tok-09', [other, active], { at: AT });
    expect(result).toBe('active');
  });

  it('⚠️ 陰性対照: どの鍵ともcooldownUntilが一致しなければ何も名乗らない', () => {
    const dropped = tokenOf({
      id: 'tok-08',
      cooldownUntil: TARGET + 60 * 60_000,
      cooldownSource: 'quota_reset',
    });
    const active = tokenOf({ id: 'tok-09' });
    const result = matchNoticeResetAgainstPool(NOTICE_TEXT, 'tok-09', [dropped, active], {
      at: AT,
    });
    expect(result).toBeUndefined();
  });

  it('⚠️ 陰性対照: 文言から時刻が読めなければ何も名乗らない（帯が無い形）', () => {
    const dropped = tokenOf({ id: 'tok-08', cooldownUntil: TARGET, cooldownSource: 'quota_reset' });
    const active = tokenOf({ id: 'tok-09' });
    const result = matchNoticeResetAgainstPool(
      "You've hit your session limit · resets at 5pm",
      'tok-09',
      [dropped, active],
      { at: AT },
    );
    expect(result).toBeUndefined();
  });

  it('⚠️ 推測（notice_text）由来のcooldownUntilは、数値が一致していても比べない', () => {
    const dropped = tokenOf({ id: 'tok-08', cooldownUntil: TARGET, cooldownSource: 'notice_text' });
    const active = tokenOf({ id: 'tok-09' });
    const result = matchNoticeResetAgainstPool(NOTICE_TEXT, 'tok-09', [dropped, active], {
      at: AT,
    });
    expect(result).toBeUndefined();
  });

  it('⚠️ 推測（default）由来のcooldownUntilは、数値が一致していても比べない', () => {
    const active = tokenOf({ id: 'tok-09', cooldownUntil: TARGET, cooldownSource: 'default' });
    const dropped = tokenOf({ id: 'tok-08' });
    const result = matchNoticeResetAgainstPool(NOTICE_TEXT, 'tok-09', [dropped, active], {
      at: AT,
    });
    expect(result).toBeUndefined();
  });

  it('activeTokenIdが無ければ、材料が揃っていても何も名乗らない', () => {
    const dropped = tokenOf({ id: 'tok-08', cooldownUntil: TARGET, cooldownSource: 'quota_reset' });
    const result = matchNoticeResetAgainstPool(NOTICE_TEXT, undefined, [dropped], { at: AT });
    expect(result).toBeUndefined();
  });

  it('cooldownUntilが無い行（健全な鍵）は、どちらの側としても一致しない', () => {
    const active = tokenOf({ id: 'tok-09' });
    const other = tokenOf({ id: 'tok-08' });
    const result = matchNoticeResetAgainstPool(NOTICE_TEXT, 'tok-09', [active, other], { at: AT });
    expect(result).toBeUndefined();
  });

  it('分未満のずれは丸めて同一視する（文言は分までしか無いため）', () => {
    const dropped = tokenOf({
      id: 'tok-08',
      cooldownUntil: TARGET + 42_137,
      cooldownSource: 'quota_reset',
    });
    const active = tokenOf({ id: 'tok-09' });
    const result = matchNoticeResetAgainstPool(NOTICE_TEXT, 'tok-09', [dropped, active], {
      at: AT,
    });
    expect(result).toBe('stale');
  });

  it('分を跨ぐずれは一致とみなさない（丸めの幅を超えて拡張していないことの確認）', () => {
    const dropped = tokenOf({
      id: 'tok-08',
      cooldownUntil: TARGET + 60_000,
      cooldownSource: 'quota_reset',
    });
    const active = tokenOf({ id: 'tok-09' });
    const result = matchNoticeResetAgainstPool(NOTICE_TEXT, 'tok-09', [dropped, active], {
      at: AT,
    });
    expect(result).toBeUndefined();
  });

  it('canary: CooldownSourceの値集合が4つのままであること（増えたらここの分類を見直す）', () => {
    // `token-reset-match.ts` の `GUESSED_COOLDOWN_SOURCES` は
    // `'default' | 'notice_text'` を手で持っている（実行時の判定に具体の文字列が
    // 要るため）。値が増えたらこの歯が赤くなり、`hasAuthoritativeCooldown` を
    // 見直す契機になる。
    expect(cooldownSourceSchema.options).toEqual([
      'quota_reset',
      'overage_reset',
      'notice_text',
      'default',
    ]);
  });
});
