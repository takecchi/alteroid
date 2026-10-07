import { readFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import { describe, expect, it } from 'vitest';

import {
  JOURNAL_SEARCH_UNCOVERED_LIST,
  JOURNAL_SEARCH_UNCOVERED_LIST_MD,
  JOURNAL_SEARCH_UNSEARCHABLE_TYPES,
  SEARCHABLE_FIELDS_BY_TYPE,
} from '../packages/core/src/journal-search.js';

import { collectRepoFiles } from './repo-scan-files.js';

const ROOT = fileURLToPath(new URL('..', import.meta.url));
const EXCLUDE_DIRS = new Set(['node_modules', '.git', 'dist', 'build', '.react-router', '.vite']);
const SELF = 'scripts/journal-search-note.test.ts';
const TABLE_FILE = 'packages/core/src/journal-search.ts';

describe('日誌の検索の断りの並びは、SEARCHABLE_FIELDS_BY_TYPE から導かれる（#2609）', () => {
  const entries = Object.entries(SEARCHABLE_FIELDS_BY_TYPE) as [string, readonly string[]][];

  it('欄が空の種別がすべて載り、欄を持つ種別は載らない', () => {
    const empty = entries.filter(([, fields]) => fields.length === 0).map(([type]) => type);
    expect(empty.length).toBeGreaterThan(0);
    expect([...JOURNAL_SEARCH_UNSEARCHABLE_TYPES]).toEqual(empty);
    const listed = JOURNAL_SEARCH_UNCOVERED_LIST.split('・');
    for (const [type, fields] of entries) {
      expect(listed.includes(type), `${type} の載り方`).toBe(fields.length === 0);
    }
    expect(listed[0]).toBe('tool_use の input');
  });

  it('Markdown 版も同じ並び（名前だけバッククォートで囲む）', () => {
    expect(
      JOURNAL_SEARCH_UNCOVERED_LIST_MD.replaceAll('`', '').replace(
        'tool_use input',
        'tool_use の input',
      ),
    ).toBe(JOURNAL_SEARCH_UNCOVERED_LIST);
  });

  it('GET /journal の description（openapi.json）が、導いた並びを含む', () => {
    const spec = JSON.parse(readFileSync(path.join(ROOT, 'apps/daemon/openapi.json'), 'utf8')) as {
      paths: Record<string, { get?: { description?: string } }>;
    };
    expect(spec.paths['/journal']?.get?.description).toContain(
      `${JOURNAL_SEARCH_UNCOVERED_LIST_MD} は探す対象に入っていない。`,
    );
  });

  it('並びを手書きし直した所が無い（テストと生成物を除くソース）', () => {
    const files = collectRepoFiles(ROOT, EXCLUDE_DIRS).filter(
      (rel) =>
        /\.(ts|tsx|mjs)$/.test(rel) &&
        !/\.test(-support)?\.(ts|tsx)$/.test(rel) &&
        rel !== SELF &&
        rel !== TABLE_FILE &&
        !rel.includes('/generated/'),
    );
    expect(files.length).toBeGreaterThan(100);
    const handWritten = /`?worker_wait`?・`?turn_usage`?/;
    const offenders = files.filter((rel) =>
      handWritten.test(readFileSync(path.join(ROOT, rel), 'utf8')),
    );
    expect(
      offenders,
      '検索の断りの並びを手書きしている。packages/core/src/journal-search.ts の JOURNAL_SEARCH_UNCOVERED_LIST(_MD) を使うこと',
    ).toEqual([]);
  });
});
