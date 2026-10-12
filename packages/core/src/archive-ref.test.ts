import { describe, expect, it } from 'vitest';

import {
  acceptsArchiveRef,
  ArchiveStash,
  isArchiveRefId,
  type ArchiveStashDrop,
} from './archive-ref.js';

describe('acceptsArchiveRef / isArchiveRefId（#4485）', () => {
  it('カンマ区切りの名前の並びに archive-ref が在るときだけ受け取れると読む', () => {
    expect(acceptsArchiveRef('archive-ref')).toBe(true);
    expect(acceptsArchiveRef('foo, archive-ref ,bar')).toBe(true);
    expect(acceptsArchiveRef('archive-refs')).toBe(false);
    expect(acceptsArchiveRef('')).toBe(false);
    expect(acceptsArchiveRef(undefined)).toBe(false);
    expect(acceptsArchiveRef(null)).toBe(false);
  });

  it('id は randomUUID の形だけを通す（パスの部品になるため）', () => {
    expect(isArchiveRefId('0b5c6e1a-2f3d-4a7b-9c8d-1e2f3a4b5c6d')).toBe(true);
    expect(isArchiveRefId('../etc/passwd')).toBe(false);
    expect(isArchiveRefId('0B5C6E1A-2F3D-4A7B-9C8D-1E2F3A4B5C6D')).toBe(false);
  });
});

describe('ArchiveStash（#4485）', () => {
  it('預けた本文を委譲と id で読み、別の委譲の id では読めず消せない', () => {
    const stash = new ArchiveStash();
    const { id, chars } = stash.put('mgr-1', 'abc');
    expect(chars).toBe(3);
    expect(isArchiveRefId(id)).toBe(true);
    expect(stash.get('mgr-1', id)).toBe('abc');
    expect(stash.get('mgr-2', id)).toBeUndefined();
    stash.delete('mgr-2', id);
    expect(stash.get('mgr-1', id)).toBe('abc');
    stash.delete('mgr-1', id);
    expect(stash.get('mgr-1', id)).toBeUndefined();
    // 冪等
    stash.delete('mgr-1', id);
  });

  it('期限を過ぎた本文は捨て、捨てたことを知らせる', () => {
    let now = 0;
    const drops: ArchiveStashDrop[] = [];
    const stash = new ArchiveStash({ now: () => now, ttlMs: 1_000, onDrop: (d) => drops.push(d) });
    const { id } = stash.put('mgr-1', 'old');
    now = 999;
    expect(stash.get('mgr-1', id)).toBe('old');
    now = 1_000;
    expect(stash.get('mgr-1', id)).toBeUndefined();
    expect(drops).toEqual([{ managerId: 'mgr-1', archiveId: id, chars: 3, reason: 'expired' }]);
  });

  it('本数・文字数の上限を超えたら古いものから捨て、入れたばかりの1本は捨てない', () => {
    const drops: ArchiveStashDrop[] = [];
    const stash = new ArchiveStash({ maxEntries: 2, maxChars: 10, onDrop: (d) => drops.push(d) });
    const a = stash.put('mgr-1', 'aaaa');
    const b = stash.put('mgr-1', 'bbbb');
    const c = stash.put('mgr-1', 'cccc');
    expect(stash.get('mgr-1', a.id)).toBeUndefined();
    expect(stash.get('mgr-1', b.id)).toBe('bbbb');
    expect(stash.get('mgr-1', c.id)).toBe('cccc');
    expect(drops.map((d) => [d.archiveId, d.reason])).toEqual([[a.id, 'over-capacity']]);

    // 1本で上限を超えても、その1本は持つ（他を捨てる）
    const big = stash.put('mgr-1', 'x'.repeat(50));
    expect(stash.get('mgr-1', big.id)).toBe('x'.repeat(50));
    expect(stash.size).toBe(1);
  });
});
