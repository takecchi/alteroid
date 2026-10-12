// @vitest-environment jsdom
import { cleanup, render, screen } from '@testing-library/react';
import { createMemoryRouter, RouterProvider } from 'react-router';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import { json, Providers, stubFetch, storeTestBaseUrl } from '~/test-support';

import Memory from './memory';

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

describe('/memory 一覧 — 題と説明は鍵を伏せる', () => {
  it('題と説明に鍵があっても出さず、地の文は残る', async () => {
    const documents = [
      {
        slug: 'notes',
        title: `題の頭 GH_TOKEN=${KEY} 題の終わり`,
        description: `説明の頭 GH_TOKEN=${KEY} 説明の終わり`,
        updatedAt: new Date(Date.now() - 86_400_000).toISOString(),
        createdAt: { kind: 'unknown' },
        bytes: 42,
        frontmatter: { kind: 'none' },
        kind: 'fact',
        descriptionFreshness: { kind: 'absent' },
      },
    ];
    stubFetch((url) => (url.includes('/memory') ? json({ documents }) : undefined));
    const router = createMemoryRouter(
      [
        { path: '/', Component: Memory },
        { path: '/memory/:slug', Component: () => null },
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

    const description = await screen.findByText(/説明の頭/);
    expect(description.textContent).toContain('説明の終わり');
    expect(description.textContent).not.toContain(KEY);

    expect(container.textContent).not.toContain(KEY);
  });
});
