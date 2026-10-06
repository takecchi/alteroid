// @vitest-environment jsdom
/**
 * #3748。台帳の未了の行の「（N分前）」は、再描画のきっかけが無くても分単位で更新される。
 * **実時間を待たない**（偽のタイマー。約束の解決は `advanceTimersByTimeAsync(0)` で流す）。
 * 流儀は `dashboard-awaiting.relative-time.test.tsx`（#3700）に揃える。
 */
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
});
