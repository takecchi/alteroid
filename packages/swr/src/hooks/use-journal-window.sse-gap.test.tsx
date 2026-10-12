// @vitest-environment jsdom
import type { JournalEntry } from '@alteroid/logic';
import { cleanup, render, screen, waitFor } from '@testing-library/react';
import { useLayoutEffect } from 'react';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import { JournalFeedProvider } from './journal-feed';
import { useJournalWindow } from './use-journal-window';
import type { LiveStatus } from './use-journal-live';
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

function view(status: LiveStatus, recent: JournalEntry[]) {
  return (
    <Providers>
      <JournalFeedProvider value={{ status, recent, receivedCount: recent.length }}>
        <Probe />
      </JournalFeedProvider>
    </Providers>
  );
}

const a = decision('a', atSecond(100));
const b = decision('b', atSecond(110));
const c = decision('c', atSecond(120));
const d = decision('d', atSecond(130));

/** 本物のデーモンと同じ形: 新しい順、`since` は含む（>=）、limit 件で切る。初回の読み込みの時点では a だけが在った。 */
function stubDaemon(): { sinceAsked: string[] } {
  const sinceAsked: string[] = [];
  const server = [d, c, b, a];
  stubFetch((url) => {
    if (!url.includes('/journal')) return undefined;
    const params = new URL(url).searchParams;
    const since = params.get('since');
    if (since !== null) sinceAsked.push(since);
    const limit = Number(params.get('limit'));
    const rows = since === null ? [a] : server.filter((e) => Date.parse(e.at) >= Date.parse(since));
    const page = rows.slice(0, limit);
    return json({
      entries: page,
      scanned: page.length,
      next: null,
      oldestAt: a.at,
      crossesHorizon: false,
    });
  });
  return { sinceAsked };
}

describe('useJournalWindow: SSE が切れていた間の行（#4575）', () => {
  it('張り直したら切れた時点の先頭から取り直し、間の行を埋める（張り直しと同時に新着が届いても）', async () => {
    const { sinceAsked } = stubDaemon();
    const { rerender } = render(view('live', []));
    await waitFor(() => expect(screen.getByTestId('len').textContent).toBe('1'));

    // 切れる（その間に b, c, d がデーモンに積まれる）
    rerender(view('offline', []));
    // 張り直す。最初に届いた新着は d だけ（b, c は SSE を取りこぼした）
    rerender(view('live', [d]));

    await waitFor(() => expect(ids).toEqual(['d', 'c', 'b', 'a']));
    // 取り直しは、切れた時点の先頭（a）から
    expect(sinceAsked).toContain(a.at);
  });

  it('張り直しの後に届いた新着も、取り直しの後で先頭へ積む', async () => {
    stubDaemon();
    const { rerender } = render(view('live', []));
    await waitFor(() => expect(screen.getByTestId('len').textContent).toBe('1'));

    rerender(view('offline', []));
    rerender(view('live', []));
    await waitFor(() => expect(ids).toEqual(['d', 'c', 'b', 'a']));

    const e = decision('e', atSecond(140));
    rerender(view('live', [e, d]));
    await waitFor(() => expect(ids).toEqual(['e', 'd', 'c', 'b', 'a']));
  });

  it('対照: 切れていなければ、SSE の新着を今までどおり先頭へ積み、取り直しはしない', async () => {
    const { sinceAsked } = stubDaemon();
    const { rerender } = render(view('live', []));
    await waitFor(() => expect(screen.getByTestId('len').textContent).toBe('1'));

    const e = decision('e', atSecond(140));
    rerender(view('live', [e]));
    await waitFor(() => expect(ids).toEqual(['e', 'a']));
    expect(sinceAsked).toEqual([]);
  });
});
