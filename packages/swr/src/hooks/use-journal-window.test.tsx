// @vitest-environment jsdom
import type { JournalEntry } from '@alteroid/logic';
import { act, cleanup, render, screen, waitFor } from '@testing-library/react';
import { useLayoutEffect } from 'react';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import { JournalFeedProvider } from './journal-feed';
import { useJournalWindow } from './use-journal-window';
import { json, Providers, storeTestBaseUrl, stubFetch } from '../test-support';

function decision(id: string, at: string): JournalEntry {
  return { type: 'decision', id, at, decision: id, grounds: 'g' };
}

let committed: { prepended: boolean; front: string | undefined; length: number }[];
let loadOlder: () => void;

function Probe() {
  const win = useJournalWindow([], '');
  useLayoutEffect(() => {
    loadOlder = win.loadOlder;
    committed.push({
      prepended: win.prepended,
      front: win.entries[0]?.id,
      length: win.entries.length,
    });
  });
  return <div data-testid="len">{win.entries.length}</div>;
}

let originalFetch: typeof fetch;
beforeEach(() => {
  originalFetch = globalThis.fetch;
  committed = [];
  localStorage.clear();
  storeTestBaseUrl();
});
afterEach(() => {
  cleanup();
  globalThis.fetch = originalFetch;
});

describe('useJournalWindow: prepended', () => {
  it('先頭に新着が足された更新は、コミットされる描画で prepended が true。末尾へ足す更新・初回読み込みでは false', async () => {
    const newest = decision('d-3', '2026-10-05T03:00:00.000Z');
    const history = [
      decision('d-2', '2026-10-05T02:00:00.000Z'),
      decision('d-1', '2026-10-05T01:00:00.000Z'),
    ];
    const older = decision('d-0', '2026-10-05T00:00:00.000Z');
    stubFetch((url) => {
      if (!url.includes('/journal')) return undefined;
      return url.includes('afterId')
        ? json({ entries: [older], scanned: 1 })
        : json({ entries: history, scanned: 2, next: { id: 'd-1', at: history[1]!.at } });
    });

    const view = (recent: JournalEntry[]) => (
      <Providers>
        <JournalFeedProvider value={{ status: 'live', recent }}>
          <Probe />
        </JournalFeedProvider>
      </Providers>
    );
    const { rerender } = render(view([]));
    await waitFor(() => expect(screen.getByTestId('len').textContent).toBe('2'));
    expect(committed.every((c) => !c.prepended)).toBe(true);

    committed.length = 0;
    rerender(view([newest]));
    await waitFor(() => expect(screen.getByTestId('len').textContent).toBe('3'));
    const withNewest = committed.filter((c) => c.front === 'd-3');
    expect(withNewest.length).toBeGreaterThan(0);
    expect(withNewest.every((c) => c.prepended)).toBe(true);

    committed.length = 0;
    await act(async () => {
      loadOlder();
    });
    await waitFor(() => expect(screen.getByTestId('len').textContent).toBe('4'));
    const afterOlder = committed.filter((c) => c.length === 4);
    expect(afterOlder.length).toBeGreaterThan(0);
    expect(afterOlder.every((c) => !c.prepended && c.front === 'd-3')).toBe(true);
  });
});

describe('useJournalWindow: 読み足しの失敗', () => {
  let probe: { error: unknown; loadMoreError: unknown; retry: () => void; load: () => void };
  function ErrorProbe() {
    const win = useJournalWindow([], '');
    useLayoutEffect(() => {
      probe = {
        error: win.error,
        loadMoreError: win.loadMoreError,
        retry: win.retryLoadMore,
        load: win.loadOlder,
      };
    });
    return <div data-testid="len">{win.entries.length}</div>;
  }

  it('読み足しの失敗は error に載らず一覧も残る。撃ち直しが成功すると下りる', async () => {
    const first = Array.from({ length: 100 }, (_, i) =>
      decision(`d${i}`, new Date(Date.UTC(2026, 0, 1, 0, 0, 100 - i)).toISOString()),
    );
    let olderCalls = 0;
    stubFetch((url) => {
      if (!url.includes('/journal')) return undefined;
      if (new URL(url).searchParams.has('until')) {
        olderCalls += 1;
        if (olderCalls === 1) return json({ error: 'boom' }, 500);
        return json({ entries: [], scanned: 0 });
      }
      return json({ entries: first, scanned: first.length });
    });

    render(
      <Providers>
        <JournalFeedProvider value={{ status: 'live', recent: [] }}>
          <ErrorProbe />
        </JournalFeedProvider>
      </Providers>,
    );
    await waitFor(() => expect(screen.getByTestId('len').textContent).toBe('100'));

    act(() => probe.load());
    await waitFor(() => expect(probe.loadMoreError).toBeDefined());
    expect(probe.error).toBeUndefined();
    expect(screen.getByTestId('len').textContent).toBe('100');

    act(() => probe.retry());
    await waitFor(() => expect(probe.loadMoreError).toBeUndefined());
    expect(olderCalls).toBe(2);
  });
});
