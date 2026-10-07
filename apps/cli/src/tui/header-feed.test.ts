import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { fakeApi, said } from './fake-api.js';
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
    api.counts = { pendingApprovals: 3, unreadableApprovals: 0, runningManagers: 2 };
    const feed = new HeaderFeed(api);
    expect(feed.store.getSnapshot()).toEqual({ counts: null, live: 'connecting' });
    feed.start();
    await flush();
    expect(feed.store.getSnapshot()).toEqual({
      counts: { pendingApprovals: 3, unreadableApprovals: 0, runningManagers: 2 },
      live: 'live',
    });
    feed.stop();
  });

  it('読めない行の数だけが変わっても、件数を差し替える（#3090）', async () => {
    const api = fakeApi();
    api.counts = { pendingApprovals: 0, unreadableApprovals: 0, runningManagers: 0 };
    api.journal.push({ events: ['open'] });
    const feed = new HeaderFeed(api, { refetchDebounceMs: 100, retryBaseMs: 1_000_000 });
    feed.start();
    await flush();
    api.counts = { pendingApprovals: 0, unreadableApprovals: 2, runningManagers: 0 };
    await feed.refetch();
    expect(feed.store.getSnapshot().counts?.unreadableApprovals).toBe(2);
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
    const afterOpen = calls;
    api.counts = { pendingApprovals: 1, unreadableApprovals: 0, runningManagers: 0 };
    await flush(150);
    expect(calls).toBe(afterOpen + 1);
    expect(feed.store.getSnapshot().counts).toEqual({
      pendingApprovals: 1,
      unreadableApprovals: 0,
      runningManagers: 0,
    });
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
    expect(calls).toBe(2);
    feed.stop();
  });

  it('切れたら offline になり、指数バックオフで張り直す。繋がったら件数も取り直す', async () => {
    const api = fakeApi();
    api.journal.push({ events: ['open', new Error('切れた')] });
    api.journal.push({ events: [new Error('まだ繋がらない')] });
    const feed = new HeaderFeed(api, { retryBaseMs: 1_000 });
    feed.start();
    await flush();
    expect(feed.store.getSnapshot().live).toBe('offline');

    api.counts = { pendingApprovals: 5, unreadableApprovals: 0, runningManagers: 0 };
    await flush(999);
    expect(feed.store.getSnapshot().live).toBe('offline');
    await flush(1);
    await flush();
    expect(feed.store.getSnapshot().live).toBe('offline');
    await flush(1_999);
    expect(feed.store.getSnapshot().live).toBe('offline');
    await flush(1);
    expect(feed.store.getSnapshot().live).toBe('live');
    expect(feed.store.getSnapshot().counts?.pendingApprovals).toBe(5);
    feed.stop();
  });

  it('取り直しに失敗しても前の件数を残す（0 にしない）', async () => {
    const api = fakeApi();
    api.counts = { pendingApprovals: 4, unreadableApprovals: 0, runningManagers: 1 };
    const feed = new HeaderFeed(api);
    feed.start();
    await flush();
    api.headerCounts = () => Promise.reject(new Error('読めない'));
    await feed.refetch();
    expect(feed.store.getSnapshot().counts).toEqual({
      pendingApprovals: 4,
      unreadableApprovals: 0,
      runningManagers: 1,
    });
    feed.stop();
  });

  it('片方だけ取れたら、取れた側だけ更新し、取れなかった側は前の件数を残す（#3730）', async () => {
    const api = fakeApi();
    api.counts = { pendingApprovals: 4, unreadableApprovals: 1, runningManagers: 1 };
    const feed = new HeaderFeed(api);
    feed.start();
    await flush();
    api.headerCounts = () => Promise.resolve({ runningManagers: 3 });
    await feed.refetch();
    expect(feed.store.getSnapshot().counts).toEqual({
      pendingApprovals: 4,
      unreadableApprovals: 1,
      runningManagers: 3,
    });
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

describe('HeaderFeed.onEntry（日誌のタブが 1 本の SSE を共有する口）', () => {
  beforeEach(() => vi.useFakeTimers());
  afterEach(() => vi.useRealTimers());

  it('届いたエントリの本体を全種別で渡す（件数に響かない種別も）。open は渡さない。解除できる', async () => {
    const api = fakeApi();
    api.journal.push({
      events: [
        'open',
        { type: 'exchange', entry: said(1) },
        { type: 'turn_usage', entry: { ...said(2), type: 'turn_usage' } as never },
        'escalation',
      ],
    });
    const feed = new HeaderFeed(api, { retryBaseMs: 1_000_000 });
    const seen: string[] = [];
    const stop = feed.onEntry((entry) => seen.push(entry.id));
    const events: string[] = [];
    feed.onEvent((type) => events.push(type));
    feed.start();
    await vi.advanceTimersByTimeAsync(0);
    expect(seen).toEqual(['e1', 'e2']);
    expect(events).toEqual(['open', 'exchange', 'escalation']);
    stop();
    feed.stop();
  });

  it('2 本目の SSE は張らない（journalStream の呼びは接続ごとに 1 本）', async () => {
    const api = fakeApi();
    let opened = 0;
    const original = api.journalStream.bind(api);
    api.journalStream = (signal) => {
      opened += 1;
      return original(signal);
    };
    const feed = new HeaderFeed(api, { retryBaseMs: 1_000_000 });
    feed.onEntry(() => undefined);
    feed.onEntry(() => undefined);
    feed.start();
    await vi.advanceTimersByTimeAsync(0);
    expect(opened).toBe(1);
    feed.stop();
  });
});
