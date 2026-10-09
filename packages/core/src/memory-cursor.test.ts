import { describe, expect, it } from 'vitest';

import { decodeMemoryCursor, encodeMemoryCursor, resolveMemoryCursor } from './memory-cursor.js';
import type { MemoryDocumentMeta } from './schema.js';

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
    const result = resolveMemoryCursor(entries, encodeMemoryCursor({ from: 'a-gone' }));
    expect(result.kind).toBe('ok');
    expect(result.kind === 'ok' && result.view.map((e) => e.slug)).toEqual(['b', 'c']);
  });

  it('B6: cursor が末尾より後ろを指していれば view は空（最後の頁）', () => {
    const result = resolveMemoryCursor(entries, encodeMemoryCursor({ from: 'c-gone' }));
    expect(result).toEqual({ kind: 'ok', view: [] });
  });

  it('B7: anchor は view の先頭（#2510。描画側が必ず先頭に出す文書）', () => {
    const hit = resolveMemoryCursor(entries, encodeMemoryCursor({ from: 'b' }));
    expect(hit.kind === 'ok' && hit.anchor).toBe('b');
    const gone = resolveMemoryCursor(entries, encodeMemoryCursor({ from: 'a-gone' }));
    expect(gone.kind === 'ok' && gone.anchor).toBe('b');
    const first = resolveMemoryCursor(entries, undefined);
    expect(first.kind === 'ok' && first.anchor).toBeUndefined();
    const end = resolveMemoryCursor(entries, encodeMemoryCursor({ from: 'c-gone' }));
    expect(end.kind === 'ok' && end.anchor).toBeUndefined();
  });
});
