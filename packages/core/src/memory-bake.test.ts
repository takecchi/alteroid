import { describe, expect, it } from 'vitest';

import {
  renderMemoryDocuments,
  renderMemoryDocumentsWithBake,
  type MemoryDocumentBake,
} from './memory.js';
import {
  documentsMixed,
  documentsOverCardBudget,
  documentsTocCutByChars,
  documentsTocCutByCount,
  MEMORY_BAKE_FIXTURES,
} from './memory-bake.fixtures.test-support.js';

function bakedChars(bake: ReadonlyMap<string, MemoryDocumentBake>, slug: string): number {
  const entry = bake.get(slug);
  if (entry === undefined || entry.omitted) throw new Error(`${slug} は焼かれていない`);
  return entry.chars;
}

// 断片が焼いた文字列の中に実在することを、断片の始まりの印と長さの両方で確かめる（長さだけ・印だけでは、別の断片を指していても通る）
function fragmentAt(text: string, marker: string, chars: number): string {
  const start = text.indexOf(marker);
  expect(start, `${marker} が焼いた文字列に無い`).toBeGreaterThanOrEqual(0);
  return text.slice(start, start + chars);
}

describe('文書ごとに焼いた断片の長さ（renderMemoryDocumentsWithBake）', () => {
  for (const [name, build] of Object.entries(MEMORY_BAKE_FIXTURES)) {
    it(`${name}: 全体の文字列は renderMemoryDocuments と同じで、全文書に1つずつ答える`, () => {
      const documents = build();
      const { text, bake } = renderMemoryDocumentsWithBake(documents);
      expect(text).toBe(renderMemoryDocuments(documents));
      expect(new Set(bake.keys())).toEqual(new Set(documents.map((doc) => doc.slug)));
    });
  }

  it('カードの断片は、次の断片との区切り（空行）の直前で終わる', () => {
    const { text, bake } = renderMemoryDocumentsWithBake(documentsMixed());
    // 壊れた frontmatter の文書は前に説明の行が付いて始まりがずれるので、次の試験で別に測る
    for (const slug of ['values', 'plain-no-frontmatter', 'index-doc']) {
      const entry = bake.get(slug);
      if (entry === undefined || entry.omitted) throw new Error('焼かれていない');
      expect(entry.form).toMatch(/-card$/);
      const start = text.indexOf(`<!-- memory: ${slug}.md（`);
      const end = start + entry.chars;
      expect(text.slice(end, end + 2) === '\n\n' || end === text.length).toBe(true);
    }
  });

  it('壊れた frontmatter の文書は、前に付く説明の行まで断片の長さに含む', () => {
    const { text, bake } = renderMemoryDocumentsWithBake(documentsMixed());
    const noteStart = text.indexOf('<!-- memory: frontmatter が壊れている');
    const marker = text.indexOf('<!-- memory: broken.md（');
    expect(noteStart).toBeGreaterThanOrEqual(0);
    expect(noteStart).toBeLessThan(marker);
    expect(bakedChars(bake, 'broken')).toBe(text.indexOf('\n\n', marker) - noteStart);
  });

  it('fact は目次の1行の長さ（インデントを含み、改行を含まない）', () => {
    const { text, bake } = renderMemoryDocumentsWithBake(documentsMixed());
    const child = fragmentAt(text, '  - fact-child:', bakedChars(bake, 'fact-child'));
    expect(child.includes('\n')).toBe(false);
    expect(child.startsWith('  - fact-child: 子 — ')).toBe(true);
    const root = fragmentAt(text, '- fact-root:', bakedChars(bake, 'fact-root'));
    expect(root.endsWith('親の事実')).toBe(true);
    expect(bake.get('fact-no-description')).toMatchObject({ omitted: false, form: 'toc-line' });
  });

  it('予算を超えてカードを落とした分は1行の長さで、その一覧からも省かれた分は長さを持たず理由を言う', () => {
    const documents = documentsOverCardBudget();
    const { text, bake } = renderMemoryDocumentsWithBake(documents);
    const forms = { card: 0, stub: 0, omitted: 0 };
    for (const doc of documents) {
      const entry = bake.get(doc.slug) as MemoryDocumentBake;
      if (entry.omitted) {
        forms.omitted += 1;
        expect(entry.reason).toContain('1行の一覧からも省かれた');
        expect(text).not.toContain(`- ${doc.slug}.md（`);
        expect(text).not.toContain(`<!-- memory: ${doc.slug}.md（`);
      } else if (entry.form.endsWith('-stub')) {
        forms.stub += 1;
        const line = fragmentAt(text, `- ${doc.slug}.md（`, entry.chars);
        expect(line.includes('\n')).toBe(false);
      } else {
        forms.card += 1;
        fragmentAt(text, `<!-- memory: ${doc.slug}.md（`, entry.chars);
      }
    }
    // この入力は3つの形が全部出るように作ってある（出なければ、下の確認が何も測っていない）
    expect(forms.card).toBeGreaterThan(0);
    expect(forms.stub).toBeGreaterThan(0);
    expect(forms.omitted).toBeGreaterThan(0);
    expect(forms.card + forms.stub + forms.omitted).toBe(documents.length);
  });

  it('indexed が落ちたときは indexed-stub と名乗る', () => {
    const { bake } = renderMemoryDocumentsWithBake(documentsOverCardBudget());
    const forms = new Set(
      [...bake.values()].flatMap((entry) => (entry.omitted ? [] : [entry.form])),
    );
    expect(forms.has('premise-stub') || forms.has('indexed-stub')).toBe(true);
  });

  it('目次が件数で切れたとき、省かれた fact は長さを持たず件数の上限を理由に言う', () => {
    const documents = documentsTocCutByCount();
    const { text, bake } = renderMemoryDocumentsWithBake(documents);
    const omitted = [...bake.entries()].filter(([, entry]) => entry.omitted);
    expect(omitted.length).toBeGreaterThan(0);
    for (const [slug, entry] of omitted) {
      if (!entry.omitted) continue;
      expect(entry.reason).toContain('件数の上限');
      expect(text).not.toContain(`- ${slug}:`);
    }
    expect(omitted.length + [...bake.values()].filter((entry) => !entry.omitted).length).toBe(
      documents.length,
    );
  });

  it('目次が文字数で切れたとき、理由は文字数の予算になる', () => {
    const { text, bake } = renderMemoryDocumentsWithBake(documentsTocCutByChars());
    const omitted = [...bake.entries()].filter(([, entry]) => entry.omitted);
    expect(omitted.length).toBeGreaterThan(0);
    for (const [slug, entry] of omitted) {
      if (!entry.omitted) continue;
      expect(entry.reason).toContain('文字数の予算');
      expect(entry.reason).not.toContain('件数の上限');
      expect(text).not.toContain(`- ${slug}:`);
    }
  });

  it('文書が1つも無ければ、答えも空', () => {
    const { text, bake } = renderMemoryDocumentsWithBake([]);
    expect(text).toBe('');
    expect(bake.size).toBe(0);
  });
});
