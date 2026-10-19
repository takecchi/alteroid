import { describe, expect, it } from 'vitest';

import { renderMemoryOutline, scanMemorySections } from './memory.js';

// 「この id は複数箇所に当たる」は文書の全節で数える: offset や q で窓を切った中だけで数えると、窓の外に同じ id の節があっても印が付かず、
// 呼び手はその id で memory_section_move を撃って断られる（move は全節で一意かを見るため）

const AMBIGUOUS = '⚠この id は複数箇所に当たる';
// 先頭と末尾に、見出しも中身も同じ節（同じ id）がある文書
const DOC = '## A\nx\n## B\ny\n## C\nz\n## D\nw\n## A\nx\n';

function linesOf(outline: string, heading: string): string[] {
  return outline.split('\n').filter((line) => line.includes(`] ${heading} `));
}

describe('memory_outline の「複数箇所に当たる」印は、窓の外の節も数える', () => {
  const sections = scanMemorySections(DOC).sections;

  it('前提: 先頭と末尾の A は同じ id で、既定の出力では両方に印が付く', () => {
    const ids = sections.filter((s) => s.heading === '## A').map((s) => s.id);
    expect(ids).toHaveLength(2);
    expect(new Set(ids).size).toBe(1);
    const lines = linesOf(renderMemoryOutline(sections), '## A');
    expect(lines).toHaveLength(2);
    for (const line of lines) expect(line).toContain(AMBIGUOUS);
  });

  it('⭐ offset で先頭の A を窓の外へ出しても、末尾の A に印が付く', () => {
    const lines = linesOf(renderMemoryOutline(sections, { offset: 3 }), '## A');
    expect(lines).toHaveLength(1);
    expect(lines[0]).toContain(AMBIGUOUS);
  });

  it('⭐ q で絞って片方だけが当たっても、当たった A に印が付く', () => {
    const doc = '## A 古い\nx\n## B\ny\n## A 古い\nx\n';
    const all = scanMemorySections(doc).sections;
    expect(new Set(all.filter((s) => s.heading === '## A 古い').map((s) => s.id)).size).toBe(1);
    // offset と併用して片方だけを窓に入れる
    const lines = linesOf(renderMemoryOutline(all, { q: 'A', offset: 1 }), '## A 古い');
    expect(lines).toHaveLength(1);
    expect(lines[0]).toContain(AMBIGUOUS);
  });

  it('重複の無い節には、窓を切っても印が付かない', () => {
    const outline = renderMemoryOutline(sections, { offset: 1 });
    for (const heading of ['## B', '## C', '## D']) {
      const [line] = linesOf(outline, heading);
      expect(line).toBeDefined();
      expect(line).not.toContain(AMBIGUOUS);
    }
  });
});
