import { describe, expect, it } from 'vitest';

import { clipLine } from './clip-line';

describe('clipLine', () => {
  it('max 字ちょうどまでは切らない（ASCII・日本語）', () => {
    expect(clipLine('', 20)).toBe('');
    expect(clipLine('x'.repeat(20), 20)).toBe('x'.repeat(20));
    expect(clipLine('あ'.repeat(20), 20)).toBe('あ'.repeat(20));
  });

  it('max+1 字からは max 字で切って「…」を付ける（ASCII・日本語）', () => {
    expect(clipLine('x'.repeat(21), 20)).toBe(`${'x'.repeat(20)}…`);
    expect(clipLine('あ'.repeat(21), 20)).toBe(`${'あ'.repeat(20)}…`);
  });

  it('改行・タブ・連続する空白を空白 1 つにつぶし、前後を削ってから数える', () => {
    expect(clipLine('  a \n\n b\t\tc  ', 20)).toBe('a b c');
    expect(clipLine(`\n${'x'.repeat(20)}\n`, 20)).toBe('x'.repeat(20));
  });

  it('空白だけの文は空文字を返す（空のときの文言は呼び元が決める）', () => {
    expect(clipLine(' \n\t ', 20)).toBe('');
  });

  it('コードポイントで数え、絵文字（サロゲートペア）の途中で切らない', () => {
    expect(clipLine('😀'.repeat(20), 20)).toBe('😀'.repeat(20));
    expect(clipLine('😀'.repeat(21), 20)).toBe(`${'😀'.repeat(20)}…`);
  });

  it('UTF-16 の slice だと割れる境目で、壊れた 1 文字を出さない', () => {
    const text = `${'あ'.repeat(19)}😀😀`;
    // 切る前の書き方（UTF-16 の slice）は、20 単位目が絵文字の前半だけになる
    const before = `${text.slice(0, 20)}…`;
    expect(before).toBe(`${'あ'.repeat(19)}\ud83d…`);
    expect(before).not.toBe(clipLine(text, 20));

    expect(clipLine(text, 20)).toBe(`${'あ'.repeat(19)}😀…`);
  });

  it('伏せてから切る: 切れ目をまたぐ秘密が素で残らない', () => {
    const token = `ghp_${'A1b2C3d4E5'.repeat(4)}`;
    const clipped = clipLine(`鍵 ${token} 以下略`, 8);
    expect(clipped).not.toContain('ghp_');
    expect(clipped).not.toContain('A1b2C3');
  });
});
