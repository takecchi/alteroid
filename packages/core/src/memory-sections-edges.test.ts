import { describe, expect, it } from 'vitest';

import { memoryBodyStart } from './memory-frontmatter.js';
import {
  MEMORY_PROMPT_OUTLINE_HEADING_WIDTH,
  scanMemorySections,
  truncateOutlineHeading,
} from './memory-sections.js';

describe('memory-frontmatter / memory-sections の境界', () => {
  it('memoryBodyStart: 閉じの --- の後ろに改行が無いとき content.length を超えない', () => {
    const content = '---\ndescription: x\n---';
    expect(memoryBodyStart(content)).toBe(content.length);
  });

  it('truncateOutlineHeading: 切れ目がサロゲートペアの途中なら1字手前で切る', () => {
    const heading = `${'a'.repeat(MEMORY_PROMPT_OUTLINE_HEADING_WIDTH - 2)}😀${'b'.repeat(10)}`;
    expect(truncateOutlineHeading(heading)).toBe(
      `${'a'.repeat(MEMORY_PROMPT_OUTLINE_HEADING_WIDTH - 2)}…`,
    );
  });

  it('scanMemorySections: 開きより短い ``` ではフェンスが閉じない', () => {
    const content = '````\n```\n# Inside\n````\n# After\n';
    expect(scanMemorySections(content).sections.map((section) => section.heading)).toEqual([
      '# After',
    ]);
  });
});
