import { describe, expect, it } from 'vitest';

import { memorySectionId, renderMemoryOutline, scanMemorySections } from './memory.js';

// CRLF の文書でも、見出しの表示値に `\r` を残さない: 残すと outline の「— N 文字」が端末で行頭へ戻って見出しを上書きする。
// 節 id は今までどおり行そのもの（`\r` 込み）で計算する: 変えると、保存済みの CRLF の文書の節 id がすべて変わるため

const CRLF_DOC = '## A\r\nbody\r\n## B\r\nx\r\n';

describe('CRLF の文書の見出し', () => {
  it('⭐ 見出しの表示値に `\\r` が残らない', () => {
    const headings = scanMemorySections(CRLF_DOC).sections.map((section) => section.heading);

    expect(headings).toEqual(['## A', '## B']);
  });

  it('⭐ outline の行に `\\r` が混ざらない', () => {
    const outline = renderMemoryOutline(scanMemorySections(CRLF_DOC).sections);

    expect(outline).not.toContain('\r');
    expect(outline).toContain('] ## A — ');
  });

  it('節 id は今までどおり、行そのもの（`\\r` 込み）の見出しと本文で計算する', () => {
    const [first] = scanMemorySections(CRLF_DOC).sections;

    expect(first?.id).toBe(memorySectionId('## A\r', 'body\r\n'));
  });

  it('LF の文書は何も変わらない', () => {
    const [first] = scanMemorySections('## A\nbody\n## B\nx\n').sections;

    expect(first?.heading).toBe('## A');
    expect(first?.id).toBe(memorySectionId('## A', 'body\n'));
  });
});
