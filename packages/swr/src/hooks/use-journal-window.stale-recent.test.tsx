// @vitest-environment jsdom
import type { JournalEntry } from '@alteroid/logic';
import { cleanup, render, screen, waitFor } from '@testing-library/react';
import { useLayoutEffect } from 'react';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import { JournalFeedProvider } from './journal-feed';
import { useJournalWindow } from './use-journal-window';
import { json, Providers, storeTestBaseUrl, stubFetch } from '../test-support';

function decision(id: string, at: string): JournalEntry {
  return { type: 'decision', id, at, decision: id, grounds: 'g' };
}

function atSecond(second: number): string {
  return new Date(Date.UTC(2026, 0, 1, 0, 0, second)).toISOString();
}

let ids: string[];
function Probe() {
  const win = useJournalWindow([], '');
  useLayoutEffect(() => {
    ids = win.entries.map((e) => e.id);
  });
  return <div data-testid="len">{win.entries.length}</div>;
}

let originalFetch: typeof fetch;
beforeEach(() => {
  originalFetch = globalThis.fetch;
  ids = [];
  localStorage.clear();
  storeTestBaseUrl();
});
afterEach(() => {
  cleanup();
  globalThis.fetch = originalFetch;
});

function view(recent: JournalEntry[]) {
  return (
    <Providers>
      <JournalFeedProvider value={{ status: 'live', recent }}>
        <Probe />
      </JournalFeedProvider>
    </Providers>
  );
}

describe('useJournalWindow: SSE の recent が窓より古い行を抱えているとき（#4517）', () => {
  it('次の新着で、窓に入らなかった古い行を先頭へ積まない（一覧は新しい順のまま）', async () => {
    // 画面を開く前から SSE で 150 件溜まっている（recent は最大 200 件、窓は 100 件）
    const all = Array.from({ length: 150 }, (_, i) => decision(`d${i}`, atSecond(1000 - i)));
    const window100 = all.slice(0, 100);
    stubFetch((url) => {
      if (!url.includes('/journal')) return undefined;
      return json({ entries: window100, scanned: 100, next: { id: 'd99', at: window100[99]!.at } });
    });

    const { rerender } = render(view(all));
    await waitFor(() => expect(screen.getByTestId('len').textContent).toBe('100'));

    rerender(view([decision('new', atSecond(2000)), ...all]));
    await waitFor(() => expect(ids[0]).toBe('new'));

    expect(ids.slice(0, 3)).toEqual(['new', 'd0', 'd1']);
    expect(ids).toHaveLength(101);
    expect(ids).not.toContain('d100');
  });

  it('対照: 窓の先頭と同じ時刻の、窓に無い新着は取り込む（同じミリ秒を落とさない）', async () => {
    const head = decision('d0', atSecond(1000));
    stubFetch((url) => {
      if (!url.includes('/journal')) return undefined;
      return json({ entries: [head], scanned: 1, next: null });
    });

    const { rerender } = render(view([]));
    await waitFor(() => expect(screen.getByTestId('len').textContent).toBe('1'));

    rerender(view([decision('tie', atSecond(1000)), head]));
    await waitFor(() => expect(ids).toEqual(['tie', 'd0']));
  });
});
