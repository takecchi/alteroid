import { afterEach, describe, expect, it, vi } from 'vitest';

import {
  TRANSCRIPT_PAGE_CACHE_TTL_MS,
  TranscriptPageCache,
  transcriptPageCacheKey,
  type TranscriptPageSnapshot,
} from './transcript-page-cache.js';

// 頁送りの間だけ生ログを覚える器は、1件だけを期限つきで持つ（#4638）

const snapshot = (body: string): TranscriptPageSnapshot => ({
  body,
  filterNote: '',
  fetchedAt: '2026-10-14T00:00:00.000Z',
});

afterEach(() => {
  vi.useRealTimers();
});

describe('TranscriptPageCache', () => {
  it('同じ鍵なら期限までは返し、期限を過ぎたら返さずに捨てる', () => {
    let clock = 0;
    const cache = new TranscriptPageCache({ ttlMs: 1_000, now: () => clock });
    cache.set('k', snapshot('本文'));

    clock = 999;
    expect(cache.get('k')?.body).toBe('本文');
    clock = 1_000;
    expect(cache.get('k')).toBeUndefined();
    expect(cache.holding).toBe(false);
  });

  it('覚えるのは1件だけ: 別の鍵で覚えると前の1件は捨てる', () => {
    const cache = new TranscriptPageCache();
    cache.set('a', snapshot('A'));
    cache.set('b', snapshot('B'));

    expect(cache.get('a')).toBeUndefined();
    expect(cache.get('b')?.body).toBe('B');
    cache.clear();
  });

  it('読み手が来なくても、期限が来たらタイマーで捨てる（大きな本文を残し続けない）', () => {
    vi.useFakeTimers();
    const cache = new TranscriptPageCache();
    cache.set('k', snapshot('本文'));

    vi.advanceTimersByTime(TRANSCRIPT_PAGE_CACHE_TTL_MS - 1);
    expect(cache.holding).toBe(true);
    vi.advanceTimersByTime(1);
    expect(cache.holding).toBe(false);
  });

  it('覚え直すと期限も延びる（前のタイマーで新しい本文が捨てられない）', () => {
    vi.useFakeTimers();
    const cache = new TranscriptPageCache();
    cache.set('k', snapshot('古い'));
    vi.advanceTimersByTime(TRANSCRIPT_PAGE_CACHE_TTL_MS - 1);
    cache.set('k', snapshot('新しい'));

    vi.advanceTimersByTime(1);
    expect(cache.holding).toBe(true);
    cache.clear();
  });
});

describe('transcriptPageCacheKey', () => {
  it('担当と絞りのどれかが違えば別の鍵になり、区切りの文字で衝突しない', () => {
    const base = transcriptPageCacheKey({ managerId: 'mgr-1' });
    expect(transcriptPageCacheKey({ managerId: 'mgr-2' })).not.toBe(base);
    expect(transcriptPageCacheKey({ managerId: 'mgr-1', since: 's' })).not.toBe(base);
    expect(transcriptPageCacheKey({ managerId: 'mgr-1', until: 'u' })).not.toBe(base);
    expect(transcriptPageCacheKey({ managerId: 'mgr-1', type: 't' })).not.toBe(base);
    expect(transcriptPageCacheKey({ managerId: 'mgr-1', contains: 'c' })).not.toBe(base);
    expect(transcriptPageCacheKey({ managerId: 'mgr-1', type: 'a', contains: 'b' })).not.toBe(
      transcriptPageCacheKey({ managerId: 'mgr-1', type: 'a,b' }),
    );
  });
});
