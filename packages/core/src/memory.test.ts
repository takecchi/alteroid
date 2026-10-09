import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';

import { describe, expect, it } from 'vitest';

import {
  MEMORY_LISTING_BUDGET,
  MEMORY_PREMISE_RANKING_BUDGET,
  MEMORY_PREMISE_CARD_BUDGET,
  MEMORY_PROMPT_DESCRIPTION_BUDGET,
  MEMORY_PROMPT_INDEXED_DESCRIPTION_BUDGET,
  MEMORY_TIDY_TARGETS_BUDGET,
  describeMemoryTidyTargets,
  MEMORY_PROMPT_OUTLINE_BUDGET,
  MEMORY_PROMPT_OMITTED_TAIL_BUDGET,
  MEMORY_TOC_CHAR_BUDGET,
  MEMORY_TOC_ENTRY_LIMIT,
  MEMORY_TOC_LINE_LIMIT,
  applyMemoryFrontmatterPatch,
  assertNeverMemoryCreatedAt,
  assertNeverMemoryDescriptionDrift,
  assertNeverMemoryDescriptionFreshness,
  assertNeverMemoryFrontmatterState,
  assertNeverMemoryProtectionStatus,
  containsMemoryFrontmatterLineBreak,
  cutMemorySections,
  deriveHumanTouchedAtFromJournal,
  deriveMemoryCreatedAtFromJournal,
  deriveMemoryFrontmatter,
  MEMORY_JOURNAL_SCAN_PAGE_SIZE,
  MEMORY_SECTION_MOVE_HIERARCHY_JUMP_LIST_BUDGET,
  describeMemoryFloor,
  describeMemoryPremiseRanking,
  describeMemoryProtectionStatus,
  describeMemoryReinjectionEstimate,
  describeMemorySectionMoveHierarchyJumpWarning,
  describeMemorySessionDelta,
  describeMemoryWriteDiff,
  findMemoryFrontmatterLineBreak,
  findMemorySectionHierarchyJumps,
  findOverlappingMemorySections,
  isKnownMemoryDocKind,
  lookupMemorySection,
  measureMemoryFloor,
  measurePremiseOutlineFit,
  memoryBodyStart,
  memoryProtectionAllowsFullReplace,
  memorySectionId,
  nextDescribedState,
  parseMemoryFrontmatter,
  renderMemoryDocument,
  renderMemoryDocuments,
  renderMemoryListing,
  renderMemoryOutline,
  resolveMemoryDescriptionFreshness,
  resolveMemoryDocKind,
  scanMemorySections,
  type MemoryPart,
  type MemorySection,
  type MemoryTocIssue,
} from './memory.js';
import type { JournalEntry, MemoryDescriptionFreshness, MemoryProtectionStatus } from './schema.js';
import { listPageByOverfetch } from './journal-page.js';
import { JournalAnchorNotFoundError } from './store.js';
import type { JournalQuery, JournalStore } from './store.js';

describe('記憶の載せ方', () => {
  it('人間が開くファイル名と同じ見出しを付ける', () => {
    expect(renderMemoryDocument({ slug: 'values', content: '# 価値観\n\nあ' })).toBe(
      '<!-- memory: values.md -->\n# 価値観\n\nあ',
    );
  });

  it('末尾の空白だけを落とす（先頭と本文には触らない）', () => {
    const rendered = renderMemoryDocument({ slug: 'a', content: '\n  先頭は残す\n\n\n' });

    expect(rendered).toBe('<!-- memory: a.md -->\n\n  先頭は残す');
    expect(rendered.endsWith('先頭は残す')).toBe(true);
  });

  it('文書のあいだは空行1つで、渡された順序のまま並ぶ', () => {
    const rendered = renderMemoryDocuments([
      { slug: 'b', content: '# に\n' },
      { slug: 'a', content: '# い\n' },
    ]);
    const heads = rendered.split('\n\n').map((block) => block.split('\n')[0]);

    expect(heads[0]?.startsWith('<!-- memory: b.md（premise')).toBe(true);
    expect(heads[1]?.startsWith('<!-- memory: a.md（premise')).toBe(true);
    expect(rendered.split('\n\n').length).toBe(2);
    expect(rendered).not.toContain('\n\n\n');
  });

  it('記憶が1つも無ければ空文字（「空」を言うのは呼び手の仕事である）', () => {
    expect(renderMemoryDocuments([])).toBe('');
  });
});

describe('MemoryProtectionStatus の網羅性', () => {
  const ALL_STATUSES: MemoryProtectionStatus[] = [
    { kind: 'human' },
    { kind: 'clone-only' },
    { kind: 'unknown' },
  ];

  it('3状態それぞれで判定・描画が例外を投げずに返る', () => {
    for (const status of ALL_STATUSES) {
      expect(() => memoryProtectionAllowsFullReplace(status)).not.toThrow();
      expect(() => describeMemoryProtectionStatus(status)).not.toThrow();
    }
  });

  it('human / unknown は distill からの全文置換を許さず、clone-only だけ許す', () => {
    expect(memoryProtectionAllowsFullReplace({ kind: 'human' })).toBe(false);
    expect(memoryProtectionAllowsFullReplace({ kind: 'unknown' })).toBe(false);
    expect(memoryProtectionAllowsFullReplace({ kind: 'clone-only' })).toBe(true);
  });

  it('3状態それぞれが異なる一言を返す（unknown を human や clone-only に読み替えない）', () => {
    const labels = new Set(ALL_STATUSES.map((status) => describeMemoryProtectionStatus(status)));
    expect(labels.size).toBe(3);
  });

  it('未知の状態（型では弾かれるはずの値）が来たら、黙って倒れず例外を投げる', () => {
    const unknownVariant = { kind: 'new-kind' } as unknown as MemoryProtectionStatus;

    expect(() => memoryProtectionAllowsFullReplace(unknownVariant)).toThrow();
    expect(() => describeMemoryProtectionStatus(unknownVariant)).toThrow();
  });

  it('assertNeverMemoryProtectionStatus 自体も、渡されたものを含めて例外を投げる', () => {
    const bogus = { kind: 'bogus' } as never;
    expect(() => assertNeverMemoryProtectionStatus(bogus)).toThrow(/bogus/);
  });
});

function fakeJournal(entries: JournalEntry[]): Pick<JournalStore, 'list' | 'listPage'> {
  const journal: Pick<JournalStore, 'list' | 'listPage'> = {
    async listPage(query: JournalQuery = {}) {
      return listPageByOverfetch(journal, query);
    },
    async list(query: JournalQuery = {}): Promise<JournalEntry[]> {
      let pool = entries;
      if (query.types !== undefined) {
        const types = query.types;
        pool = pool.filter((entry) => types.includes(entry.type));
      }
      const ordered = query.order === 'asc' ? [...pool].reverse() : [...pool];
      let windowed = ordered;
      if (query.after !== undefined) {
        const anchor = query.after;
        const idx = ordered.findIndex((entry) => entry.id === anchor.id && entry.at === anchor.at);
        if (idx === -1) {
          throw new JournalAnchorNotFoundError(
            `fakeJournal: after で指定された行（id=${anchor.id}, at=${anchor.at}）が見つからない`,
          );
        }
        windowed = ordered.slice(idx + 1);
      }
      return query.limit === undefined ? windowed : windowed.slice(0, query.limit);
    },
  };
  return journal;
}

function memoryUpdateEntry(
  slug: string,
  at: string,
  action: 'write' | 'append' | 'remove' | undefined,
  options: { cause?: 'human' | 'clone'; id?: string } = {},
): JournalEntry {
  return {
    type: 'memory_update',
    id: options.id ?? `id-${slug}-${at}`,
    at,
    slug,
    cause: options.cause ?? 'clone',
    action,
    summary: 'テスト用',
  } as JournalEntry;
}

describe('MemoryCreatedAt の網羅性', () => {
  it('assertNeverMemoryCreatedAt は未知の状態を投げる', () => {
    const bogus = { kind: 'bogus' } as never;
    expect(() => assertNeverMemoryCreatedAt(bogus)).toThrow(/bogus/);
  });
});

describe('deriveMemoryCreatedAtFromJournal — 日誌から createdAt の根拠を導出する', () => {
  it('その slug の最初の write の at が採られる（新しいほうが採られないこと）', async () => {
    const journal = fakeJournal([
      memoryUpdateEntry('notes', '2026-03-01T00:00:00.000Z', 'write'),
      memoryUpdateEntry('notes', '2026-02-01T00:00:00.000Z', 'append'),
      memoryUpdateEntry('notes', '2026-01-01T00:00:00.000Z', 'write'),
    ]);

    const result = await deriveMemoryCreatedAtFromJournal(journal);

    expect(result.get('notes')).toBe('2026-01-01T00:00:00.000Z');
  });

  it('action:write が無い slug は結果に含まれない（根拠が無い＝unknown の元）', async () => {
    const journal = fakeJournal([
      memoryUpdateEntry('appended-only', '2026-01-01T00:00:00.000Z', 'append'),
      memoryUpdateEntry('removed-only', '2026-01-01T00:00:00.000Z', 'remove'),
      memoryUpdateEntry('legacy', '2026-01-01T00:00:00.000Z', undefined),
    ]);

    const result = await deriveMemoryCreatedAtFromJournal(journal);

    expect(result.has('appended-only')).toBe(false);
    expect(result.has('removed-only')).toBe(false);
    expect(result.has('legacy')).toBe(false);
    expect(result.size).toBe(0);
  });

  it('日誌が空なら空の Map（根拠ゼロ件）', async () => {
    const result = await deriveMemoryCreatedAtFromJournal(fakeJournal([]));

    expect(result.size).toBe(0);
  });

  it('複数の slug を同時に扱える', async () => {
    const journal = fakeJournal([
      memoryUpdateEntry('b', '2026-02-01T00:00:00.000Z', 'write'),
      memoryUpdateEntry('a', '2026-01-15T00:00:00.000Z', 'write'),
      memoryUpdateEntry('b', '2026-01-01T00:00:00.000Z', 'write'),
    ]);

    const result = await deriveMemoryCreatedAtFromJournal(journal);

    expect(result.get('a')).toBe('2026-01-15T00:00:00.000Z');
    expect(result.get('b')).toBe('2026-01-01T00:00:00.000Z');
  });
});

describe('deriveHumanTouchedAtFromJournal — 日誌から human guard の根拠を導出する', () => {
  it('その slug の最後（最新）の human 書き込みの at が採られる', async () => {
    const journal = fakeJournal([
      memoryUpdateEntry('notes', '2026-03-01T00:00:00.000Z', 'write', { cause: 'human' }),
      memoryUpdateEntry('notes', '2026-02-01T00:00:00.000Z', 'write', { cause: 'human' }),
      memoryUpdateEntry('notes', '2026-01-01T00:00:00.000Z', 'write', { cause: 'human' }),
    ]);

    const result = await deriveHumanTouchedAtFromJournal(journal);

    expect(result.get('notes')).toBe('2026-03-01T00:00:00.000Z');
  });

  it('cause:clone は対象外', async () => {
    const journal = fakeJournal([
      memoryUpdateEntry('notes', '2026-01-01T00:00:00.000Z', 'write', { cause: 'clone' }),
    ]);

    const result = await deriveHumanTouchedAtFromJournal(journal);

    expect(result.has('notes')).toBe(false);
  });

  it('action:remove は human でも対象外（削除は将来の保護理由にならない）', async () => {
    const journal = fakeJournal([
      memoryUpdateEntry('notes', '2026-01-01T00:00:00.000Z', 'remove', { cause: 'human' }),
    ]);

    const result = await deriveHumanTouchedAtFromJournal(journal);

    expect(result.has('notes')).toBe(false);
  });

  it('日誌が空なら空の Map', async () => {
    const result = await deriveHumanTouchedAtFromJournal(fakeJournal([]));

    expect(result.size).toBe(0);
  });
});

describe('ページング（Issue #1283）— pageSize を変えても導出結果が変わらない', () => {
  const PAGE_SIZE = 3;

  function manyWriteEntries(count: number): JournalEntry[] {
    const entries: JournalEntry[] = [];
    for (let i = 0; i < count; i += 1) {
      const at = new Date(Date.UTC(2026, 0, 1) + i * 60_000).toISOString();
      entries.push(memoryUpdateEntry(`slug-${i}`, at, 'write', { id: `id-${i}` }));
    }
    return entries.reverse();
  }

  it.each([0, 1, PAGE_SIZE, PAGE_SIZE + 1])(
    '件数=%i: deriveMemoryCreatedAtFromJournal が既定ページサイズと同じ値を返す',
    async (count) => {
      const entries = manyWriteEntries(count);
      const journal = fakeJournal(entries);

      const paged = await deriveMemoryCreatedAtFromJournal(journal, { pageSize: PAGE_SIZE });
      const unpaged = await deriveMemoryCreatedAtFromJournal(journal, {
        pageSize: Math.max(count, 1) + 1000,
      });

      expect(paged.size).toBe(count);
      expect([...paged.entries()]).toEqual([...unpaged.entries()]);
    },
  );

  it.each([0, 1, PAGE_SIZE, PAGE_SIZE + 1])(
    '件数=%i: deriveHumanTouchedAtFromJournal が既定ページサイズと同じ値を返す',
    async (count) => {
      const entries: JournalEntry[] = [];
      for (let i = 0; i < count; i += 1) {
        const at = new Date(Date.UTC(2026, 0, 1) + i * 60_000).toISOString();
        entries.push(
          memoryUpdateEntry(`slug-${i}`, at, 'write', { cause: 'human', id: `id-${i}` }),
        );
      }
      entries.reverse();
      const journal = fakeJournal(entries);

      const paged = await deriveHumanTouchedAtFromJournal(journal, { pageSize: PAGE_SIZE });
      const unpaged = await deriveHumanTouchedAtFromJournal(journal, {
        pageSize: Math.max(count, 1) + 1000,
      });

      expect(paged.size).toBe(count);
      expect([...paged.entries()]).toEqual([...unpaged.entries()]);
    },
  );

  it('壊れた行を捨てて短くなったページを終端と読まず、先の行まで読む（Issue #2494）', async () => {
    const entries: JournalEntry[] = [];
    for (let i = 0; i < 6; i += 1) {
      const at = new Date(Date.UTC(2026, 0, 1) + i * 60_000).toISOString();
      entries.push(memoryUpdateEntry(`slug-${i}`, at, 'write', { cause: 'human', id: `id-${i}` }));
    }
    entries.reverse();
    const inner = fakeJournal(entries);
    const dropping: Pick<JournalStore, 'listPage'> = {
      listPage: async (query) => {
        const page = await inner.listPage(query);
        return { entries: page.entries.filter((e) => e.id !== 'id-1'), next: page.next };
      },
    };

    const created = await deriveMemoryCreatedAtFromJournal(dropping, { pageSize: PAGE_SIZE });
    const touched = await deriveHumanTouchedAtFromJournal(dropping, { pageSize: PAGE_SIZE });

    expect([...created.keys()].sort()).toEqual(
      ['slug-0', 'slug-2', 'slug-3', 'slug-4', 'slug-5'].sort(),
    );
    expect(touched.size).toBe(5);
  });

  it('ページが丸ごと壊れていても、その先の行まで読む（Issue #2605）', async () => {
    const entries: JournalEntry[] = [];
    for (let i = 0; i < 9; i += 1) {
      const at = new Date(Date.UTC(2026, 0, 1) + i * 60_000).toISOString();
      entries.push(memoryUpdateEntry(`slug-${i}`, at, 'write', { cause: 'human', id: `id-${i}` }));
    }
    entries.reverse();
    const inner = fakeJournal(entries);
    const broken = new Set(['id-3', 'id-4', 'id-5']);
    const dropping: Pick<JournalStore, 'listPage'> = {
      listPage: async (query) => {
        const page = await inner.listPage(query);
        return { entries: page.entries.filter((e) => !broken.has(e.id)), next: page.next };
      },
    };

    const created = await deriveMemoryCreatedAtFromJournal(dropping, { pageSize: PAGE_SIZE });
    expect([...created.keys()].sort()).toEqual(
      ['slug-0', 'slug-1', 'slug-2', 'slug-6', 'slug-7', 'slug-8'].sort(),
    );
  });

  it('既定の pageSize（MEMORY_JOURNAL_SCAN_PAGE_SIZE）を省略しても動く（境界の桁だけ確認）', async () => {
    expect(MEMORY_JOURNAL_SCAN_PAGE_SIZE).toBeGreaterThan(0);
    const result = await deriveMemoryCreatedAtFromJournal(
      fakeJournal([memoryUpdateEntry('notes', '2026-01-01T00:00:00.000Z', 'write')]),
    );
    expect(result.get('notes')).toBe('2026-01-01T00:00:00.000Z');
  });
});

function fact(
  slug: string,
  options: {
    title?: string;
    description?: string;
    type?: string;
    parent?: string;
    freshness?: MemoryDescriptionFreshness;
    extraFrontmatter?: string;
  } = {},
): MemoryPart {
  const title = options.title ?? slug;
  const type = options.type ?? 'fact';
  const lines = ['---'];
  if (options.description !== undefined) lines.push(`description: ${options.description}`);
  lines.push(`type: ${type}`);
  if (options.parent !== undefined) lines.push(`parent: ${options.parent}`);
  if (options.extraFrontmatter !== undefined) lines.push(options.extraFrontmatter);
  lines.push('---');
  lines.push(`# ${title}`);
  lines.push('本文の詳細（目次からは開けない）');
  return {
    slug,
    title,
    content: lines.join('\n'),
    descriptionFreshness: options.freshness ?? { kind: 'unknown' },
  };
}

function premise(slug: string, body = '本文'): MemoryPart {
  return { slug, content: `# ${slug}\n${body}` };
}

function manySectionPremise(slug: string, n: number, headingLength = 40): MemoryPart {
  const heading = (i: number) => `${'あ'.repeat(headingLength)}${String(i).padStart(4, '0')}`;
  const body = Array.from({ length: n }, (_, i) => `# ${heading(i)}\n本文`).join('\n');
  return { slug, content: body };
}

describe('frontmatter の解釈（parseMemoryFrontmatter）— 3状態、畳まない', () => {
  it('先頭が `---` でなければ none', () => {
    expect(parseMemoryFrontmatter('# 価値観\n\n本文')).toEqual({ kind: 'none' });
    expect(parseMemoryFrontmatter('')).toEqual({ kind: 'none' });
  });

  it('閉じの `---` が無ければ malformed', () => {
    expect(parseMemoryFrontmatter('---\ndescription: x\n# 見出し')).toEqual({
      kind: 'malformed',
    });
  });

  it('未知のキーがあれば malformed', () => {
    expect(parseMemoryFrontmatter('---\nauthor: someone\n---\n# T')).toEqual({
      kind: 'malformed',
    });
  });

  it('`key: value` の形から外れた行（コロンが無い）があれば malformed', () => {
    expect(parseMemoryFrontmatter('---\njust text\n---\n# T')).toEqual({ kind: 'malformed' });
  });

  it('既知のキー（description / type / parent）だけなら parsed。値は文字列のまま', () => {
    expect(
      parseMemoryFrontmatter('---\ndescription: 要旨\ntype: fact\nparent: p\n---\n# T\n本文'),
    ).toEqual({ kind: 'parsed', description: '要旨', type: 'fact', parent: 'p' });
  });

  it('値は型推論しない（`type: no` は文字列 "no" のまま。false にしない）', () => {
    const parsed = parseMemoryFrontmatter('---\ntype: no\n---\n# T');
    expect(parsed).toEqual({ kind: 'parsed', type: 'no' });
  });

  it('一部のキーだけでも parsed になる（description のみ、type のみ）', () => {
    expect(parseMemoryFrontmatter('---\ndescription: 要旨だけ\n---\n# T')).toEqual({
      kind: 'parsed',
      description: '要旨だけ',
    });
  });
});

describe('applyMemoryFrontmatterPatch — frontmatter のキーだけを差し替える。本文には触れない', () => {
  const longBody = [
    '# 価値観',
    '',
    '## 判断の基準',
    '',
    '本文1行目。',
    '本文2行目。',
    '',
    '## 好み',
    '',
    '- 箇条書き1',
    '- 箇条書き2',
    '',
    '### 細目',
    '',
    '最後の段落。複数行の\n本文が続く。',
  ].join('\n');

  it('frontmatter が無い（none）文書には、先頭に新しく作って足す。本文は無傷', () => {
    const next = applyMemoryFrontmatterPatch(longBody, { description: '新しい要旨' });
    expect(next).toBe(`---\ndescription: 新しい要旨\n---\n${longBody}`);
    expect(next.endsWith(longBody)).toBe(true);
  });

  it('type を渡さなければ、none の文書は premise のまま（載り方は変わらない）', () => {
    const next = applyMemoryFrontmatterPatch(longBody, { description: '要旨' });
    expect(resolveMemoryDocKind(parseMemoryFrontmatter(next))).toBe('premise');
  });

  it('parsed の文書は、渡したキーだけを差し替え、渡さなかったキーは既存のまま残す', () => {
    const original = `---\ndescription: 古い要旨\ntype: fact\nparent: root\n---\n${longBody}`;
    const next = applyMemoryFrontmatterPatch(original, { description: '新しい要旨' });
    expect(parseMemoryFrontmatter(next)).toEqual({
      kind: 'parsed',
      description: '新しい要旨',
      type: 'fact',
      parent: 'root',
    });
  });

  it('本文は1バイトも変わらない（見出しを複数持つ長い本文で確かめる）', () => {
    const original = `---\ndescription: 古い要旨\ntype: premise\n---\n${longBody}`;
    const next = applyMemoryFrontmatterPatch(original, { type: 'fact' });
    const body = next.split('\n').slice(4).join('\n');
    expect(body).toBe(longBody);
  });

  it('3キー全部を同時に差し替えられる', () => {
    const original = `---\ndescription: 古\ntype: premise\nparent: old-parent\n---\n${longBody}`;
    const next = applyMemoryFrontmatterPatch(original, {
      description: '新',
      type: 'fact',
      parent: 'new-parent',
    });
    expect(parseMemoryFrontmatter(next)).toEqual({
      kind: 'parsed',
      description: '新',
      type: 'fact',
      parent: 'new-parent',
    });
  });

  it('malformed には例外を投げる（呼び手が先に断ること）', () => {
    const malformed = '---\nno colon here\n---\n本文';
    expect(parseMemoryFrontmatter(malformed)).toEqual({ kind: 'malformed' });
    expect(() => applyMemoryFrontmatterPatch(malformed, { description: 'x' })).toThrow();
  });

  describe('本文が空（frontmatter だけの文書）— 閉じの --- の後ろの改行は元のまま', () => {
    it('元が末尾に改行を持つなら、閉じの --- の後ろの改行が残る（1バイトも減らない）', () => {
      const original = '---\ndescription: 旧\n---\n';
      const next = applyMemoryFrontmatterPatch(original, { description: '新' });
      expect(next).toBe('---\ndescription: 新\n---\n');
      expect(next.endsWith('---\n')).toBe(true);
      expect(next.length).toBe(original.length);
    });

    it('元が末尾に改行を持たないなら、改行を足さない（1バイトも増えない）', () => {
      const original = '---\ndescription: 旧\n---';
      const next = applyMemoryFrontmatterPatch(original, { description: '新' });
      expect(next).toBe('---\ndescription: 新\n---');
      expect(next.endsWith('\n')).toBe(false);
      expect(next.length).toBe(original.length);
    });

    it('本文が空でも frontmatter は読み直せる（改行の扱いが形を壊していない）', () => {
      for (const original of ['---\ndescription: 旧\ntype: fact\n---\n', '---\ntype: fact\n---']) {
        const next = applyMemoryFrontmatterPatch(original, { parent: 'root' });
        expect(parseMemoryFrontmatter(next)).toMatchObject({ kind: 'parsed', parent: 'root' });
      }
    });

    it('本文が空でない側は影響を受けない（末尾の改行がそのまま残る）', () => {
      const original = `---\ndescription: 旧\n---\n${longBody}\n`;
      const next = applyMemoryFrontmatterPatch(original, { description: '新' });
      expect(next).toBe(`---\ndescription: 新\n---\n${longBody}\n`);
    });
  });
});

describe('区分の解決（resolveMemoryDocKind）— 既定は premise（4-11 の安全弁）', () => {
  it('frontmatter が無い（none）なら premise', () => {
    expect(resolveMemoryDocKind({ kind: 'none' })).toBe('premise');
  });

  it('frontmatter が壊れている（malformed）なら premise', () => {
    expect(resolveMemoryDocKind({ kind: 'malformed' })).toBe('premise');
  });

  it('type が無ければ premise', () => {
    expect(resolveMemoryDocKind({ kind: 'parsed' })).toBe('premise');
  });

  it('type が既知の集合に無い値なら premise', () => {
    expect(resolveMemoryDocKind({ kind: 'parsed', type: 'note' })).toBe('premise');
  });

  it('type: premise は premise、type: fact は fact、type: indexed は indexed', () => {
    expect(resolveMemoryDocKind({ kind: 'parsed', type: 'premise' })).toBe('premise');
    expect(resolveMemoryDocKind({ kind: 'parsed', type: 'fact' })).toBe('fact');
    expect(resolveMemoryDocKind({ kind: 'parsed', type: 'indexed' })).toBe('indexed');
  });

  it('⚠️ indexed を追加した後も、綴り違い（大文字）は premise へ倒れる（安全弁は壊れていない）', () => {
    expect(resolveMemoryDocKind({ kind: 'parsed', type: 'Indexed' })).toBe('premise');
    expect(resolveMemoryDocKind({ kind: 'parsed', type: 'indexeds' })).toBe('premise');
  });
});

describe('isKnownMemoryDocKind — 書き込み側の入口が使う判定', () => {
  it('premise と fact と indexed は既知', () => {
    expect(isKnownMemoryDocKind('premise')).toBe(true);
    expect(isKnownMemoryDocKind('fact')).toBe(true);
    expect(isKnownMemoryDocKind('indexed')).toBe(true);
  });

  it('綴り違い・大文字・空文字・未知の語は既知ではない', () => {
    expect(isKnownMemoryDocKind('Fact')).toBe(false);
    expect(isKnownMemoryDocKind('facts')).toBe(false);
    expect(isKnownMemoryDocKind('premis')).toBe(false);
    expect(isKnownMemoryDocKind('')).toBe(false);
    expect(isKnownMemoryDocKind('note')).toBe(false);
    expect(isKnownMemoryDocKind('Indexed')).toBe(false);
    expect(isKnownMemoryDocKind('indexeds')).toBe(false);
  });
});

describe('containsMemoryFrontmatterLineBreak — 改行を含む値の検出', () => {
  it('\\n を含めば true', () => {
    expect(containsMemoryFrontmatterLineBreak('a\nb')).toBe(true);
  });

  it('\\r を含めば true（\\r\\n だけでなく単独の \\r も）', () => {
    expect(containsMemoryFrontmatterLineBreak('a\rb')).toBe(true);
    expect(containsMemoryFrontmatterLineBreak('a\r\nb')).toBe(true);
  });

  it('改行を含まなければ false（--- を含む1行の値はここでは問題ない）', () => {
    expect(containsMemoryFrontmatterLineBreak('a')).toBe(false);
    expect(containsMemoryFrontmatterLineBreak('a---b')).toBe(false);
    expect(containsMemoryFrontmatterLineBreak('')).toBe(false);
  });

  it('検査を挟まないまま渡すと、値の続きが本文の先頭へ紛れ込む（再現）', () => {
    const original = '---\ndescription: 古\n---\n# 見出し\n\n本文である';
    const injected = applyMemoryFrontmatterPatch(original, {
      description: 'a\n---\nb',
      type: 'fact',
    });
    expect(parseMemoryFrontmatter(injected)).toEqual({ kind: 'parsed', description: 'a' });
    expect(injected.endsWith('本文である')).toBe(true);
    expect(injected).toContain('b\ntype: fact\n---\n# 見出し');
    expect(containsMemoryFrontmatterLineBreak('a\n---\nb')).toBe(true);
  });
});

describe('findMemoryFrontmatterLineBreak — 断りに名乗る証拠（位置・種類・抜粋）', () => {
  it('改行が無ければ null（containsMemoryFrontmatterLineBreak が false を返す値と同じ）', () => {
    expect(findMemoryFrontmatterLineBreak('a')).toBeNull();
    expect(findMemoryFrontmatterLineBreak('a---b')).toBeNull();
    expect(findMemoryFrontmatterLineBreak('')).toBeNull();
  });

  it('\\n の位置（1始まり）と種類を返す', () => {
    const found = findMemoryFrontmatterLineBreak('ab\ncd');
    expect(found?.position).toBe(3);
    expect(found?.char).toBe('\n');
  });

  it('単独の \\r も検出し、種類を \\r と返す（\\r\\n だけでなく）', () => {
    const found = findMemoryFrontmatterLineBreak('ab\rcd');
    expect(found?.position).toBe(3);
    expect(found?.char).toBe('\r');
  });

  it('\\r\\n は最初の \\r を位置として返す（/[\\r\\n]/ が \\r に先に当たるため）', () => {
    const found = findMemoryFrontmatterLineBreak('ab\r\ncd');
    expect(found?.position).toBe(3);
    expect(found?.char).toBe('\r');
  });

  it('複数の改行が在っても、最初の1つだけを返す', () => {
    const found = findMemoryFrontmatterLineBreak('a\nb\nc');
    expect(found?.position).toBe(2);
  });

  it('抜粋は前後の短い窓を持ち、改行そのものは \\n / \\r という見える形になる（生の改行を含まない）', () => {
    const found = findMemoryFrontmatterLineBreak('前置き\n後書き');
    expect(found?.excerpt).toBe('前置き\\n後書き');
    expect(found?.excerpt).not.toMatch(/[\r\n]/);
  });

  it('窓の外は省略記号 `…` が付く（前後どちらも）', () => {
    const before = 'あ'.repeat(30);
    const after = 'い'.repeat(30);
    const found = findMemoryFrontmatterLineBreak(`${before}\n${after}`);
    expect(found?.excerpt.startsWith('…')).toBe(true);
    expect(found?.excerpt.endsWith('…')).toBe(true);
    expect(found?.excerpt).toBe(`…${'あ'.repeat(20)}\\n${'い'.repeat(20)}…`);
  });

  it('窓の中に別の改行が在っても、それもエスケープされる（抜粋そのものに生の改行が残らない）', () => {
    const found = findMemoryFrontmatterLineBreak('a\nb\nc');
    expect(found?.excerpt).not.toMatch(/[\r\n]/);
    expect(found?.excerpt).toBe('a\\nb\\nc');
  });
});

describe('要旨の鮮度（resolveMemoryDescriptionFreshness）— 4状態、畳まない', () => {
  it('description が無ければ absent（describedAt があっても absent が勝つ）', () => {
    expect(
      resolveMemoryDescriptionFreshness({
        description: undefined,
        describedAt: '2026-08-20T00:00:00Z',
        updatedAt: '2026-08-21T00:00:00Z',
        describedBytes: undefined,
        describedBytesAt: undefined,
        currentBytes: 0,
      }),
    ).toEqual({ kind: 'absent' });
  });

  it('description はあるが describedAt を持たなければ unknown', () => {
    expect(
      resolveMemoryDescriptionFreshness({
        description: '要旨',
        describedAt: undefined,
        updatedAt: '2026-08-21T00:00:00Z',
        describedBytes: undefined,
        describedBytesAt: undefined,
        currentBytes: 0,
      }),
    ).toEqual({ kind: 'unknown' });
  });

  it('describedAt が updatedAt 以降なら fresh', () => {
    expect(
      resolveMemoryDescriptionFreshness({
        description: '要旨',
        describedAt: '2026-08-21T00:00:00Z',
        updatedAt: '2026-08-21T00:00:00Z',
        describedBytes: undefined,
        describedBytesAt: undefined,
        currentBytes: 0,
      }),
    ).toEqual({ kind: 'fresh' });
  });

  it('describedAt が updatedAt より前なら stale（差をミリ秒で持つ、#821）。drift も併せて持つ（#913）', () => {
    expect(
      resolveMemoryDescriptionFreshness({
        description: '要旨',
        describedAt: '2026-08-20T00:00:00Z',
        updatedAt: '2026-08-21T00:00:00Z',
        describedBytes: 500,
        describedBytesAt: undefined,
        currentBytes: 700,
      }),
    ).toEqual({
      kind: 'stale',
      staleForMs: 24 * 60 * 60 * 1000,
      drift: { kind: 'measured', describedBytes: 500, currentBytes: 700, deltaBytes: 200 },
    });
  });

  it('stale の差は1時間と30日で別の値になる（語ではなく数で測る、#821 条件2）', () => {
    const oneHour = resolveMemoryDescriptionFreshness({
      description: '要旨',
      describedAt: '2026-08-20T00:00:00Z',
      updatedAt: '2026-08-20T01:00:00Z',
      describedBytes: 500,
      describedBytesAt: undefined,
      currentBytes: 700,
    });
    const thirtyDays = resolveMemoryDescriptionFreshness({
      description: '要旨',
      describedAt: '2026-08-01T00:00:00Z',
      updatedAt: '2026-08-31T00:00:00Z',
      describedBytes: 500,
      describedBytesAt: undefined,
      currentBytes: 700,
    });
    expect(oneHour).toEqual({
      kind: 'stale',
      staleForMs: 60 * 60 * 1000,
      drift: { kind: 'measured', describedBytes: 500, currentBytes: 700, deltaBytes: 200 },
    });
    expect(thirtyDays).toEqual({
      kind: 'stale',
      staleForMs: 30 * 24 * 60 * 60 * 1000,
      drift: { kind: 'measured', describedBytes: 500, currentBytes: 700, deltaBytes: 200 },
    });
    expect(oneHour.kind === 'stale' && thirtyDays.kind === 'stale').toBe(true);
    if (oneHour.kind === 'stale' && thirtyDays.kind === 'stale') {
      expect(oneHour.staleForMs).not.toBe(thirtyDays.staleForMs);
    }
  });

  it('精度違いで辞書式と数値の順序が食い違っても、staleForMs は負にならない（0 に丸める）', () => {
    const result = resolveMemoryDescriptionFreshness({
      description: '要旨',
      describedAt: '2026-09-11T10:00:00.500Z',
      updatedAt: '2026-09-11T10:00:00Z',
      describedBytes: undefined,
      describedBytesAt: undefined,
      currentBytes: 0,
    });
    expect(result).toEqual({ kind: 'stale', staleForMs: 0, drift: { kind: 'unrecorded' } });
  });

  it('assertNeverMemoryDescriptionFreshness は未知の状態を投げる', () => {
    const bogus = { kind: 'bogus' } as never;
    expect(() => assertNeverMemoryDescriptionFreshness(bogus)).toThrow(/bogus/);
  });

  it('assertNeverMemoryFrontmatterState は未知の状態を投げる', () => {
    const bogus = { kind: 'bogus' } as never;
    expect(() => assertNeverMemoryFrontmatterState(bogus)).toThrow(/bogus/);
  });
});

describe('#913 / #821 残課題: stale に添える drift（本文の変化量）', () => {
  const stale = (
    describedBytes: number | undefined,
    currentBytes: number,
    describedBytesAt?: string,
  ) =>
    resolveMemoryDescriptionFreshness({
      description: '要旨',
      describedAt: '2026-08-20T00:00:00Z',
      updatedAt: '2026-08-21T00:00:00Z',
      describedBytes,
      describedBytesAt,
      currentBytes,
    });

  it('本文が増えていれば deltaBytes は正', () => {
    expect(stale(1000, 1200)).toEqual({
      kind: 'stale',
      staleForMs: 24 * 60 * 60 * 1000,
      drift: { kind: 'measured', describedBytes: 1000, currentBytes: 1200, deltaBytes: 200 },
    });
  });

  it('本文が縮んでいれば deltaBytes は負（「変わっていない」と混ぜない）', () => {
    expect(stale(1000, 800)).toEqual({
      kind: 'stale',
      staleForMs: 24 * 60 * 60 * 1000,
      drift: { kind: 'measured', describedBytes: 1000, currentBytes: 800, deltaBytes: -200 },
    });
  });

  it('本文が変わっていなければ deltaBytes は0（measured のまま。unrecorded にはしない）', () => {
    expect(stale(1000, 1000)).toEqual({
      kind: 'stale',
      staleForMs: 24 * 60 * 60 * 1000,
      drift: { kind: 'measured', describedBytes: 1000, currentBytes: 1000, deltaBytes: 0 },
    });
  });

  it('describedBytes が無ければ unrecorded（0 に化けさせない、#821 条件1と同じ形）', () => {
    expect(stale(undefined, 1000)).toEqual({
      kind: 'stale',
      staleForMs: 24 * 60 * 60 * 1000,
      drift: { kind: 'unrecorded' },
    });
  });

  it('describedBytesAt が describedAt 以下（同時刻含む）なら measured（#821 残課題）', () => {
    expect(stale(1000, 1200, '2026-08-20T00:00:00Z')).toEqual({
      kind: 'stale',
      staleForMs: 24 * 60 * 60 * 1000,
      drift: { kind: 'measured', describedBytes: 1000, currentBytes: 1200, deltaBytes: 200 },
    });
  });

  it('describedBytesAt が describedAt より後なら at-least（基準点は下限でしかない、#821 残課題）', () => {
    expect(stale(1000, 1200, '2026-08-20T12:00:00Z')).toEqual({
      kind: 'stale',
      staleForMs: 24 * 60 * 60 * 1000,
      drift: {
        kind: 'at-least',
        baselineBytes: 1000,
        baselineAt: '2026-08-20T12:00:00Z',
        currentBytes: 1200,
        deltaBytes: 200,
      },
    });
  });

  it('at-least でも、基準点のバイト数を変えると deltaBytes が動く（#821 条件2と同じ形）', () => {
    const smallDelta = stale(1000, 1100, '2026-08-20T12:00:00Z');
    const largeDelta = stale(500, 1100, '2026-08-20T12:00:00Z');
    expect(smallDelta.kind === 'stale' && smallDelta.drift.kind === 'at-least').toBe(true);
    expect(largeDelta.kind === 'stale' && largeDelta.drift.kind === 'at-least').toBe(true);
    if (
      smallDelta.kind === 'stale' &&
      smallDelta.drift.kind === 'at-least' &&
      largeDelta.kind === 'stale' &&
      largeDelta.drift.kind === 'at-least'
    ) {
      expect(smallDelta.drift.deltaBytes).toBe(100);
      expect(largeDelta.drift.deltaBytes).toBe(600);
      expect(smallDelta.drift.deltaBytes).not.toBe(largeDelta.drift.deltaBytes);
    }
  });

  it('assertNeverMemoryDescriptionDrift は未知の状態を投げる', () => {
    const bogus = { kind: 'bogus' } as never;
    expect(() => assertNeverMemoryDescriptionDrift(bogus)).toThrow(/bogus/);
  });
});

describe('deriveMemoryFrontmatter — fs / pg が list() / read() / documents() で共通に使う唯一の実装', () => {
  it('none の文書は premise・description 無し・absent', () => {
    const derived = deriveMemoryFrontmatter({
      content: '# 価値観\n本文',
      updatedAt: '2026-08-21T00:00:00Z',
      describedAt: undefined,
      describedBytes: undefined,
      describedBytesAt: undefined,
      currentBytes: 0,
    });
    expect(derived.frontmatter).toEqual({ kind: 'none' });
    expect(derived.kind).toBe('premise');
    expect(derived.description).toBeUndefined();
    expect(derived.descriptionFreshness).toEqual({ kind: 'absent' });
  });

  it('fact かつ describedAt が updatedAt 以降なら fresh を返す', () => {
    const derived = deriveMemoryFrontmatter({
      content: '---\ndescription: 要旨\ntype: fact\n---\n# T\n本文',
      updatedAt: '2026-08-21T00:00:00Z',
      describedAt: '2026-08-21T00:00:00Z',
      describedBytes: undefined,
      describedBytesAt: undefined,
      currentBytes: 0,
    });
    expect(derived.kind).toBe('fact');
    expect(derived.description).toBe('要旨');
    expect(derived.descriptionFreshness).toEqual({ kind: 'fresh' });
  });
});

describe('nextDescribedState — 書き手は書けない。store が新旧の description を比べて describedAt/describedBytes/describedBytesAt を進める（4-3、#913、#821 残課題）', () => {
  it('description が変わっていない、かつ基準点が既に在れば、3つとも据え置く（分岐2）', () => {
    const result = nextDescribedState({
      priorContent: '---\ndescription: 同じ\n---\n# T\n旧本文',
      nextContent: '---\ndescription: 同じ\n---\n# T\n新本文（本文だけ変えた）',
      priorDescribedAt: '2026-08-01T00:00:00Z',
      priorDescribedBytes: 123,
      priorDescribedBytesAt: '2026-08-01T00:00:00Z',
      priorBytes: 456,
      priorUpdatedAt: '2026-08-10T00:00:00Z',
      writtenAt: '2026-08-21T00:00:00Z',
      writtenBytes: 999,
    });
    expect(result).toEqual({
      describedAt: '2026-08-01T00:00:00Z',
      describedBytes: 123,
      describedBytesAt: '2026-08-01T00:00:00Z',
    });
  });

  it('description が変わっていれば、渡された writtenAt / writtenBytes の3つへ進める（分岐1）', () => {
    const result = nextDescribedState({
      priorContent: '---\ndescription: 旧\n---\n# T\n本文',
      nextContent: '---\ndescription: 新\n---\n# T\n本文',
      priorDescribedAt: '2026-08-01T00:00:00Z',
      priorDescribedBytes: 123,
      priorDescribedBytesAt: '2026-08-01T00:00:00Z',
      priorBytes: 111,
      priorUpdatedAt: '2026-08-15T00:00:00Z',
      writtenAt: '2026-08-21T00:00:00Z',
      writtenBytes: 999,
    });
    expect(result).toEqual({
      describedAt: '2026-08-21T00:00:00Z',
      describedBytes: 999,
      describedBytesAt: '2026-08-21T00:00:00Z',
    });
  });

  it('新規作成（priorContent が null）で description が付けば、changed 扱いになる（分岐1、3つとも進む）', () => {
    const result = nextDescribedState({
      priorContent: null,
      nextContent: '---\ndescription: 初めての要旨\n---\n# T\n本文',
      priorDescribedAt: undefined,
      priorDescribedBytes: undefined,
      priorDescribedBytesAt: undefined,
      priorBytes: undefined,
      priorUpdatedAt: undefined,
      writtenAt: '2026-08-21T00:00:00Z',
      writtenBytes: 42,
    });
    expect(result).toEqual({
      describedAt: '2026-08-21T00:00:00Z',
      describedBytes: 42,
      describedBytesAt: '2026-08-21T00:00:00Z',
    });
  });

  it('書いた直後は describedAt === updatedAt かつ describedBytes === writtenBytes になるので、直後の読み出しは必ず fresh', () => {
    const writtenAt = '2026-08-21T00:00:00Z';
    const writtenBytes = 42;
    const { describedAt, describedBytes, describedBytesAt } = nextDescribedState({
      priorContent: '---\ndescription: 旧\n---\n# T\n本文',
      nextContent: '---\ndescription: 新\n---\n# T\n本文',
      priorDescribedAt: '2026-08-01T00:00:00Z',
      priorDescribedBytes: 123,
      priorDescribedBytesAt: '2026-08-01T00:00:00Z',
      priorBytes: 111,
      priorUpdatedAt: '2026-08-15T00:00:00Z',
      writtenAt,
      writtenBytes,
    });
    expect(
      resolveMemoryDescriptionFreshness({
        description: '新',
        describedAt,
        updatedAt: writtenAt,
        describedBytes,
        describedBytesAt,
        currentBytes: writtenBytes,
      }),
    ).toEqual({ kind: 'fresh' });
  });

  it('基準点がまだ無ければ、本文だけの書き込みでも「書く前の状態」を基準点として立てる（分岐3）', () => {
    const result = nextDescribedState({
      priorContent: '---\ndescription: 同じ\n---\n# T\n旧本文',
      nextContent: '---\ndescription: 同じ\n---\n# T\n新本文（本文だけ追記した）',
      priorDescribedAt: '2026-08-01T00:00:00Z',
      priorDescribedBytes: undefined,
      priorDescribedBytesAt: undefined,
      priorBytes: 456,
      priorUpdatedAt: '2026-08-10T00:00:00Z',
      writtenAt: '2026-08-21T00:00:00Z',
      writtenBytes: 999,
    });
    expect(result).toEqual({
      describedAt: '2026-08-01T00:00:00Z',
      describedBytes: 456,
      describedBytesAt: '2026-08-10T00:00:00Z',
    });
  });

  it('基準点が無く、かつ「書く前の状態」も無い（新規作成で description が無いまま）なら、何も立てない', () => {
    const result = nextDescribedState({
      priorContent: null,
      nextContent: '# T\n本文（description 無し）',
      priorDescribedAt: undefined,
      priorDescribedBytes: undefined,
      priorDescribedBytesAt: undefined,
      priorBytes: undefined,
      priorUpdatedAt: undefined,
      writtenAt: '2026-08-21T00:00:00Z',
      writtenBytes: 42,
    });
    expect(result).toEqual({
      describedAt: undefined,
      describedBytes: undefined,
      describedBytesAt: undefined,
    });
  });

  it('一度立った基準点は、次の本文だけの書き込みでも動かない（分岐2。基準点のリセットを検出する歯）', () => {
    const first = nextDescribedState({
      priorContent: '---\ndescription: 同じ\n---\n# T\n旧本文',
      nextContent: '---\ndescription: 同じ\n---\n# T\n新本文（1回目の追記）',
      priorDescribedAt: '2026-08-01T00:00:00Z',
      priorDescribedBytes: undefined,
      priorDescribedBytesAt: undefined,
      priorBytes: 456,
      priorUpdatedAt: '2026-08-10T00:00:00Z',
      writtenAt: '2026-08-21T00:00:00Z',
      writtenBytes: 700,
    });
    expect(first).toEqual({
      describedAt: '2026-08-01T00:00:00Z',
      describedBytes: 456,
      describedBytesAt: '2026-08-10T00:00:00Z',
    });

    const second = nextDescribedState({
      priorContent: '---\ndescription: 同じ\n---\n# T\n新本文（1回目の追記）',
      nextContent: '---\ndescription: 同じ\n---\n# T\n新本文（2回目の追記）',
      priorDescribedAt: first.describedAt,
      priorDescribedBytes: first.describedBytes,
      priorDescribedBytesAt: first.describedBytesAt,
      priorBytes: 700,
      priorUpdatedAt: '2026-08-21T00:00:00Z',
      writtenAt: '2026-08-25T00:00:00Z',
      writtenBytes: 900,
    });
    expect(second).toEqual({
      describedAt: '2026-08-01T00:00:00Z',
      describedBytes: 456,
      describedBytesAt: '2026-08-10T00:00:00Z',
    });
  });
});

describe('renderMemoryDocuments — 区分ごとの載り方と、目次→詳細の受け入れ基準', () => {
  it('【区分の既定】frontmatter を1つも持たない文書は premise として扱われる（載り方はカード）', () => {
    const docs = [premise('b', 'に'), premise('a', 'い')];
    const rendered = renderMemoryDocuments(docs);

    expect(rendered).toContain('<!-- memory: b.md（premise');
    expect(rendered).toContain('<!-- memory: a.md（premise');
    expect(rendered).not.toContain('## 記憶の目次');
    expect(rendered).not.toBe(docs.map(renderMemoryDocument).join('\n\n'));
  });

  it('premise（区分無し）はカード（要旨＋節の目次）が載り、本文は1文字も載らない', () => {
    const rendered = renderMemoryDocuments([
      { slug: 'values', content: '# 価値観\n大事にしていること' },
    ]);
    expect(rendered).toContain('<!-- memory: values.md（premise');
    expect(rendered).toContain('# 価値観');
    expect(rendered).not.toContain('大事にしていること');
    expect(rendered).toContain('memory_section_read');
  });

  it('fact は目次の1行だけが載り、本文は載らない（memory_read で開く前提）', () => {
    const rendered = renderMemoryDocuments([
      fact('runbook', {
        title: '定点観測',
        description: '費用の推移',
        freshness: { kind: 'fresh' },
      }),
    ]);
    expect(rendered).toContain('runbook: 定点観測');
    expect(rendered).toContain('費用の推移');
    expect(rendered).not.toContain('本文の詳細（目次からは開けない）');
  });

  it('二重に載せない: premise がカードで載っているとき、同じ文書が目次側にも出ない', () => {
    const docs = [
      premise('p1', '前提の本文'),
      fact('f1', { title: 'F1', description: '要旨', freshness: { kind: 'fresh' } }),
    ];
    const rendered = renderMemoryDocuments(docs);

    const occurrences = rendered.split('<!-- memory: p1.md（premise').length - 1;
    expect(occurrences).toBe(1);
    expect(rendered).not.toContain('- p1:');
    expect(rendered).not.toContain('本文の詳細（目次からは開けない）');
    expect(rendered).toContain('- f1: F1');
  });

  it('取りこぼさない: documents() の件数 == 全文で載った件数 + 目次に出た件数', () => {
    const docs = [
      premise('premise-a'),
      premise('premise-b'),
      fact('fact-a', { description: '要旨a', freshness: { kind: 'fresh' } }),
      fact('fact-b', {
        description: '要旨b',
        freshness: { kind: 'stale', staleForMs: 1000, drift: { kind: 'unrecorded' } },
      }),
      fact('malformed-parent-ignored', {
        description: '要旨c',
        freshness: { kind: 'unknown' },
        parent: 'nope',
      }),
    ];
    const rendered = renderMemoryDocuments(docs);

    const cardCount = (rendered.match(/<!-- memory: [\w-]+\.md（premise/g) ?? []).length;
    const tocCount = docs.filter((doc) => rendered.includes(`- ${doc.slug}:`)).length;
    expect(cardCount + tocCount).toBe(docs.length);
  });

  it('切ったら言う: 目次を件数で切ったら、切った件数が出力に現れる', () => {
    // freshness は absent にする: fresh 等だと印の文字数ぶん1行が伸びて、固定している件数（300／5）が崩れる。
    const docs = Array.from({ length: MEMORY_TOC_ENTRY_LIMIT + 5 }, (_, index) =>
      fact(`fact-${index}`, { description: `要旨${index}`, freshness: { kind: 'absent' } }),
    );
    const rendered = renderMemoryDocuments(docs);
    expect(rendered).toContain('…ほか 5 件は目次から省略');
    expect(rendered).toContain(
      `…ほか 5 件は目次から省略（目次の対象は全 ${MEMORY_TOC_ENTRY_LIMIT + 5} 件）。`,
    );
    expect(rendered).not.toContain('今回載せた分だけである');
  });

  it('⭐ 部分だけを描く呼び手の下では、省略行が「記憶の全体ではなく、今回載せた分だけ」と明言する', () => {
    const docs = Array.from({ length: MEMORY_TOC_ENTRY_LIMIT + 5 }, (_, index) =>
      fact(`fact-${index}`, { description: `要旨${index}`, freshness: { kind: 'absent' } }),
    );
    const outsideDoc = fact('outside-doc', { description: '外', freshness: { kind: 'absent' } });
    const rendered = renderMemoryDocuments(docs, { presentInMemory: [...docs, outsideDoc] });

    expect(rendered).toContain(
      `…ほか 5 件は目次から省略（この目次に並べたのは全 ${MEMORY_TOC_ENTRY_LIMIT + 5} 件。` +
        '記憶の全体ではなく、今回載せた分だけである）。',
    );
    expect(rendered).not.toContain(`目次の対象は全 ${MEMORY_TOC_ENTRY_LIMIT + 5} 件）。`);
  });

  it('presentInMemory を渡していても、この描画が記憶の全体を覆っていれば従来どおりの文言のまま', () => {
    const docs = Array.from({ length: MEMORY_TOC_ENTRY_LIMIT + 5 }, (_, index) =>
      fact(`fact-${index}`, { description: `要旨${index}`, freshness: { kind: 'absent' } }),
    );
    const rendered = renderMemoryDocuments(docs, { presentInMemory: docs });

    expect(rendered).toContain(
      `…ほか 5 件は目次から省略（目次の対象は全 ${MEMORY_TOC_ENTRY_LIMIT + 5} 件）。`,
    );
    expect(rendered).not.toContain('今回載せた分だけである');
  });

  describe('目次の蓋: 件数のみ／文字数のみ／両方を、非自明な入力で作り分ける', () => {
    it('件数のみで切れる（305件・短い要旨——文字数の予算にはまだ余裕がある）', () => {
      // freshness は absent にする: 印の分だけ1行が伸びると「300件ぶんの短い要旨は文字数の予算に収まる」前提が崩れる。
      const docs = Array.from({ length: MEMORY_TOC_ENTRY_LIMIT + 5 }, (_, i) =>
        fact(`fact-${String(i).padStart(3, '0')}`, {
          description: 'x'.repeat(10),
          freshness: { kind: 'absent' },
        }),
      );
      const rendered = renderMemoryDocuments(docs);

      expect(rendered.match(/^- fact-/gm)?.length).toBe(MEMORY_TOC_ENTRY_LIMIT);
      expect(rendered).toContain(
        `…ほか 5 件は目次から省略（目次の対象は全 ${MEMORY_TOC_ENTRY_LIMIT + 5} 件）。`,
      );
      expect(rendered).toContain(
        `${MEMORY_TOC_ENTRY_LIMIT} 件の上限に当たって件数で切った（文字数の予算 ` +
          `${MEMORY_TOC_CHAR_BUDGET.toLocaleString('en-US')} 文字にはまだ余裕がある）。`,
      );
      expect(rendered).not.toContain('文字に当たって文字数で切った');
      expect(rendered).not.toContain('の両方に当たって切った');
      expect(rendered).not.toContain('memory_frontmatter_set で短くする');
      expect(rendered).toContain(
        'fact 文書が存在することを毎ターンの焼き込みの中で名乗る唯一の場所',
      );
      expect(rendered).toContain(
        '省かれた 5 件は、この焼き込みの中では存在しないのと見分けが付かない。',
      );
    });

    it('文字数のみで切れる（100件・要旨が1行の上限いっぱい——件数は300件の上限の下）', () => {
      const docs = Array.from({ length: 100 }, (_, i) =>
        fact(`fact-${String(i).padStart(3, '0')}`, {
          description: 'あ'.repeat(MEMORY_TOC_LINE_LIMIT),
          freshness: { kind: 'fresh' },
        }),
      );
      const rendered = renderMemoryDocuments(docs);

      const shownCount = rendered.match(/^- fact-/gm)?.length ?? 0;
      expect(shownCount).toBeGreaterThan(0);
      expect(shownCount).toBeLessThan(100);
      expect(rendered).toContain('…ほか');
      expect(rendered).toContain('目次から省略（目次の対象は全 100 件）。');
      expect(rendered).toContain(
        `文字数の予算 ${MEMORY_TOC_CHAR_BUDGET.toLocaleString('en-US')} 文字に当たって文字数で切った` +
          `（件数は ${MEMORY_TOC_ENTRY_LIMIT} 件の上限の下——要旨が長い文書が多い）。`,
      );
      expect(rendered).not.toContain('件の上限に当たって件数で切った');
      expect(rendered).not.toContain('の両方に当たって切った');
      expect(rendered).toContain(
        '要旨（description）が長い文書は memory_frontmatter_set で短くすると、同じ件数でもここに多く載る。',
      );
      expect(rendered).toContain(
        'fact 文書が存在することを毎ターンの焼き込みの中で名乗る唯一の場所',
      );
    });

    it('両方に当たる（320件・要旨が1行の上限いっぱい——件数の上限を超え、なお300件ぶんが文字数の予算も超える）', () => {
      const docs = Array.from({ length: MEMORY_TOC_ENTRY_LIMIT + 20 }, (_, i) =>
        fact(`fact-${String(i).padStart(3, '0')}`, {
          description: 'あ'.repeat(MEMORY_TOC_LINE_LIMIT),
          freshness: { kind: 'fresh' },
        }),
      );
      const rendered = renderMemoryDocuments(docs);

      const shownCount = rendered.match(/^- fact-/gm)?.length ?? 0;
      expect(shownCount).toBeGreaterThan(0);
      expect(shownCount).toBeLessThan(MEMORY_TOC_ENTRY_LIMIT);
      expect(rendered).toContain(
        `目次から省略（目次の対象は全 ${MEMORY_TOC_ENTRY_LIMIT + 20} 件）。`,
      );
      expect(rendered).toContain(
        `件数（${MEMORY_TOC_ENTRY_LIMIT} 件の上限）と文字数（予算 ` +
          `${MEMORY_TOC_CHAR_BUDGET.toLocaleString('en-US')} 文字）の両方に当たって切った。`,
      );
      expect(rendered).not.toContain('件の上限に当たって件数で切った');
      expect(rendered).not.toContain('文字に当たって文字数で切った');
      expect(rendered).toContain(
        'fact 文書が存在することを毎ターンの焼き込みの中で名乗る唯一の場所',
      );
    });

    // 文字数の蓋は、件数で切った後の残りに掛ける。束ねた全体に先に掛けると、表示件数は同じなのに「両方」と誤って名乗る。
    it('⭐ 順序が結果を変える境界（先頭300件は予算に大きな余裕、320件束ねると予算超過——正しくは「件数のみ」）', () => {
      const shortDocs = Array.from({ length: MEMORY_TOC_ENTRY_LIMIT }, (_, i) =>
        fact(`fact-${String(i).padStart(3, '0')}`, { freshness: { kind: 'absent' } }),
      );
      const longDocs = Array.from({ length: 20 }, (_, i) =>
        fact(`zzz-${String(i).padStart(3, '0')}`, {
          description: 'あ'.repeat(MEMORY_TOC_LINE_LIMIT),
          freshness: { kind: 'fresh' },
        }),
      );
      const rendered = renderMemoryDocuments([...shortDocs, ...longDocs]);

      const shownCount = rendered.match(/^- (fact|zzz)-/gm)?.length ?? 0;
      expect(shownCount).toBe(MEMORY_TOC_ENTRY_LIMIT);
      expect(rendered).not.toMatch(/^- zzz-/m);

      expect(rendered).toContain(
        `${MEMORY_TOC_ENTRY_LIMIT} 件の上限に当たって件数で切った（文字数の予算 ` +
          `${MEMORY_TOC_CHAR_BUDGET.toLocaleString('en-US')} 文字にはまだ余裕がある）。`,
      );
      expect(rendered).not.toContain('の両方に当たって切った');
      expect(rendered).not.toContain('文字に当たって文字数で切った');
    });
  });

  // freshness は absent にする: fresh だと印の文字数ぶん1行が伸びて、下の2つの it() の数値が印の実装に引きずられる。
  const tocCapFact = (index: number) =>
    fact(`fact-${String(index).padStart(3, '0')}`, {
      description: 'あ'.repeat(MEMORY_TOC_LINE_LIMIT),
      freshness: { kind: 'absent' },
    });

  // 1行ぶんの費用は、書式を手で真似ず2件と1件の描画の差で実測する。`renderMemoryTocLine` の書式を写すと、書式が変わったときにここだけ古くなる。
  const measureTocMarginalCost = () => {
    const one = renderMemoryDocuments([tocCapFact(0)]);
    const two = renderMemoryDocuments([tocCapFact(0), tocCapFact(1)]);
    return { one, two, marginal: two.length - one.length };
  };

  // 逐語で持つ: 定数を import して両側を一緒に動かす形にしない。
  const TOC_OMISSION_NOTE_HEAD = '…ほか ';

  // 「穴が在った」と「修理が効いている」を1本の it() に同居させない: 遊びが緩い側に合わせられて、予算の超過を見逃す。
  it('⭐⭐⭐ 穴の実在: 蓋が無ければ、束ねた候補行は 300件 × 1行200字 の下限を超えて伸びる', () => {
    const { one, two, marginal } = measureTocMarginalCost();
    expect(one).not.toContain('省略');
    expect(two).not.toContain('省略');

    const extrapolatedCandidateTotal = one.length + (MEMORY_TOC_ENTRY_LIMIT - 1) * marginal;

    const preCapFloor = MEMORY_TOC_ENTRY_LIMIT * MEMORY_TOC_LINE_LIMIT;
    expect(extrapolatedCandidateTotal).toBeGreaterThan(preCapFloor);
  });

  // 上界の第2項は丸い数字にしない: 予算の上に載る断り書きの実長に連動させ、遊びの大きさに書き手の裁量を残さない。
  it('⭐⭐⭐ 修理の実在: 予算を超えてよいのは断り書きぶんだけ（遊びは断り書きの実測長が決める）', () => {
    const docs = Array.from({ length: MEMORY_TOC_ENTRY_LIMIT }, (_, i) => tocCapFact(i));
    const rendered = renderMemoryDocuments(docs);
    expect(rendered).toContain('省略');

    const noteStart = rendered.indexOf(TOC_OMISSION_NOTE_HEAD);
    expect(noteStart).toBeGreaterThan(-1);
    const omissionNote = rendered.slice(noteStart);
    expect(omissionNote).not.toMatch(/^- fact-/m);

    expect(rendered.length).toBeLessThan(MEMORY_TOC_CHAR_BUDGET + omissionNote.length);

    const { one, marginal } = measureTocMarginalCost();
    const extrapolatedCandidateTotal = one.length + (MEMORY_TOC_ENTRY_LIMIT - 1) * marginal;
    expect(rendered.length).toBeLessThan(extrapolatedCandidateTotal / 2);
  });

  // 値そのもの（12_000）は固定しない: 実測に基づく調整まで禁じる歯になる。固定するのは値の帰属と関係だけ。
  it('⭐ 焼き込みの予算（MEMORY_TOC_CHAR_BUDGET）は、他のどの記憶の予算とも値を分け合わない', () => {
    const source = readFileSync(fileURLToPath(new URL('./memory.ts', import.meta.url)), 'utf8');
    const byName = new Map<string, number>();
    for (const match of source.matchAll(/export const (MEMORY_\w*_BUDGET) = ([\d_]+);/g)) {
      byName.set(match[1] as string, Number((match[2] as string).replace(/_/g, '')));
    }

    expect(byName.get('MEMORY_TOC_CHAR_BUDGET')).toBe(MEMORY_TOC_CHAR_BUDGET);

    const sharing = [...byName.entries()]
      .filter(
        ([name, value]) => name !== 'MEMORY_TOC_CHAR_BUDGET' && value === MEMORY_TOC_CHAR_BUDGET,
      )
      .map(([name]) => name)
      .sort();
    expect(sharing).toEqual([]);

    expect(MEMORY_TOC_CHAR_BUDGET).toBeGreaterThan(MEMORY_LISTING_BUDGET);
    expect(MEMORY_TOC_CHAR_BUDGET).toBeGreaterThan(MEMORY_PROMPT_OUTLINE_BUDGET);
    expect(MEMORY_TOC_CHAR_BUDGET).toBeLessThan(MEMORY_TOC_ENTRY_LIMIT * MEMORY_TOC_LINE_LIMIT);
  });

  it('切らないときは、切った件数の注記が出ない（切る/切らないは別の it() で測る）', () => {
    const docs = [fact('a'), fact('b'), fact('c')];
    const rendered = renderMemoryDocuments(docs);
    expect(rendered).not.toContain('省略');
  });

  it('古い要旨は消えない: stale な fact 文書が印つきで目次に残る', () => {
    const rendered = renderMemoryDocuments([
      fact('stale-doc', {
        title: 'Stale Doc',
        description: '古い要旨',
        freshness: {
          kind: 'stale',
          staleForMs: 60 * 60 * 1000,
          drift: { kind: 'measured', describedBytes: 500, currentBytes: 700, deltaBytes: 200 },
        },
      }),
    ]);
    expect(rendered).toContain('stale-doc');
    expect(rendered).toContain(
      '要旨は本文より1時間古い（本文は+200バイト（+40%）変わった）: 古い要旨',
    );
  });

  // 4つの被験体には必ず同じ slug を渡す（分けない）: slug は出力の行頭に出るので、分けると印が何を返しても4つが別の文字列になり、distinct.size === 4 が無条件に通って歯が無力になる。
  it('4状態を畳まない: fresh / stale / unknown / absent がそれぞれ別の表示になる（被験体の slug は揃える）', () => {
    const SAME_SLUG = 'x';
    const fresh = renderMemoryDocuments([
      fact(SAME_SLUG, { description: '説明', freshness: { kind: 'fresh' } }),
    ]);
    const stale = renderMemoryDocuments([
      fact(SAME_SLUG, {
        description: '説明',
        freshness: { kind: 'stale', staleForMs: 1000, drift: { kind: 'unrecorded' } },
      }),
    ]);
    const unknown = renderMemoryDocuments([
      fact(SAME_SLUG, { description: '説明', freshness: { kind: 'unknown' } }),
    ]);
    const absent = renderMemoryDocuments([fact(SAME_SLUG, { freshness: { kind: 'absent' } })]);

    const rendered = [fresh, stale, unknown, absent];

    const slugs = new Set(rendered.map((s) => s.match(/^- (\S+?):/m)?.[1]));
    expect(slugs).toEqual(new Set([SAME_SLUG]));

    const distinct = new Set(rendered.map((s) => s.trim()));
    expect(distinct.size).toBe(4);
    expect(absent).toContain('（要旨なし）');
  });

  it('stale の drift 3状態を畳まない: measured / at-least / unrecorded がそれぞれ別の表示になる（被験体の slug は揃える）', () => {
    const SAME_SLUG = 'y';
    const measured = renderMemoryDocuments([
      fact(SAME_SLUG, {
        description: '説明',
        freshness: {
          kind: 'stale',
          staleForMs: 1000,
          drift: { kind: 'measured', describedBytes: 1000, currentBytes: 1200, deltaBytes: 200 },
        },
      }),
    ]);
    const atLeast = renderMemoryDocuments([
      fact(SAME_SLUG, {
        description: '説明',
        freshness: {
          kind: 'stale',
          staleForMs: 1000,
          drift: {
            kind: 'at-least',
            baselineBytes: 1000,
            baselineAt: '2026-08-20T12:00:00Z',
            currentBytes: 1200,
            deltaBytes: 200,
          },
        },
      }),
    ]);
    const unrecorded = renderMemoryDocuments([
      fact(SAME_SLUG, {
        description: '説明',
        freshness: { kind: 'stale', staleForMs: 1000, drift: { kind: 'unrecorded' } },
      }),
    ]);

    const rendered = [measured, atLeast, unrecorded];
    const slugs = new Set(rendered.map((s) => s.match(/^- (\S+?):/m)?.[1]));
    expect(slugs).toEqual(new Set([SAME_SLUG]));

    const distinct = new Set(rendered.map((s) => s.trim()));
    expect(distinct.size).toBe(3);

    expect(measured).toContain('本文は+200バイト（+20%）変わった');
    expect(atLeast).toContain('+200バイト以上変わった');
    expect(atLeast).not.toContain('%');
    expect(atLeast).not.toContain('2026-08-20T12:00:00Z');
  });

  it('malformed の文書は消えず、premise として扱われ、frontmatter が壊れている印が付く', () => {
    const rendered = renderMemoryDocuments([
      { slug: 'broken', content: '---\nauthor: 未知のキー\n---\n# Broken\n本文は残る' },
    ]);
    expect(rendered).toContain('frontmatter が壊れている');
    expect(rendered).toContain('<!-- memory: broken.md（premise');
    expect(rendered).not.toContain('## 記憶の目次');
    expect(rendered).toContain('# Broken');
  });

  it('存在しない親を指す parent を黙って落とさない', () => {
    const rendered = renderMemoryDocuments([
      fact('orphan', { description: '説明', freshness: { kind: 'fresh' }, parent: 'not-exist' }),
    ]);
    expect(rendered).toContain('orphan');
    expect(rendered).toContain('親 not-exist が見つからない');
  });

  // 器は必ず premise 2件 + fact 1件にする: premise が0件だと「親が premise」と「親が無い」の2分岐が畳まれて変異を検出できない。it() も分ける。
  it('⭐ 親が premise を指すときは「見つからない」ではなく「在るが、目次には出ない」と言う', () => {
    const rendered = renderMemoryDocuments([
      premise('core-a', '前提A'),
      premise('core-b', '前提B'),
      fact('child', { description: '子', freshness: { kind: 'fresh' }, parent: 'core-a' }),
    ]);
    expect(rendered).toContain('親 core-a は在るが、この目次は fact だけを列挙する');
    expect(rendered).not.toContain('親 core-a が見つからない');
  });

  it('親が本当に存在しない slug なら、従来どおり「見つからない」のまま', () => {
    const rendered = renderMemoryDocuments([
      premise('core-a', '前提A'),
      premise('core-b', '前提B'),
      fact('child', {
        description: '子',
        freshness: { kind: 'fresh' },
        parent: 'really-not-exist',
      }),
    ]);
    expect(rendered).toContain('親 really-not-exist が見つからない');
    expect(rendered).not.toContain('在るが、この目次は fact だけを列挙する');
  });

  it('⭐ 親が今回の描画に含まれないだけのときは「見つからない」と言わない', () => {
    const rendered = renderMemoryDocuments(
      [fact('child', { description: '子', freshness: { kind: 'fresh' }, parent: 'core-a' })],
      { presentInMemory: [{ slug: 'core-a', content: '' }, fact('child')] },
    );
    expect(rendered).toContain('親 core-a は在るが、ここに載せた分には含まれない');
    expect(rendered).not.toContain('が見つからない');
  });

  it('親が本当に存在しないなら、`presentInMemory` を渡していても従来どおり「見つからない」', () => {
    const rendered = renderMemoryDocuments(
      [
        fact('child', {
          description: '子',
          freshness: { kind: 'fresh' },
          parent: 'really-not-exist',
        }),
      ],
      { presentInMemory: [fact('child')] },
    );
    expect(rendered).toContain('親 really-not-exist が見つからない');
    expect(rendered).not.toContain('ここに載せた分には含まれない');
  });

  it('親が同じ描画の中に premise として載っているなら、`presentInMemory` を渡してもそちらの言い方が勝つ', () => {
    const rendered = renderMemoryDocuments(
      [
        premise('core-a', '前提A'),
        premise('core-b', '前提B'),
        fact('child', { description: '子', freshness: { kind: 'fresh' }, parent: 'core-a' }),
      ],
      { presentInMemory: [premise('core-a', '前提A'), premise('core-b', '前提B'), fact('child')] },
    );
    expect(rendered).toContain('親 core-a は在るが、この目次は fact だけを列挙する');
    expect(rendered).not.toContain('ここに載せた分には含まれない');
  });

  it('`presentInMemory` を渡さなければ出力が1バイトも変わらない', () => {
    const docs = [
      fact('orphan', { description: '説明', freshness: { kind: 'fresh' }, parent: 'not-exist' }),
    ];
    const rendered = renderMemoryDocuments(docs);
    expect(rendered).toBe(
      '<!-- memory: index -->\n' +
        '## 記憶の目次（fact。本文は memory_read で開く。階層はインデントで表す）\n' +
        '- orphan: orphan — 要旨の後に本文は動いていない: 説明［親 not-exist が見つからない］',
    );
  });

  it('循環する parent を黙って落とさない', () => {
    const rendered = renderMemoryDocuments([
      fact('cycle-a', { description: 'A', freshness: { kind: 'fresh' }, parent: 'cycle-b' }),
      fact('cycle-b', { description: 'B', freshness: { kind: 'fresh' }, parent: 'cycle-a' }),
    ]);
    expect(rendered).toContain('cycle-a');
    expect(rendered).toContain('cycle-b');
    expect(rendered).toContain('循環');
  });

  it('自分自身を親に指定しても黙って落とさない', () => {
    const rendered = renderMemoryDocuments([
      fact('self-parent', {
        description: 'S',
        freshness: { kind: 'fresh' },
        parent: 'self-parent',
      }),
    ]);
    expect(rendered).toContain('self-parent');
    expect(rendered).toContain('循環');
  });

  it('階層はインデントで表す（親子とも fact のとき）', () => {
    const rendered = renderMemoryDocuments([
      fact('parent-doc', { title: '親', description: '親の説明', freshness: { kind: 'fresh' } }),
      fact('child-doc', {
        title: '子',
        description: '子の説明',
        freshness: { kind: 'fresh' },
        parent: 'parent-doc',
      }),
    ]);
    const lines = rendered.split('\n');
    const parentLine = lines.find((line) => line.includes('parent-doc:'));
    const childLine = lines.find((line) => line.includes('child-doc:'));
    expect(parentLine).toBeDefined();
    expect(childLine).toBeDefined();
    const leadingSpaces = (line: string) => line.length - line.trimStart().length;
    expect(leadingSpaces(childLine ?? '')).toBeGreaterThan(leadingSpaces(parentLine ?? ''));
  });

  it('記憶が1つも無ければ空文字のまま（従来と同じ）', () => {
    expect(renderMemoryDocuments([])).toBe('');
  });

  // `toContain('循環')` だけだと `cycle` と区別できない（両方に「循環」が含まれる）ので、専用の逐語で確かめる。
  it('⭐ 循環の一部がこの描画の外を通るとき、cycle ではなく cycle-outside-render として出る', () => {
    const ringA = fact('ring-a', {
      description: 'A',
      freshness: { kind: 'fresh' },
      parent: 'ring-b',
    });
    const ringB = fact('ring-b', {
      description: 'B',
      freshness: { kind: 'fresh' },
      parent: 'ring-c',
    });
    const ringC = fact('ring-c', {
      description: 'C',
      freshness: { kind: 'fresh' },
      parent: 'ring-a',
    });

    const rendered = renderMemoryDocuments([ringA, ringB], {
      presentInMemory: [ringA, ringB, ringC],
    });

    expect(rendered).toContain('ring-a');
    expect(rendered).toContain('ring-b');
    expect(rendered).not.toContain('ring-c:');
    expect(rendered).toContain(
      '親 ring-b との間で循環（輪の一部はここに載せた分には含まれない——記憶の側にある）',
    );
    expect(rendered).toContain(
      '親 ring-c との間で循環（輪の一部はここに載せた分には含まれない——記憶の側にある）',
    );
    expect(rendered).not.toContain('親 ring-b との間で循環］');
    expect(rendered).not.toContain('親 ring-c との間で循環］');
  });

  it('presentInMemory を渡していても、輪の全員がこの描画の中で完結していれば cycle のまま', () => {
    const cycleA = fact('closed-a', {
      description: 'A',
      freshness: { kind: 'fresh' },
      parent: 'closed-b',
    });
    const cycleB = fact('closed-b', {
      description: 'B',
      freshness: { kind: 'fresh' },
      parent: 'closed-a',
    });

    const rendered = renderMemoryDocuments([cycleA, cycleB], {
      presentInMemory: [cycleA, cycleB],
    });

    expect(rendered).toContain('親 closed-b との間で循環］');
    expect(rendered).toContain('親 closed-a との間で循環］');
    expect(rendered).not.toContain('輪の一部');
  });

  it('対照: 親が描画の外に在るが循環していないときは、従来どおり parent-not-rendered のまま', () => {
    const core = { slug: 'core', content: '' };
    const child = fact('child', {
      description: '子',
      freshness: { kind: 'fresh' },
      parent: 'core',
    });

    const rendered = renderMemoryDocuments([child], { presentInMemory: [core, child] });

    expect(rendered).toContain('親 core は在るが、ここに載せた分には含まれない');
    expect(rendered).not.toContain('循環');
  });

  it('⭐ MemoryTocIssue の5状態は互いに異なる文言になる（畳んでいない）', () => {
    const ALL_ISSUES: Record<MemoryTocIssue, true> = {
      'missing-parent': true,
      cycle: true,
      'parent-not-listed': true,
      'parent-not-rendered': true,
      'cycle-outside-render': true,
    };
    const issues = Object.keys(ALL_ISSUES) as MemoryTocIssue[];
    expect(issues.length).toBe(5);

    const outputs: Record<MemoryTocIssue, string> = {
      'missing-parent': renderMemoryDocuments([
        fact('miss-child', { description: '子', freshness: { kind: 'fresh' }, parent: 'nope' }),
      ]),
      'parent-not-listed': renderMemoryDocuments([
        premise('listed-core'),
        fact('listed-child', {
          description: '子',
          freshness: { kind: 'fresh' },
          parent: 'listed-core',
        }),
      ]),
      'parent-not-rendered': renderMemoryDocuments(
        [
          fact('rendered-child', {
            description: '子',
            freshness: { kind: 'fresh' },
            parent: 'rendered-core',
          }),
        ],
        { presentInMemory: [{ slug: 'rendered-core', content: '' }] },
      ),
      cycle: renderMemoryDocuments([
        fact('closed-a2', { description: 'A', freshness: { kind: 'fresh' }, parent: 'closed-b2' }),
        fact('closed-b2', { description: 'B', freshness: { kind: 'fresh' }, parent: 'closed-a2' }),
      ]),
      'cycle-outside-render': renderMemoryDocuments(
        [fact('ext-a', { description: 'A', freshness: { kind: 'fresh' }, parent: 'ext-b' })],
        {
          presentInMemory: [
            fact('ext-a', { description: 'A', freshness: { kind: 'fresh' }, parent: 'ext-b' }),
            fact('ext-b', { description: 'B', freshness: { kind: 'fresh' }, parent: 'ext-c' }),
            fact('ext-c', { description: 'C', freshness: { kind: 'fresh' }, parent: 'ext-a' }),
          ],
        },
      ),
    };

    for (const issue of issues) {
      expect(outputs[issue].length).toBeGreaterThan(0);
    }
    // 印そのもの（［…］の中身）を取り出して比べる: 全文だと slug や description の違いだけで別文字列になり、印を畳む変異を見逃す。
    const bracket = (rendered: string): string => rendered.match(/［[^］]+］/)?.[0] ?? '';
    const markers = issues.map((issue) => bracket(outputs[issue]));
    expect(markers.every((marker) => marker.length > 0)).toBe(true);
    expect(new Set(markers).size).toBe(5);
  });
});

describe('premise のカードの束ねた蓋（MEMORY_PREMISE_CARD_BUDGET）— 文書数に対する上界', () => {
  const capPremise = (index: number): MemoryPart => ({
    slug: `premise-${String(index).padStart(3, '0')}`,
    title: `前提${index}`,
    content: [
      '---',
      'type: premise',
      `description: ${'あ'.repeat(MEMORY_PROMPT_DESCRIPTION_BUDGET)}`,
      '---',
      '',
      ...Array.from({ length: 200 }, (_, n) => `## 節${n} ${'見出し'.repeat(4)}\n\n本文\n`),
    ].join('\n'),
  });

  // 1枚ぶんの費用は書式を真似ず2件と1件の描画の差で実測する: `renderPremiseCard` の書式を写すと、書式が変わったときにここだけ古くなる。
  const measureCardMarginalCost = () => {
    const one = renderMemoryDocuments([capPremise(0)]);
    const two = renderMemoryDocuments([capPremise(0), capPremise(1)]);
    return { one, two, marginal: two.length - one.length };
  };

  // 逐語で持つ: 定数を import して両側を一緒に動かさない。
  const DEMOTION_NOTE_HEAD = '<!-- memory: カードを落とした分（premise / indexed';

  it('⭐⭐ doc の導出（premise 5枚 / indexed 9枚で収まり、6枚目の premise で噛む）が現物と一致する', () => {
    const saturated = (index: number, kind: 'premise' | 'indexed'): MemoryPart => ({
      slug: `${kind}-${String(index).padStart(3, '0')}`,
      content: [
        '---',
        `type: ${kind}`,
        `description: ${'あ'.repeat(kind === 'premise' ? MEMORY_PROMPT_DESCRIPTION_BUDGET : MEMORY_PROMPT_INDEXED_DESCRIPTION_BUDGET)}`,
        '---',
        '',
        ...Array.from(
          { length: 400 },
          (_, n) => `## 節${n} ${'見出しの語'.repeat(6)}\n\n本文${n}\n`,
        ),
      ].join('\n'),
    });
    const marginal = (kind: 'premise' | 'indexed'): number =>
      renderMemoryDocuments([saturated(0, kind), saturated(1, kind)]).length -
      renderMemoryDocuments([saturated(0, kind)]).length;

    expect(Math.floor(MEMORY_PREMISE_CARD_BUDGET / marginal('premise'))).toBe(5);
    expect(Math.floor(MEMORY_PREMISE_CARD_BUDGET / marginal('indexed'))).toBe(9);

    const six = renderMemoryDocuments(
      Array.from({ length: 6 }, (_, index) => saturated(index, 'premise')),
    );
    expect(six).toContain(DEMOTION_NOTE_HEAD);
  });

  it('⭐⭐ 蓋は indexed のカードにも掛かる（indexed を蓋の外に置かない）', () => {
    const capIndexed = (index: number): MemoryPart => ({
      slug: `indexed-${String(index).padStart(3, '0')}`,
      title: `索引${index}`,
      content: [
        '---',
        'type: indexed',
        `description: ${'い'.repeat(MEMORY_PROMPT_INDEXED_DESCRIPTION_BUDGET)}`,
        '---',
        '',
        ...Array.from({ length: 200 }, (_, n) => `## 節${n} ${'見出し'.repeat(4)}\n\n本文\n`),
      ].join('\n'),
    });

    const marginalIndexed =
      renderMemoryDocuments([capIndexed(0), capIndexed(1)]).length -
      renderMemoryDocuments([capIndexed(0)]).length;
    const count = Math.ceil((MEMORY_PREMISE_CARD_BUDGET * 2) / marginalIndexed);
    const docs = Array.from({ length: count }, (_, index) => capIndexed(index));

    const rendered = renderMemoryDocuments(docs);

    expect(rendered).toContain(DEMOTION_NOTE_HEAD);
    expect(rendered.length).toBeLessThan(MEMORY_PREMISE_CARD_BUDGET * 2);
  });

  // 予算は1本で測る（混在）: 区分ごとに1本ずつ持たせる改修は、どちらも単独では予算の2倍に届かず緑のまま通る。
  it('⭐⭐⭐ premise と indexed は1つの予算を分け合う（区分ごとに2本持たない）', () => {
    const capIndexedShared = (index: number): MemoryPart => ({
      slug: `shared-idx-${String(index).padStart(3, '0')}`,
      content: [
        '---',
        'type: indexed',
        `description: ${'い'.repeat(MEMORY_PROMPT_INDEXED_DESCRIPTION_BUDGET)}`,
        '---',
        '',
        '## 節\n\n本文\n',
      ].join('\n'),
    });

    const marginalPremise = measureCardMarginalCost().marginal;
    const marginalIndexed =
      renderMemoryDocuments([capIndexedShared(0), capIndexedShared(1)]).length -
      renderMemoryDocuments([capIndexedShared(0)]).length;

    const premiseCount = Math.floor((MEMORY_PREMISE_CARD_BUDGET * 0.6) / marginalPremise);
    const indexedCount = Math.floor((MEMORY_PREMISE_CARD_BUDGET * 0.6) / marginalIndexed);
    expect(premiseCount, 'premise の足場が空である').toBeGreaterThan(0);
    expect(indexedCount, 'indexed の足場が空である').toBeGreaterThan(0);

    const premiseOnly = Array.from({ length: premiseCount }, (_, i) => capPremise(i));
    const indexedOnly = Array.from({ length: indexedCount }, (_, i) => capIndexedShared(i));

    expect(renderMemoryDocuments(premiseOnly)).not.toContain(DEMOTION_NOTE_HEAD);
    expect(renderMemoryDocuments(indexedOnly)).not.toContain(DEMOTION_NOTE_HEAD);

    const mixed = renderMemoryDocuments([...premiseOnly, ...indexedOnly]);
    expect(mixed).toContain(DEMOTION_NOTE_HEAD);

    const note = mixed.slice(mixed.indexOf(DEMOTION_NOTE_HEAD));
    expect(mixed.length).toBeLessThan(MEMORY_PREMISE_CARD_BUDGET + note.length);
  });

  it('⭐⭐⭐ 穴の実在: 蓋が無ければ、束ねたカードは文書数に比例して予算を桁で超える', () => {
    const { one, two, marginal } = measureCardMarginalCost();
    expect(one).not.toContain(DEMOTION_NOTE_HEAD);
    expect(two).not.toContain(DEMOTION_NOTE_HEAD);
    expect(marginal).toBeGreaterThan(MEMORY_PROMPT_OUTLINE_BUDGET);

    const docsToDoubleBudget = Math.ceil((MEMORY_PREMISE_CARD_BUDGET * 2) / marginal);
    const extrapolated = one.length + (docsToDoubleBudget - 1) * marginal;
    expect(extrapolated).toBeGreaterThan(MEMORY_PREMISE_CARD_BUDGET * 2);

    expect(docsToDoubleBudget).toBeLessThan(100);
  });

  // 上界の第2項は丸い数字にしない: 予算の上に載る断り書きの実長にする。
  it('⭐⭐⭐ 修理の実在: 枚数を増やしても、予算を超えてよいのは断り書きぶんだけ', () => {
    const { one, marginal } = measureCardMarginalCost();
    const many = Math.ceil((MEMORY_PREMISE_CARD_BUDGET * 3) / marginal);
    const rendered = renderMemoryDocuments(Array.from({ length: many }, (_, i) => capPremise(i)));

    const noteStart = rendered.indexOf(DEMOTION_NOTE_HEAD);
    expect(noteStart).toBeGreaterThan(-1);
    const note = rendered.slice(noteStart);
    expect(note).not.toContain('節（memory_section_read に節id を渡せば本文が開く');

    expect(rendered.length).toBeLessThan(MEMORY_PREMISE_CARD_BUDGET + note.length);

    const extrapolated = one.length + (many - 1) * marginal;
    expect(rendered.length).toBeLessThan(extrapolated / 2);
  });

  it('⭐⭐⭐ カードを落としても文書は消えない: 全ての slug が焼き込みに現れる', () => {
    const { marginal } = measureCardMarginalCost();
    const many = Math.ceil((MEMORY_PREMISE_CARD_BUDGET * 2) / marginal);
    const docs = Array.from({ length: many }, (_, i) => capPremise(i));
    const rendered = renderMemoryDocuments(docs);

    expect(rendered).toContain(DEMOTION_NOTE_HEAD);
    expect(docs.filter((doc) => !rendered.includes(doc.slug))).toEqual([]);
  });

  // 上界は note.length を含む量では測らない: note に落とした分の一覧が入っていて、一覧の予算を外しても上界が一緒に伸びて緑のままになる。
  it('⭐⭐⭐ 上界は文書数に依らない: 枚数を足しても、総量はカード1枚ぶんも増えない', () => {
    const { marginal } = measureCardMarginalCost();
    const base = Math.ceil((MEMORY_PREMISE_CARD_BUDGET * 2) / marginal);
    const few = renderMemoryDocuments(Array.from({ length: base }, (_, i) => capPremise(i)));
    const many = renderMemoryDocuments(Array.from({ length: base + 100 }, (_, i) => capPremise(i)));

    expect(few).toContain(DEMOTION_NOTE_HEAD);
    expect(many).toContain(DEMOTION_NOTE_HEAD);

    expect(many.length - few.length).toBeLessThan(marginal);
  });

  // 期待値は実装の式を写さず、1文書ずつ描いた長さの和と実測した区切りの長さから独立に再計算する。
  it('⭐⭐⭐ 断り書きが名乗るのは蓋が無かったときの総量である（蓋の後の長さではない）', () => {
    const { marginal } = measureCardMarginalCost();
    const count = Math.ceil((MEMORY_PREMISE_CARD_BUDGET * 2) / marginal);
    const docs = Array.from({ length: count }, (_, i) => capPremise(i));
    const rendered = renderMemoryDocuments(docs);
    expect(rendered).toContain(DEMOTION_NOTE_HEAD);

    const a = docs[0];
    const b = docs[1];
    if (a === undefined || b === undefined) throw new Error('足場が空である');
    const joinChars =
      renderMemoryDocuments([a, b]).length -
      renderMemoryDocuments([a]).length -
      renderMemoryDocuments([b]).length;
    expect(joinChars).toBeGreaterThan(0);

    const uncapped =
      docs.reduce((sum, doc) => sum + renderMemoryDocuments([doc]).length, 0) +
      joinChars * (docs.length - 1);

    expect(rendered).toContain(
      `カード（premise と indexed）の合計が ${uncapped.toLocaleString('en-US')} 文字になり`,
    );
    expect(uncapped).toBeGreaterThan(rendered.length);
  });

  it('落とした件数・残した件数・開く口・直し方を名乗る', () => {
    const { marginal } = measureCardMarginalCost();
    const many = Math.ceil((MEMORY_PREMISE_CARD_BUDGET * 2) / marginal);
    const rendered = renderMemoryDocuments(Array.from({ length: many }, (_, i) => capPremise(i)));

    expect(rendered).toContain('件のカードを落として1行にした');
    expect(rendered).toContain('カードのまま載っているのは');
    expect(rendered).toContain('memory_outline');
    expect(rendered).toContain('memory_section_read');
    expect(rendered).toContain('memory_section_move');
    expect(rendered).toContain('要旨（description）を削る方向へ倒さないこと');
  });

  // 節数で大きさに差を付けない: 節目次が1文書あたりの予算に当たると、節を増やすほどカードが小さくなる。要旨の長さで付ける。
  const sizedPremise = (index: number): MemoryPart => ({
    slug: `sized-${String(index).padStart(3, '0')}`,
    title: `前提${index}`,
    content: [
      '---',
      'type: premise',
      `description: ${'あ'.repeat(200 + index * 100)}`,
      '---',
      '',
      ...Array.from({ length: 5 }, (_, n) => `## 節${n}\n\n本文\n`),
    ].join('\n'),
  });

  it('⭐⭐ 落とすのは大きいほうから（渡す順序を変えても結果が変わらない）', () => {
    const docs = Array.from({ length: 40 }, (_, i) => sizedPremise(i));

    const forward = renderMemoryDocuments(docs);
    const reversed = renderMemoryDocuments([...docs].reverse());

    const demotedSlugs = (rendered: string) => {
      const note = rendered.slice(rendered.indexOf(DEMOTION_NOTE_HEAD));
      return docs
        .map((doc) => doc.slug)
        .filter((slug) => note.includes(`- ${slug}.md（`))
        .sort();
    };
    expect(forward).toContain(DEMOTION_NOTE_HEAD);
    expect(demotedSlugs(forward)).toEqual(demotedSlugs(reversed));

    const smallest = docs[0];
    if (smallest === undefined) throw new Error('足場が空である');
    expect(forward).toContain(`<!-- memory: ${smallest.slug}.md（premise`);
  });

  // 差分の載せ直しには蓋を掛けない: 掛けると同じ文脈の中で同じ文書の載り方が2通り並ぶ。
  it('⭐⭐ 差分の載せ直し（seenContent を渡す呼び）には蓋を掛けない', () => {
    const { marginal } = measureCardMarginalCost();
    const many = Math.ceil((MEMORY_PREMISE_CARD_BUDGET * 2) / marginal);
    const docs = Array.from({ length: many }, (_, i) => capPremise(i));

    expect(renderMemoryDocuments(docs)).toContain(DEMOTION_NOTE_HEAD);

    const asDelta = renderMemoryDocuments(docs, {
      presentInMemory: docs,
      seenContent: new Map(),
    });
    expect(asDelta).not.toContain(DEMOTION_NOTE_HEAD);
  });

  it('⭐⭐ measureMemoryFloor: demotedPremiseDocs が実物と一致し、premiseDocs は引かれない', () => {
    const { marginal } = measureCardMarginalCost();
    const many = Math.ceil((MEMORY_PREMISE_CARD_BUDGET * 2) / marginal);
    const docs = Array.from({ length: many }, (_, i) => capPremise(i));

    const floor = measureMemoryFloor(docs);
    expect(floor.premiseDocs).toBe(many);
    expect(floor.demotedPremiseDocs).toBeGreaterThan(0);
    expect(floor.demotedPremiseDocs).toBeLessThan(many);

    const rendered = renderMemoryDocuments(docs);
    expect(rendered).toContain(
      `**大きいほうから ${floor.demotedPremiseDocs.toLocaleString('en-US')} 件のカードを落として1行にした**`,
    );

    expect(measureMemoryFloor([capPremise(0)]).demotedPremiseDocs).toBe(0);
  });

  it('⭐⭐ describeMemoryFloor は、蓋が噛んだ回だけ増減の読み方を断る', () => {
    const { marginal } = measureCardMarginalCost();
    const many = Math.ceil((MEMORY_PREMISE_CARD_BUDGET * 2) / marginal);
    const capped = Array.from({ length: many }, (_, i) => capPremise(i));
    const small = [capPremise(0)];

    const cappedLine = describeMemoryFloor({
      before: measureMemoryFloor(capped.slice(0, -1)),
      after: measureMemoryFloor(capped),
      slug: capped[capped.length - 1]?.slug ?? 'premise-000',
      kind: 'premise',
      created: false,
    });
    expect(cappedLine).toContain('この増減は蓋が効いた後の値である');

    const smallLine = describeMemoryFloor({
      before: measureMemoryFloor([]),
      after: measureMemoryFloor(small),
      slug: 'premise-000',
      kind: 'premise',
      created: false,
    });
    expect(smallLine).not.toContain('この増減は蓋が効いた後の値である');
  });

  describe('断り書きは落ちた区分について嘘をつかない（#805 で蓋が indexed へ広がった後）', () => {
    const saturatedIndexed = (index: number): MemoryPart => ({
      slug: `sat-idx-${String(index).padStart(3, '0')}`,
      content: [
        '---',
        'type: indexed',
        `description: ${'い'.repeat(MEMORY_PROMPT_INDEXED_DESCRIPTION_BUDGET)}`,
        '---',
        '',
        '## 節\n\n本文\n',
      ].join('\n'),
    });

    it('⭐⭐⭐ indexed だけが落ちたとき、premise が落ちたとは名乗らない', () => {
      const rendered = renderMemoryDocuments(
        Array.from({ length: 20 }, (_, i) => saturatedIndexed(i)),
      );
      expect(rendered).toContain(DEMOTION_NOTE_HEAD);

      expect(rendered).toMatch(/（premise 0 件 \/ indexed [\d,]+ 件。/);
      expect(rendered).toMatch(/^- sat-idx-\d+\.md（indexed・/m);
      expect(rendered).not.toContain('premise のカードの合計');
    });

    it('⭐⭐⭐ 落ちたのが indexed だけなら、「indexed にせよ」という実行できない助言を出さない', () => {
      const rendered = renderMemoryDocuments(
        Array.from({ length: 20 }, (_, i) => saturatedIndexed(i)),
      );
      expect(rendered).not.toContain('type: indexed にする');
      expect(rendered).toContain('に残っている手はこれだけである');
      expect(rendered).toContain('type: indexed にしても1文字も下がらない');
      expect(rendered).toContain('memory_section_move で割り');
    });

    it('⭐⭐ 落ちたのが premise だけなら、(1) の手を premise の件数で名指しして出す', () => {
      const { marginal } = measureCardMarginalCost();
      const count = Math.ceil((MEMORY_PREMISE_CARD_BUDGET * 2) / marginal);
      const rendered = renderMemoryDocuments(
        Array.from({ length: count }, (_, i) => capPremise(i)),
      );
      expect(rendered).toContain(DEMOTION_NOTE_HEAD);

      expect(rendered).toMatch(/（premise [\d,]+ 件 \/ indexed 0 件。/);
      expect(rendered).toMatch(
        /\(1\) 上の premise [\d,]+ 件を memory_frontmatter_set で type: indexed にする/,
      );
      expect(rendered).not.toContain('に残っている手はこれだけである');
      expect(rendered).toMatch(/^- premise-\d+\.md（premise・/m);
    });

    it('⭐⭐ 両方が混ざって落ちたときは、内訳と両方の手が出る', () => {
      const { marginal } = measureCardMarginalCost();
      const premiseCount = Math.ceil((MEMORY_PREMISE_CARD_BUDGET * 1.5) / marginal);
      const docs = [
        ...Array.from({ length: premiseCount }, (_, i) => capPremise(i)),
        ...Array.from({ length: 20 }, (_, i) => saturatedIndexed(i)),
      ];
      const rendered = renderMemoryDocuments(docs);
      expect(rendered).toContain(DEMOTION_NOTE_HEAD);

      const note = rendered.slice(rendered.indexOf(DEMOTION_NOTE_HEAD));
      const matched = /（premise ([\d,]+) 件 \/ indexed ([\d,]+) 件。/.exec(note);
      expect(matched, '内訳が出ていない').not.toBeNull();
      const declaredPremise = Number((matched?.[1] ?? '0').replace(/,/g, ''));
      const declaredIndexed = Number((matched?.[2] ?? '0').replace(/,/g, ''));
      expect(declaredPremise + declaredIndexed).toBe(measureMemoryFloor(docs).demotedPremiseDocs);
      // 内訳の数と一覧に出ている行の数は一致しない（行は一覧の予算で省かれうる）ので、突き合わせる相手は measureMemoryFloor の側にする。
      expect(declaredPremise).toBeGreaterThan(0);
    });
  });

  it('⚠️ 前提の固定: カード1枚は束ねた予算より必ず小さい（だから「1枚は残す」枝は到達不能）', () => {
    const { marginal } = measureCardMarginalCost();
    expect(marginal).toBeLessThan(MEMORY_PREMISE_CARD_BUDGET);
    expect(MEMORY_PROMPT_DESCRIPTION_BUDGET + MEMORY_PROMPT_OUTLINE_BUDGET).toBeLessThan(
      MEMORY_PREMISE_CARD_BUDGET,
    );
  });
});

const INVARIANT2_CORPUS: MemoryPart[] = [
  { slug: 'no-frontmatter', content: '# no-frontmatter\n本文A\n## 節A1\n中身A1' },
  {
    slug: 'explicit-premise',
    content:
      '---\ntype: premise\ndescription: 要旨B\n---\n# explicit-premise\n本文B\n## 節B1\n中身B1\n## 節B2\n中身B2',
  },
  { slug: 'fact-doc', content: '---\ntype: fact\ndescription: 要旨C\n---\n# fact-doc\n本文C' },
  { slug: 'broken', content: '---\nno colon here\n---\n# broken\n本文D' },
  {
    slug: 'unknown-type',
    content:
      '---\ntype: something-else\ndescription: 要旨E\n---\n# unknown-type\n本文E\n## 節E1\n中身E1',
  },
];

const INVARIANT2_GOLDEN =
  '<!-- memory: no-frontmatter.md（premise・本文は載っていない。全 32 文字 / 2 節） -->\n要旨: （まだ書かれていない。memory_frontmatter_set の description で書くこと——ここが空だと、本文を開くまでこの文書が何なのか分からない）\n節（memory_section_read に節id を渡せば本文が開く。数字は文字数・子込み）:\n[5f35fd4b-d02c5e61] # no-frontmatter — 32 文字\n  [a200735a-6700831a] ## 節A1 — 11 文字\n\n<!-- memory: explicit-premise.md（premise・本文は載っていない。全 85 文字 / 3 節） -->\n要旨: 要旨B\n節（memory_section_read に節id を渡せば本文が開く。数字は文字数・子込み）:\n[d261b61a-c981527a] # explicit-premise — 46 文字\n  [0ca6eb3f-52241122] ## 節B1 — 12 文字\n  [e2d59aaf-2a39d6bb] ## 節B2 — 11 文字\n\n<!-- memory: frontmatter が壊れている（既知の形にならなかった。premise として扱っている） -->\n<!-- memory: broken.md（premise・本文は載っていない。全 34 文字 / 1 節） -->\n要旨: （まだ書かれていない。memory_frontmatter_set の description で書くこと——ここが空だと、本文を開くまでこの文書が何なのか分からない）\n節（memory_section_read に節id を渡せば本文が開く。数字は文字数・子込み）:\n[489e4048-1b0e31ad] # broken — 12 文字\n\n<!-- memory: unknown-type.md（premise・本文は載っていない。全 76 文字 / 2 節） -->\n要旨: 要旨E\n節（memory_section_read に節id を渡せば本文が開く。数字は文字数・子込み）:\n[9f0ec3f9-96417823] # unknown-type — 30 文字\n  [d6a625f1-9195a16d] ## 節E1 — 11 文字\n\n<!-- memory: index -->\n## 記憶の目次（fact。本文は memory_read で開く。階層はインデントで表す）\n- fact-doc: fact-doc — 要旨を書いた時刻が記録されていない: 要旨C';

describe('indexed — 第3の区分（要旨だけ。節の目次は焼かれない）', () => {
  it('⭐⭐ MEMORY_PROMPT_INDEXED_DESCRIPTION_BUDGET は premise の要旨予算＋目次予算より必ず小さい', () => {
    expect(MEMORY_PROMPT_INDEXED_DESCRIPTION_BUDGET).toBeLessThan(
      MEMORY_PROMPT_DESCRIPTION_BUDGET + MEMORY_PROMPT_OUTLINE_BUDGET,
    );
    expect(MEMORY_PROMPT_INDEXED_DESCRIPTION_BUDGET).toBe(6_000);
  });

  it('indexed のカードには「本文は載っていない」（head）と「目次は載らない」（節の行）、節数・全体の文字数が出る', () => {
    const withSections: MemoryPart = {
      slug: 'proj-only',
      content:
        '---\ndescription: 特定のプロジェクトでしか使わない記憶\ntype: indexed\n---\n' +
        '## 一\n本文1\n## 二\n本文2\n## 三\n本文3',
    };
    const rendered = renderMemoryDocuments([withSections]);

    expect(rendered).toContain('<!-- memory: proj-only.md（indexed・本文は載っていない。');
    // head に indexed 固有の説明は足さない: 節0件のとき indexed と premise の床が一致してしまう。
    expect(rendered).toContain('目次は載らない');
    expect(rendered).toContain(`全 ${withSections.content.length} 文字`);
    expect(rendered).toContain('/ 3 節');
    expect(rendered).toContain('要旨: 特定のプロジェクトでしか使わない記憶');
  });

  it('indexed は節の目次（節idの行）を1文字も焼かない（unlike premise）', () => {
    const content = '---\ntype: indexed\ndescription: 要旨\n---\n## 一\n本文1\n## 二\n本文2';
    const indexedRendered = renderMemoryDocuments([{ slug: 'doc', content }]);
    const premiseRendered = renderMemoryDocuments([
      { slug: 'doc', content: content.replace('type: indexed', 'type: premise') },
    ]);

    const sectionIdLine = /\[[0-9a-f]{8}-[0-9a-f]{8}\]/;
    expect(premiseRendered).toMatch(sectionIdLine);
    expect(indexedRendered).not.toMatch(sectionIdLine);
    expect(indexedRendered).not.toContain('見出し');
  });

  it('indexed は節を開く手段（memory_outline → memory_section_read）を案内する。q= / offset= は名指ししない', () => {
    const content = '---\ntype: indexed\ndescription: 要旨\n---\n## 一\n本文1';
    const rendered = renderMemoryDocuments([{ slug: 'doc', content }]);

    expect(rendered).toContain('memory_outline');
    expect(rendered).toContain('memory_section_read');
    // q= / offset= は名指ししない: 実行できない助言になる。
    expect(rendered).not.toContain('q=');
    expect(rendered).not.toContain('offset=');
  });

  it('節が1つも無い indexed 文書は、memory_read で開く旨を出す（premise の0節分岐と同じ形）', () => {
    const rendered = renderMemoryDocuments([
      { slug: 'doc', content: '---\ntype: indexed\ndescription: 要旨\n---\n前書きだけ' },
    ]);
    expect(rendered).toContain('1つも無い');
    expect(rendered).toContain('memory_read');
  });

  it.each([
    { sections: 0, descLen: 10 },
    { sections: 3, descLen: 100 },
    { sections: 50, descLen: 4_000 },
    { sections: 300, descLen: 9_000 },
  ])(
    '⭐⭐ 同じ文書を premise にしたときより indexed にしたときのほうが床は必ず小さい（節 $sections・要旨 $descLen 文字）',
    ({ sections, descLen }) => {
      const body = Array.from({ length: sections }, (_, i) => `## 節${i}\n本文${i}`).join('\n');
      const description = 'あ'.repeat(descLen);
      const premiseDoc: MemoryPart = {
        slug: 'doc',
        content: `---\ndescription: ${description}\ntype: premise\n---\n${body}`,
      };
      const indexedDoc: MemoryPart = {
        slug: 'doc',
        content: `---\ndescription: ${description}\ntype: indexed\n---\n${body}`,
      };

      const premiseFloor = measureMemoryFloor([premiseDoc]);
      const indexedFloor = measureMemoryFloor([indexedDoc]);

      expect(indexedFloor.totalChars).toBeLessThan(premiseFloor.totalChars);
    },
  );

  it('measureMemoryFloor は indexedChars / indexedDocs / largestIndexed を返す（indexed 0件なら 0 / 0 / null）', () => {
    const onlyPremise = measureMemoryFloor([premise('p', '本文')]);
    expect(onlyPremise.indexedChars).toBe(0);
    expect(onlyPremise.indexedDocs).toBe(0);
    expect(onlyPremise.largestIndexed).toBeNull();

    const withIndexed = measureMemoryFloor([
      { slug: 'small', content: '---\ntype: indexed\ndescription: 小\n---\n## 一\n本文' },
      {
        slug: 'large',
        content: `---\ntype: indexed\ndescription: 大\n---\n${'## 節\n本文\n'.repeat(20)}`,
      },
    ]);
    expect(withIndexed.indexedDocs).toBe(2);
    expect(withIndexed.indexedChars).toBeGreaterThan(0);
    expect(withIndexed.largestIndexed?.slug).toBe('large');
  });

  it('⭐ 不変条件2: indexed を含まない合成コーパスの出力は、この PR の前後で1文字も変わらない（golden）', () => {
    const rendered = renderMemoryDocuments(INVARIANT2_CORPUS);
    expect(rendered).toBe(INVARIANT2_GOLDEN);
  });
});

describe('renderMemoryListing — `memory_list` 用の一覧。全区分を対象にする', () => {
  it('記憶が空なら空である旨を返す', () => {
    expect(renderMemoryListing([])).toBe('（記憶はまだ空）');
  });

  it('premise も fact も一覧に出る（premise は全文には出ないが一覧には出る）', () => {
    const listing = renderMemoryListing([
      {
        slug: 'p1',
        title: 'P1',
        kind: 'premise',
        description: undefined,
        descriptionFreshness: { kind: 'absent' },
        parent: undefined,
        updatedAt: '2026-08-21T00:00:00Z',
        createdAt: { kind: 'unknown' },
      },
      {
        slug: 'f1',
        title: 'F1',
        kind: 'fact',
        description: '要旨',
        descriptionFreshness: { kind: 'fresh' },
        parent: undefined,
        updatedAt: '2026-08-21T00:00:00Z',
        createdAt: { kind: 'unknown' },
      },
    ]);
    expect(listing).toContain('[premise] p1: P1');
    expect(listing).toContain('[fact] f1: F1');
    expect(listing).toContain('要旨');
  });

  // known / unknown は別々の it() にする: 片方が通るともう片方も通ったように見える形にしない。
  it('createdAt が known なら ISO 時刻がそのまま出る', () => {
    const listing = renderMemoryListing([
      {
        slug: 'p1',
        title: 'P1',
        kind: 'premise',
        description: undefined,
        descriptionFreshness: { kind: 'absent' },
        parent: undefined,
        updatedAt: '2026-08-21T00:00:00Z',
        createdAt: { kind: 'known', at: '2026-01-02T03:04:05.000Z' },
      },
    ]);

    expect(listing).toContain('作成: 2026-01-02T03:04:05.000Z');
    expect(listing).toContain('更新: 2026-08-21T00:00:00Z');
  });

  it('⭐ 親が premise を指していても、一覧では通常どおり解決する（案4の副作用が無い）', () => {
    const listing = renderMemoryListing([
      {
        slug: 'core',
        title: 'Core',
        kind: 'premise',
        description: undefined,
        descriptionFreshness: { kind: 'absent' },
        parent: undefined,
        updatedAt: '2026-08-21T00:00:00Z',
        createdAt: { kind: 'unknown' },
      },
      {
        slug: 'child',
        title: 'Child',
        kind: 'fact',
        description: '子',
        descriptionFreshness: { kind: 'fresh' },
        parent: 'core',
        updatedAt: '2026-08-21T00:00:00Z',
        createdAt: { kind: 'unknown' },
      },
    ]);

    expect(listing).toContain('[premise] core: Core');
    expect(listing).toContain('[fact] child: Child');
    expect(listing).not.toContain('見つからない');
    expect(listing).not.toContain('列挙する');
    expect(listing).not.toContain('循環');
  });

  it('createdAt が unknown なら「不明」と明言する（空文字で隠さない）', () => {
    const listing = renderMemoryListing([
      {
        slug: 'p1',
        title: 'P1',
        kind: 'premise',
        description: undefined,
        descriptionFreshness: { kind: 'absent' },
        parent: undefined,
        updatedAt: '2026-08-21T00:00:00Z',
        createdAt: { kind: 'unknown' },
      },
    ]);

    expect(listing).toContain('作成: 不明');
    expect(listing).not.toMatch(/作成: $/m);
    expect(listing).not.toMatch(/作成: \/ /);
  });

  it('stale の印は差の大きさで文字列が変わる（1時間差と30日差、条件2）', () => {
    const entry = (staleForMs: number) => ({
      slug: 'stale-doc',
      title: 'Stale',
      kind: 'fact' as const,
      description: '要旨',
      descriptionFreshness: {
        kind: 'stale' as const,
        staleForMs,
        drift: { kind: 'unrecorded' as const },
      },
      parent: undefined,
      updatedAt: '2026-08-21T00:00:00Z',
      createdAt: { kind: 'unknown' as const },
    });

    const oneHour = renderMemoryListing([entry(60 * 60 * 1000)]);
    const thirtyDays = renderMemoryListing([entry(30 * 24 * 60 * 60 * 1000)]);

    expect(oneHour).toContain('要旨は本文より1時間古い');
    expect(thirtyDays).toContain('要旨は本文より30日古い');
    expect(oneHour).not.toBe(thirtyDays);
  });

  it('unknown（記録なし）と fresh（正直なゼロ）は別の言葉で出る（条件1）', () => {
    const entry = (descriptionFreshness: { kind: 'fresh' | 'unknown' }) => ({
      slug: 'doc',
      title: 'Doc',
      kind: 'fact' as const,
      description: '要旨',
      descriptionFreshness,
      parent: undefined,
      updatedAt: '2026-08-21T00:00:00Z',
      createdAt: { kind: 'unknown' as const },
    });

    const fresh = renderMemoryListing([entry({ kind: 'fresh' })]);
    const unknown = renderMemoryListing([entry({ kind: 'unknown' })]);

    expect(fresh).not.toBe(unknown);
    expect(unknown).not.toMatch(/\d+(秒|分|時間|日)/);
    expect(unknown).toContain('記録されていない');
    expect(fresh).not.toContain('記録されていない');
    expect(fresh).toContain('本文は動いていない');
  });

  it('要旨がある文書（fresh / stale / unknown）は必ず何か言う。absent だけ何も出さない（条件3）', () => {
    const base = {
      slug: 'doc',
      title: 'Doc',
      kind: 'fact' as const,
      parent: undefined,
      updatedAt: '2026-08-21T00:00:00Z',
      createdAt: { kind: 'unknown' as const },
    };
    const fresh = renderMemoryListing([
      { ...base, description: '説明', descriptionFreshness: { kind: 'fresh' as const } },
    ]);
    const stale = renderMemoryListing([
      {
        ...base,
        description: '説明',
        descriptionFreshness: {
          kind: 'stale' as const,
          staleForMs: 1000,
          drift: { kind: 'unrecorded' as const },
        },
      },
    ]);
    const unknown = renderMemoryListing([
      { ...base, description: '説明', descriptionFreshness: { kind: 'unknown' as const } },
    ]);
    const absent = renderMemoryListing([
      { ...base, description: undefined, descriptionFreshness: { kind: 'absent' as const } },
    ]);

    expect(fresh).not.toContain('— 説明');
    expect(stale).not.toContain('— 説明');
    expect(unknown).not.toContain('— 説明');
    expect(absent).not.toContain(' — ');
  });

  // 「1行の抜粋」と「一覧の打ち切り」を1つの語で測らない: 長い要旨には1行ごとに「…文字省略」の注記が付くので、'省略' を探すと一覧を切っていなくても当たる。
  function docs(count: number, descriptionLength = 40) {
    return Array.from({ length: count }, (_, index) => ({
      slug: `doc-${index}`,
      title: `題${index}`,
      kind: 'fact' as const,
      description: 'あ'.repeat(descriptionLength),
      descriptionFreshness: { kind: 'fresh' as const },
      parent: undefined,
      updatedAt: '2026-08-21T00:00:00Z',
      createdAt: { kind: 'unknown' as const },
    }));
  }

  it('文書が増えても、一覧は文字数の予算に収まる', () => {
    const listing = renderMemoryListing(docs(500));

    expect(listing.length).toBeLessThan(MEMORY_LISTING_BUDGET + 500);
  });

  it('要旨が長くても、一覧は文字数の予算に収まる', () => {
    const listing = renderMemoryListing(docs(500, 400));

    expect(listing.length).toBeLessThan(MEMORY_LISTING_BUDGET + 500);
  });

  it('切ったなら黙らない（出した件数・全体の件数・全文の取り方が出る）', () => {
    const listing = renderMemoryListing(docs(500));

    expect(listing).toMatch(/ほか \d+ 件は省略/);
    expect(listing).toContain('全 500 件');
    expect(listing).toContain('memory_read');
  });

  it('予算に収まる件数なら、一覧の断り書きを付けない', () => {
    const listing = renderMemoryListing(docs(3));

    expect(listing).not.toMatch(/件は省略/);
  });
});

describe('#913: 要旨の鮮度は時間差だけでなく本文の変化量も運ぶ', () => {
  function driftEntry(
    slug: string,
    staleForMs: number,
    drift:
      | { kind: 'measured'; describedBytes: number; currentBytes: number; deltaBytes: number }
      | {
          kind: 'at-least';
          baselineBytes: number;
          baselineAt: string;
          currentBytes: number;
          deltaBytes: number;
        }
      | { kind: 'unrecorded' },
  ) {
    return {
      slug,
      title: slug,
      kind: 'fact' as const,
      description: '要旨',
      descriptionFreshness: { kind: 'stale' as const, staleForMs, drift },
      parent: undefined,
      updatedAt: '2026-08-21T00:00:00Z',
      createdAt: { kind: 'unknown' as const },
    };
  }

  function extractByteDelta(listing: string, slug: string): number | null {
    const line = listing.split('\n').find((l) => l.includes(`${slug}:`));
    if (line === undefined) return null;
    const match = /([+-])\s*([\d,]+)\s*バイト/.exec(line);
    if (match === null) return null;
    const sign = match[1] === '-' ? -1 : 1;
    const digits = match[2];
    // 0 を作らない: 「読めなかった」を「0バイト変わった」に化けさせると、この歯が測っている当のものを歯自身が壊す。
    if (digits === undefined) return null;
    return sign * Number(digits.replace(/,/g, ''));
  }

  it('⭐ 30日で+200バイトの文書より、1時間で+60,000バイト変わった文書のほうが、変化量としては大きいと数で分かる', () => {
    const barelyTouchedInAMonth = driftEntry('doc-a', 30 * 24 * 60 * 60 * 1000, {
      kind: 'measured',
      describedBytes: 1000,
      currentBytes: 1200,
      deltaBytes: 200,
    });
    const heavilyEditedInAnHour = driftEntry('doc-b', 60 * 60 * 1000, {
      kind: 'measured',
      describedBytes: 1000,
      currentBytes: 61000,
      deltaBytes: 60000,
    });

    const listing = renderMemoryListing([barelyTouchedInAMonth, heavilyEditedInAnHour]);

    const deltaA = extractByteDelta(listing, 'doc-a');
    const deltaB = extractByteDelta(listing, 'doc-b');

    expect(deltaA).not.toBeNull();
    expect(deltaB).not.toBeNull();
    expect(deltaB as number).toBeGreaterThan(deltaA as number);
  });

  it('⭐ 変化量の数を変えると出力も変わる（語ではなく数で測る。200バイトと60,000バイトの2点）', () => {
    const small = renderMemoryListing([
      driftEntry('doc', 60 * 60 * 1000, {
        kind: 'measured',
        describedBytes: 1000,
        currentBytes: 1200,
        deltaBytes: 200,
      }),
    ]);
    const large = renderMemoryListing([
      driftEntry('doc', 60 * 60 * 1000, {
        kind: 'measured',
        describedBytes: 1000,
        currentBytes: 61000,
        deltaBytes: 60000,
      }),
    ]);

    expect(small).not.toBe(large);
    expect(extractByteDelta(small, 'doc')).toBe(200);
    expect(extractByteDelta(large, 'doc')).toBe(60000);
  });

  it('⭐⭐ 陰性対照1: unrecorded（記録なし）と「0バイト変わった」は別の言葉で出る（#821 条件1と同じ形）', () => {
    const unrecorded = renderMemoryListing([
      driftEntry('doc', 60 * 60 * 1000, { kind: 'unrecorded' }),
    ]);
    const zeroChanged = renderMemoryListing([
      driftEntry('doc', 60 * 60 * 1000, {
        kind: 'measured',
        describedBytes: 1000,
        currentBytes: 1000,
        deltaBytes: 0,
      }),
    ]);

    expect(unrecorded).not.toBe(zeroChanged);
    expect(extractByteDelta(unrecorded, 'doc')).toBeNull();
    expect(unrecorded).toContain('記録されていない');
    expect(zeroChanged).not.toContain('記録されていない');
  });

  it('⭐⭐ 陰性対照2: 本文が縮んだ文書（負の変化量）は「変わっていない」と同じ表示にならない', () => {
    const shrunk = renderMemoryListing([
      driftEntry('doc', 60 * 60 * 1000, {
        kind: 'measured',
        describedBytes: 1000,
        currentBytes: 800,
        deltaBytes: -200,
      }),
    ]);
    const unchanged = renderMemoryListing([
      driftEntry('doc', 60 * 60 * 1000, {
        kind: 'measured',
        describedBytes: 1000,
        currentBytes: 1000,
        deltaBytes: 0,
      }),
    ]);

    expect(shrunk).not.toBe(unchanged);
    expect(extractByteDelta(shrunk, 'doc')).toBe(-200);
  });

  it('⭐⭐ 陰性対照4: at-least は measured（% つき）とも unrecorded とも別の言葉で出る（#821 残課題）', () => {
    const atLeast = renderMemoryListing([
      driftEntry('doc', 60 * 60 * 1000, {
        kind: 'at-least',
        baselineBytes: 1000,
        baselineAt: '2026-08-20T12:00:00Z',
        currentBytes: 1200,
        deltaBytes: 200,
      }),
    ]);
    const measured = renderMemoryListing([
      driftEntry('doc', 60 * 60 * 1000, {
        kind: 'measured',
        describedBytes: 1000,
        currentBytes: 1200,
        deltaBytes: 200,
      }),
    ]);
    const unrecorded = renderMemoryListing([
      driftEntry('doc', 60 * 60 * 1000, { kind: 'unrecorded' }),
    ]);

    expect(atLeast).not.toBe(measured);
    expect(atLeast).not.toBe(unrecorded);
    expect(atLeast).toContain('以上変わった');
    expect(atLeast).not.toContain('%');
    expect(measured).toContain('%');
    expect(atLeast).not.toContain('2026-08-20T12:00:00Z');
  });

  it('⭐⭐ 陰性対照3: fresh の文書には変化量が出ない（stale 以外へ漏れていない）', () => {
    const fresh = renderMemoryListing([
      {
        slug: 'doc',
        title: 'Doc',
        kind: 'fact' as const,
        description: '要旨',
        descriptionFreshness: { kind: 'fresh' as const },
        parent: undefined,
        updatedAt: '2026-08-21T00:00:00Z',
        createdAt: { kind: 'unknown' as const },
      },
    ]);

    expect(extractByteDelta(fresh, 'doc')).toBeNull();
    expect(fresh).not.toMatch(/バイト/);
  });
});

describe('記憶の節（memory_outline / memory_section_move、#318 案 (b)）', () => {
  const withFrontmatter = [
    '---',
    'description: 私について',
    'type: premise',
    '---',
    '前書きである（節ではない）。',
    '',
    '# 私について',
    '本文A',
    '',
    '## 経歴',
    '本文B',
    '',
    '### だから',
    '本文C',
    '',
    '#### さらに',
    '本文D',
    '',
    '## 例',
    '本文E',
    '',
  ].join('\n');

  const headingsOf = (content: string): string[] =>
    scanMemorySections(content).sections.map((section) => section.heading);

  it('frontmatter は節ではない（本文の始まりより前を1つも節にしない）', () => {
    const scan = scanMemorySections(withFrontmatter);

    expect(scan.bodyStart).toBe(memoryBodyStart(withFrontmatter));
    for (const section of scan.sections)
      expect(section.start).toBeGreaterThanOrEqual(scan.bodyStart);
    expect(headingsOf(withFrontmatter)).toEqual([
      '# 私について',
      '## 経歴',
      '### だから',
      '#### さらに',
      '## 例',
    ]);
  });

  it('最初の見出しより前の前書きは節ではない（指す値が発行されない）', () => {
    const scan = scanMemorySections(withFrontmatter);
    const first = scan.sections[0];

    expect(first?.heading).toBe('# 私について');
    expect(withFrontmatter.slice(scan.bodyStart, first?.start)).toContain('前書きである');
    for (const section of scan.sections) {
      expect(withFrontmatter.slice(section.start, section.end)).not.toContain('前書きである');
    }
  });

  // 「同じ深さ以下」を「同じ深さ」に狭めない: `###` の節が次の `##` で終わらなくなり、子でないものを子として運ぶ。
  it('節は「同じ深さ以下の次の見出しの直前」で終わる（### は次の ## で終わり、次の #### では終わらない）', () => {
    const sections = scanMemorySections(withFrontmatter).sections;
    const dakara = sections.find((section) => section.heading === '### だから');
    const body = withFrontmatter.slice(dakara?.start, dakara?.end);

    expect(body).toContain('#### さらに');
    expect(body).toContain('本文D');
    expect(body).not.toContain('## 例');
    expect(body).not.toContain('本文E');
  });

  it('各節の文字数は子込みである（移したときに動く量が、呼ぶ前に分かる）', () => {
    const sections = scanMemorySections(withFrontmatter).sections;
    const keireki = sections.find((section) => section.heading === '## 経歴');
    const dakara = sections.find((section) => section.heading === '### だから');
    const sarani = sections.find((section) => section.heading === '#### さらに');

    expect(keireki?.chars).toBe((keireki?.end ?? 0) - (keireki?.start ?? 0));
    expect(keireki?.chars).toBeGreaterThan(dakara?.chars ?? 0);
    expect(dakara?.chars).toBeGreaterThan(sarani?.chars ?? 0);
  });

  describe('節id は「指し先」であると同時に「版の照合」である', () => {
    it('中身が変われば id が変わる（＝読んだ後の書き換えを検出できる）', () => {
      const before = scanMemorySections(withFrontmatter).sections.find(
        (section) => section.heading === '## 例',
      );
      const after = scanMemorySections(
        withFrontmatter.replace('本文E', '本文E（直した）'),
      ).sections.find((section) => section.heading === '## 例');

      expect(before?.id).not.toBe(after?.id);
    });

    // 文書全体のハッシュを ETag にしない: 無関係な節が動いただけで断られるようになり、この道具が使えなくなる。
    it('他の節が変わっても id は変わらない（無関係な変更で誤検出しない）', () => {
      const before = scanMemorySections(withFrontmatter).sections.find(
        (section) => section.heading === '## 例',
      );
      const after = scanMemorySections(
        withFrontmatter.replace('本文A', '本文A（別の節を直した）'),
      ).sections.find((section) => section.heading === '## 例');

      expect(after?.id).toBe(before?.id);
    });

    it('入れ子の子を移すと、親の id は変わる（子は親の中身だから）', () => {
      const scan = scanMemorySections(withFrontmatter);
      const parentBefore = scan.sections.find((section) => section.heading === '### だから');
      const child = scan.sections.find((section) => section.heading === '#### さらに');
      const { nextContent } = cutMemorySections(withFrontmatter, [child as never]);
      const parentAfter = scanMemorySections(nextContent).sections.find(
        (section) => section.heading === '### だから',
      );

      expect(parentAfter).toBeDefined();
      expect(parentAfter?.id).not.toBe(parentBefore?.id);
    });

    it('見出しが同じで中身も同じ節は、同じ id になる（曖昧さが id に現れる）', () => {
      // 末尾の空行まで一致させる: 最後の節だけ末尾の改行の数が違うと別の id になる。
      const doc = '# A\n本文\n\n# A\n本文\n\n# B\n終わり\n';
      const [first, second] = scanMemorySections(doc).sections;

      expect(first?.id).toBe(second?.id);
      expect(lookupMemorySection(scanMemorySections(doc).sections, first?.id as string).kind).toBe(
        'ambiguous',
      );
    });

    it('memorySectionId は「見出しだけのハッシュ」と「見出し＋中身のハッシュ」を繋いだ形である', () => {
      const a = memorySectionId('## 経歴', '本文B\n');
      const b = memorySectionId('## 経歴', '別の本文\n');
      const c = memorySectionId('## 別の見出し', '本文B\n');

      expect(a.split('-')[0]).toBe(b.split('-')[0]);
      expect(a.split('-')[1]).not.toBe(b.split('-')[1]);
      expect(a.split('-')[0]).not.toBe(c.split('-')[0]);
    });
  });

  describe('lookupMemorySection は「無い」と「古い」を畳まない', () => {
    const sections = () => scanMemorySections(withFrontmatter).sections;

    it('その id の節が在れば found', () => {
      const target = sections().find((section) => section.heading === '## 経歴');

      expect(lookupMemorySection(sections(), target?.id as string)).toMatchObject({
        kind: 'found',
      });
    });

    it('見出しが一致するが中身のハッシュが違うなら stale（誰かが書き換えた）', () => {
      const target = sections().find((section) => section.heading === '## 経歴');
      const stale = `${(target?.id as string).split('-')[0]}-00000000`;

      expect(lookupMemorySection(sections(), stale)).toMatchObject({ kind: 'stale' });
    });

    it('見出しごと一致しないなら absent（打ち間違い・別の文書）', () => {
      expect(lookupMemorySection(sections(), 'deadbeef-cafebabe')).toMatchObject({
        kind: 'absent',
      });
    });
  });

  // 走査は2本のまま、1つの it() で並べて assert する: 検出器は拾いすぎる側・決定器は拾わない側へ倒してあり向きが逆なので、片方を「直して」1本にまとめる変更をここで止める。
  it('走査は2本である: 差分の要約はフェンスの中の見出しを拾い、節の境界は拾わない', () => {
    const fenced = [
      '# ログ',
      '',
      '## 例',
      '```sh',
      '## これは見出しではない',
      'echo hi',
      '```',
      '本文',
      '',
    ].join('\n');

    expect(headingsOf(fenced)).toEqual(['# ログ', '## 例']);

    const withoutFence = ['# ログ', '', '## 例', '本文', ''].join('\n');
    expect(describeMemoryWriteDiff(fenced, withoutFence)).toContain('## これは見出しではない');
  });

  it('コードフェンスの中の見出しを節の境界にしないので、移した後もフェンスの開閉が揃う', () => {
    const fenced = [
      '# ログ',
      '',
      '## 例',
      '```sh',
      '## これは見出しではない',
      'echo hi',
      '```',
      '本文E',
      '',
      '## 次',
      '本文F',
      '',
    ].join('\n');
    const target = scanMemorySections(fenced).sections.find(
      (section) => section.heading === '## 例',
    );
    const { nextContent, cut } = cutMemorySections(fenced, [target as never]);

    expect((cut.match(/^```/gm) ?? []).length).toBe(2);
    expect((nextContent.match(/^```/gm) ?? []).length).toBe(0);
    expect(nextContent).toContain('## 次');
    expect(nextContent).not.toContain('echo hi');
  });

  it('~~~ のフェンスも追う（``` だけを見ていない）', () => {
    const fenced = ['# ログ', '~~~', '## 中', '~~~', '本文', ''].join('\n');

    expect(headingsOf(fenced)).toEqual(['# ログ']);
  });

  it('開いたまま閉じないフェンスは、そこから先を全部フェンスの中とみなす（拾わない側へ倒す）', () => {
    const broken = ['# ログ', '```sh', '## 閉じていない', '本文', ''].join('\n');

    expect(headingsOf(broken)).toEqual(['# ログ']);
  });

  describe('cutMemorySections は継ぎ足しである（frontmatter を書き直さない）', () => {
    it('frontmatter のバイト列が1バイトも変わらない（キーの順序も空白も含めて）', () => {
      const doc = [
        '---',
        'type:  premise',
        'description:   私について',
        '---',
        '# A',
        '本文',
        '',
        '# B',
        '本文',
        '',
      ].join('\n');
      const scan = scanMemorySections(doc);
      const target = scan.sections.find((section) => section.heading === '# A');
      const { nextContent } = cutMemorySections(doc, [target as never]);

      expect(nextContent.slice(0, scan.bodyStart)).toBe(doc.slice(0, scan.bodyStart));
      expect(nextContent).toContain('type:  premise');
      expect(nextContent).toContain('description:   私について');
      expect(nextContent).not.toContain('# A');
    });

    it('切り取った文字列と残った文字列を繋ぐと、必ず元に戻る（1文字も落とさない・増やさない）', () => {
      const scan = scanMemorySections(withFrontmatter);
      for (const section of scan.sections) {
        const { nextContent, cut } = cutMemorySections(withFrontmatter, [section]);
        expect(nextContent.slice(0, section.start) + cut + nextContent.slice(section.start)).toBe(
          withFrontmatter,
        );
      }
    });
  });

  describe('cutMemorySections（複数節をまとめて切り取る）', () => {
    const multiDoc = [
      '---',
      'type:  premise',
      'description:   複数節',
      '---',
      '# A',
      '本文A',
      '',
      '# B',
      '本文B',
      '',
      '# C',
      '本文C',
      '',
    ].join('\n');
    const find = (heading: string): MemorySection =>
      scanMemorySections(multiDoc).sections.find(
        (section) => section.heading === heading,
      ) as MemorySection;

    it('cutMemorySections は継ぎ足しである — 切り取った文字列と残った文字列から元が復元できる（複数節・飛び飛びでも）', () => {
      const a = find('# A');
      const b = find('# B');
      const c = find('# C');
      const header = multiDoc.slice(0, a.start);
      const pieceA = multiDoc.slice(a.start, a.end);
      const pieceB = multiDoc.slice(b.start, b.end);
      const pieceC = multiDoc.slice(c.start, c.end);

      const { nextContent, cut } = cutMemorySections(multiDoc, [a, c]);

      expect(nextContent).toBe(header + pieceB);
      expect(cut).toBe(pieceA + pieceC);
      expect(header + pieceA + pieceB + pieceC).toBe(multiDoc);
    });

    it('cutMemorySections は frontmatter のバイト列を1バイトも動かさない（複数節でも）', () => {
      const scan = scanMemorySections(multiDoc);

      const { nextContent } = cutMemorySections(multiDoc, [find('# A'), find('# C')]);

      expect(nextContent.slice(0, scan.bodyStart)).toBe(multiDoc.slice(0, scan.bodyStart));
      expect(nextContent).toContain('type:  premise');
      expect(nextContent).toContain('description:   複数節');
    });

    it('cutMemorySections は渡す順に依存しない（逆順に渡しても結果が同じ）', () => {
      const a = find('# A');
      const c = find('# C');

      const forward = cutMemorySections(multiDoc, [a, c]);
      const backward = cutMemorySections(multiDoc, [c, a]);

      expect(backward).toEqual(forward);
    });
  });

  describe('findOverlappingMemorySections（範囲の重なりの検査）', () => {
    const sections = () => scanMemorySections(withFrontmatter).sections;
    const find = (heading: string): MemorySection =>
      sections().find((section) => section.heading === heading) as MemorySection;

    it('親と子を同時に指すと重なりとして拾う（end は子込みなので、親を切ると子も一緒に動く）', () => {
      const parent = find('## 経歴');
      const child = find('### だから');

      const overlap = findOverlappingMemorySections([parent, child]);

      expect(overlap).not.toBeNull();
      expect([overlap?.first.heading, overlap?.second.heading]).toEqual(['## 経歴', '### だから']);
    });

    it('同じ節id を2回渡すのも重なりとして拾う（範囲が完全に一致する）', () => {
      const section = find('## 例');

      expect(findOverlappingMemorySections([section, section])).not.toBeNull();
    });

    it('隣り合う兄弟は重なりではない（誤検出しない。渡す順にも依存しない）', () => {
      const keireki = find('## 経歴');
      const rei = find('## 例');

      expect(findOverlappingMemorySections([keireki, rei])).toBeNull();
      expect(findOverlappingMemorySections([rei, keireki])).toBeNull();
    });

    it('空配列・1件だけなら null（重なりようがない）', () => {
      expect(findOverlappingMemorySections([])).toBeNull();
      expect(findOverlappingMemorySections([find('## 経歴')])).toBeNull();
    });
  });

  describe('findMemorySectionHierarchyJumps（階層飛びの子孫を探す。issue #1382）', () => {
    const sections = () => scanMemorySections(withFrontmatter).sections;
    const find = (heading: string): MemorySection =>
      sections().find((section) => section.heading === heading) as MemorySection;

    it('1段ずつの通常の親子では何も鳴らない（正しい入れ子まで警告しない）', () => {
      expect(findMemorySectionHierarchyJumps(sections(), find('# 私について'))).toEqual([]);
      expect(findMemorySectionHierarchyJumps(sections(), find('## 経歴'))).toEqual([]);
    });

    it('親の直下に2段深い見出しが直接ぶら下がると検出する（### を挟まず ## → ####）', () => {
      const doc = [
        '## 親',
        '親本文',
        '',
        '#### 無関係な規則（### を挟んでいない）',
        '子本文',
        '',
        '## 兄弟',
        '兄弟本文',
        '',
      ].join('\n');
      const all = scanMemorySections(doc).sections;
      const parent = all.find((section) => section.heading === '## 親') as MemorySection;
      const jumper = all.find(
        (section) => section.heading === '#### 無関係な規則（### を挟んでいない）',
      ) as MemorySection;

      const jumps = findMemorySectionHierarchyJumps(all, parent);

      expect(jumps).toHaveLength(1);
      expect(jumps[0]?.section.id).toBe(jumper.id);
      expect(jumps[0]?.parent.id).toBe(parent.id);
      expect(jumps[0]?.gap).toBe(2);
    });

    it('飛びは直近の親を基準に判定する（孫のさらに孫の飛びは、祖父ではなく直近の親との差で見る）', () => {
      const doc = [
        '## 親',
        '親本文',
        '',
        '### 通常の子（1段。飛んでいない）',
        '子本文',
        '',
        '###### さらに孫（子から3段。飛んでいる）',
        '孫本文',
        '',
      ].join('\n');
      const all = scanMemorySections(doc).sections;
      const parent = all.find((section) => section.heading === '## 親') as MemorySection;
      const child = all.find(
        (section) => section.heading === '### 通常の子（1段。飛んでいない）',
      ) as MemorySection;
      const grandchild = all.find(
        (section) => section.heading === '###### さらに孫（子から3段。飛んでいる）',
      ) as MemorySection;

      const jumps = findMemorySectionHierarchyJumps(all, parent);

      expect(jumps).toHaveLength(1);
      expect(jumps[0]?.section.id).toBe(grandchild.id);
      expect(jumps[0]?.parent.id).toBe(child.id);
      expect(jumps[0]?.gap).toBe(3);
    });

    // 兄弟どうしは prev.end === next.start: スタックの pop 条件が `<=` でなく `<` だと、閉じた前の兄弟が残って後続の「直近の親」を取り違え、2件目の検出漏れになる。
    it('隣り合う兄弟どうしは、互いを親と誤認せずそれぞれ独立に root からの飛びを判定する', () => {
      const doc = [
        '## 親',
        '親本文',
        '',
        '##### 兄（親から3段飛んでいる。#/##/### を挟んでいない）',
        '兄本文',
        '',
        '##### 弟（兄の兄弟。同じく親から3段飛んでいる）',
        '弟本文',
        '',
      ].join('\n');
      const all = scanMemorySections(doc).sections;
      const parent = all.find((section) => section.heading === '## 親') as MemorySection;
      const elder = all.find(
        (section) => section.heading === '##### 兄（親から3段飛んでいる。#/##/### を挟んでいない）',
      ) as MemorySection;
      const younger = all.find(
        (section) => section.heading === '##### 弟（兄の兄弟。同じく親から3段飛んでいる）',
      ) as MemorySection;

      const jumps = findMemorySectionHierarchyJumps(all, parent);

      expect(jumps).toHaveLength(2);
      const bySection = new Map(jumps.map((jump) => [jump.section.id, jump]));
      expect(bySection.get(elder.id)?.parent.id).toBe(parent.id);
      expect(bySection.get(elder.id)?.gap).toBe(3);
      expect(bySection.get(younger.id)?.parent.id).toBe(parent.id);
      expect(bySection.get(younger.id)?.gap).toBe(3);
    });

    it('root に子孫が無ければ空配列', () => {
      const leaf = find('#### さらに');
      expect(findMemorySectionHierarchyJumps(sections(), leaf)).toEqual([]);
    });
  });

  describe('describeMemorySectionMoveHierarchyJumpWarning（応答へ足す警告文。issue #1382）', () => {
    it('階層飛びが無ければ null（応答に1行も足さない）', () => {
      const all = scanMemorySections(withFrontmatter).sections;
      const parent = all.find((section) => section.heading === '## 経歴') as MemorySection;

      expect(describeMemorySectionMoveHierarchyJumpWarning(all, [parent])).toBeNull();
    });

    it('階層飛びが在れば、子孫の総数と飛びの件数を数えた警告文を返す（拒否の語を使わない）', () => {
      const doc = [
        '## 親',
        '親本文',
        '',
        '### 通常の子',
        '子本文',
        '',
        '##### 飛んだ孫',
        '孫本文',
        '',
      ].join('\n');
      const all = scanMemorySections(doc).sections;
      const parent = all.find((section) => section.heading === '## 親') as MemorySection;

      const warning = describeMemorySectionMoveHierarchyJumpWarning(all, [parent]);

      expect(warning).not.toBeNull();
      expect(warning).toContain('子孫 2 件のうち 1 件');
      expect(warning).toContain('飛んだ孫');
      expect(warning).not.toContain('断る');
      expect(warning).not.toContain('何も変わっていない');
    });

    it('複数 root をまとめて渡すと、件数は根をまたいだ合計になる', () => {
      const docA = ['## A', '本文', '', '#### Aの飛び', '本文', ''].join('\n');
      const docB = ['## B', '本文', '', '#### Bの飛び', '本文', ''].join('\n');
      const combined = `${docA}\n${docB}`;
      const all = scanMemorySections(combined).sections;
      const a = all.find((section) => section.heading === '## A') as MemorySection;
      const b = all.find((section) => section.heading === '## B') as MemorySection;

      const warning = describeMemorySectionMoveHierarchyJumpWarning(all, [a, b]);

      expect(warning).toContain('子孫 2 件のうち 2 件');
      expect(warning).toContain('Aの飛び');
      expect(warning).toContain('Bの飛び');
    });

    it('一覧は文字数の予算で切る（MEMORY_SECTION_MOVE_HIERARCHY_JUMP_LIST_BUDGET）', () => {
      const jumperHeadings = Array.from(
        { length: 40 },
        (_, index) => `#### 飛び${index}あああああああ`,
      );
      const doc = [
        '## 親',
        '親本文',
        '',
        ...jumperHeadings.flatMap((heading) => [heading, '本文', '']),
      ].join('\n');
      const all = scanMemorySections(doc).sections;
      const parent = all.find((section) => section.heading === '## 親') as MemorySection;

      const warning = describeMemorySectionMoveHierarchyJumpWarning(all, [parent]);

      expect(warning).not.toBeNull();
      expect(warning).toContain('件は一覧から省略');
      expect((warning as string).length).toBeLessThan(
        MEMORY_SECTION_MOVE_HIERARCHY_JUMP_LIST_BUDGET + 600,
      );
    });
  });

  it('memoryBodyStart は frontmatterBody（applyMemoryFrontmatterPatch が使う側）と一致する', () => {
    // 本文の始まりが2つの実装に分かれると、frontmatter を添字で運ぶ側が本文の一部を frontmatter として運ぶ形で壊れる。
    const cases = [
      '---\ndescription: x\n---\n# A\n本文\n',
      '---\ndescription: x\n---\n',
      '---\ndescription: x\n---',
      '# A\n本文\n',
      '---\n閉じが無い\n# A\n',
      '',
    ];
    for (const content of cases) {
      const patched =
        parseMemoryFrontmatter(content).kind === 'malformed'
          ? null
          : applyMemoryFrontmatterPatch(content, {});
      if (patched !== null)
        expect(patched.endsWith(content.slice(memoryBodyStart(content)))).toBe(true);
    }
  });

  // 節ごとに中身を変える: 中身まで同一の節は節id が衝突し、`renderMemoryOutline` がその行へ ⚠ を付ける。
  const flood = (count: number): string =>
    Array.from({ length: count }, (_, index) => `## 節${index}\n${'あ'.repeat(50)}${index}\n`).join(
      '\n',
    );

  describe('renderMemoryOutline', () => {
    it('本文を1文字も出さない（出るのは節id・見出し行・文字数だけ）', () => {
      const doc = ['# 見出し', 'SECRET-XYZ-999', '', '## 子', 'SECRET-XYZ-999', ''].join('\n');

      const outline = renderMemoryOutline(scanMemorySections(doc).sections);

      expect(outline).not.toContain('SECRET-XYZ-999');
      expect(outline).toContain('# 見出し');
      expect(outline).toContain('## 子');
    });

    it('frontmatter の行を1つも出さない', () => {
      const outline = renderMemoryOutline(scanMemorySections(withFrontmatter).sections);

      expect(outline).not.toContain('description:');
      expect(outline).not.toContain('type:');
      expect(outline).not.toContain('---');
    });

    it('インデントが見出しの深さを表す', () => {
      const lines = renderMemoryOutline(scanMemorySections(withFrontmatter).sections).split('\n');

      expect(lines[0]).toMatch(/^\[/);
      expect(lines[1]).toMatch(/^ {2}\[/);
      expect(lines[2]).toMatch(/^ {4}\[/);
      expect(lines[3]).toMatch(/^ {6}\[/);
    });

    it('中身まで同一の節が2つあると、その id の行に「この id では動かせない」と印が出る', () => {
      const doc = '# A\n本文\n\n# A\n本文\n\n# B\n終わり\n';

      const outline = renderMemoryOutline(scanMemorySections(doc).sections);

      expect(outline.match(/この id では動かせない/g)?.length).toBe(2);
    });

    it('節が1つも無いなら、そう返す（黙って空を返さない）', () => {
      expect(renderMemoryOutline(scanMemorySections('前書きだけである。\n').sections)).toContain(
        '節が1つも無い',
      );
    });

    it('件数ではなく文字数の予算で切り、切ったことを必ず言う', () => {
      const outline = renderMemoryOutline(scanMemorySections(flood(400)).sections);

      expect(outline).toMatch(/末尾 \d+ 節は省略/);
      expect(outline).toContain('全 400 件');
    });

    describe("side（予算で落とす側を選ぶ。既定は 'head'）", () => {
      const many = flood(400);
      const sectionsOf = () => scanMemorySections(many).sections;
      const idsIn = (outline: string): string[] =>
        [...outline.matchAll(/\[([0-9a-f]{8}-[0-9a-f]{8})\]/g)].map((match) => match[1] as string);

      it("⭐ side='tail' は、既定の目次には出てこない末尾側の節id を出す", () => {
        const sections = sectionsOf();
        const first = sections[0]!;
        const last = sections[sections.length - 1]!;

        const head = renderMemoryOutline(sections);
        const tail = renderMemoryOutline(sections, 'tail');

        expect(head).toContain(first.id);
        expect(head).not.toContain(last.id);
        expect(tail).toContain(last.id);
        expect(tail).not.toContain(first.id);
      });

      it('⭐ 断り書きが「どちら側を」「何節」省いたかを言う（どちらの向きでも）', () => {
        const sections = sectionsOf();

        expect(renderMemoryOutline(sections)).toMatch(
          /…末尾 \d+ 節は省略（節は全 400 件あり、先頭から \d+ 件だけ出した）。/,
        );
        expect(renderMemoryOutline(sections, 'tail')).toMatch(
          /…先頭 \d+ 節は省略（節は全 400 件あり、末尾から \d+ 件だけ出した）。/,
        );
      });

      it('断り書きが続きの取り方を案内する（既定は side=tail へ、tail は既定へ）', () => {
        const sections = sectionsOf();

        expect(renderMemoryOutline(sections)).toContain('side=tail');
        expect(renderMemoryOutline(sections, 'tail')).toContain('side を渡さずに呼べば出る');
        // 「中央」の語だけを測らない: 逆のことを言う文面（「中央も出る」）が素通りする。
        expect(renderMemoryOutline(sections)).toContain('どちらの向きでも出ない');
        expect(renderMemoryOutline(sections, 'tail')).toContain('どちらの向きでも出ない');
      });

      it('断り書きは穴が空いている側へ置く（既定は最後の行、tail は先頭の行）', () => {
        const head = renderMemoryOutline(sectionsOf()).split('\n');
        const tail = renderMemoryOutline(sectionsOf(), 'tail').split('\n');

        expect(head.at(-1)).toContain('節は省略');
        expect(head[0]).not.toContain('節は省略');
        expect(tail[0]).toContain('節は省略');
        expect(tail.at(-1)).not.toContain('節は省略');
      });

      it("引数を渡さないのは side='head' と同じ（既定の向きを変えていない）", () => {
        const sections = sectionsOf();

        expect(renderMemoryOutline(sections)).toBe(renderMemoryOutline(sections, 'head'));
      });

      it('⭐ 出る節id は並びの端そのもので、向きで1文字も変わらない', () => {
        const sections = sectionsOf();
        const all = sections.map((section) => section.id);

        const headIds = idsIn(renderMemoryOutline(sections));
        const tailIds = idsIn(renderMemoryOutline(sections, 'tail'));

        expect(headIds.length).toBeGreaterThan(1);
        expect(tailIds.length).toBeGreaterThan(1);
        expect(all.slice(0, headIds.length)).toEqual(headIds);
        expect(all.slice(-tailIds.length)).toEqual(tailIds);
      });

      it('予算に入りきる文書では、向きを渡しても出力が1文字も変わらない（切っていない）', () => {
        const sections = scanMemorySections(withFrontmatter).sections;

        expect(renderMemoryOutline(sections, 'tail')).toBe(renderMemoryOutline(sections, 'head'));
        expect(renderMemoryOutline(sections, 'tail')).not.toContain('節は省略');
      });

      it("side='tail' でも本文を1文字も出さない（向きを足しても消えない性質）", () => {
        const doc = ['# 見出し', 'SECRET-XYZ-999', '', '## 子', 'SECRET-XYZ-999', ''].join('\n');

        const outline = renderMemoryOutline(scanMemorySections(doc).sections, 'tail');

        expect(outline).not.toContain('SECRET-XYZ-999');
        expect(outline).toContain('## 子');
      });
    });

    // 期待値は逐語（'8,000'）で持つ: 定数を import すると、実装側の定数を差し替える変異で比較の両側が一緒に動いて素通りする。
    describe('省略の断り書きに足す予算の注記（3点が同時に見える）', () => {
      const sections = () => scanMemorySections(flood(400)).sections;

      it('値・何を切る予算か・別の予算の名前の3つが head 側の断り書きに見える', () => {
        const outline = renderMemoryOutline(sections());

        expect(outline).toContain('8,000');
        expect(outline).toContain('memory_outline の1回のツール応答');
        expect(outline).toContain('毎ターン全員が払う焼き込み');
        expect(outline).toContain('MEMORY_LISTING_BUDGET');
      });

      it('同じ3点が tail 側の断り書きにも見える（共有の1文字列を使っている）', () => {
        const outline = renderMemoryOutline(sections(), 'tail');

        expect(outline).toContain('8,000');
        expect(outline).toContain('memory_outline の1回のツール応答');
        expect(outline).toContain('毎ターン全員が払う焼き込み');
        expect(outline).toContain('MEMORY_LISTING_BUDGET');
      });

      it('MEMORY_LISTING_BUDGET といまの値が一致しているので「別の予算である」と言う', () => {
        expect(MEMORY_LISTING_BUDGET).toBe(8_000);

        const outline = renderMemoryOutline(sections());

        expect(outline).toContain('別の予算である');
        expect(outline).not.toContain('値が一致しない');
      });

      it('自身を「目次」と呼ばない（取り違えの発端はこの語の重複だった）', () => {
        const outline = renderMemoryOutline(sections());
        const tailOutline = renderMemoryOutline(sections(), 'tail');

        expect(outline).not.toContain('次の目次がそこへ届く');
        expect(tailOutline).toContain('次に memory_outline を呼んだときの応答にそれが載る');
      });

      it('⭐ memory.ts の中で 8,000 を持つ MEMORY_*_BUDGET 定数を、断り書きが漏れなく名指しする', () => {
        const source = readFileSync(fileURLToPath(new URL('./memory.ts', import.meta.url)), 'utf8');
        const byName = new Map<string, number>();
        for (const match of source.matchAll(/export const (MEMORY_\w*_BUDGET) = ([\d_]+);/g)) {
          byName.set(match[1] as string, Number((match[2] as string).replace(/_/g, '')));
        }

        expect(byName.get('MEMORY_OUTLINE_BUDGET')).toBe(8_000);
        const siblings = [...byName.entries()]
          .filter(([name, value]) => name !== 'MEMORY_OUTLINE_BUDGET' && value === 8_000)
          .map(([name]) => name)
          .sort();

        expect(siblings).toEqual(['MEMORY_LISTING_BUDGET']);

        const outline = renderMemoryOutline(sections());
        for (const name of siblings) expect(outline).toContain(name);
      });

      // 「MCP の出力上限」のような短い逐語では測らない: scope 側の文にも同じ語があり、族の名乗りの文を消しても緑のままになる。
      it('⭐ 族の名乗り（「他にもある」）が head 側の断り書きに見える（scope 側の「MCP の出力上限」とは別の逐語で測る）', () => {
        const outline = renderMemoryOutline(sections());

        expect(outline).toContain('この数字だけではどの予算かは決まらない');
        expect(outline).toContain('同じ理由で同じ値を持つ予算が他にもある');
        expect(outline).toContain(
          '（MCP の出力上限）という理由で道具の応答を切る予算に共通して使われている値であり',
        );
      });

      it('⭐ 同じ族の名乗りが tail 側の断り書きにも見える（共有の1文字列を使っている）', () => {
        const outline = renderMemoryOutline(sections(), 'tail');

        expect(outline).toContain('この数字だけではどの予算かは決まらない');
        expect(outline).toContain('同じ理由で同じ値を持つ予算が他にもある');
        expect(outline).toContain(
          '（MCP の出力上限）という理由で道具の応答を切る予算に共通して使われている値であり',
        );
      });

      it('⚠️ 族の名乗りは個体名（MEMORY_LISTING_BUDGET 以外の定数名・memory_list）を挙げない', () => {
        const outline = renderMemoryOutline(sections());
        // 族の名乗りの文だけを抜き出して測る: 断り書き全体への not.toContain だと sibling 側の名指しごと壊れる。
        const familyStart = outline.indexOf('そして');
        expect(familyStart).toBeGreaterThan(-1);
        const family = outline.slice(familyStart);

        expect(family).not.toContain('MEMORY_LISTING_BUDGET');
        expect(family).not.toContain('memory_list');
      });
    });

    describe('q（見出しの絞り込み）と offset（窓をずらす）', () => {
      it('⭐ q も offset も渡さないとき、出力は1文字も変わらない（オプション形・省略の両方）', () => {
        const sections = scanMemorySections(flood(400)).sections;

        const bare = renderMemoryOutline(sections);
        const emptyOptions = renderMemoryOutline(sections, {});
        const explicitHead = renderMemoryOutline(sections, { side: 'head' });
        const stringForm = renderMemoryOutline(sections, 'head');

        expect(emptyOptions).toBe(bare);
        expect(explicitHead).toBe(bare);
        expect(stringForm).toBe(bare);
      });

      it('q が見出しに1つも一致しないとき、一致0件だと明示する（予算で切れたのとは違う文言）', () => {
        const sections = scanMemorySections('# 見出しA\n本文\n\n# 見出しB\n本文\n').sections;

        const outline = renderMemoryOutline(sections, { q: 'ぜったい出てこない文字列XYZ' });

        expect(outline).toContain('一致0件');
        expect(outline).toContain('全 2 節を検索した');
        expect(outline).not.toContain('予算で省略');
        expect(outline).not.toContain('全件を載せた');
      });

      it('q は大文字小文字を区別しない部分一致で見出しを絞り込む', () => {
        const sections = scanMemorySections(
          '# Alpha Section\n本文\n\n# beta section\n本文\n\n# gamma\n本文\n',
        ).sections;

        const outline = renderMemoryOutline(sections, { q: 'SECTION' });

        expect(outline).toContain('Alpha Section');
        expect(outline).toContain('beta section');
        expect(outline).not.toContain('gamma');
        expect(outline).toContain('全 3 節のうち 2 節が一致した');
      });

      it('q に一致はあるが全件が予算に収まるとき「全件を載せた」と言い、一致0件とは違う文言になる', () => {
        const sections = scanMemorySections('# Alpha\n本文\n\n# Beta\n本文\n').sections;

        const outline = renderMemoryOutline(sections, { q: 'Alpha' });

        expect(outline).toContain('全 2 節のうち 1 節が一致した');
        expect(outline).toContain('全件を載せた');
        expect(outline).not.toContain('一致0件');
      });

      it('⭐ q に一致した節が予算で切れたとき、一致0件とは別の文言で「予算で省略」と言う', () => {
        const many = Array.from(
          { length: 400 },
          (_, index) => `## マッチ対象-${index}\n${'あ'.repeat(50)}${index}\n`,
        ).join('\n');
        const sections = scanMemorySections(many).sections;

        const outline = renderMemoryOutline(sections, { q: 'マッチ対象' });

        expect(outline).toContain('全 400 節のうち 400 節が一致した');
        expect(outline).toContain('予算で省略');
        expect(outline).not.toContain('一致0件');
        expect(outline).not.toContain('全件を載せた');
      });

      it('q は side と併用でき、絞り込んだ結果を末尾から詰められる', () => {
        const many = Array.from(
          { length: 400 },
          (_, index) => `## マッチ対象-${index}\n${'あ'.repeat(50)}${index}\n`,
        ).join('\n');
        const sections = scanMemorySections(many).sections;
        const first = sections[0]!;
        const last = sections[sections.length - 1]!;

        const headOutline = renderMemoryOutline(sections, { q: 'マッチ対象', side: 'head' });
        const tailOutline = renderMemoryOutline(sections, { q: 'マッチ対象', side: 'tail' });

        expect(headOutline).toContain(first.id);
        expect(headOutline).not.toContain(last.id);
        expect(tailOutline).toContain(last.id);
        expect(tailOutline).not.toContain(first.id);
      });

      it.each(['.', '*', '[', '(', '\\', '(a', '[a-z]', 'a.b', 'a*b', 'a\\b'])(
        '⭐ q=%s のような正規表現のメタ文字を渡しても壊れない',
        (needle) => {
          const sections = scanMemorySections('# 見出しA\n本文\n\n# 見出しB\n本文\n').sections;

          expect(() => renderMemoryOutline(sections, { q: needle })).not.toThrow();
          expect(renderMemoryOutline(sections, { q: needle })).toContain('一致0件');
        },
      );

      it('q のメタ文字が見出しに literal に含まれていれば、その並びとして一致する', () => {
        const sections = scanMemorySections('# a.b special\n本文\n\n# axb other\n本文\n').sections;

        const outline = renderMemoryOutline(sections, { q: 'a.b' });

        expect(outline).toContain('全 2 節のうち 1 節が一致した');
        expect(outline).toContain('a.b special');
        expect(outline).not.toContain('axb other');
      });

      it('offset は先頭から N 節を飛ばしてから予算を埋める', () => {
        const sections = scanMemorySections(flood(10)).sections;

        const fromStart = renderMemoryOutline(sections, { offset: 0 });
        const fromThree = renderMemoryOutline(sections, { offset: 3 });

        expect(fromStart).toContain(sections[0]!.id);
        expect(fromThree).not.toContain(sections[0]!.id);
        expect(fromThree).not.toContain(sections[1]!.id);
        expect(fromThree).not.toContain(sections[2]!.id);
        expect(fromThree).toContain(sections[3]!.id);
      });

      it('offset は範囲外（節数以上）なら黙って空を返さず、明示して断る', () => {
        const sections = scanMemorySections('# A\n本文\n\n# B\n本文\n').sections;

        const outline = renderMemoryOutline(sections, { offset: 5 });

        expect(outline).toContain('offset=5');
        expect(outline).toContain('節は無い');
        expect(outline).toContain('全 2 節');
      });

      // offset === 節数 を単独で固定する: 節数より大きい値だけでは、`>=` を `>` に弱めるオフバイワンを検出できない。
      it('offset はちょうど節数と同じ値でも範囲外として断る（境界値。節数より大きい値だけでは区別できない）', () => {
        const sections = scanMemorySections('# A\n本文\n\n# B\n本文\n').sections;

        const outline = renderMemoryOutline(sections, { offset: 2 });

        expect(outline).toContain('offset=2');
        expect(outline).toContain('節は無い');
        expect(outline).toContain('全 2 節');
      });

      it('offset は続きの offset の値そのものと、いま何節目から何節目までかを言う', () => {
        const sections = scanMemorySections(flood(400)).sections;

        const outline = renderMemoryOutline(sections, { offset: 0 });

        expect(outline).toMatch(/1〜\d+ 節目 \/ 全 400 節のうち \d+ 節を出した。/);
        expect(outline).toMatch(/続きが在る。次は offset=\d+ で呼ぶこと/);
      });

      it('offset が最後まで届くと「続きは無い」と言う', () => {
        const sections = scanMemorySections('# A\n本文\n\n# B\n本文\n').sections;

        const outline = renderMemoryOutline(sections, { offset: 1 });

        expect(outline).toContain('続きは無い（最後まで出した）');
      });

      it('⭐⭐ offset を窓の大きさぶんずつ進めれば、有限回の呼び出しで全節id が出る（到達漏れ0件の根拠）', () => {
        const sections = scanMemorySections(flood(2000)).sections;
        const allIds = new Set(sections.map((section) => section.id));

        const seenIds = new Set<string>();
        let offset = 0;
        let iterations = 0;
        const MAX_ITERATIONS = 2000;

        for (;;) {
          iterations += 1;
          if (iterations > MAX_ITERATIONS) {
            throw new Error(`offset を進めても終わらない（${MAX_ITERATIONS} 回で打ち切り）`);
          }
          const outline = renderMemoryOutline(sections, { offset });
          for (const match of outline.matchAll(/\[([0-9a-f]{8}-[0-9a-f]{8})\]/g)) {
            seenIds.add(match[1] as string);
          }
          const more = /続きが在る。次は offset=(\d+) で呼ぶこと/.exec(outline);
          if (!more) break;
          offset = Number(more[1]);
        }

        expect(seenIds).toEqual(allIds);
        expect(iterations).toBeLessThan(sections.length);
      });

      it('offset は side を見ない（渡しても既定の先頭からの詰め方のまま）', () => {
        const sections = scanMemorySections(flood(10)).sections;

        const withoutSide = renderMemoryOutline(sections, { offset: 2 });
        const withTailSide = renderMemoryOutline(sections, { offset: 2, side: 'tail' });

        expect(withoutSide).toBe(withTailSide);
      });

      it('q と offset は併用でき、offset は絞り込んだ結果に対して窓を開く', () => {
        const many = Array.from(
          { length: 20 },
          (_, index) =>
            `## マッチ対象-${index}\n${'あ'.repeat(10)}${index}\n\n## 無関係-${index}\n本文\n`,
        ).join('\n');
        const sections = scanMemorySections(many).sections;
        const matched = sections.filter((section) => section.heading.includes('マッチ対象'));

        const outline = renderMemoryOutline(sections, { q: 'マッチ対象', offset: 0 });

        expect(outline).toContain('全 40 節のうち 20 節が一致した');
        expect(outline).toContain(matched[0]!.id);
        expect(outline).toMatch(/絞り込み後 20 節のうち \d+ 節を出した。/);
      });
    });
  });

  describe('indexed の文書と memory_outline の統合（#805 × #807）', () => {
    const indexedDoc = (body: string): string =>
      ['---', 'description: 要旨である。', 'type: indexed', '---', body].join('\n');

    it('⭐⭐ indexed は節の目次を1つも焼かないが、offset を回せば全節id に到達できる（到達漏れ0件）', () => {
      const content = indexedDoc(flood(2000));
      const sections = scanMemorySections(content).sections;
      const allIds = new Set(sections.map((section) => section.id));

      const card = renderMemoryDocuments([{ slug: 'probe', content }]);
      expect(card).not.toMatch(/\[[0-9a-f]{8}-[0-9a-f]{8}\]/);

      const seenIds = new Set<string>();
      let offset = 0;
      let iterations = 0;
      const MAX_ITERATIONS = 2000;
      for (;;) {
        iterations += 1;
        if (iterations > MAX_ITERATIONS) {
          throw new Error(`offset を進めても終わらない（${MAX_ITERATIONS} 回で打ち切り）`);
        }
        const outline = renderMemoryOutline(sections, { offset });
        for (const match of outline.matchAll(/\[([0-9a-f]{8}-[0-9a-f]{8})\]/g)) {
          seenIds.add(match[1] as string);
        }
        const more = /続きが在る。次は offset=(\d+) で呼ぶこと/.exec(outline);
        if (!more) break;
        offset = Number(more[1]);
      }

      expect(seenIds).toEqual(allIds);
      expect(iterations).toBeLessThan(sections.length);
    });

    // 「本文の語では引けない」は assert しない: 本文は型の上で手元に無く、常に緑になる。代わりに節id・文字数の欄へ q が広がっていないことを測る。
    // 見出しに数字を入れない合成データを使う: 文字数が見出しの数字に偶然当たると、当たった理由が区別できない。
    it('indexed の文書でも q で見出しを引ける。⛔ 節id や文字数へは広がらない（見出しだけを見る）', () => {
      const kana = 'あいうえおかきくけこ';
      const digitFree = (index: number): string =>
        String(index)
          .split('')
          .map((digit) => kana[Number(digit)])
          .join('');
      const body = Array.from(
        { length: 300 },
        (_, index) => `## セクション${digitFree(index)}\n${'ん'.repeat(50)}${digitFree(index)}\n`,
      ).join('\n');
      const content = indexedDoc(
        ['## ミダシダケノゴ を含む見出し', 'この節の本文には目印がある。', '', body].join('\n'),
      );
      const sections = scanMemorySections(content).sections;
      const target = sections.find((section) => section.heading.includes('ミダシダケノゴ'));
      if (target === undefined) throw new Error('合成データが壊れている（目印の節が無い）');

      const byHeading = renderMemoryOutline(sections, { q: 'ミダシダケノゴ' });
      expect(byHeading).toContain('ミダシダケノゴ');
      expect(byHeading).toMatch(/\[[0-9a-f]{8}-[0-9a-f]{8}\]/);

      const byId = renderMemoryOutline(sections, { q: target.id.slice(0, 8) });
      expect(byId).toContain('一致0件');

      const byChars = renderMemoryOutline(sections, { q: String(target.chars) });
      expect(byChars).toContain('一致0件');
    });
  });
});

// 分岐のテストではない: `memory_section_move` の frontmatter 検査へ到達する入力は構成できないので、「検査が鳴ること」ではなく「鳴る入力が無いこと」を性質として測る。
describe('節の切り取りは frontmatter の解釈を変えない（乗っ取りが起こりえない）', () => {
  const documents = [
    '---\ndescription: x\ntype: premise\n---\n# A\n本文\n\n## B\n本文\n',
    '前書き\n---\ndescription: 乗っ取り\n---\n# A\n本文\n\n# B\n本文\n',
    '# A\n本文\n\n---\ndescription: 乗っ取り\n---\n\n# B\n本文\n',
    '---\ndescription: x\n---\n---\ndescription: 乗っ取り\n---\n# A\n本文\n',
    '# A\n本文\n',
    '---\ndescription: x\n---\n# A\n本文\n',
  ];

  it('どの文書のどの節を切り取っても、frontmatter のバイト列も解釈も変わらない', () => {
    for (const content of documents) {
      const scan = scanMemorySections(content);
      const priorKind = parseMemoryFrontmatter(content).kind;
      for (const section of scan.sections) {
        const { nextContent } = cutMemorySections(content, [section]);
        expect(nextContent.slice(0, scan.bodyStart)).toBe(content.slice(0, scan.bodyStart));
        expect(parseMemoryFrontmatter(nextContent).kind).toBe(priorKind);
      }
    }
  });

  it('切り取った文字列は必ず見出し行から始まる（移し先の先頭に frontmatter を作れない）', () => {
    for (const content of documents) {
      for (const section of scanMemorySections(content).sections) {
        const { cut } = cutMemorySections(content, [section]);
        expect(cut.split('\n')[0]).toMatch(/^#{1,6}\s/);
      }
    }
  });
});

// 器に premise 2件 + fact 1件を必ず持たせる: fact が0件だと premise 絞りを外す変異が同値で生存し、premise が0件だと逆側の分岐が測れない。
describe('measureMemoryFloor — 焼き込みの大きさを測る（記憶の肥大への恒久対策）', () => {
  function mixedDocs(): MemoryPart[] {
    return [
      premise('p-small', '短い前提'),
      premise('p-large', 'あ'.repeat(500)),
      fact('f-one', { description: '要旨', freshness: { kind: 'fresh' } }),
    ];
  }

  it('⭐ totalChars は renderMemoryDocuments(documents).length と厳密に一致する（複数の器で）', () => {
    const fixtures: MemoryPart[][] = [
      [],
      [premise('only-premise', '本文')],
      [fact('only-fact', { description: '要旨', freshness: { kind: 'fresh' } })],
      mixedDocs(),
      [{ slug: 'broken', content: '---\nauthor: 未知のキー\n---\n# Broken\n本文' }],
      [fact('orphan', { description: '説明', freshness: { kind: 'fresh' }, parent: 'not-exist' })],
    ];
    for (const docs of fixtures) {
      expect(measureMemoryFloor(docs).totalChars).toBe(renderMemoryDocuments(docs).length);
    }
  });

  it('premise 合計は premise の文書だけの合計に一致し、fact の分を含まない（器に fact 1件必須）', () => {
    const docs = mixedDocs();
    const floor = measureMemoryFloor(docs);
    const premiseOnlyRendered = renderMemoryDocuments(
      docs.filter((doc) => doc.slug.startsWith('p-')),
    );

    expect(floor.premiseDocs).toBe(2);
    expect(floor.factDocs).toBe(1);
    expect(floor.premiseChars).toBe(premiseOnlyRendered.length);
    expect(floor.totalChars).toBeGreaterThan(floor.premiseChars);
    expect(floor.tocChars).toBeGreaterThan(0);
  });

  it('largestPremise は最も大きい premise を指す（`renderPremisePart` の結果の長さで比べる）', () => {
    const docs = mixedDocs();
    const floor = measureMemoryFloor(docs);
    expect(floor.largestPremise?.slug).toBe('p-large');
    // 数を書き写さない: 実際に載る形の長さと一致することを測る。器が変わっても腐らない。
    const largeRendered = renderMemoryDocuments(docs.filter((doc) => doc.slug === 'p-large'));
    expect(floor.largestPremise?.chars).toBe(largeRendered.length);
    const smallRendered = renderMemoryDocuments(docs.filter((doc) => doc.slug === 'p-small'));
    expect(largeRendered.length).toBeGreaterThan(smallRendered.length);
  });

  it('premise が1件も無ければ largestPremise は null', () => {
    const floor = measureMemoryFloor([
      fact('only-fact', { description: '要旨', freshness: { kind: 'fresh' } }),
    ]);
    expect(floor.largestPremise).toBeNull();
  });

  it('malformed な frontmatter の premise は、注記込みの長さで数える（`content.length` ではない）', () => {
    const broken: MemoryPart = {
      slug: 'broken',
      content: '---\nauthor: 未知のキー\n---\n# Broken\n本文',
    };
    const floor = measureMemoryFloor([broken]);
    expect(floor.totalChars).toBeGreaterThan(broken.content.length);
    expect(floor.largestPremise?.chars).toBe(floor.totalChars);
  });

  it('単位は文字（String.length）であって bytes ではない', () => {
    const docs = [premise('zenkaku', '価値観です')];
    const floor = measureMemoryFloor(docs);
    const rendered = renderMemoryDocuments(docs);
    expect(floor.totalChars).toBe(rendered.length);
    expect(floor.totalChars).not.toBe(Buffer.byteLength(rendered, 'utf8'));
  });

  it('⭐ 記憶を1バイトも書き換えない（`MemoryPart[]` を受け取るだけの純粋関数）', () => {
    const docs = mixedDocs();
    const before = docs.map((doc) => doc.content);
    measureMemoryFloor(docs);
    expect(docs.map((doc) => doc.content)).toEqual(before);
  });
});

describe('measurePremiseOutlineFit / MemoryFloor.outlineSaturatedPremise — 目次の崖（#772）', () => {
  it('切れていない文書に対して null を返す（節が少ない文書）', () => {
    const doc = manySectionPremise('small', 3);
    expect(renderMemoryDocuments([doc])).not.toContain('節は目次から省略');
    expect(measurePremiseOutlineFit(doc)).toBeNull();
  });

  it('節が1つも無い文書に対して null を返す', () => {
    const doc: MemoryPart = { slug: 'no-sections', content: '見出しの無い前書きだけ' };
    expect(measurePremiseOutlineFit(doc)).toBeNull();
  });

  it('⭐ 切れている文書に対して返す rest/shown/total が、断り書きの中の数と一致する', () => {
    const doc = manySectionPremise('saturated', 400);
    const fit = measurePremiseOutlineFit(doc);
    expect(fit).not.toBeNull();

    const rendered = renderMemoryDocuments([doc]);
    const hit =
      /末尾 ([\d,]+) 節は目次から省略（全 ([\d,]+) 節のうち先頭 ([\d,]+) 節だけ載せた）/.exec(
        rendered,
      );
    expect(hit).not.toBeNull();
    const [, rest = '', total = '', shown = ''] = hit as RegExpExecArray;
    const toNumber = (s: string) => Number(s.replace(/,/g, ''));

    expect(fit?.rest).toBe(toNumber(rest));
    expect(fit?.total).toBe(toNumber(total));
    expect(fit?.shown).toBe(toNumber(shown));
    expect(fit!.shown + fit!.rest).toBe(fit!.total);
  });

  // リテラル（85 等）は書かない: 見出し長で動く。`measurePremiseOutlineFit` が返す shown を使う。
  it('⭐⭐ shown は崖そのものである（先頭 shown 節では省略が出ず、shown+1 節では出る）', () => {
    const headingLength = 40;
    const saturated = manySectionPremise('cliff-source', 400, headingLength);
    const fit = measurePremiseOutlineFit(saturated);
    expect(fit).not.toBeNull();
    const shown = fit!.shown;
    expect(shown).toBeGreaterThan(0);
    expect(shown).toBeLessThan(400);

    const exactlyShown = manySectionPremise('cliff-exact', shown, headingLength);
    expect(measurePremiseOutlineFit(exactlyShown)).toBeNull();
    expect(renderMemoryDocuments([exactlyShown])).not.toContain('節は目次から省略');

    const oneMore = manySectionPremise('cliff-plus-one', shown + 1, headingLength);
    const oneMoreFit = measurePremiseOutlineFit(oneMore);
    expect(oneMoreFit).not.toBeNull();
    expect(oneMoreFit?.rest).toBe(1);
    expect(oneMoreFit?.shown).toBe(shown);
    expect(renderMemoryDocuments([oneMore])).toContain('節は目次から省略');
  });

  it('measureMemoryFloor(...).outlineSaturatedPremise は、切れている premise だけを含む', () => {
    const saturated = manySectionPremise('floor-saturated', 400);
    const notSaturated = premise('floor-small', '短い前提');
    const floor = measureMemoryFloor([saturated, notSaturated]);

    const slugs = floor.outlineSaturatedPremise.map((entry) => entry.slug);
    expect(slugs).toContain('floor-saturated');
    expect(slugs).not.toContain('floor-small');
    expect(floor.outlineSaturatedPremise).toHaveLength(1);
  });

  // demotedPremise（カードごと1行に落ちた文書）は除外する: 目次そのものが焼かれていないので、「目次が予算で切れている」と名乗ると嘘になる。
  it('⚠⚠ outlineSaturatedPremise は、束ねた蓋で1行に落ちた premise を含まない', () => {
    const template = (index: number): MemoryPart => ({
      slug: `outline-demoted-${String(index).padStart(3, '0')}`,
      content: Array.from({ length: 200 }, (_, i) => `## ${'あ'.repeat(20)}${i}\n本文`).join('\n'),
    });

    expect(measurePremiseOutlineFit(template(0))).not.toBeNull();

    const count = 20;
    const docs = Array.from({ length: count }, (_, i) => template(i));
    const floor = measureMemoryFloor(docs);

    expect(floor.demotedPremiseDocs).toBeGreaterThan(0);
    expect(floor.demotedPremiseDocs).toBeLessThan(count);

    expect(floor.outlineSaturatedPremise.length + floor.demotedPremiseDocs).toBe(count);
  });
});

describe('describeMemoryFloor — 「毎ターンの床」の一言（新規作成の枝がいちばん声を大きい）', () => {
  const emptyFloor = measureMemoryFloor([]);

  it('⭐ premise の新規作成では、区分・床の遷移（文字）・「毎ターン何が焼かれるか」の3つが出る', () => {
    const after = measureMemoryFloor([premise('new-doc', 'あ'.repeat(100))]);
    const reply = describeMemoryFloor({
      before: emptyFloor,
      after,
      slug: 'new-doc',
      kind: 'premise',
      created: true,
    });

    expect(reply).toContain('premise');
    expect(reply).toContain(
      `${emptyFloor.totalChars.toLocaleString('en-US')} 文字から ${after.totalChars.toLocaleString('en-US')} 文字へ`,
    );
    expect(reply).toContain('毎ターン「要旨＋節の目次」がクローンの文脈へ焼かれる');
    expect(reply).toContain('memory_section_read');
    expect(reply).toContain('⭐');
  });

  it('fact の新規作成では「全文が焼かれる」の1行が出ない', () => {
    const after = measureMemoryFloor([
      fact('new-fact', { description: '要旨', freshness: { kind: 'fresh' } }),
    ]);
    const reply = describeMemoryFloor({
      before: emptyFloor,
      after,
      slug: 'new-fact',
      kind: 'fact',
      created: true,
    });

    expect(reply).toContain('fact');
    expect(reply).not.toContain('全文がそのままクローンの文脈へ焼かれる');
  });

  it('既存文書の更新（新規作成ではない）では「全文が焼かれる」も⭐も出ない', () => {
    const before = measureMemoryFloor([premise('doc', '短い本文')]);
    const after = measureMemoryFloor([premise('doc', '短い本文をもっと増やした')]);
    const reply = describeMemoryFloor({
      before,
      after,
      slug: 'doc',
      kind: 'premise',
      created: false,
    });

    expect(reply).toContain('premise');
    expect(reply).not.toContain('全文がそのままクローンの文脈へ焼かれる');
    expect(reply).not.toContain('⭐');
  });

  it('⭐ 床が減ったときは増減が負で出る（増えたときは正。符号を単体で固定する）', () => {
    // 器は本文の長さではなく節の数で作り分ける: 焼き込みはカードなので、本文を減らしても載る量はほぼ変わらない。
    const big = measureMemoryFloor([
      premise('doc', ['## 一', '本文', '## 二', '本文', '## 三', '本文'].join('\n')),
    ]);
    const small = measureMemoryFloor([premise('doc', '## 一\n本文')]);

    const shrunk = describeMemoryFloor({
      before: big,
      after: small,
      slug: 'doc',
      kind: 'premise',
      created: false,
    });
    expect(small.totalChars).toBeLessThan(big.totalChars);
    expect(shrunk).toContain(`（${(small.totalChars - big.totalChars).toLocaleString('en-US')}）`);
    expect(shrunk).toContain('-');

    const grown = describeMemoryFloor({
      before: small,
      after: big,
      slug: 'doc',
      kind: 'premise',
      created: false,
    });
    expect(grown).toContain(`（+${(big.totalChars - small.totalChars).toLocaleString('en-US')}）`);
  });

  it('⛔ 既存の語「区分が変わった」を使い回さない（tools.test.ts の歯と同じ語を撃たない）', () => {
    const before = measureMemoryFloor([premise('doc', 'a')]);
    const after = measureMemoryFloor([
      fact('doc', { type: 'fact', description: '要旨', freshness: { kind: 'fresh' } }),
    ]);
    const reply = describeMemoryFloor({ before, after, slug: 'doc', kind: 'fact', created: false });

    expect(reply).not.toContain('区分が変わった');
  });

  // 「文字」を応答全体から探さない: 単位を名乗る行が複数あり、遷移の単位を変えても別の行で合格してしまう。遷移の行に絞る。
  it('単位は文字である（bytes を出していない）', () => {
    const after = measureMemoryFloor([premise('zenkaku', '価値観です')]);
    const reply = describeMemoryFloor({
      before: emptyFloor,
      after,
      slug: 'zenkaku',
      kind: 'premise',
      created: true,
    });
    const transition = reply
      .split('\n')
      .find((line) => line.includes('から') && line.includes('へ'));
    expect(
      transition,
      '床の遷移を名乗る行そのものが応答から消えた（この歯は、その行の単位を測っている）',
    ).toBeDefined();
    expect(
      transition,
      '床の遷移の単位が「文字」でなくなった。この赤の意味は「読み手が、床の数を' +
        '何の単位で読めばよいか分からなくなった」——応答の別の行にまだ「文字」が' +
        '残っていても、遷移の行が名乗っていなければ同じことである。',
    ).toContain('文字');
    expect(reply).not.toContain('bytes');
  });

  it('床の行は「いま読み直した値」であることを名乗る（read→write の間の書き換え窓があるため）', () => {
    const after = measureMemoryFloor([premise('doc', '本文')]);
    const reply = describeMemoryFloor({
      before: emptyFloor,
      after,
      slug: 'doc',
      kind: 'premise',
      created: true,
    });
    expect(reply).toContain('いま読み直した値');
  });

  it('⭐ premise の新規作成では、いま最大の premise の slug と文字数が出る', () => {
    const after = measureMemoryFloor([
      premise('small', '短い'),
      premise('new-doc', 'あ'.repeat(500)),
    ]);
    const reply = describeMemoryFloor({
      before: emptyFloor,
      after,
      slug: 'new-doc',
      kind: 'premise',
      created: true,
    });

    expect(after.largestPremise?.slug).toBe('new-doc');
    expect(reply).toContain('いま最も大きい premise: new-doc');
    expect(reply).toContain(`${after.largestPremise?.chars.toLocaleString('en-US')} 文字`);
  });

  it('⭐ premise の新規作成では、縮める3手順（memory_outline → memory_section_move → memory_frontmatter_set）の道具名が全部出る', () => {
    const after = measureMemoryFloor([premise('new-doc', 'あ'.repeat(500))]);
    const reply = describeMemoryFloor({
      before: emptyFloor,
      after,
      slug: 'new-doc',
      kind: 'premise',
      created: true,
    });

    expect(reply).toContain('memory_outline');
    expect(reply).toContain('memory_section_move');
    expect(reply).toContain('memory_frontmatter_set');
  });

  it('⛔ fact の新規作成には、最大の premise の名指しも3手順も出ない（稀にしか出ない枝専用）', () => {
    const after = measureMemoryFloor([
      premise('some-premise', 'あ'.repeat(500)),
      fact('new-fact', { description: '要旨', freshness: { kind: 'fresh' } }),
    ]);
    const reply = describeMemoryFloor({
      before: emptyFloor,
      after,
      slug: 'new-fact',
      kind: 'fact',
      created: true,
    });

    expect(reply).not.toContain('いま最も大きい premise');
    expect(reply).not.toContain('memory_outline');
    expect(reply).not.toContain('memory_section_move');
    expect(reply).not.toContain('memory_frontmatter_set');
  });

  it('⛔ 既存文書の更新（created: false）には、最大の premise の名指しも3手順も出ない', () => {
    const before = measureMemoryFloor([premise('doc', '短い本文')]);
    const after = measureMemoryFloor([premise('doc', '短い本文をもっと増やした')]);
    const reply = describeMemoryFloor({
      before,
      after,
      slug: 'doc',
      kind: 'premise',
      created: false,
    });

    expect(reply).not.toContain('いま最も大きい premise');
    expect(reply).not.toContain('memory_outline');
    expect(reply).not.toContain('memory_section_move');
    expect(reply).not.toContain('memory_frontmatter_set');
  });

  describe('outlineSaturationNote — 1文書あたりの目次の予算に対する4つの場合（#772）', () => {
    it('⭐ 収まっている → 収まっている: 1文字も出さない（floorLine にも焼き込みにも0）', () => {
      const before = measureMemoryFloor([premise('doc', '短い本文')]);
      const after = measureMemoryFloor([premise('doc', '短い本文をもっと増やした')]);
      const reply = describeMemoryFloor({
        before,
        after,
        slug: 'doc',
        kind: 'premise',
        created: false,
      });

      expect(reply).not.toContain('張り付いている');
      expect(reply).not.toContain('越えた');
      expect(reply).not.toContain('切られなくなった');

      const rendered = renderMemoryDocuments([premise('doc', '短い本文をもっと増やした')]);
      expect(rendered).not.toContain('落ちている');
      expect(rendered).not.toContain('移し切るまで');
    });

    it('A: 張り付き → 張り付き: 「揺れ」の断り（節を移した効果ではない）', () => {
      const before = measureMemoryFloor([manySectionPremise('doc', 400)]);
      const after = measureMemoryFloor([manySectionPremise('doc', 450)]);
      const reply = describeMemoryFloor({
        before,
        after,
        slug: 'doc',
        kind: 'premise',
        created: false,
      });

      const afterFit = after.outlineSaturatedPremise.find((entry) => entry.slug === 'doc');
      expect(afterFit).toBeDefined();
      expect(reply).toContain('張り付いている');
      expect(reply).toContain('この増減は張り付いた領域の中の揺れであって、節を移した効果ではない');
      expect(reply).toContain(`全 ${afterFit!.total.toLocaleString('en-US')} 節`);
      expect(reply).toContain(
        `${afterFit!.shown.toLocaleString('en-US')} 節だけが焼き込みに載っている`,
      );
      expect(reply).toContain(
        `落ちている ${afterFit!.rest.toLocaleString('en-US')} 節を移し切るまで`,
      );
      expect(reply).not.toContain('越えた');
      expect(reply).not.toContain('切られなくなった');
    });

    it('B: 収まっている → 張り付き: 「この書き込みで予算を越えた」（増分は本物）', () => {
      const before = measureMemoryFloor([manySectionPremise('doc', 3)]);
      const after = measureMemoryFloor([manySectionPremise('doc', 400)]);
      const reply = describeMemoryFloor({
        before,
        after,
        slug: 'doc',
        kind: 'premise',
        created: false,
      });

      const afterFit = after.outlineSaturatedPremise.find((entry) => entry.slug === 'doc');
      expect(afterFit).toBeDefined();
      expect(reply).toContain('この書き込みで doc の節の目次が1文書あたりの予算');
      expect(reply).toContain('越えた');
      expect(reply).toContain('この増分は揺れではなく本物である');
      expect(reply).toContain(`${afterFit!.rest.toLocaleString('en-US')} 節が落ちた`);
      expect(reply).not.toContain('張り付いている');
      expect(reply).not.toContain('切られなくなった');
    });

    it('C: 張り付き → 飽和リストから外れた: 「目次で切られなくなった」。⛔ この先どう動くかは言わない', () => {
      const before = measureMemoryFloor([manySectionPremise('doc', 400)]);
      const after = measureMemoryFloor([manySectionPremise('doc', 3)]);
      const reply = describeMemoryFloor({
        before,
        after,
        slug: 'doc',
        kind: 'premise',
        created: false,
      });

      const beforeFit = before.outlineSaturatedPremise.find((entry) => entry.slug === 'doc');
      const afterFit = after.outlineSaturatedPremise.find((entry) => entry.slug === 'doc');
      expect(beforeFit).toBeDefined();
      expect(afterFit).toBeUndefined();
      expect(reply).toContain('切られなくなった');
      expect(reply).toContain('省略の断り書きごと床から落ちた');
      expect(reply).not.toContain('張り付いている');
      expect(reply).not.toContain('越えた');
      expect(reply).not.toContain('節を移した分だけ床が下がる');
    });

    // C は「この先どう動くか」を言わない: 消え方が4通り（収まった／indexed／fact／消えた）あり MemoryFloor は区分を持たず区別できない。indexed へ移った回に「節を移せば床が下がる」は偽になる。
    it('⭐⭐ premise → indexed で飽和が消えた回でも、C は「節を移した分だけ床が下がる」と言わない', () => {
      const saturated = manySectionPremise('doc', 400);
      const asIndexed: MemoryPart = {
        slug: 'doc',
        content: `---\ntype: indexed\ndescription: 付け替えた\n---\n${saturated.content}`,
      };
      const before = measureMemoryFloor([saturated]);
      const after = measureMemoryFloor([asIndexed]);
      expect(before.outlineSaturatedPremise.map((entry) => entry.slug)).toContain('doc');
      expect(after.outlineSaturatedPremise).toHaveLength(0);
      expect(after.indexedDocs).toBe(1);

      const reply = describeMemoryFloor({
        before,
        after,
        slug: 'doc',
        kind: 'indexed',
        created: false,
      });

      expect(reply).toContain('切られなくなった');
      expect(reply).not.toContain('節を移した分だけ床が下がる');
      expect(reply).toContain('区別していない');
    });

    // memory_section_move は移し先の視点で slug を渡す: 名乗るべきは張り付いている当の文書 A であって、input.slug（B）ではない。
    it('⭐⭐ memory_section_move: slug（移し先 B）ではなく、張り付いている移動元 A を名乗る', () => {
      const before = measureMemoryFloor([
        manySectionPremise('a-doc', 400),
        premise('b-doc', '移す前のB'),
      ]);
      const after = measureMemoryFloor([
        manySectionPremise('a-doc', 100),
        premise('b-doc', '移した後のB（節が増えた）'),
      ]);
      const reply = describeMemoryFloor({
        before,
        after,
        slug: 'b-doc',
        kind: 'premise',
        created: false,
      });

      const beforeAFit = before.outlineSaturatedPremise.find((entry) => entry.slug === 'a-doc');
      const afterAFit = after.outlineSaturatedPremise.find((entry) => entry.slug === 'a-doc');
      expect(beforeAFit).toBeDefined();
      expect(afterAFit).toBeDefined();
      expect(beforeAFit!.rest).not.toBe(afterAFit!.rest);

      expect(reply).toContain('a-doc の節の目次は1文書あたりの予算');
      expect(reply).toContain('張り付いている');
      expect(reply).not.toContain('b-doc の節の目次');
    });

    // 飽和しているが何も変わっていない premise は名乗らない: 無関係な文書へ書いたターンに、張り付いた別の文書の名前が毎回出る。
    it('⭐ 飽和したまま何も変わっていない premise は、無関係な書き込みでは名乗らない', () => {
      const saturatedElsewhere = manySectionPremise('saturated-elsewhere', 400);
      const before = measureMemoryFloor([saturatedElsewhere, premise('unrelated', '元の本文')]);
      const after = measureMemoryFloor([
        saturatedElsewhere,
        premise('unrelated', '書き換えた本文'),
      ]);

      const beforeFit = before.outlineSaturatedPremise.find(
        (entry) => entry.slug === 'saturated-elsewhere',
      );
      const afterFit = after.outlineSaturatedPremise.find(
        (entry) => entry.slug === 'saturated-elsewhere',
      );
      expect(beforeFit).toEqual(afterFit);

      const reply = describeMemoryFloor({
        before,
        after,
        slug: 'unrelated',
        kind: 'premise',
        created: false,
      });

      expect(reply).not.toContain('saturated-elsewhere');
      expect(reply).not.toContain('張り付いている');
    });
  });
});

describe('describeMemoryReinjectionEstimate — 「次のターンの会話へ載る見込み」の一言', () => {
  it('⭐ premise の文書へ書くと、renderMemoryDocuments([文書]) と一致する文字数が出る（載るのはカード）', () => {
    const doc = premise('about-me-core', 'あ'.repeat(500));
    const reply = describeMemoryReinjectionEstimate([doc], [doc], new Map());
    const expectedChars = renderMemoryDocuments([doc]).length;

    expect(reply).toContain(`${expectedChars.toLocaleString('en-US')} 文字`);
    expect(reply).toContain('premise・カード（要旨＋節の目次）');
    expect(renderMemoryDocuments([doc])).not.toContain('あ'.repeat(500));
    expect(renderMemoryDocuments([doc])).toContain('# about-me-core');
  });

  it('⭐ fact の文書へ書くと、目次1行ぶんしか出ない——同じ本文量でも premise よりずっと小さい', () => {
    const factDoc = fact('runbook', {
      description: '費用の推移',
      freshness: { kind: 'fresh' },
    });
    const longFactDoc: MemoryPart = { ...factDoc, content: factDoc.content + 'あ'.repeat(5000) };
    const reply = describeMemoryReinjectionEstimate([longFactDoc], [longFactDoc], new Map());
    const expectedChars = renderMemoryDocuments([longFactDoc]).length;

    expect(reply).toContain(`${expectedChars.toLocaleString('en-US')} 文字`);
    expect(reply).toContain('fact・目次1行');
    expect(expectedChars).toBeLessThan(200);
  });

  it('⭐ 区分で結果が変わる——同じ本文量の premise と fact を比べると、fact のほうが小さい数を返す', () => {
    const body = 'あ'.repeat(1000);
    const premiseDoc = premise('doc-p', body);
    const factDoc: MemoryPart = {
      ...fact('doc-f', { description: '要旨', freshness: { kind: 'fresh' } }),
      content: `---\ntype: fact\ndescription: 要旨\n---\n# doc-f\n${body}`,
    };

    const premiseChars = renderMemoryDocuments([premiseDoc]).length;
    const factChars = renderMemoryDocuments([factDoc]).length;

    expect(describeMemoryReinjectionEstimate([premiseDoc], [premiseDoc], new Map())).toContain(
      `${premiseChars.toLocaleString('en-US')} 文字`,
    );
    expect(describeMemoryReinjectionEstimate([factDoc], [factDoc], new Map())).toContain(
      `${factChars.toLocaleString('en-US')} 文字`,
    );
    expect(factChars).toBeLessThan(premiseChars);
  });

  it('⚠️「他に何も変わらなければ」という条件付きであることを明言する（単一文書でも複数文書でも）', () => {
    const singleParts: [MemoryPart] = [premise('a', '本文')];
    const multiParts: [MemoryPart, MemoryPart] = [premise('a', '本文'), premise('b', '本文')];
    const single = describeMemoryReinjectionEstimate(singleParts, singleParts, new Map());
    const multi = describeMemoryReinjectionEstimate(multiParts, multiParts, new Map());

    for (const reply of [single, multi]) {
      expect(reply).toContain('予測であって実測ではない');
      expect(reply).toContain('他に何も変わらなければ');
      expect(reply).toContain('単純に合算しないこと');
    }
  });

  it('⭐ memory_section_move の形（2文書）では、両方の合計が1つの数として出る（別々に render して足したものとは限らず、まとめて render した値と一致する）', () => {
    const fromDoc = premise('about-me', 'あ'.repeat(300));
    const toDoc = premise('about-me-appendix', 'い'.repeat(300));

    const reply = describeMemoryReinjectionEstimate([toDoc, fromDoc], [toDoc, fromDoc], new Map());
    const combinedChars = renderMemoryDocuments([toDoc, fromDoc]).length;
    const separateSum =
      renderMemoryDocuments([toDoc]).length + renderMemoryDocuments([fromDoc]).length;

    expect(reply).toContain(`${combinedChars.toLocaleString('en-US')} 文字`);
    expect(combinedChars).not.toBe(separateSum);
    expect(reply).toContain('about-me-appendix と about-me の合計');
  });

  it('⚠️ memory_section_move（2文書）だけに「両方の合計である」の注記が出る——1文書のときは出ない', () => {
    const singleParts: [MemoryPart] = [premise('a', '本文')];
    const multiParts: [MemoryPart, MemoryPart] = [premise('a', '本文'), premise('b', '本文')];
    const single = describeMemoryReinjectionEstimate(singleParts, singleParts, new Map());
    const multi = describeMemoryReinjectionEstimate(multiParts, multiParts, new Map());

    expect(single).not.toContain('移動元と移動先の両方');
    expect(multi).toContain('移動元と移動先の両方');
    expect(multi).toContain('両方まとめて渡した結果');
  });

  it('内訳に文書ごとの区分（premise・カード / fact・目次1行）が並ぶ', () => {
    const premiseDoc = premise('about-me', '本文');
    const factDoc: MemoryPart = {
      ...fact('appendix', { description: '付録', freshness: { kind: 'fresh' } }),
    };

    const reply = describeMemoryReinjectionEstimate(
      [factDoc, premiseDoc],
      [factDoc, premiseDoc],
      new Map(),
    );

    expect(reply).toContain('appendix（fact・目次1行）');
    expect(reply).toContain('about-me（premise・カード（要旨＋節の目次））');
  });

  it('parts が空なら呼び手の実装誤りとして例外を投げる（型を迂回した呼び手への最後の砦）', () => {
    // 型を迂回して空を渡す: 引数は非空タプルで `tsc` は `[]` を拒むが、迂回した呼び手への throw が残っていることを確かめる。
    const empty = [] as unknown as [MemoryPart, ...MemoryPart[]];
    expect(() => describeMemoryReinjectionEstimate(empty, [], new Map())).toThrow();
  });

  it('memoryAfter に空配列を渡しても throw しない（presentInMemory 無しと同じ挙動になるだけ）', () => {
    const doc = fact('orphan', { description: '説明', freshness: { kind: 'fresh' } });
    expect(() => describeMemoryReinjectionEstimate([doc], [], new Map())).not.toThrow();
  });

  it('⭐ 親が今回の書き込みに含まれない premise を指す fact を書いたとき、見込みは「見つからない」ではなく「ここに載せた分には含まれない」の印ぶんで数える', () => {
    const core = premise('core', '前提の本文');
    const child = fact('child', {
      description: '子',
      freshness: { kind: 'fresh' },
      parent: 'core',
    });
    const memoryAfter = [core, child];

    const reply = describeMemoryReinjectionEstimate([child], memoryAfter, new Map());
    const expectedChars = renderMemoryDocuments([child], { presentInMemory: memoryAfter }).length;
    const beforeFixChars = renderMemoryDocuments([child]).length;

    expect(reply).toContain(`${expectedChars.toLocaleString('en-US')} 文字`);
    expect(expectedChars).toBeGreaterThan(beforeFixChars);
    expect(renderMemoryDocuments([child], { presentInMemory: memoryAfter })).toContain(
      '親 core は在るが、ここに載せた分には含まれない',
    );
  });
});

describe('describeMemorySessionDelta — 「セッション構築時点からの増分」の一言（P3）', () => {
  it('⭐ セッション構築時点から増えていれば、方向（増える）と割合が出る', () => {
    const reply = describeMemorySessionDelta({ afterChars: 150, injectedMemoryChars: 100 });

    expect(reply).toContain('次に組み立て直されたら焼かれる量（セッション構築時点との差）');
    expect(reply).toContain('セッション構築時点 100 文字');
    expect(reply).toContain('いま 150 文字');
    expect(reply).toContain('+50 文字');
    expect(reply).toContain('+50%');
    expect(reply).toContain('増える見込み');
  });

  it('⭐ セッション構築時点から減っていれば、方向（減る）と負の割合が出る', () => {
    const reply = describeMemorySessionDelta({ afterChars: 60, injectedMemoryChars: 100 });

    expect(reply).toContain('-40 文字');
    expect(reply).toContain('-40%');
    expect(reply).toContain('減る見込み');
    expect(reply).not.toContain('増える');
  });

  it('⭐⭐ 増分が0のとき（何も変わっていないとき）に、増えたかのような文言を出さない（必須の歯）', () => {
    const reply = describeMemorySessionDelta({ afterChars: 100, injectedMemoryChars: 100 });

    expect(reply).toContain('変わっていない');
    expect(reply).not.toMatch(/増え/);
    expect(reply).not.toMatch(/減っ/);
  });

  it('セッション構築時点が0文字だったときは、割合を捏造せず「出せない」と言う', () => {
    const reply = describeMemorySessionDelta({ afterChars: 40, injectedMemoryChars: 0 });

    expect(reply).toContain('+40 文字');
    expect(reply).toContain('割合は出せない');
    expect(reply).not.toMatch(/%/);
  });

  it('⚠️ injectedMemoryChars が null（引けない）なら、現在値であることを明記して現在値を出す', () => {
    const reply = describeMemorySessionDelta({ afterChars: 12_345, injectedMemoryChars: null });

    expect(reply).toContain('12,345 文字');
    expect(reply).toContain('現在値である');
    expect(reply).not.toContain('次に組み立て直されたら焼かれる量（セッション構築時点との差）');
  });

  it('閾値・警告に相当する語を使わない（判断はクローンが下す）', () => {
    const grown = describeMemorySessionDelta({ afterChars: 999_999, injectedMemoryChars: 1 });
    const fallback = describeMemorySessionDelta({ afterChars: 999_999, injectedMemoryChars: null });

    for (const reply of [grown, fallback]) {
      expect(reply).not.toContain('畳');
      expect(reply).not.toContain('危な');
      expect(reply).not.toContain('断る');
      expect(reply).not.toContain('べきだ');
    }
  });
});

describe('describeMemoryPremiseRanking — 「premise の大きさの順位」の一言（P3）', () => {
  it('premise が無ければ、順位ではなくその旨を言う', () => {
    const reply = describeMemoryPremiseRanking([]);
    expect(reply).toContain('premise の大きさの順位');
    expect(reply).toContain('いま premise はまだ無い');
  });

  it('fact しか無くても、順位ではなくその旨を言う（fact は対象にしない）', () => {
    const reply = describeMemoryPremiseRanking([fact('runbook', { description: '事実' })]);
    expect(reply).toContain('いま premise はまだ無い');
  });

  it('⭐ premise を大きい順に並べる', () => {
    const small = premise('doc-small', 'あ'.repeat(10));
    const large = premise('doc-large', 'い'.repeat(1000));
    const medium = premise('doc-medium', 'う'.repeat(100));

    const reply = describeMemoryPremiseRanking([small, large, medium]);

    const idxLarge = reply.indexOf('doc-large:');
    const idxMedium = reply.indexOf('doc-medium:');
    const idxSmall = reply.indexOf('doc-small:');
    expect(idxLarge).toBeGreaterThan(-1);
    expect(idxMedium).toBeGreaterThan(-1);
    expect(idxSmall).toBeGreaterThan(-1);
    expect(idxLarge).toBeLessThan(idxMedium);
    expect(idxMedium).toBeLessThan(idxSmall);
    expect(reply).toContain('1. doc-large:');
    expect(reply).toContain('全 3 件');
  });

  it('同じ大きさなら slug 昇順で決定的に並ぶ（呼ぶたびに順序が入れ替わらない）', () => {
    const a = premise('aaa', 'おなじ本文');
    const z = premise('zzz', 'おなじ本文');

    const reply1 = describeMemoryPremiseRanking([z, a]);
    const reply2 = describeMemoryPremiseRanking([a, z]);

    expect(reply1).toBe(reply2);
    // 先に `aaa` の行が在ることを確かめる: 無いと `-1 < n` で素通りする。
    expect(reply1).toContain('aaa:');
    expect(reply1.indexOf('aaa:')).toBeLessThan(reply1.indexOf('zzz:'));
  });

  it('fact は数えない——premise だけの順位になる', () => {
    const p = premise('doc-p', '本文');
    const f = fact('doc-f', { description: '要旨' });

    const reply = describeMemoryPremiseRanking([p, f]);

    expect(reply).toContain('doc-p:');
    expect(reply).not.toContain('doc-f:');
    expect(reply).toContain('全 1 件');
  });

  it('malformed な frontmatter を持つ premise は、content.length ではなく実際に載る形で数える', () => {
    const malformed: MemoryPart = {
      slug: 'broken',
      content: '---\nnot: [valid\n---\n# 壊れた\n本文',
    };
    expect(resolveMemoryDocKind(parseMemoryFrontmatter(malformed.content))).toBe('premise');

    const reply = describeMemoryPremiseRanking([malformed]);
    const match = /broken: ([\d,]+) 文字/.exec(reply);
    expect(match).not.toBeNull();
    const reportedChars = Number(((match as RegExpExecArray)[1] ?? '').replace(/,/g, ''));
    expect(reportedChars).toBeGreaterThan(malformed.content.length);
  });

  it('⭐ 予算を超えたら、件数ではなく文字数で切り、省いた件数を必ず言う', () => {
    const many = Array.from({ length: 200 }, (_, i) =>
      premise(`p${i.toString().padStart(4, '0')}`, '本文'),
    );

    const reply = describeMemoryPremiseRanking(many);

    expect(reply).toMatch(/…ほか \d+ 件は省略/);
    expect(reply).toContain('全 200 件');
    expect(reply).toContain('memory_list で確認できる');

    const shownMatch = /大きい順に (\d+) 件だけ出した/.exec(reply);
    expect(shownMatch).not.toBeNull();
    const shown = Number((shownMatch as RegExpExecArray)[1]);
    expect(shown).toBeGreaterThan(0);
    expect(shown).toBeLessThan(200);

    const restMatch = /…ほか (\d+) 件は省略/.exec(reply);
    const rest = Number((restMatch as RegExpExecArray)[1]);
    expect(shown + rest).toBe(200);
  });

  it('予算に収まる件数なら、省略の注記を出さない', () => {
    const few = [premise('a', '本文'), premise('b', '本文')];
    const reply = describeMemoryPremiseRanking(few);
    expect(reply).not.toContain('省略');
    expect(String(MEMORY_PREMISE_RANKING_BUDGET)).not.toBe('0');
  });

  it('閾値・警告に相当する語を使わない（判断はクローンが下す）', () => {
    const many = Array.from({ length: 5 }, (_, i) => premise(`p${i}`, 'あ'.repeat(1000)));
    const reply = describeMemoryPremiseRanking(many);

    expect(reply).not.toContain('畳');
    expect(reply).not.toContain('危な');
    expect(reply).not.toContain('大きすぎ');
  });
});

describe('premise の焼き込み（カード）と、載せ直しの絞り込み（seenContent）', () => {
  function manySections(count: number, extra = ''): string {
    const body = Array.from({ length: count }, (_, i) => `## 節${i}\n節${i}の本文である。`).join(
      '\n',
    );
    return `---\ntype: premise\ndescription: 前提の要旨\n---\n${body}${extra}`;
  }

  it('⭐ カードには本文が載らず、要旨・節の見出し・節id・文字数・開き方が載る', () => {
    const rendered = renderMemoryDocuments([
      {
        slug: 'about-me',
        content:
          '---\ntype: premise\ndescription: 私の要旨\n---\n## 判断の基準\nここが本文である。',
      },
    ]);

    expect(rendered).not.toContain('ここが本文である');
    expect(rendered).toContain('要旨: 私の要旨');
    expect(rendered).toContain('## 判断の基準');
    expect(rendered).toContain('memory_section_read');
    expect(rendered).toMatch(/\[[0-9a-f]{8}-[0-9a-f]{8}\] ## 判断の基準 — /);
    expect(rendered.length).toBeLessThan(400);
  });

  it('要旨がまだ書かれていない premise では、書けと言う（黙って空欄にしない）', () => {
    const rendered = renderMemoryDocuments([{ slug: 'doc', content: '## 節\n本文' }]);
    expect(rendered).toContain('要旨: （まだ書かれていない');
    expect(rendered).toContain('memory_frontmatter_set');
  });

  it('見出しが1つも無い premise では、節が無いことと見出しを付ける利点を言う', () => {
    const rendered = renderMemoryDocuments([{ slug: 'doc', content: '見出しの無い本文' }]);
    expect(rendered).toContain('節: 1つも無い');
    expect(rendered).not.toContain('見出しの無い本文');
    expect(rendered).toContain('memory_read');
  });

  it('⭐ 目次が予算に収まらない文書は、省いた件数と「割る手順」を名乗る', () => {
    const huge = Array.from(
      { length: 400 },
      (_, i) => `## これは十分に長い見出しであり予算を食い尽くす ${i}\n本文`,
    ).join('\n');
    const rendered = renderMemoryDocuments([
      { slug: 'big', content: `---\ntype: premise\ndescription: 大きい\n---\n${huge}` },
    ]);

    expect(rendered).toContain('節は目次から省略');
    expect(rendered).toContain('目次すら毎ターンの焼き込みに収まっていない');
    expect(rendered).toContain('memory_section_move');
    expect(rendered.length).toBeLessThan(MEMORY_PROMPT_OUTLINE_BUDGET * 2);
  });

  it('⭐⭐ 目次が予算で切れた文書は、落ちた末尾の直近の節を節id つきで名指しする', () => {
    const filler = Array.from(
      { length: 200 },
      (_, i) => `## これは十分に長い見出しであり予算を食い尽くす ${i}\n本文`,
    ).join('\n');
    const content =
      `---\ntype: premise\ndescription: 大きい\n---\n${filler}\n` +
      '## 58. 今日足したばかりの規則\n本文';
    const rendered = renderMemoryDocuments([{ slug: 'big', content }]);

    expect(rendered).toContain('節は目次から省略');
    const omissionAt = rendered.indexOf('節は目次から省略');
    const namedAt = rendered.indexOf('## 58. 今日足したばかりの規則');
    expect(namedAt).toBeGreaterThan(omissionAt);

    expect(rendered).toMatch(/\[[0-9a-f]{8}-[0-9a-f]{8}\] ## 58\. 今日足したばかりの規則 — /);
    expect(rendered).toContain('節id はそのまま memory_section_read に渡せる');
  });

  // 名指しの量は件数ではなく文字数で持つ: 件数だと見出しの長さ次第で断り書きの長さが暴れる。
  it('⚠ 落ちた末尾の名指しは件数ではなく文字数で切る（長い見出し1本で暴れない）', () => {
    const filler = Array.from(
      { length: 200 },
      (_, i) => `## これは十分に長い見出しであり予算を食い尽くす ${i}\n本文`,
    ).join('\n');
    const monster = `## ${'長'.repeat(4_000)}\n本文`;
    const rendered = renderMemoryDocuments([
      {
        slug: 'big',
        content: `---\ntype: premise\ndescription: 大きい\n---\n${filler}\n${monster}`,
      },
    ]);

    expect(rendered).not.toContain('長'.repeat(4_000));
    // 見出しが消えると slice(-1) が末尾1文字になり、下の長さの上限は緑のまま残る。切り出す前に在ることを確かめる。
    expect(rendered).toContain('落ちた末尾のうち直近の節');
    const namedBlock = rendered.slice(rendered.indexOf('落ちた末尾のうち直近の節'));
    expect(namedBlock.length).toBeLessThan(MEMORY_PROMPT_OMITTED_TAIL_BUDGET * 4);
  });

  it('⭐ 縮めれば載る文書には、見出しを平均いくつまで縮めればよいかを数字で出す', () => {
    const huge = Array.from(
      { length: 120 },
      (_, i) => `## これは十分に長い見出しであり予算を食い尽くす ${i}\n本文`,
    ).join('\n');
    const rendered = renderMemoryDocuments([
      { slug: 'big', content: `---\ntype: premise\ndescription: 大きい\n---\n${huge}` },
    ]);

    expect(rendered).toMatch(/1行の平均は \d+ 文字（うち節id と文字数の固定費が \d+ 文字）。/);
    expect(rendered).toMatch(/見出しを平均 \d+ 文字（いま \d+ 文字）まで縮める必要がある。/);
  });

  // 達成不能な助言を出さない: 固定費は節数に比例し、節が増えると最短（`# x`）まで縮めても予算に入らない点を越える。そこで「縮めれば載る」は嘘になるので「割るしかない」と名乗る。
  it('🔴 見出しを最短まで縮めても載らない文書には「縮めれば載る」と言わず、割れと言う', () => {
    const many = Array.from({ length: 400 }, (_, i) => `# ${i}\n本文`).join('\n');
    const rendered = renderMemoryDocuments([
      { slug: 'log', content: `---\ntype: premise\ndescription: 追記だけの文書\n---\n${many}` },
    ]);

    expect(rendered).toContain('節は目次から省略');
    expect(rendered).toContain('見出しを最短');
    expect(rendered).toContain('割るしかない');
    expect(rendered).not.toMatch(/まで縮める必要がある/);
  });

  // 名乗った助言は、助言のとおり縮めて描き直して確かめる: 数の書き写しだと N の丸め方（floor / ceil）の誤りを見逃す。
  it('⭐⭐⭐ 名乗った目標まで見出しを縮めると、本当に全節が載る（助言が実行できる）', () => {
    const heading = (i: number) => `## ${i}. ${'あ'.repeat(60)}`;
    const build = (make: (i: number) => string) =>
      `---\ntype: premise\ndescription: 規則\n---\n` +
      Array.from({ length: 106 }, (_, i) => `${make(i + 1)}\n${'本文'.repeat(60)}`).join('\n');

    const before = renderMemoryDocuments([{ slug: 'rules', content: build(heading) }]);
    const target = /見出しを平均 (\d+) 文字（いま \d+ 文字）まで縮める必要がある。/.exec(before);
    expect(target).not.toBeNull();
    const limit = Number((target as RegExpExecArray)[1]);

    const after = renderMemoryDocuments([
      { slug: 'rules', content: build((i) => heading(i).slice(0, limit)) },
    ]);
    expect(after).not.toContain('節は目次から省略');
    expect(before).toContain('節は目次から省略');
  });

  // 縮める目標は下限（`# x` の3文字）を下回らない: 反転を判定している線を節数を振って総当たりで見る（1点の実例では線が1文字ずれても気づかない）。
  it('⚠ 縮めろと言うときの目標は、見出しの最短（3文字）を下回らない', () => {
    const claims: number[] = [];
    for (let n = 150; n <= 260; n += 1) {
      const body = Array.from({ length: n }, (_, i) => `# ${i}\n本`).join('\n');
      const rendered = renderMemoryDocuments([
        { slug: 'log', content: `---\ntype: premise\ndescription: d\n---\n${body}` },
      ]);
      const hit = /見出しを平均 (\d+) 文字（いま \d+ 文字）まで縮める必要がある。/.exec(rendered);
      if (hit !== null) claims.push(Number(hit[1]));
    }
    expect(claims.length).toBeGreaterThan(0);
    expect(Math.min(...claims)).toBeGreaterThanOrEqual(3);
  });

  it('⭐ 目次が予算で切れた断り書きは、反転側・非反転側のどちらでも予算値を名乗る', () => {
    const budgetPhrase = `予算 ${MEMORY_PROMPT_OUTLINE_BUDGET.toLocaleString('en-US')} 文字`;

    const shrinkable = Array.from(
      { length: 120 },
      (_, i) => `## これは十分に長い見出しであり予算を食い尽くす ${i}\n本文`,
    ).join('\n');
    const nonInverted = renderMemoryDocuments([
      {
        slug: 'shrinkable',
        content: `---\ntype: premise\ndescription: 大きい\n---\n${shrinkable}`,
      },
    ]);
    expect(nonInverted).toMatch(/見出しを平均 \d+ 文字（いま \d+ 文字）まで縮める必要がある。/);
    expect(nonInverted).toContain(budgetPhrase);

    const unshrinkable = Array.from({ length: 400 }, (_, i) => `# ${i}\n本文`).join('\n');
    const inverted = renderMemoryDocuments([
      {
        slug: 'unshrinkable',
        content: `---\ntype: premise\ndescription: 追記だけの文書\n---\n${unshrinkable}`,
      },
    ]);
    expect(inverted).toContain('見出しを最短');
    expect(inverted).not.toMatch(/まで縮める必要がある。/);
    expect(inverted).toContain(budgetPhrase);
  });

  it('⭐⭐ 断り書きは目次の総量を「載った分＋省いた分」の内訳とともに出し、何の文字数かを名指しする', () => {
    const totalNamingPhrase = '節の目次は全 ';
    const notBodyPhrase = '（節の本文の総量ではない）';
    const breakdown =
      /節の目次は全 ([\d,]+) 節ぶんで ([\d,]+) 文字（節の本文の総量ではない）——うち焼き込みに載った分 ([\d,]+) 文字、予算に入らず省いた分 ([\d,]+) 文字。/;
    const toNumber = (s: string) => Number(s.replace(/,/g, ''));

    const shrinkable = Array.from(
      { length: 120 },
      (_, i) => `## これは十分に長い見出しであり予算を食い尽くす ${i}\n本文`,
    ).join('\n');
    const nonInverted = renderMemoryDocuments([
      {
        slug: 'shrinkable-total',
        content: `---\ntype: premise\ndescription: 大きい\n---\n${shrinkable}`,
      },
    ]);
    expect(nonInverted).toMatch(/見出しを平均 \d+ 文字（いま \d+ 文字）まで縮める必要がある。/);
    expect(nonInverted).toContain(totalNamingPhrase);
    expect(nonInverted).toContain(notBodyPhrase);
    const nonInvertedMatch = breakdown.exec(nonInverted);
    expect(nonInvertedMatch).not.toBeNull();
    const [, , nOutline = '', nShown = '', nDropped = ''] = nonInvertedMatch as RegExpExecArray;
    expect(toNumber(nShown) + toNumber(nDropped)).toBe(toNumber(nOutline));
    expect(toNumber(nShown)).toBeGreaterThan(0);
    expect(toNumber(nDropped)).toBeGreaterThan(0);

    const unshrinkable = Array.from({ length: 400 }, (_, i) => `# ${i}\n本文`).join('\n');
    const inverted = renderMemoryDocuments([
      {
        slug: 'unshrinkable-total',
        content: `---\ntype: premise\ndescription: 追記だけの文書\n---\n${unshrinkable}`,
      },
    ]);
    expect(inverted).toContain('見出しを最短');
    expect(inverted).not.toMatch(/まで縮める必要がある。/);
    expect(inverted).toContain(totalNamingPhrase);
    expect(inverted).toContain(notBodyPhrase);
    const invertedMatch = breakdown.exec(inverted);
    expect(invertedMatch).not.toBeNull();
    const [, , iOutline = '', iShown = '', iDropped = ''] = invertedMatch as RegExpExecArray;
    expect(toNumber(iShown) + toNumber(iDropped)).toBe(toNumber(iOutline));
    expect(toNumber(iShown)).toBeGreaterThan(0);
    expect(toNumber(iDropped)).toBeGreaterThan(0);
  });

  it('⭐ 断り書きは「落ちている節を移し切るまで床は動かない」ことを1文で言う（rest/shown の数と一致する）', () => {
    const sentence =
      /落ちている ([\d,]+) 節をすべて移し切るまで、毎ターンの床はほとんど動かない.+?。([\d,]+) 節まで割り切った時点で省略が消え、この断り書きごと床から落ちる——そこが節の移動が床に効き始める点である。/;
    const toNumber = (s: string) => Number(s.replace(/,/g, ''));

    const shrinkable = Array.from(
      { length: 120 },
      (_, i) => `## これは十分に長い見出しであり予算を食い尽くす ${i}\n本文`,
    ).join('\n');
    const nonInverted = renderMemoryDocuments([
      {
        slug: 'sentence-shrinkable',
        content: `---\ntype: premise\ndescription: d\n---\n${shrinkable}`,
      },
    ]);
    const nonInvertedHit = sentence.exec(nonInverted);
    expect(nonInvertedHit).not.toBeNull();
    const omissionHit =
      /末尾 ([\d,]+) 節は目次から省略（全 ([\d,]+) 節のうち先頭 ([\d,]+) 節だけ載せた）/.exec(
        nonInverted,
      );
    expect(omissionHit).not.toBeNull();
    const [, nRest = '', , nShown = ''] = omissionHit as RegExpExecArray;
    const [, sentenceRest = '', sentenceShown = ''] = nonInvertedHit as RegExpExecArray;
    expect(toNumber(sentenceRest)).toBe(toNumber(nRest));
    expect(toNumber(sentenceShown)).toBe(toNumber(nShown));

    const unshrinkable = Array.from({ length: 400 }, (_, i) => `# ${i}\n本文`).join('\n');
    const inverted = renderMemoryDocuments([
      {
        slug: 'sentence-unshrinkable',
        content: `---\ntype: premise\ndescription: d\n---\n${unshrinkable}`,
      },
    ]);
    expect(sentence.test(inverted)).toBe(true);

    const notSaturated = renderMemoryDocuments([premise('not-saturated', '本文')]);
    expect(notSaturated).not.toContain('落ちている');
    expect(notSaturated).not.toContain('移し切るまで');
  });

  // 予算値を2回出さない: `arithmetic` が既に予算を名乗っているので、出現回数がちょうど1回であることを両側で測る。
  it('⛔ 目次の総量を足しても、予算値の出現は反転側・非反転側とも1回のままである', () => {
    const budgetPhrase = `予算 ${MEMORY_PROMPT_OUTLINE_BUDGET.toLocaleString('en-US')} 文字`;
    const countOccurrences = (text: string, needle: string) => text.split(needle).length - 1;

    const shrinkable = Array.from(
      { length: 120 },
      (_, i) => `## これは十分に長い見出しであり予算を食い尽くす ${i}\n本文`,
    ).join('\n');
    const nonInverted = renderMemoryDocuments([
      {
        slug: 'shrinkable-budget-once',
        content: `---\ntype: premise\ndescription: 大きい\n---\n${shrinkable}`,
      },
    ]);
    expect(nonInverted).toMatch(/見出しを平均 \d+ 文字（いま \d+ 文字）まで縮める必要がある。/);
    expect(countOccurrences(nonInverted, budgetPhrase)).toBe(1);

    const unshrinkable = Array.from({ length: 400 }, (_, i) => `# ${i}\n本文`).join('\n');
    const inverted = renderMemoryDocuments([
      {
        slug: 'unshrinkable-budget-once',
        content: `---\ntype: premise\ndescription: 追記だけの文書\n---\n${unshrinkable}`,
      },
    ]);
    expect(inverted).toContain('見出しを最短');
    expect(inverted).not.toMatch(/まで縮める必要がある。/);
    expect(countOccurrences(inverted, budgetPhrase)).toBe(1);
  });

  // 締めは「何を移すか」の基準を持つ: `side=tail` と `memory_section_move` が隣接していて、「末尾を見て移す」と誤読すると新しい学びを fact へ追い出しかねない。
  it('⭐⭐ 断り書きの締めは、移す対象の基準と side=tail の誤読の両方を名乗る', () => {
    const huge = Array.from(
      { length: 200 },
      (_, i) => `## これは十分に長い見出しであり予算を食い尽くす ${i}\n本文`,
    ).join('\n');
    const rendered = renderMemoryDocuments([
      { slug: 'big', content: `---\ntype: premise\ndescription: 大きい\n---\n${huge}` },
    ]);

    expect(rendered).toContain(
      '移すのは済んだ経緯・1回きりの実測・失効した手順であって、末尾の新しい節ではない。',
    );
    expect(rendered).toContain('side=tail は末尾を**読む**ための向きであって');
    expect(rendered).toContain('末尾を**移す**ための指示ではない');
  });

  it('⭐ 要旨が長すぎる文書は、切ったことと全文の在り処と直し方を名乗る', () => {
    const longDescription = 'あ'.repeat(MEMORY_PROMPT_DESCRIPTION_BUDGET + 500);
    const rendered = renderMemoryDocuments([
      {
        slug: 'doc',
        content: `---\ntype: premise\ndescription: ${longDescription}\n---\n## 節\n本文`,
      },
    ]);

    expect(rendered).toContain('要旨が長すぎて毎ターンの焼き込みに収まっていない');
    expect(rendered).toContain('memory_list');
    expect(rendered).toContain('要旨に本文を書かず');
    expect(rendered).toContain('## 節');
  });

  it('要旨が目安に収まっていれば、切らないし印も出さない（線の反対側）', () => {
    const rendered = renderMemoryDocuments([
      { slug: 'doc', content: '---\ntype: premise\ndescription: 短い要旨\n---\n## 節\n本文' },
    ]);
    expect(rendered).toContain('要旨: 短い要旨');
    expect(rendered).not.toContain('要旨が長すぎて');
  });


  it('⭐ 節を1つ足しただけなら、カードの変わった範囲だけが載る', () => {
    const before: MemoryPart = { slug: 'alteroid-work', content: manySections(60) };
    const after: MemoryPart = {
      slug: 'alteroid-work',
      content: manySections(60, '\n## 新しい節\n追記した本文'),
    };

    const rendered = renderMemoryDocuments([after], {
      seenContent: new Map([[after.slug, before.content]]),
    });

    expect(rendered).toContain('## 新しい節');
    expect(rendered).not.toContain('## 節30');
    expect(rendered).toContain('は変わっていない');
    expect(rendered).toContain('<!-- memory: alteroid-work.md（カードの変わった範囲だけ） -->');
    expect(rendered.length).toBeLessThan(renderMemoryDocuments([after]).length / 5);
  });

  // 要旨の行（節ではない）の書き換えは「いまは無い行」と名乗らない: 新しい版は added 側に既に載っていて、何も失われていない。
  it('⭐ 要旨だけを直したときは、変わった範囲だけが載り、「消えた節」は1文字も名乗らない（要旨の行は節ではない）', () => {
    const before: MemoryPart = { slug: 'doc', content: manySections(60) };
    const after: MemoryPart = {
      slug: 'doc',
      content: manySections(60).replace('description: 前提の要旨', 'description: 直した要旨'),
    };

    const rendered = renderMemoryDocuments([after], {
      seenContent: new Map([[after.slug, before.content]]),
    });

    expect(rendered).toContain('要旨: 直した要旨');
    expect(rendered).not.toContain('## 節30');
    expect(rendered).toContain('行は変わっていないので載せていない');
    expect(rendered).toContain('<!-- memory: doc.md（カードの変わった範囲だけ） -->');
    expect(rendered).not.toContain('いまは無い');
    expect(rendered).not.toContain('押し出された節');
    expect(rendered).not.toContain('判定できない節');
  });

  describe('消えた節を「押し出された／消えた・書き換わった／判定できない」に分ける', () => {
    it('⭐⭐ 押し出された節（甲）は、いまの節id 付きで名指しされ、節自体は文書に在ることが確かめられる', () => {
      const BASE_COUNT = 220;
      const baseBody = Array.from(
        { length: BASE_COUNT },
        (_, i) => `## 節${i}\n節${i}の本文である。`,
      ).join('\n');
      // before.content は末尾に改行を1つ持たせる: scanMemorySections は文書の絶対末尾の最後の節だけ末尾の改行を body に含めないので、改行なしの before へ継ぎ足すと、見出し・本文が同じでも節219の id が変わってしまう（合成データ特有の継ぎ目）。
      const before: MemoryPart = {
        slug: 'doc',
        content: `---\ntype: premise\ndescription: 前提の要旨\n---\n${baseBody}\n`,
      };
      const appendedBody = Array.from(
        { length: 80 },
        (_, i) => `## 追記節${i}\n追記節${i}の本文である。`,
      ).join('\n');
      const after: MemoryPart = { slug: 'doc', content: `${before.content}${appendedBody}` };

      const idPattern = /\[([0-9a-f]{8}-[0-9a-f]{8})\]/g;
      const idsIn = (text: string): Set<string> =>
        new Set([...text.matchAll(idPattern)].map((match) => match[1] as string));

      const idsVisibleBefore = idsIn(renderMemoryDocuments([before]));
      const idsVisibleAfterAlone = idsIn(renderMemoryDocuments([after]));
      const vanished = [...idsVisibleBefore].filter((id) => !idsVisibleAfterAlone.has(id));

      expect(vanished.length).toBeGreaterThan(0);

      const currentSections = scanMemorySections(after.content).sections;
      for (const id of vanished) {
        expect(currentSections.some((section) => section.id === id)).toBe(true);
      }

      const rendered = renderMemoryDocuments([after], {
        seenContent: new Map([[after.slug, before.content]]),
      });

      expect(rendered).toContain(`押し出された節: ${vanished.length} 節`);
      expect(rendered).toContain('節そのものは文書に在る');
      expect(rendered).not.toContain('いまは無い節');
      expect(rendered).not.toContain('判定できない節');
      const idsInRendered = idsIn(rendered);
      expect(vanished.some((id) => idsInRendered.has(id))).toBe(true);
    });

    it('見出しが本文と一緒に変わっただけの通常の更新は「押し出された」と名乗らない（同じ節がまだ見えている）', () => {
      const before: MemoryPart = {
        slug: 'doc',
        content: '---\ntype: premise\ndescription: 要旨\n---\n## 節A\n元の本文\n\n## 節B\n本文B\n',
      };
      const after: MemoryPart = {
        slug: 'doc',
        content:
          '---\ntype: premise\ndescription: 要旨\n---\n## 節A\n書き換えた本文\n\n## 節B\n本文B\n',
      };

      const rendered = renderMemoryDocuments([after], {
        seenContent: new Map([[after.slug, before.content]]),
      });

      const afterSection = scanMemorySections(after.content).sections.find(
        (section) => section.heading === '## 節A',
      )!;
      expect(rendered).toContain(afterSection.id);
      expect(rendered).not.toContain('押し出された節');
      expect(rendered).not.toContain('いまは無い節');
      expect(rendered).not.toContain('判定できない節');
    });

    it('見出しごと消された・書き換わった節は「消えたか書き換わった」（乙）と名乗る', () => {
      const before: MemoryPart = { slug: 'doc', content: manySections(60) };
      const after: MemoryPart = {
        slug: 'doc',
        content: manySections(60)
          .split('\n')
          .filter((line) => line !== '## 節30' && line !== '節30の本文である。')
          .join('\n'),
      };

      expect(scanMemorySections(after.content).sections.some((s) => s.heading === '## 節30')).toBe(
        false,
      );

      const rendered = renderMemoryDocuments([after], {
        seenContent: new Map([[after.slug, before.content]]),
      });

      expect(rendered).toContain('いまは無い節: 1 節');
      expect(rendered).toContain('どの節の見出しとも一致しない');
      expect(rendered).not.toContain('押し出された節');
      expect(rendered).not.toContain('判定できない節');
    });

    it('見出しが重複していて、どの節に対応するか決められないときは「判定できない」（丙）と名乗る（3つ目の状態を潰さない）', () => {
      // 変わっていない節を大量に添える（manySections の60節）: added がカード全体の MEMORY_DELTA_MAX_RATIO（0.5）を超えると差分を諦めてカード全体を返し、「判定できない節」の文言を検査する経路に載らない。
      const before: MemoryPart = {
        slug: 'doc',
        content: manySections(60, '\n\n## 重複見出し\n本文A\n'),
      };
      const after: MemoryPart = {
        slug: 'doc',
        content: manySections(60, '\n\n## 重複見出し\n本文A書き換え\n\n## 重複見出し\n本文C\n'),
      };

      const currentHeadingCount = scanMemorySections(after.content).sections.filter(
        (s) => s.heading === '## 重複見出し',
      ).length;
      expect(currentHeadingCount).toBe(2);

      const rendered = renderMemoryDocuments([after], {
        seenContent: new Map([[after.slug, before.content]]),
      });

      expect(rendered).toContain('判定できない節: 1 節');
      expect(rendered).toContain('同じ見出しがいまの文書に複数在るため');
      expect(rendered).not.toContain('押し出された節');
      expect(rendered).not.toContain('いまは無い節');
    });
  });

  it('⭐ 大半が変わったときは差分にせずカード全体を載せる（「変わった範囲だけ」と名乗らない）', () => {
    const before: MemoryPart = { slug: 'doc', content: manySections(20) };
    const after: MemoryPart = {
      slug: 'doc',
      content: `---\ntype: premise\ndescription: 前提の要旨\n---\n${Array.from(
        { length: 20 },
        (_, i) => `## まったく違う見出し${i}\n中身も違う。`,
      ).join('\n')}`,
    };

    const rendered = renderMemoryDocuments([after], {
      seenContent: new Map([[after.slug, before.content]]),
    });

    expect(rendered).toBe(renderMemoryDocuments([after]));
    expect(rendered).not.toContain('カードの変わった範囲だけ');
  });

  it('⭐ seenContent を渡さなければ出力は1バイトも変わらない（システムプロンプト側の不変条件）', () => {
    const docs = [
      { slug: 'a', content: manySections(5) },
      { slug: 'b', content: manySections(3) },
    ];
    expect(renderMemoryDocuments(docs, {})).toBe(renderMemoryDocuments(docs));
    expect(renderMemoryDocuments(docs, { presentInMemory: docs })).toBe(
      renderMemoryDocuments(docs),
    );
  });

  it('⭐ 床（measureMemoryFloor）は seenContent の影響を受けない', () => {
    const before: MemoryPart = { slug: 'doc', content: manySections(60) };
    const after: MemoryPart = { slug: 'doc', content: manySections(60, '\n## 追記\n本文') };

    const injected = renderMemoryDocuments([after], {
      seenContent: new Map([[after.slug, before.content]]),
    }).length;
    const floor = measureMemoryFloor([after]).totalChars;

    expect(injected).toBeLessThan(floor / 5);
    expect(floor).toBe(renderMemoryDocuments([after]).length);
  });

  it('見ていない文書（新規作成）はカード全体が載る——空の Map と同じ扱い', () => {
    const doc: MemoryPart = { slug: 'new-doc', content: manySections(5) };
    expect(renderMemoryDocuments([doc], { seenContent: new Map() })).toBe(
      renderMemoryDocuments([doc]),
    );
  });

  it('fact は seenContent を渡しても目次1行のまま（もともと本文が載らないので差分の余地が無い）', () => {
    const before = fact('appendix', { description: '古い要旨', freshness: { kind: 'fresh' } });
    const after = fact('appendix', { description: '新しい要旨', freshness: { kind: 'fresh' } });
    expect(
      renderMemoryDocuments([after], { seenContent: new Map([[after.slug, before.content]]) }),
    ).toBe(renderMemoryDocuments([after]));
  });

  // 行で切る: UTF-16 の code unit で切ると絵文字（⚠️ / 🎯）のサロゲートペアが割れて壊れた文字が文脈へ載る。
  it('⭐ 絵文字（サロゲートペア）を含む見出しの境界で切っても、壊れた文字を作らない', () => {
    const body = (extra: string): string =>
      `---\ntype: premise\ndescription: 🎯 要旨 ⚠️\n---\n${Array.from(
        { length: 40 },
        (_, i) => `## 🎯 節${i} ⚠️\n本文`,
      ).join('\n')}${extra}`;
    const rendered = renderMemoryDocuments(
      [{ slug: 'doc', content: body('\n## 🎯 追記 ⚠️\n本文') }],
      {
        seenContent: new Map([['doc', body('')]]),
      },
    );

    expect(rendered).toContain('## 🎯 追記 ⚠️');
    expect(
      /[\uD800-\uDBFF](?![\uDC00-\uDFFF])|(?<![\uD800-\uDBFF])[\uDC00-\uDFFF]/u.test(rendered),
    ).toBe(false);
  });

  it('⭐ 見込みの文字数が、差分として実際に載る文字数と一致する', () => {
    const before: MemoryPart = { slug: 'doc', content: manySections(60) };
    const after: MemoryPart = { slug: 'doc', content: manySections(60, '\n## 追記\n本文') };
    const seen = new Map([[after.slug, before.content]]);

    const actual = renderMemoryDocuments([after], { presentInMemory: [after], seenContent: seen });
    const reply = describeMemoryReinjectionEstimate([after], [after], seen);

    expect(reply).toContain(`${actual.length.toLocaleString('en-US')} 文字`);
    expect(reply).toContain('doc（premise・カードの変わった範囲だけ）');
    expect(actual.length).toBeLessThan(renderMemoryDocuments([after]).length / 5);
  });
});

describe('describeMemoryTidyTargets — 焼き込みに収まっていない文書を名指しする', () => {
  function fatOutline(slug: string): MemoryPart {
    const body = Array.from(
      { length: 300 },
      (_, i) => `## これは十分に長い見出しであり予算を食い尽くす ${i}\n本文`,
    ).join('\n');
    return { slug, content: `---\ntype: premise\ndescription: 要旨\n---\n${body}` };
  }

  it('⭐ 目次が予算を超えた文書を、名前と数で名指しする', () => {
    const reply = describeMemoryTidyTargets([fatOutline('alteroid-work')]);

    expect(reply).toContain('棚卸しの的');
    expect(reply).toContain('- alteroid-work:');
    expect(reply).toContain('節の目次が');
    // 予算そのものを書き写さず、定数から出す（腐らない）。
    expect(reply).toContain(`予算 ${MEMORY_PROMPT_OUTLINE_BUDGET.toLocaleString('en-US')} 文字`);
    // 何をすればよいかを言う（名指しだけで終わらせない）。
    expect(reply).toContain('memory_section_move');
  });

  it('⭐ 要旨が予算を超えた文書も名指しする（別の理由として並ぶ）', () => {
    const long = 'あ'.repeat(MEMORY_PROMPT_DESCRIPTION_BUDGET + 100);
    const reply = describeMemoryTidyTargets([
      { slug: 'about-me', content: `---\ntype: premise\ndescription: ${long}\n---\n## 節\n本文` },
    ]);

    expect(reply).toContain('- about-me:');
    expect(reply).toContain('要旨が');
    expect(reply).not.toContain('節の目次が');
  });

  it('2つとも超えていれば、1行に2つの理由が並ぶ', () => {
    const long = 'あ'.repeat(MEMORY_PROMPT_DESCRIPTION_BUDGET + 100);
    const fat = fatOutline('both');
    const both: MemoryPart = {
      slug: 'both',
      content: fat.content.replace('description: 要旨', `description: ${long}`),
    };

    const reply = describeMemoryTidyTargets([both]);
    const line = reply.split('\n').find((row) => row.startsWith('- both:')) ?? '';
    expect(line).toContain('節の目次が');
    expect(line).toContain('要旨が');
  });

  /**
   * ⭐ **「的が無い」を「記憶が小さい」と読ませない。** 予算は1文書ごとに
   * 掛かるので、全部が予算の下でも合計は大きくなりうる。
   */
  it('⭐ 的が1つも無いときは、それが「小さい」ではないと断る', () => {
    const reply = describeMemoryTidyTargets([premise('small', '## 節\n本文')]);

    expect(reply).toContain('収まっていない文書は無い');
    expect(reply).toContain('「記憶が小さい」ではない');
  });

  it('fact は的にしない（もともと目次の1行しか焼かれない）', () => {
    const fat = fatOutline('appendix');
    const asFact: MemoryPart = {
      slug: 'appendix',
      content: fat.content.replace('type: premise', 'type: fact'),
    };
    expect(describeMemoryTidyTargets([asFact])).toContain('収まっていない文書は無い');
  });

  it('一覧は文字数の予算で切り、切ったら件数を言う', () => {
    const many = Array.from({ length: 60 }, (_, i) => fatOutline(`doc-${i}`));
    const reply = describeMemoryTidyTargets(many);

    expect(reply).toContain('件は省略');
    expect(reply.length).toBeLessThan(MEMORY_TIDY_TARGETS_BUDGET * 2);
  });
});
