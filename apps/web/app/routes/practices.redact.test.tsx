// @vitest-environment jsdom
import { cleanup, render, screen } from '@testing-library/react';
import { createMemoryRouter, RouterProvider } from 'react-router';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import { json, Providers, stubFetch, storeTestBaseUrl } from '~/test-support';

import Practices from './practices';

const KEY = `ghp_${'a1B2c3D4e5'.repeat(4)}`;

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

describe('/practices 一覧 — 題は鍵を伏せる', () => {
  it('題に鍵があっても出さず、地の文は残る', async () => {
    const practices = [
      {
        slug: 'daily-report',
        kind: '日報',
        title: `題の頭 GH_TOKEN=${KEY} 題の終わり`,
        updatedAt: new Date(Date.now() - 86_400_000).toISOString(),
        createdAt: new Date(Date.now() - 3 * 86_400_000).toISOString(),
        chars: 42,
      },
    ];
    stubFetch((url) => (url.includes('/practices') ? json({ practices }) : undefined));
    const router = createMemoryRouter(
      [
        { path: '/', Component: Practices },
        { path: '/practices/:slug', Component: () => null },
      ],
      { initialEntries: ['/'] },
    );
    const { container } = render(
      <Providers>
        <RouterProvider router={router} />
      </Providers>,
    );

    const title = await screen.findByText(/題の頭/);
    expect(title.textContent).toContain('題の終わり');
    expect(title.textContent).not.toContain(KEY);
    expect(container.textContent).not.toContain(KEY);
  });
});
