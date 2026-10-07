// @vitest-environment jsdom
import { cleanup, render, screen, waitFor } from '@testing-library/react';
import { createMemoryRouter, RouterProvider } from 'react-router';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import type { JournalEntry } from '@alteroid/logic';
import { json, Providers, storeTestBaseUrl } from '~/test-support';

import Tokens from './tokens';

function renderTokens() {
  const router = createMemoryRouter([{ path: '/', Component: Tokens }], {
    initialEntries: ['/'],
  });
  return render(
    <Providers>
      <RouterProvider router={router} />
    </Providers>,
  );
}

function entry(over: Partial<Extract<JournalEntry, { type: 'token_rotation' }>> = {}) {
  return {
    type: 'token_rotation' as const,
    id: 'j-1',
    at: '2026-09-07T07:33:12.146Z',
    event: 'not_rotated' as const,
    text: '認証トークン: 切り替えなかった（reached）。もう回した後の通知（世代が合わない）。',
    ...over,
  };
}

let originalFetch: typeof globalThis.fetch;

function stub(entries: readonly unknown[]): void {
  globalThis.fetch = ((input: RequestInfo | URL) => {
    const url = typeof input === 'string' ? input : input instanceof URL ? input.href : input.url;
    if (new URL(url).pathname === '/journal') return Promise.resolve(json({ entries }));
    return Promise.resolve(
      json({ tokens: [], settings: { rotateOn: 'free_exhausted', cooldownMs: 18_000_000 } }),
    );
  }) as typeof fetch;
}

describe('not_rotated の badge は、捨てた理由を言い分ける', () => {
  beforeEach(() => {
    originalFetch = globalThis.fetch;
    localStorage.clear();
    storeTestBaseUrl();
    stub([]);
  });
  afterEach(() => {
    cleanup();
    globalThis.fetch = originalFetch;
  });

  it('古い観測で捨てた回は「条件に当たらなかった」と言わない', async () => {
    stub([entry({ signal: 'reached', freshness: 'stale' })]);

    renderTokens();

    // badge の文言で待つ: 本文にも「もう回した後の通知」が出るので、そちらでは badge を測れないため
    await waitFor(() => {
      expect(screen.getByText(/条件には当たっている/)).toBeTruthy();
    });
    expect(screen.queryByText(/条件に当たらなかった/)).toBeNull();
  });

  it('本当に条件に当たらなかった回は、従来どおりそう書く', async () => {
    stub([entry({ signal: 'org_policy', freshness: 'current' })]);

    renderTokens();

    await waitFor(() => {
      expect(screen.getByText(/条件に当たらなかった/)).toBeTruthy();
    });
    expect(screen.queryByText(/もう回した後の通知。契機には当たっている/)).toBeNull();
  });

  it('freshness が無い回も、従来どおりの文言になる', async () => {
    // undefined を stale と読まない: 読むと観測を持たない行に「もう回した後」と書くことになるため
    stub([entry({ signal: 'none' })]);

    renderTokens();

    await waitFor(() => {
      expect(screen.getByText(/条件に当たらなかった/)).toBeTruthy();
    });
  });
});
