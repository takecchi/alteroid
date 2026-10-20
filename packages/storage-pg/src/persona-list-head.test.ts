import type { MemoryDocument, MemoryDocumentMeta } from '@alteroid/core';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import type { Db } from './db.js';
import { createPgStoresFromDb, type PgStores } from './index.js';
import { createMigratedTestDb, type TestDbHandle } from './test-db.test-support.js';

// 記憶の一覧が本文を全部流さずに、`read()` から作る値と同じ一覧を返す（#5089）

let client: TestDbHandle;
let db: Db;
let stores: PgStores;

beforeEach(async () => {
  ({ client, db } = await createMigratedTestDb());
  stores = createPgStoresFromDb(db);
});

afterEach(async () => {
  await client.close();
});

const HEAD = 4096;
const filler = (chars: number): string =>
  `${'あいうえお本文。'.repeat(Math.ceil(chars / 8)).slice(0, chars)}\n`;

function metaOfDocument(doc: MemoryDocument): MemoryDocumentMeta {
  const meta: Partial<MemoryDocument> = { ...doc };
  delete meta.content;
  return meta as MemoryDocumentMeta;
}

const DOCS: Record<string, string> = {
  short: '# 短い\n\n本文\n',
  'no-heading-short': '見出しの無い短い文書\n',
  'frontmatter-short': '---\ndescription: 説明\ntype: topic\n---\n# 題\n本文\n',
  'malformed-short': '---\ndescription 区切りが無い\n---\n# 題\n',
  'long-heading-top': `# 長い文書\n\n${filler(HEAD * 3)}`,
  'long-frontmatter-top': `---\ndescription: 長い文書の説明\nparent: short\n---\n# 題\n${filler(HEAD * 3)}`,
  // 見出しが先頭の外: 本文を読み直さないと題が決まらない
  'long-heading-deep': `${filler(HEAD * 2)}# 深い見出し\n${filler(100)}`,
  'long-no-heading': filler(HEAD * 2),
  // frontmatter が先頭の中で閉じない
  'long-frontmatter-open': `---\ndescription: ${'長'.repeat(HEAD * 2)}\n---\n# 題\n`,
  // 先頭のちょうど境目で見出しの行が切れる
  // 先頭が「# 境目」で切れる: 切れた行を使うと題が「境目」になってしまう
  'heading-cut-at-boundary': `${'x'.repeat(HEAD - 5)}\n# 境目で切れる見出し\n${filler(HEAD)}`,
  'crlf-long': `# CRLF の題\r\n${'行\r\n'.repeat(HEAD)}`,
  'exactly-head': `# ちょうど\n${'y'.repeat(HEAD - '# ちょうど\n'.length - 1)}\n`,
  emoji: `# 絵文字 😀\n${'😀'.repeat(HEAD * 2)}\n`,
};

describe('PgPersonaStore.list（#5089）', () => {
  it('⭐ 一覧の各行は read() から作る値と同じ（並びも変えない）', async () => {
    for (const [slug, content] of Object.entries(DOCS)) {
      await stores.persona.write(slug, content);
    }
    const listed = await stores.persona.list();

    const expected: MemoryDocumentMeta[] = [];
    for (const slug of listed.map((entry) => entry.slug)) {
      const doc = await stores.persona.read(slug);
      if (doc === null) throw new Error(`${slug} が読めない`);
      expected.push(metaOfDocument(doc));
    }
    expect(listed).toEqual(expected);
    expect(new Set(listed.map((entry) => entry.slug))).toEqual(new Set(Object.keys(DOCS)));
    // 並びは slug のバイト順（変える前と同じ）
    expect(listed.map((entry) => entry.slug)).toEqual(
      [...Object.keys(DOCS)].sort((a, b) => Buffer.compare(Buffer.from(a), Buffer.from(b))),
    );
    // 題が先頭の外にしか無い文書も、全文と同じ題になる
    expect(listed.find((entry) => entry.slug === 'long-heading-deep')?.title).toBe('深い見出し');
    expect(listed.find((entry) => entry.slug === 'long-no-heading')?.title).toBe('long-no-heading');
  });

  it('⭐ 先頭で決まる文書の本文は読まない（本文を流すのは決まらない文書だけ）', async () => {
    await stores.persona.write('decided', `# 題\n${filler(HEAD * 10)}`);
    await stores.persona.write('undecided', filler(HEAD * 2));

    const queries: { sql: string; params: unknown[] }[] = [];
    const logged = createPgStoresFromDb(
      client.withLogger({
        logQuery: (sql, params) => {
          queries.push({ sql, params });
        },
      }),
    );

    const listed = await logged.persona.list();

    expect(listed.map((entry) => entry.slug)).toEqual(['decided', 'undecided']);
    // 本文の列を丸ごと選ぶのは2本目だけで、その対象は決まらない文書だけ
    const fullReads = queries.filter((query) => /select "slug", "content"/.test(query.sql));
    expect(fullReads).toHaveLength(1);
    expect(fullReads[0]?.params).toEqual(['undecided']);
  });
});
