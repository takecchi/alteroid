// @vitest-environment jsdom
import { cleanup, fireEvent, render, screen } from '@testing-library/react';
import { createMemoryRouter, RouterProvider } from 'react-router';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import {
  DEFAULT_VIEWPORT_WIDTH,
  json,
  Providers,
  setViewportWidth,
  sse,
  stubFetch,
  storeTestBaseUrl,
} from '~/test-support';

import Shell from './shell';

function renderShell() {
  const router = createMemoryRouter(
    [
      {
        path: '/',
        Component: Shell,
        children: [
          { index: true, Component: () => <button type="button">本文の最初の操作</button> },
        ],
      },
    ],
    { initialEntries: ['/'] },
  );
  return render(
    <Providers>
      <RouterProvider router={router} />
    </Providers>,
  );
}

let originalFetch: typeof fetch;

beforeEach(() => {
  originalFetch = globalThis.fetch;
  localStorage.clear();
  storeTestBaseUrl();
  stubFetch((url, init) => {
    if (url.endsWith('/health'))
      return json({
        ok: true,
        pid: 1,
        operator: true,
        storage: '/tmp/alteroid',
        auth: { enabled: false, providers: [] },
      });
    if (url.includes('/approvals')) return json({ approvals: [] });
    if (url.endsWith('/journal/stream')) return sse([], { keepOpen: true, signal: init?.signal });
    return undefined;
  });
});

afterEach(() => {
  cleanup();
  globalThis.fetch = originalFetch;
  setViewportWidth(DEFAULT_VIEWPORT_WIDTH);
});

function tabStops(): HTMLElement[] {
  return Array.from(
    document.querySelectorAll<HTMLElement>('a[href], button, input, select, textarea, [tabindex]'),
  ).filter((el) => el.getAttribute('tabindex') !== '-1');
}

describe.each([
  ['広い画面', DEFAULT_VIEWPORT_WIDTH],
  ['狭い画面（375px）', 375],
])('スキップリンク: %s', (_label, width) => {
  it('最初の Tab 停止が「本文へ移動」で、飛び先は <main>', async () => {
    setViewportWidth(width);
    renderShell();
    await screen.findByText('本文の最初の操作');

    const first = tabStops()[0]!;
    expect(first.textContent).toBe('本文へ移動');
    const href = first.getAttribute('href')!;
    const main = document.querySelector('main')!;
    expect(href).toBe(`#${main.id}`);
    expect(main.contains(screen.getByText('本文の最初の操作'))).toBe(true);
  });

  it('押すと <main> にフォーカスが移る（次の Tab は本文の操作部品へ行ける位置）', async () => {
    setViewportWidth(width);
    renderShell();
    await screen.findByText('本文の最初の操作');

    fireEvent.click(screen.getByRole('link', { name: '本文へ移動' }));
    expect(document.activeElement).toBe(document.querySelector('main'));
  });
});
