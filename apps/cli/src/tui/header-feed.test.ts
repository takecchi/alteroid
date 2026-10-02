import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { fakeApi } from './fake-api.js';
import { affectsHeader, HeaderFeed, retryDelay } from './header-feed.js';

describe('retryDelay（指数バックオフ）', () => {
  it('1 秒から倍々で、30 秒で頭打ち', () => {
    expect([0, 1, 2, 3, 4, 5, 6, 10].map((n) => retryDelay(n))).toEqual([
      1000, 2000, 4000, 8000, 16000, 30000, 30000, 30000,
    ]);
  });
});

describe('affectsHeader', () => {
  it('件数に響かない量の多い種別だけを除く', () => {
    expect(affectsHeader('escalation')).toBe(true);
    expect(affectsHeader('exchange')).toBe(true);
    expect(affectsHeader('tool_use')).toBe(true);
    expect(affectsHeader('turn_usage')).toBe(false);
    expect(affectsHeader('context_usage')).toBe(false);
    expect(affectsHeader('inbox_flow')).toBe(false);
  });
});

describe('HeaderFeed', () => {
  beforeEach(() => vi.useFakeTimers());
  afterEach(() => vi.useRealTimers());

  const flush = async (ms = 0): Promise<void> => {
    await vi.advanceTimersByTimeAsync(ms);
  };

  it('起動時に件数を取り、open で live になる', async () => {
    const api = fakeApi();
    api.counts = { pendingApprovals: 3, runningManagers: 2 };
    const feed = new HeaderFeed(api);
    expect(feed.store.getSnapshot()).toEqual({ counts: null, live: 'connecting' });
    feed.start();
    await flush();
    expect(feed.store.getSnapshot()).toEqual({
      counts: { pendingApprovals: 3, runningManagers: 2 },
      live: 'live',
    });
    feed.stop();
  });

  it('届いた出来事で件数を取り直す。続けて届いてもまとめる', async () => {
    const api = fakeApi();
    let calls = 0;
    const original = api.headerCounts.bind(api);
    api.headerCounts = () => {
      calls += 1;
      return original();
    };
    api.journal.push({ events: ['open', 'escalation', 'exchange', 'tool_use'] });
    const feed = new HeaderFeed(api, { refetchDebounceMs: 100, retryBaseMs: 1_000_000 });
    feed.start();
    await flush();
    const afterOpen = calls; // start と open の取得
    api.counts = { pendingApprovals: 1, runningManagers: 0 };
    await flush(150);
    expect(calls).toBe(afterOpen + 1); // 3 件の出来事が 1 回にまとまる
    expect(feed.store.getSnapshot().counts).toEqual({ pendingApprovals: 1, runningManagers: 0 });
    feed.stop();
  });

  it('量の多い種別では取り直さない', async () => {
    const api = fakeApi();
    let calls = 0;
    const original = api.headerCounts.bind(api);
    api.headerCounts = () => {
      calls += 1;
      return original();
    };
    api.journal.push({ events: ['open', 'turn_usage', 'inbox_flow'] });
    const feed = new HeaderFeed(api, { refetchDebounceMs: 10, retryBaseMs: 1_000_000 });
    feed.start();
    await flush(100);
    expect(calls).toBe(2); // start と open だけ
    feed.stop();
  });

  it('切れたら offline になり、指数バックオフで張り直す。繋がったら件数も取り直す', async () => {
    const api = fakeApi();
    api.journal.push({ events: ['open', new Error('切れた')] });
    api.journal.push({ events: [new Error('まだ繋がらない')] });
    // 3 本目は台本無し = 繋がったまま黙る。
    const feed = new HeaderFeed(api, { retryBaseMs: 1_000 });
    feed.start();
    await flush();
    expect(feed.store.getSnapshot().live).toBe('offline');

    api.counts = { pendingApprovals: 5, runningManagers: 0 };
    await flush(999);
    expect(feed.store.getSnapshot().live).toBe('offline');
    await flush(1); // 1 秒後に 2 本目（失敗）
    await flush();
    expect(feed.store.getSnapshot().live).toBe('offline');
    await flush(1_999); // 次は 2 秒後
    expect(feed.store.getSnapshot().live).toBe('offline');
    await flush(1);
    expect(feed.store.getSnapshot().live).toBe('live');
    expect(feed.store.getSnapshot().counts?.pendingApprovals).toBe(5);
    feed.stop();
  });

  it('取り直しに失敗しても前の件数を残す（0 にしない）', async () => {
    const api = fakeApi();
    api.counts = { pendingApprovals: 4, runningManagers: 1 };
    const feed = new HeaderFeed(api);
    feed.start();
    await flush();
    api.headerCounts = () => Promise.reject(new Error('読めない'));
    await feed.refetch();
    expect(feed.store.getSnapshot().counts).toEqual({ pendingApprovals: 4, runningManagers: 1 });
    feed.stop();
  });

  it('stop したら再接続も取り直しも止まる', async () => {
    const api = fakeApi();
    api.journal.push({ events: ['open', new Error('切れた')] });
    const feed = new HeaderFeed(api, { retryBaseMs: 1_000 });
    feed.start();
    await flush();
    feed.stop();
    const before = api.journal.length;
    await flush(60_000);
    expect(api.journal.length).toBe(before);
  });
});
