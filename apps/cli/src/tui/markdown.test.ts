import { describe, expect, it } from 'vitest';

import { renderMarkdown } from './markdown.js';
import { wrapRichLine } from './wrap.js';

const flat = (text: string): string[] =>
  renderMarkdown(text).map((line) => line.map((s) => s.text).join(''));

describe('renderMarkdown（marked の lexer → 意味ロール付き span）', () => {
  it('見出しと強調に意味ロール・装飾が付く', () => {
    const [heading, blank, para] = renderMarkdown('# 題\n\n**太字**と`code`');
    expect(heading).toEqual([{ text: '題', bold: true, tone: 'heading' }]);
    expect(blank).toEqual([]);
    expect(para).toEqual([
      { text: '太字', bold: true },
      { text: 'と' },
      { text: 'code', tone: 'code' },
    ]);
  });

  it('箇条書き・番号付き・引用・コードブロック・表を端末向けの行にする', () => {
    expect(flat('- a\n- b')).toEqual(['• a', '• b']);
    expect(flat('3. x\n4. y')).toEqual(['3. x', '4. y']);
    expect(flat('> 引用')).toEqual(['│ 引用']);
    expect(flat('```\nfoo\nbar\n```')).toEqual(['foo', 'bar']);
    expect(flat('| a | b |\n|---|---|\n| 1 | 2 |')).toEqual(['a │ b', '1 │ 2']);
  });

  it('リンクは文言のあとに URL を添え、下線・色付き（HTML は作らない）', () => {
    const [line] = renderMarkdown('[文言](https://example.com)');
    expect(line).toEqual([
      { text: '文言', underline: true, tone: 'link' },
      { text: '（', tone: 'marker' },
      { text: 'https://example.com', underline: true, tone: 'link' },
      { text: '）', tone: 'marker' },
    ]);
    expect(flat('[ここ](https://example.com/x)を見る')).toEqual([
      'ここ（https://example.com/x）を見る',
    ]);
  });

  it('文言が URL そのもののリンクは、URL を二重にしない（#4047）', () => {
    expect(flat('<https://example.com>')).toEqual(['https://example.com']);
    expect(flat('https://example.com')).toEqual(['https://example.com']);
    expect(flat('[https://example.com](https://example.com)')).toEqual(['https://example.com']);
    expect(flat('<a@example.com>')).toEqual(['a@example.com']);
  });

  it('URL が空のリンクは文言だけ', () => {
    expect(flat('[文言]()')).toEqual(['文言']);
  });

  it('リンクの文言・URL に入った方向制御の文字と制御文字は、端末へ出す前に除く', () => {
    const bidi = String.fromCodePoint(0x202e, 0x2066, 0x2069);
    expect(flat(`[a${bidi}b](https://example.com/${bidi}p${bidi})`)).toEqual([
      'ab（https://example.com/p）',
    ]);
    const esc = String.fromCodePoint(0x1b);
    const bel = String.fromCodePoint(0x07);
    for (const line of flat(`[a](https://example.com/${esc}[31mp${bel}q)`)) {
      expect(line).not.toContain(esc);
      expect(line).not.toContain(bel);
    }
  });

  it('リンクの長い URL は折り返しても 1 文字も欠けない', () => {
    const url = `https://example.com/${'a'.repeat(50)}`;
    const [line] = renderMarkdown(`[文言](${url})`);
    const rows = wrapRichLine(line ?? [], 20).map((r) => r.map((s) => s.text).join(''));
    expect(rows.join('')).toBe(`文言（${url}）`);
  });

  it('先頭・末尾の空行を落とし、連続する空行を 1 本へ畳む', () => {
    expect(flat('\n\na\n\n\n\nb\n\n')).toEqual(['a', '', 'b']);
  });

  it('生の HTML は文字のまま出す（要素として解釈しない）', () => {
    expect(flat('<script>x</script>').join('')).toContain('<script>');
  });
});
