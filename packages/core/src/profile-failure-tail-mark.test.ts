import { describe, expect, it } from 'vitest';
import { redactProfileFailure } from './profile.js';

// #6506: 伏せてから末尾 4,000 字へ切るとき、切り口が伏せ字の印の途中に当たっても欠けた印（`REDACTED] …`）を出さない
describe('redactProfileFailure の切り口と伏せ字の印', () => {
  const LIMIT = 4_000;
  const TAIL_MARK = '…（前略）\n';
  const MARK = '[REDACTED]';
  const SECRET = 'pin-fake-tail-secret-value';
  const env = { PIN_FAKE_TAIL_TOKEN: SECRET };

  // 伏せたあとの本文で、切り口（末尾から LIMIT 字の位置）が印の先頭から `into` 字目に当たる入力を作る
  function inputCuttingMarkAt(into: number): string {
    const after = ' x'.repeat(LIMIT).slice(0, LIMIT - (MARK.length - into));
    return `${'head '.repeat(50)}${SECRET}${after}`;
  }

  it.each([1, 5, 9])('切り口が印の %i 字目に当たると、印の後ろから残す', (into) => {
    const { error } = redactProfileFailure({ error: inputCuttingMarkAt(into) }, env);
    expect(error.startsWith(TAIL_MARK)).toBe(true);
    expect(error).not.toContain('REDACTED');
    expect(error).not.toContain(SECRET);
    // 印の後ろから残すので、上限より短くなる（前へ広げて上限を超えない）
    expect(error.length).toBe(TAIL_MARK.length + LIMIT - (MARK.length - into));
  });

  it('切り口がちょうど印の先頭なら、印をそのまま残す', () => {
    const { error } = redactProfileFailure({ error: inputCuttingMarkAt(0) }, env);
    expect(error).toBe(`${TAIL_MARK}${MARK}${' x'.repeat(LIMIT).slice(0, LIMIT - MARK.length)}`);
  });

  it('切り口が印の直後なら、今までどおり末尾 4,000 字を残す', () => {
    const { error } = redactProfileFailure({ error: inputCuttingMarkAt(MARK.length) }, env);
    expect(error.length).toBe(TAIL_MARK.length + LIMIT);
    expect(error).not.toContain('REDACTED');
  });

  it('上限以内なら切らない', () => {
    const { error } = redactProfileFailure({ error: `失敗 ${SECRET}` }, env);
    expect(error).toBe(`失敗 ${MARK}`);
  });
});
