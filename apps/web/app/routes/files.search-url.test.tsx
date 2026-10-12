// @vitest-environment jsdom
import { act, cleanup, render, screen, waitFor } from '@testing-library/react';
import { createMemoryRouter, RouterProvider } from 'react-router';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { json, Providers, storeTestBaseUrl } from '~/test-support';

import Files from './files';

let originalFetch: typeof fetch;

beforeEach(() => {
  originalFetch = globalThis.fetch;
  localStorage.clear();
  storeTestBaseUrl();
  globalThis.fetch = (async (input: RequestInfo | URL, init?: RequestInit) => {
    const request = input instanceof Request ? input : new Request(input, init);
    const url = new URL(request.url);
    if (url.pathname === '/attachments/limits') return json({ error: 'none' }, 404);
    if (url.pathname === '/attachments') {
      const zero = { count: 0, totalBytes: 0 };
      return json({
        items: [],
        usage: {
          ...zero,
          byFrom: { human: zero, clone: zero, manager: zero, integration: zero, unknown: zero },
        },
      });
    }
    throw new TypeError(`Failed to fetch: ${url.href}`);
  }) as typeof fetch;
});

afterEach(() => {
  cleanup();
  vi.useRealTimers();
  globalThis.fetch = originalFetch;
});

const input = () => screen.getByLabelText('ファイルを名前で探す') as HTMLInputElement;

async function openWith(initial: string) {
  const router = createMemoryRouter([{ path: '/files', Component: Files }], {
    initialEntries: [initial],
  });
  render(
    <Providers>
      <RouterProvider router={router} />
    </Providers>,
  );
  await waitFor(() => expect(input()).toBeTruthy());
  return router;
}

// 時計を止めて待ちを越える: 書き戻しは debounce の後に起きるので、取り込めていなければここで URL が戻る
async function pastDebounce() {
  await act(async () => {
    vi.advanceTimersByTime(1000);
  });
}

describe('ファイルの検索欄が URL 側からの変更を取り込む（#4584。日誌の #3985 と同じ穴）', () => {
  it('ナビの /files（q なし）へ移ると、検索が外れ、元の語へ書き戻されない', async () => {
    const router = await openWith('/files?q=foo');
    expect(input().value).toBe('foo');
    vi.useFakeTimers();
    await act(async () => {
      await router.navigate('/files');
    });
    await pastDebounce();
    expect(input().value).toBe('');
    expect(router.state.location.search).toBe('');
  });

  it('?q=bar へのリンクで移ると bar になり、foo へ書き戻されない', async () => {
    const router = await openWith('/files?q=foo');
    vi.useFakeTimers();
    await act(async () => {
      await router.navigate('/files?q=bar');
    });
    await pastDebounce();
    expect(input().value).toBe('bar');
    expect(router.state.location.search).toBe('?q=bar');
  });
});
