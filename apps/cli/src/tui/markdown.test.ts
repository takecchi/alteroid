import { describe, expect, it } from 'vitest';

import { renderMarkdown } from './markdown.js';

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

  it('リンクは見えている文言のまま下線・色付き（HTML は作らない）', () => {
    const [line] = renderMarkdown('[文言](https://example.com)');
    expect(line).toEqual([{ text: '文言', underline: true, tone: 'link' }]);
  });

  it('先頭・末尾の空行を落とし、連続する空行を 1 本へ畳む', () => {
    expect(flat('\n\na\n\n\n\nb\n\n')).toEqual(['a', '', 'b']);
  });

  it('生の HTML は文字のまま出す（要素として解釈しない）', () => {
    expect(flat('<script>x</script>').join('')).toContain('<script>');
  });
});
