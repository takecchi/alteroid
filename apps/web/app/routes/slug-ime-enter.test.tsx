// @vitest-environment jsdom
import { act, cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { createMemoryRouter, RouterProvider } from 'react-router';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import { json, Providers, stubFetch, storeTestBaseUrl } from '~/test-support';

import Memory from './memory';
import Practices from './practices';

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

async function flush(): Promise<void> {
  await act(async () => {
    for (let i = 0; i < 10; i += 1) await Promise.resolve();
  });
}

const CASES = [
  {
    name: '記憶（/memory）',
    Component: Memory,
    listPath: '/memory',
    detailPath: '/memory/:slug',
    listKey: 'documents',
  },
  {
    name: 'やり方（/practices）',
    Component: Practices,
    listPath: '/practices',
    detailPath: '/practices/:slug',
    listKey: 'practices',
  },
] as const;

describe.each(CASES)('$name の名前欄 — IME 変換中の ⌘/Ctrl + Enter', (c) => {
  function renderPage() {
    stubFetch((url) => (url.includes(c.listPath) ? json({ [c.listKey]: [] }) : undefined));
    const router = createMemoryRouter(
      [
        { path: '/', Component: c.Component },
        { path: c.detailPath, Component: () => null },
      ],
      { initialEntries: ['/'] },
    );
    render(
      <Providers>
        <RouterProvider router={router} />
      </Providers>,
    );
    return router;
  }

  async function typeSlug(): Promise<HTMLElement> {
    const input = await screen.findByLabelText(/^名前（/);
    fireEvent.change(input, { target: { value: 'work-style' } });
    return input;
  }

  it('isComposing: true では遷移しない', async () => {
    const router = renderPage();
    const input = await typeSlug();

    fireEvent.keyDown(input, { key: 'Enter', metaKey: true, isComposing: true });
    await flush();
    expect(router.state.location.pathname).toBe('/');
  });

  it('isComposing: false / keyCode: 229 でも遷移しない', async () => {
    const router = renderPage();
    const input = await typeSlug();

    fireEvent.keyDown(input, { key: 'Enter', metaKey: true, isComposing: false, keyCode: 229 });
    await flush();
    expect(router.state.location.pathname).toBe('/');
  });

  it('Enter 単体・Shift + Enter では遷移しない', async () => {
    const router = renderPage();
    const input = await typeSlug();

    fireEvent.keyDown(input, { key: 'Enter', isComposing: false });
    fireEvent.keyDown(input, { key: 'Enter', shiftKey: true, isComposing: false });
    await flush();
    expect(router.state.location.pathname).toBe('/');
  });

  it('isComposing: false（229 でもない）の ⌘/Ctrl + Enter では遷移する', async () => {
    const router = renderPage();
    const input = await typeSlug();

    fireEvent.keyDown(input, { key: 'Enter', ctrlKey: true, isComposing: false });
    await waitFor(() => expect(router.state.location.pathname).toBe(`${c.listPath}/work-style`));
  });
});
