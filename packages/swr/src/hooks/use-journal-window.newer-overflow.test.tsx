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

function atSecond(second: number): string {
  return new Date(Date.UTC(2026, 0, 1, 0, 0, 0) + second * 1000).toISOString();
}

let ids: string[];
let refreshNewer: () => void;
let isLoadingNewer: boolean;
function Probe() {
  const win = useJournalWindow([], '');
  useLayoutEffect(() => {
    ids = win.entries.map((e) => e.id);
    refreshNewer = win.refreshNewer;
    isLoadingNewer = win.isLoadingNewer;
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

const head = decision('h', atSecond(0));
// 窓を開いた後に、SSE で届かずに積まれた行（新しい順）。1頁（100件）を超える
const later = Array.from({ length: 150 }, (_, i) => decision(`n${150 - i}`, atSecond(150 - i)));

/**
 * 本物のデーモンと同じ形: 既定は新しい順、`since` は含む（>=）、`afterId` / `afterAt` は前の頁の最後の行より後ろ
 * （新しい順なので古い側）、limit 件で切り、続きが在れば `next` に最後の行を返す。
 * 初回の読み込み（since が無い）の時点では h だけが在った。
 */
function stubDaemon(): { queries: URLSearchParams[] } {
  const queries: URLSearchParams[] = [];
  const server = [...later, head];
  stubFetch((url) => {
    if (!url.includes('/journal')) return undefined;
    const params = new URL(url).searchParams;
    queries.push(params);
    const since = params.get('since');
    const afterId = params.get('afterId');
    const limit = Number(params.get('limit'));
    let rows =
      since === null ? [head] : server.filter((e) => Date.parse(e.at) >= Date.parse(since));
    if (afterId !== null) rows = rows.slice(rows.findIndex((e) => e.id === afterId) + 1);
    const page = rows.slice(0, limit);
    const last = page.at(-1);
    return json({
      entries: page,
      scanned: page.length,
      next: rows.length > limit && last !== undefined ? { id: last.id, at: last.at } : null,
      oldestAt: head.at,
      crossesHorizon: false,
    });
  });
  return { queries };
}

describe('useJournalWindow: 新しい分が1頁を超えて積まれていたとき（#4577）', () => {
  it('「新しい分を取る」で、窓の先頭との間を欠かさずに全部入れる', async () => {
    const { queries } = stubDaemon();
    render(
      <Providers>
        <JournalFeedProvider value={{ status: 'live', recent: [], receivedCount: 0 }}>
          <Probe />
        </JournalFeedProvider>
      </Providers>,
    );
    await waitFor(() => expect(screen.getByTestId('len').textContent).toBe('1'));

    act(() => {
      refreshNewer();
    });
    await waitFor(() => expect(isLoadingNewer).toBe(false));
    await waitFor(() => expect(ids).toEqual([...later.map((e) => e.id), 'h']));
    // 続きは窓の先頭（h）を `since` に保ったまま継続点で読む
    const continued = queries.filter((q) => q.get('afterId') !== null);
    expect(continued.length).toBeGreaterThan(0);
    expect(continued.every((q) => q.get('since') === head.at)).toBe(true);
  });
});
