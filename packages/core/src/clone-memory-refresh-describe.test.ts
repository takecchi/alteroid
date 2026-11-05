import { describe, expect, it } from 'vitest';

import { describeMemoryIndexRefresh } from './clone-distill-memory-state.js';

describe('describeMemoryIndexRefresh — 要約後の索引の載せ直しの日誌の本文', () => {
  it('違った文書が上限を超えたら、先頭だけ並べて「ほか M 件」にする', () => {
    const slugs = Array.from({ length: 13 }, (_, i) => `doc-${String(i)}`);
    const text = describeMemoryIndexRefresh({
      slugs,
      renderedChars: 1234,
      totalDocuments: 20,
    });
    expect(text).toContain('違った文書 13 件');
    expect(text).toContain('doc-0（焼いた時点に無かった）');
    expect(text).toContain('doc-9（焼いた時点に無かった）');
    expect(text).not.toContain('doc-10');
    expect(text).toContain('ほか 3 件');
    expect(text).toContain('載せ直した文字数 1234');
    expect(text).toContain('全文書数 20');
  });
});
