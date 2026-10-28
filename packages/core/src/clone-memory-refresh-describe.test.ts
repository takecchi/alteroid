import { describe, expect, it } from 'vitest';

import { describeMemoryIndexRefresh } from './clone-distill-memory-state.js';

describe('describeMemoryIndexRefresh — 要約後の索引の載せ直しの日誌の本文', () => {
  it('違った文書が上限を超えたら、先頭だけ並べて「ほか M 件」にする', () => {
    const changed = Array.from({ length: 13 }, (_, i) => `doc-${String(i)}`);
    const text = describeMemoryIndexRefresh({
      reinjected: true,
      diff: { changed, added: [], removed: [] },
      renderedChars: 1234,
      totalDocuments: 20,
    });
    expect(text).toContain('違った文書 13 件');
    expect(text).toContain('doc-0（内容が変わった）');
    expect(text).toContain('doc-9（内容が変わった）');
    expect(text).not.toContain('doc-10');
    expect(text).toContain('ほか 3 件');
    expect(text).toContain('載せ直した文字数 1234');
    expect(text).toContain('全文書数 20');
  });

  it('載せ直さなかった回は文字数 0 と全文書数だけを書く', () => {
    const text = describeMemoryIndexRefresh({
      reinjected: false,
      diff: { changed: [], added: [], removed: [] },
      renderedChars: 0,
      totalDocuments: 7,
    });
    expect(text).toContain('記憶の索引は載せ直さなかった');
    expect(text).toContain('載せ直した文字数 0');
    expect(text).toContain('全文書数 7');
  });
});
