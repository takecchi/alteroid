import { describe, expect, it } from 'vitest';

import { sectionBlock } from './section-block.js';

// 節の末尾に区切りを足す形を1本にする（#5681。superseded・quota-recovery-notice・situation が使う）
describe('sectionBlock', () => {
  it('行の後に空行・---・空行を足して改行でつなぐ', () => {
    expect(sectionBlock(['# 見出し', '本文'])).toBe('# 見出し\n本文\n\n---\n');
  });

  it('行が無くても区切りだけは付く', () => {
    expect(sectionBlock([])).toBe('\n---\n');
  });
});
