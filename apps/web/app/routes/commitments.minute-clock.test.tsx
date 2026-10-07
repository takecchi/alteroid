// @vitest-environment jsdom
import { act, cleanup, render, screen } from '@testing-library/react';
import { createMemoryRouter, RouterProvider } from 'react-router';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { json, Providers, stubFetch, storeTestBaseUrl } from '~/test-support';

import Commitments from './commitments';

const START = new Date('2026-10-07T12:00:00.000Z').getTime();

let originalFetch: typeof fetch;
beforeEach(() => {
  originalFetch = globalThis.fetch;
  localStorage.clear();
  storeTestBaseUrl();
  vi.useFakeTimers({ now: START, toFake: ['setInterval', 'clearInterval', 'Date'] });
  Object.defineProperty(document, 'visibilityState', { value: 'visible', configurable: true });
});
afterEach(() => {
  cleanup();
  vi.useRealTimers();
  globalThis.fetch = originalFetch;
});

async function flush() {
  for (let i = 0; i < 20; i += 1) {
    await act(async () => {
      await vi.advanceTimersByTimeAsync(0);
    });
  }
}

describe('台帳の未了の行の相対の時刻（#3748）', () => {
  it('分が進むと「たった今」が「N分前」に変わる', async () => {
    const at = new Date(START).toISOString();
    stubFetch((url) => {
      if (!url.includes('/commitments')) return undefined;
      return json({
        entries: [{ id: 'cmt-1', origin: 'human', body: '直す', at, updatedAt: at }],
      });
    });
    const router = createMemoryRouter([{ path: '/', Component: Commitments }], {
      initialEntries: ['/'],
    });
    render(
      <Providers>
        <RouterProvider router={router} />
      </Providers>,
    );
    await flush();
    expect(screen.getByText('直す')).toBeTruthy();
    expect(screen.getByText('(たった今)')).toBeTruthy();

    await act(async () => {
      await vi.advanceTimersByTimeAsync(3 * 60_000);
    });
    expect(screen.getByText('(3分前)')).toBeTruthy();
    expect(screen.queryByText('(たった今)')).toBeNull();
  });

  it('分の時計より30秒先の行を「まもなく」と言わない（#3966）', async () => {
    const at = new Date(START + 30_000).toISOString();
    stubFetch((url) => {
      if (!url.includes('/commitments')) return undefined;
      return json({
        entries: [{ id: 'cmt-1', origin: 'human', body: '直す', at, updatedAt: at }],
      });
    });
    const router = createMemoryRouter([{ path: '/', Component: Commitments }], {
      initialEntries: ['/'],
    });
    render(
      <Providers>
        <RouterProvider router={router} />
      </Providers>,
    );
    await flush();
    expect(screen.getByText('(たった今)')).toBeTruthy();
    expect(screen.queryByText('(まもなく)')).toBeNull();
  });
});
