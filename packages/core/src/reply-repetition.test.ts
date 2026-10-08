import { describe, expect, it } from 'vitest';

import {
  collapseRepetition,
  LINE_REPEAT_THRESHOLD,
  TOKEN_REPEAT_THRESHOLD,
} from './reply-repetition.js';

describe('返信の繰り返しの崩壊の切り詰め（#4142）', () => {
  it('court の行の連続を、最初の1回と注記1行にする', () => {
    const body = `まず確認した。\n${Array.from({ length: 40 }, () => 'court').join('\n')}\n以上。`;
    const result = collapseRepetition(body);
    expect(result.text).toBe(
      'まず確認した。\ncourt\n（以下、同じ「court」が 40 回続いたので省いた）\n以上。',
    );
    expect(result.collapsed).toEqual([{ unit: 'court', count: 40, kind: 'line' }]);
  });

  it('同じ文の行の連続（前後の空白は無視）も切り詰める。注記には先頭40字までを写す', () => {
    const sentence = 'あ'.repeat(60);
    const body = Array.from({ length: 10 }, (_, i) =>
      i % 2 === 0 ? sentence : ` ${sentence} `,
    ).join('\n');
    const result = collapseRepetition(body);
    expect(result.text.split('\n')).toHaveLength(2);
    expect(result.text).toContain(`同じ「${'あ'.repeat(40)}」が 10 回続いた`);
    expect(result.text.split('\n')[0]).toBe(sentence);
    expect(result.text.split('\n')[1]).not.toContain('あ'.repeat(41));
  });

  it('1行の中で同じ語が連続しても切り詰める（前後の本文は残す）', () => {
    const line = `前置き ${Array.from({ length: 30 }, () => 'court').join(' ')} 後ろ`;
    const result = collapseRepetition(line);
    expect(result.text).toBe('前置き court （以下、同じ「court」が 30 回続いたので省いた） 後ろ');
    expect(result.collapsed).toEqual([{ unit: 'court', count: 30, kind: 'token' }]);
  });

  it('行は閾値ちょうどで切り詰め、1つ手前では触らない', () => {
    const at = Array.from({ length: LINE_REPEAT_THRESHOLD }, () => 'court').join('\n');
    const before = Array.from({ length: LINE_REPEAT_THRESHOLD - 1 }, () => 'court').join('\n');
    expect(collapseRepetition(at).collapsed).toHaveLength(1);
    expect(collapseRepetition(before)).toEqual({ text: before, collapsed: [] });
  });

  it('語は閾値ちょうどで切り詰め、1つ手前では触らない', () => {
    const at = Array.from({ length: TOKEN_REPEAT_THRESHOLD }, () => 'ha').join(' ');
    const before = Array.from({ length: TOKEN_REPEAT_THRESHOLD - 1 }, () => 'ha').join(' ');
    expect(collapseRepetition(at).collapsed).toEqual([{ unit: 'ha', count: 16, kind: 'token' }]);
    expect(collapseRepetition(before)).toEqual({ text: before, collapsed: [] });
  });

  it('間に別の行が挟まる繰り返しは連続ではないので触らない', () => {
    const body = Array.from({ length: 20 }, (_, i) => (i % 2 === 0 ? 'court' : 'x')).join('\n');
    expect(collapseRepetition(body)).toEqual({ text: body, collapsed: [] });
  });

  it('コードブロックの中は触らない（外は切り詰める）', () => {
    const rows = Array.from({ length: 30 }, () => 'ok').join('\n');
    const body = `\`\`\`\n${rows}\n\`\`\`\n${Array.from({ length: 9 }, () => 'court').join('\n')}`;
    const result = collapseRepetition(body);
    expect(result.text.startsWith(`\`\`\`\n${rows}\n\`\`\`\n`)).toBe(true);
    expect(result.collapsed).toEqual([{ unit: 'court', count: 9, kind: 'line' }]);
  });

  it('20字を超える語の繰り返しは語としては見ない', () => {
    const long = 'a'.repeat(21);
    const body = Array.from({ length: 30 }, () => long).join(' ');
    expect(collapseRepetition(body).collapsed).toEqual([]);
  });

  it('普通の文章・空文字はそのまま', () => {
    expect(collapseRepetition('')).toEqual({ text: '', collapsed: [] });
    const prose = '了解した。\n\n\n\n次に進む。';
    expect(collapseRepetition(prose)).toEqual({ text: prose, collapsed: [] });
  });
});
