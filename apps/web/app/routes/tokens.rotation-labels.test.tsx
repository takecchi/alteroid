// @vitest-environment jsdom
import { cleanup, render, screen, waitFor } from '@testing-library/react';
import { createMemoryRouter, RouterProvider } from 'react-router';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';

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

function entry(over: Record<string, unknown> = {}) {
  return {
    type: 'token_rotation' as const,
    id: 'j-1',
    at: '2026-09-07T07:33:12.146Z',
    event: 'rotated' as const,
    text: '認証トークンを切り替えた。',
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

describe('切り替えの履歴: きっかけ・見直したきっかけ', () => {
  beforeEach(() => {
    originalFetch = globalThis.fetch;
    localStorage.clear();
    storeTestBaseUrl();
  });
  afterEach(() => {
    cleanup();
    globalThis.fetch = originalFetch;
  });

  it('既知の値は人間の言葉で出し、識別子は出さない', async () => {
    stub([entry({ signal: 'overage_closed', reason: 'runner_connected' })]);

    renderTokens();

    await waitFor(() => {
      expect(screen.getByText('きっかけ: 利用枠が尽き、従量課金枠も閉じている')).toBeTruthy();
    });
    expect(screen.getByText('見直したきっかけ: 実行環境が繋がった')).toBeTruthy();
    expect(screen.queryByText(/overage_closed/)).toBeNull();
    expect(screen.queryByText(/runner_connected/)).toBeNull();
  });

  it('知らない値は捨てずに、素の値のまま見える形で出す', async () => {
    stub([entry({ signal: 'brand_new_signal', reason: 'brand_new_reason' })]);

    renderTokens();

    await waitFor(() => {
      expect(screen.getByText(/きっかけ: brand_new_signal/)).toBeTruthy();
    });
    expect(screen.getByText(/見直したきっかけ: brand_new_reason/)).toBeTruthy();
  });

  it('表の継ぎ目の名前（toString など）が来ても、知らない値として素の値で出す', async () => {
    stub([entry({ signal: 'toString' })]);

    renderTokens();

    await waitFor(() => {
      expect(screen.getByText(/きっかけ: toString/)).toBeTruthy();
    });
  });
});
