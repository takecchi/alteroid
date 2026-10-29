import { describe, expect, it } from 'vitest';

import { memoryHeadingOf, memoryTitleOf, stripMemoryContent } from './memory-document.js';
import type { MemoryDocument } from './schema.js';

describe('memoryTitleOf / memoryHeadingOf — 本文の最初の見出しを題にする', () => {
  it('最初の `# 見出し` を題にし、前後の空白は落とす', () => {
    expect(memoryTitleOf('前置き\n#   題名  \n本文\n# 二つ目', 'slug')).toBe('題名');
  });

  it('見出しの無い本文は既定（slug）に倒れる', () => {
    expect(memoryTitleOf('見出しなし\n本文だけ', 'fallback-slug')).toBe('fallback-slug');
    expect(memoryHeadingOf('見出しなし')).toBeUndefined();
  });

  it('`#` の後に空白が無い行・2段目以降の見出しは見出しとして数えない', () => {
    expect(memoryHeadingOf('#題\n## 小見出し')).toBeUndefined();
  });
});

describe('stripMemoryContent', () => {
  it('本文を落とし、要旨の欄はそのまま写す', () => {
    const doc: MemoryDocument = {
      slug: 'a',
      title: '題',
      updatedAt: '2026-09-23T13:27:27.123Z',
      createdAt: { kind: 'unknown' },
      bytes: 3,
      frontmatter: { state: 'absent' },
      kind: 'note',
      description: 'd',
      parent: 'p',
      descriptionFreshness: { state: 'fresh' },
      content: 'abc',
    } as unknown as MemoryDocument;
    const meta = stripMemoryContent(doc);
    expect('content' in meta).toBe(false);
    expect(meta).toEqual({ ...doc, content: undefined });
  });
});
