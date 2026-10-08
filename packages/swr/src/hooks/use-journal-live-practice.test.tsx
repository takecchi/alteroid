// @vitest-environment jsdom
import { cleanup, render, screen } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { usePractice, usePracticeVersions, usePractices } from './queries';
import { useJournalLive } from './use-journal-live';
import { json, Providers, sse, stubFetch, storeTestBaseUrl, type FetchStub } from '../test-support';

function Probe() {
  const live = useJournalLive();
  const list = usePractices();
  const detail = usePractice('daily');
  const versions = usePracticeVersions('daily');
  const loaded = list.data && detail.data && versions.data;
  return (
    <div>
      <div data-testid="received">{live.receivedCount ?? 0}</div>
      <div data-testid="loaded">{loaded ? 'loaded' : ''}</div>
    </div>
  );
}

let originalFetch: typeof fetch;

beforeEach(() => {
  originalFetch = globalThis.fetch;
  localStorage.clear();
  storeTestBaseUrl();
});

afterEach(() => {
  cleanup();
  globalThis.fetch = originalFetch;
});

function fetches(stub: FetchStub, path: string): number {
  return stub.calls.filter((url) => new URL(url).pathname === path).length;
}

type Frame = { event: string; data: unknown };

function decision(id: string, target?: { kind: 'practice'; slug: string }): Frame {
  return {
    event: 'decision',
    data: {
      type: 'decision',
      id,
      at: '2026-10-09T00:00:00.000Z',
      decision: 'やり方 daily を書き直した',
      grounds: '根拠',
      ...(target === undefined ? {} : { target }),
    },
  };
}

const PRACTICE = {
  slug: 'daily',
  kind: '調査',
  title: '題',
  content: '本文',
  version: 1,
};

function renderProbe(frames: Frame[]) {
  const stub = stubFetch((url, init) => {
    const path = new URL(url).pathname;
    if (path === '/journal/stream') {
      return sse([{ event: 'open', data: { ok: true } }, ...frames], {
        keepOpen: true,
        signal: init?.signal,
      });
    }
    if (path === '/practices') return json({ practices: [] });
    if (path === '/practices/daily') return json({ practice: PRACTICE, version: 1 });
    if (path === '/practices/daily/versions') return json({ versions: [] });
    return undefined;
  });
  render(
    <Providers>
      <Probe />
    </Providers>,
  );
  return stub;
}

describe('やり方の書き込みの取り直し（SSE、#4065）', () => {
  it('target(practice) 付きの decision で、一覧・その slug の詳細・履歴を取り直す', async () => {
    const stub = renderProbe([decision('d1', { kind: 'practice', slug: 'daily' })]);
    await vi.waitFor(() => {
      expect(fetches(stub, '/practices')).toBeGreaterThanOrEqual(2);
      expect(fetches(stub, '/practices/daily')).toBeGreaterThanOrEqual(2);
      expect(fetches(stub, '/practices/daily/versions')).toBeGreaterThanOrEqual(2);
    });
  });

  it('別の slug の書き込みでは、開いているやり方の詳細・履歴を取り直さない', async () => {
    const stub = renderProbe([decision('d1', { kind: 'practice', slug: 'other' })]);
    await vi.waitFor(() => {
      expect(fetches(stub, '/practices')).toBeGreaterThanOrEqual(2);
    });
    await screen.findByText('loaded');
    expect(fetches(stub, '/practices/daily')).toBe(1);
    expect(fetches(stub, '/practices/daily/versions')).toBe(1);
  });

  it('target の無い（古い）decision では取り直さず、壊れもしない', async () => {
    const stub = renderProbe([decision('d1')]);
    await screen.findByText('loaded');
    await vi.waitFor(() => {
      expect(screen.getByTestId('received').textContent).toBe('1');
    });
    expect(fetches(stub, '/practices')).toBe(1);
    expect(fetches(stub, '/practices/daily')).toBe(1);
    expect(fetches(stub, '/practices/daily/versions')).toBe(1);
  });
});
