// @vitest-environment jsdom
import { cleanup, render, screen } from '@testing-library/react';
import { createMemoryRouter, RouterProvider } from 'react-router';
import { afterEach, describe, expect, it } from 'vitest';

import { ErrorNote, JournalEntryRow } from '@alteroid/ui';

import App, { ErrorBoundary } from './root';

afterEach(cleanup);

const TOKEN = `ghp_${'A1b2C3d4E5'.repeat(4)}`;
const SHA = '0123456789abcdef0123456789abcdef01234567';

describe('ErrorBoundary の伏せ字', () => {
  it('Error（stack）・それ以外（String）のどちらからもトークンが消える', () => {
    const error = new Error(`boom ${TOKEN}`);
    const first = render(<ErrorBoundary error={error} />);
    expect(first.container.textContent).toContain('boom');
    expect(first.container.textContent).not.toContain(TOKEN);
    first.unmount();

    const second = render(<ErrorBoundary error={`plain ${TOKEN}`} />);
    expect(second.container.textContent).toContain('plain');
    expect(second.container.textContent).not.toContain(TOKEN);
  });
});

describe('App が全 route を伏せ字の provider で包む', () => {
  it('子の route の中の ui の部品（ErrorNote・日誌の本文）が偽トークンを伏せる', () => {
    const router = createMemoryRouter(
      [
        {
          path: '/',
          Component: App,
          children: [
            {
              index: true,
              Component: () => (
                <>
                  <ErrorNote error={new Error(`401 ${TOKEN}`)} />
                  <JournalEntryRow
                    atLabel="09-30 05:45"
                    type="exchange"
                    summary={`x ${TOKEN} y ${SHA}`}
                    raw={{ text: TOKEN }}
                    defaultOpen
                  />
                </>
              ),
            },
          ],
        },
      ],
      { initialEntries: ['/'] },
    );
    const { container } = render(<RouterProvider router={router} />);
    expect(screen.getByText(/401/)).toBeTruthy();
    expect(container.textContent).toContain(SHA);
    expect(container.textContent).not.toContain(TOKEN);
  });
});
