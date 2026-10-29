import type { MemoryDocument, MemoryDocumentMeta } from './schema.js';

// 欄を1つずつ写す（`{ ...doc }` にしない）: 展開すると `content` が要旨へ紛れ込み、一覧が本文ごと運ぶことになるため
export function stripMemoryContent(doc: MemoryDocument): MemoryDocumentMeta {
  return {
    slug: doc.slug,
    title: doc.title,
    updatedAt: doc.updatedAt,
    createdAt: doc.createdAt,
    bytes: doc.bytes,
    frontmatter: doc.frontmatter,
    kind: doc.kind,
    description: doc.description,
    parent: doc.parent,
    descriptionFreshness: doc.descriptionFreshness,
  };
}

// 題の取り方は fs と pg で同じ形が要る: 器ごとに題が違うと、同じ文書が一覧で別の名前になるため
export function memoryHeadingOf(content: string): string | undefined {
  for (const line of content.split('\n')) {
    const heading = /^#\s+(.+?)\s*$/.exec(line);
    if (heading?.[1]) return heading[1];
  }
  return undefined;
}

export function memoryTitleOf(content: string, fallback: string): string {
  return memoryHeadingOf(content) ?? fallback;
}
