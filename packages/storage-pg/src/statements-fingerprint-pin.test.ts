import { describe, expect, it } from 'vitest';

import { statementsFingerprint } from './migrate.js';

// 指紋は「文を NUL で繋いだ文字列の sha256（hex 全長）」。値を固定して、繋ぎ方・符号化・桁の取り違えを縛る
describe('statementsFingerprint', () => {
  it('文の一覧ごとに値が固定されている', () => {
    expect(statementsFingerprint([])).toBe(
      'e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855',
    );
    expect(statementsFingerprint(['select 1'])).toBe(
      '822ae07d4783158bc1912bb623e5107cc9002d519e1143a9c200ed6ee18b6d0f',
    );
    expect(statementsFingerprint(['a', 'b'])).toBe(
      '59b271ae1bbcb1d31d41929817f4b16fb439eb4f31520b5ad1d5ce98920a7138',
    );
    expect(statementsFingerprint(['あ', '😀'])).toBe(
      'e7a1ec1506e483c97f4a7a1932dcf6ff23c0aea82be12067543c5bee9d029013',
    );
  });

  it('文の境目をずらした別の並びは別の指紋になる', () => {
    expect(statementsFingerprint(['ab', 'c'])).not.toBe(statementsFingerprint(['a', 'bc']));
  });

  it('既定（実際の文の一覧）は 64 桁の hex', () => {
    expect(statementsFingerprint()).toMatch(/^[0-9a-f]{64}$/);
  });
});
