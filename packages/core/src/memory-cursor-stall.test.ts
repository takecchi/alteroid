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

describe('memory_list の頁送り: 親子が入り乱れても、必ず進み・欠落しない（#2510）', () => {
  // 決まった種から作る擬似乱数（失敗を再現できるように）。
  function rng(seed: number): () => number {
    let s = seed;
    return () => {
      s = (s * 1664525 + 1013904223) % 4294967296;
      return s / 4294967296;
    };
  }

  it('親の向き（slug の大小）をばらした 40 通りで、from が厳密に増え、全文書に届く', () => {
    const long = 'あ'.repeat(120);
    for (let seed = 1; seed <= 40; seed++) {
      const rand = rng(seed);
      const slugs = Array.from({ length: 160 }, (_, i) => `s${String(i).padStart(3, '0')}`);
      const documents = slugs.map((slug, i) => {
        // 約半数に、自分より前・後ろどちらの slug にもなりうる親を付ける（自己参照は除く）。
        const parentIndex = Math.floor(rand() * slugs.length);
        const parent = rand() < 0.5 && parentIndex !== i ? slugs[parentIndex] : undefined;
        return doc(slug, parent, long);
      });
      const seen = new Set<string>();
      let previousIndex = -1;
      let cursor: string | undefined;
      let finished = false;
      for (let i = 0; i < documents.length + 1; i++) {
        const listing = page(documents, cursor);
        for (const d of documents) if (listing.includes(`- [fact] ${d.slug}:`)) seen.add(d.slug);
        const next = nextCursor(listing);
        if (next === undefined) {
          finished = true;
          break;
        }
        const decoded = decodeMemoryCursor(next);
        const from = decoded.ok ? decoded.cursor.from : '?';
        const index = documents.findIndex((d) => d.slug === from);
        expect(index, `seed=${String(seed)} 頁 ${String(i)}`).toBeGreaterThan(previousIndex);
        previousIndex = index;
        cursor = next;
      }
      expect({ seed, finished, missing: documents.length - seen.size }).toEqual({
        seed,
        finished: true,
        missing: 0,
      });
    }
  });

  it('cursor 無しの1頁目は、錨を渡さない描き方と同じ（1頁目の表示は変わらない）', () => {
    const documents = [doc('a', 'z', '子'), doc('m', undefined, '根'), doc('z', undefined, '親')];
    const entries = documents.map((d) => ({ ...d }));
    expect(page(documents, undefined)).toBe(
      renderMemoryListing(entries, { total: documents.length }),
    );
  });
});
