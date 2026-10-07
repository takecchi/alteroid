// @vitest-environment jsdom
import { cleanup, render, screen } from '@testing-library/react';
import { createMemoryRouter, RouterProvider } from 'react-router';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import {
  DEFAULT_VIEWPORT_WIDTH,
  json,
  Providers,
  setViewportWidth,
  sse,
  storeTestBaseUrl,
  stubFetch,
} from '~/test-support';

import Shell from './shell';

const HEALTH = {
  ok: true,
  pid: 1,
  operator: true,
  storage: '/tmp/alteroid',
  auth: { enabled: false, providers: [] },
};

function stubShell(conversations: () => Response) {
  stubFetch((url, init) => {
    if (url.endsWith('/health')) return json(HEALTH);
    if (url.includes('/approvals')) return json({ approvals: [] });
    if (url.endsWith('/journal/stream')) return sse([], { keepOpen: true, signal: init?.signal });
    if (url.endsWith('/conversations/unread-count')) return conversations();
    return undefined;
  });
}

function renderShell() {
  const router = createMemoryRouter(
    [
      {
        path: '/',
        Component: Shell,
        children: [{ index: true, Component: () => <div>ダッシュボードの中身</div> }],
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
  setViewportWidth(DEFAULT_VIEWPORT_WIDTH);
});

afterEach(() => {
  cleanup();
  globalThis.fetch = originalFetch;
});

const count = (body: unknown) => json(body);

describe('左ナビ「会話」の未読の札', () => {
  it('未読のある会話の数が札に出て、リンクの名前にも入る', async () => {
    stubShell(() => count({ count: 2, capped: false }));

    renderShell();

    const link = await screen.findByRole('link', { name: /未読のある会話 2 件/ });
    expect(link.getAttribute('href')).toBe('/chat');
    expect(link.textContent).toContain('2');
    expect(link.textContent).not.toContain('+');
  });

  it('数え切れていない（capped）ときは「N+」で、名前は「N 件以上」', async () => {
    stubShell(() => count({ count: 99, capped: true }));

    renderShell();

    const link = await screen.findByRole('link', { name: /未読のある会話 99 件以上/ });
    expect(link.textContent).toContain('99+');
  });

  it('未読が無ければ札を出さない', async () => {
    stubShell(() => count({ count: 0, capped: false }));

    renderShell();

    await screen.findByText('ダッシュボードの中身');
    await screen.findByRole('link', { name: '会話' });
    expect(screen.queryByLabelText(/未読/)).toBeNull();
  });

  it.each([
    ['取得の失敗', () => json({ error: 'internal' }, 500)],
    [
      '既読の記録が読めない旨の応答',
      () => count({ count: 3, capped: false, readStateUnreadable: 'x' }),
    ],
  ])('%s は、札無し（0 件）と区別できる「読めていない」印にする', async (_n, respond) => {
    stubShell(respond);

    renderShell();

    expect(await screen.findByLabelText('未読の会話を読めていない')).toBeTruthy();
    expect(screen.getByTitle('未読の会話を読めていない')).toBeTruthy();
    expect(screen.queryByLabelText(/未読のある会話/)).toBeNull();
  });
});
