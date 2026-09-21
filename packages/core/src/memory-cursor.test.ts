import { describe, expect, it } from 'vitest';

import { decodeMemoryCursor, encodeMemoryCursor, resolveMemoryCursor } from './memory-cursor.js';
import type { MemoryDocumentMeta } from './schema.js';

/**
 * `resolveMemoryCursor`（`memory_list` の継続点）の分岐対応表。
 *
 * `schedule-cursor.test.ts` と同じ形（分岐を数え上げて1本ずつ歯を通す）。
 *
 * | 分岐 | 内容 | 歯 |
 * | --- | --- | --- |
 * | B1 | `cursorRaw === undefined` → 絞らない（先頭から） | `B1: cursor 未指定は先頭から（絞らない）` |
 * | B2 | base64 として読めない | `B2: base64 として読めない cursor は malformed` |
 * | B3 | base64/JSON としては読めるが schema に合わない | `B3: schema に合わない cursor は malformed` |
 * | B4 | 有効な cursor（錨が実在する。位置の探索） | `B4: 錨が実在すれば位置の探索でそれより後ろだけを残す` |
 * | B5 | 錨が現在の一覧に実在しない（文書が消された等） | `B5: 錨が消えていても比較（第二の手段）で続きが決まる` |
 * | B6 | cursor が一覧の末尾を指す | `B6: cursor が最後の行を指していれば view は空（最後の頁）` |
 */
function meta(slug: string): MemoryDocumentMeta {
  return {
    slug,
    title: `${slug} の見出し`,
    updatedAt: '2026-01-01T00:00:00.000Z',
    createdAt: { at: '2026-01-01T00:00:00.000Z', source: 'observed' },
    bytes: 10,
    frontmatter: {},
    kind: 'premise',
    description: undefined,
    parent: undefined,
    descriptionFreshness: undefined,
  } as unknown as MemoryDocumentMeta;
}

describe('encodeMemoryCursor / decodeMemoryCursor（部品）', () => {
  it('符号化・復号の往復で中身が保たれる', () => {
    const cursor = { from: 'about-me' };
    expect(decodeMemoryCursor(encodeMemoryCursor(cursor))).toEqual({ ok: true, cursor });
  });

  it('B2: base64 として読めない cursor は malformed', () => {
    expect(decodeMemoryCursor('!!! not base64 !!!')).toEqual({ ok: false });
  });

  it('B3: schema に合わない cursor は malformed（from が空文字）', () => {
    const raw = Buffer.from(JSON.stringify({ from: '' }), 'utf8').toString('base64url');
    expect(decodeMemoryCursor(raw)).toEqual({ ok: false });
  });

  it('B3: schema に合わない cursor は malformed（from の欄が無い）', () => {
    const raw = Buffer.from(JSON.stringify({ kind: 'x' }), 'utf8').toString('base64url');
    expect(decodeMemoryCursor(raw)).toEqual({ ok: false });
  });
});

describe('resolveMemoryCursor（分岐）', () => {
  const entries = [meta('a'), meta('b'), meta('c')];

  it('B1: cursor 未指定は先頭から（絞らない）', () => {
    const result = resolveMemoryCursor(entries, undefined);
    expect(result).toEqual({ kind: 'ok', view: entries });
  });

  it('B2/B3を統合: 壊れた cursor は malformed（黙って先頭へ倒さない）', () => {
    expect(resolveMemoryCursor(entries, '!!!')).toEqual({ kind: 'malformed' });
  });

  it('B4: 錨が実在すれば、位置の探索でその行から（含む）後ろを残す', () => {
    const result = resolveMemoryCursor(entries, encodeMemoryCursor({ from: 'b' }));
    expect(result.kind).toBe('ok');
    expect(result.kind === 'ok' && result.view.map((e) => e.slug)).toEqual(['b', 'c']);
  });

  it('B5: 錨が消えていても比較（第二の手段）で続きが決まる', () => {
    // 'a' と 'b' の間に在った文書が消された、という状況。
    const result = resolveMemoryCursor(entries, encodeMemoryCursor({ from: 'a-gone' }));
    expect(result.kind).toBe('ok');
    expect(result.kind === 'ok' && result.view.map((e) => e.slug)).toEqual(['b', 'c']);
  });

  it('B6: cursor が末尾より後ろを指していれば view は空（最後の頁）', () => {
    const result = resolveMemoryCursor(entries, encodeMemoryCursor({ from: 'c-gone' }));
    expect(result).toEqual({ kind: 'ok', view: [] });
  });
});
