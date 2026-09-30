import { describe, expect, it } from 'vitest';

import { decodeMemoryCursor, resolveMemoryCursor } from './memory-cursor.js';
import { renderMemoryListing } from './memory.js';
import type { MemoryDocumentMeta } from './schema.js';

/**
 * 候補: 「slug の小さい子 `b`（親 `z` は slug が大きい）の前に予算を食う root が
 * 並ぶと、続きの cursor が `b` を指したまま頁が進まない」。
 *
 * `tools.ts` の memory_list ハンドラと同じ手順（resolveMemoryCursor → renderMemoryListing
 * に paging.total を渡す）を、ストアを使わず純関数だけで再現する。
 */
function doc(slug: string, parent: string | undefined, description: string): MemoryDocumentMeta {
  return {
    slug,
    title: `題 ${slug}`,
    kind: 'fact',
    description,
    descriptionFreshness: { kind: 'fresh' },
    parent,
    updatedAt: '2026-08-21T00:00:00Z',
    createdAt: { kind: 'unknown' },
  } as unknown as MemoryDocumentMeta;
}

function page(documents: readonly MemoryDocumentMeta[], cursor: string | undefined): string {
  const resolved = resolveMemoryCursor(documents, cursor);
  if (resolved.kind !== 'ok') throw new Error('malformed cursor');
  return renderMemoryListing(
    resolved.view.map((d) => ({
      slug: d.slug,
      title: d.title,
      kind: d.kind,
      description: d.description,
      descriptionFreshness: d.descriptionFreshness,
      parent: d.parent,
      updatedAt: d.updatedAt,
      createdAt: d.createdAt,
    })),
    { total: documents.length, anchor: resolved.anchor },
  );
}

function nextCursor(listing: string): string | undefined {
  return /memory_list cursor=([A-Za-z0-9_-]+)/.exec(listing)?.[1];
}

describe('memory_list の cursor は、親の slug が子より大きくても頁が進む', () => {
  it('b（子）/ z（親）/ c001..c200（長い説明の root）: cursor を辿って全文書に届く', () => {
    const long = 'あ'.repeat(150);
    // PersonaStore.list() の契約どおり slug 昇順に並べる。
    const documents = [
      doc('b', 'z', '子'),
      ...Array.from({ length: 200 }, (_, i) =>
        doc(`c${String(i + 1).padStart(3, '0')}`, undefined, long),
      ),
      doc('z', undefined, '親'),
    ].sort((x, y) => (x.slug < y.slug ? -1 : x.slug > y.slug ? 1 : 0));

    const seen = new Set<string>();
    const cursors: string[] = [];
    let cursor: string | undefined;
    for (let i = 0; i < 20; i++) {
      const listing = page(documents, cursor);
      for (const d of documents) if (listing.includes(`- [fact] ${d.slug}:`)) seen.add(d.slug);
      const next = nextCursor(listing);
      if (next === undefined) break;
      cursors.push(next);
      cursor = next;
    }

    const froms = cursors.map((c) => {
      const decoded = decodeMemoryCursor(c);
      return decoded.ok ? decoded.cursor.from : '?';
    });
    // 同じ cursor が2回続けて返る = 頁が進んでいない
    // 同じ cursor が2回続けて返る = 頁が進んでいない（ストア順で from が増えること）
    const stalled = froms.some(
      (from, i) =>
        i > 0 &&
        documents.findIndex((d) => d.slug === from) <=
          documents.findIndex((d) => d.slug === froms[i - 1]),
    );
    expect({
      stalled,
      froms,
      reachedAll: seen.size === documents.length,
      missing: documents.length - seen.size,
    }).toEqual({
      stalled: false,
      froms: froms,
      reachedAll: true,
      missing: 0,
    });
  });
});
