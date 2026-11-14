import type { MemoryPart } from './memory.js';

// 記憶の索引（`renderMemoryDocuments`）の出力を前後で比べるための、決まった入力。蓋が効く形（カードを落とす・落とした一覧も切れる・目次が件数と文字数で切れる）を全部含める。
// 乱数・時刻を使わない: 同じ入力から毎回同じ出力が出ないと、前後の比較が成り立たないため。

function frontmatter(fields: Record<string, string | undefined>): string {
  const lines = ['---'];
  for (const [key, value] of Object.entries(fields)) {
    if (value !== undefined) lines.push(`${key}: ${value}`);
  }
  lines.push('---');
  return lines.join('\n');
}

function sections(prefix: string, count: number, headingWidth: number): string {
  return Array.from(
    { length: count },
    (_, index) => `## ${prefix}${'あ'.repeat(headingWidth)}${String(index).padStart(3, '0')}\n本文`,
  ).join('\n');
}

export function documentsMixed(): MemoryPart[] {
  return [
    {
      slug: 'values',
      content: `${frontmatter({ type: 'premise', description: '大事にしていること' })}\n# 価値観\n${sections('v', 4, 6)}`,
    },
    {
      slug: 'plain-no-frontmatter',
      content: '# 前書きだけ\n本文',
    },
    {
      slug: 'broken',
      content: '---\nunknown-key: 壊れている\n---\n# 壊れた\n本文',
    },
    {
      slug: 'index-doc',
      content: `${frontmatter({ type: 'indexed', description: '索引だけ焼く文書' })}\n# 索引\n${sections('i', 3, 5)}`,
    },
    {
      slug: 'indexed-no-description',
      content: `${frontmatter({ type: 'indexed' })}\n# 要旨なし\n本文`,
    },
    {
      slug: 'fact-root',
      title: '親',
      content: `${frontmatter({ type: 'fact', description: '親の事実' })}\n# 親\n本文`,
    },
    {
      slug: 'fact-child',
      title: '子',
      content: `${frontmatter({ type: 'fact', description: '子の事実', parent: 'fact-root' })}\n# 子\n本文`,
    },
    {
      slug: 'fact-orphan',
      title: '孤児',
      content: `${frontmatter({ type: 'fact', description: '消えた親', parent: 'nowhere' })}\n# 孤児\n本文`,
    },
    {
      slug: 'fact-no-description',
      title: '要旨なし',
      content: `${frontmatter({ type: 'fact' })}\n# 要旨なし\n本文`,
    },
  ];
}

export function documentsOverCardBudget(): MemoryPart[] {
  return Array.from({ length: 90 }, (_, index): MemoryPart => {
    const slug = `card-${String(index).padStart(3, '0')}`;
    const kind = index % 3 === 0 ? 'indexed' : 'premise';
    return {
      slug,
      content: `${frontmatter({ type: kind, description: `${'説明'.repeat(index + 1)}` })}\n# ${slug}\n${sections(slug, 30 + (index % 20), 40)}`,
    };
  });
}

export function documentsTocCutByCount(): MemoryPart[] {
  return Array.from({ length: MEMORY_TOC_FIXTURE_COUNT }, (_, index): MemoryPart => {
    const slug = `fact-${String(index).padStart(4, '0')}`;
    return {
      slug,
      title: slug,
      content: `${frontmatter({ type: 'fact', description: 'x' })}\n# ${slug}\n本文`,
    };
  });
}

export function documentsTocCutByChars(): MemoryPart[] {
  return Array.from({ length: 150 }, (_, index): MemoryPart => {
    const slug = `long-${String(index).padStart(3, '0')}`;
    return {
      slug,
      title: `題 ${slug}`,
      content: `${frontmatter({ type: 'fact', description: '長い要旨'.repeat(40) })}\n# ${slug}\n本文`,
    };
  });
}

const MEMORY_TOC_FIXTURE_COUNT = 330;

export const MEMORY_BAKE_FIXTURES = {
  mixed: documentsMixed,
  overCardBudget: documentsOverCardBudget,
  tocCutByCount: documentsTocCutByCount,
  tocCutByChars: documentsTocCutByChars,
} as const;
