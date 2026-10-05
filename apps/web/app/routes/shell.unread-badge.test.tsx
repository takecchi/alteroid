// @vitest-environment jsdom
/**
 * 左ナビ「会話」の未読の札。承認待ちの札と同じ作法: 未読のある会話の数を出し、読めていない
 * ときは 0 件（札無し）と区別できる danger の「?」にする。
 */
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

function conversation(id: string, unreadCount: number) {
  return {
    conversationId: id,
    startedAt: '2026-08-20T00:00:00.000Z',
    updatedAt: '2026-08-20T00:01:00.000Z',
    messages: 2,
    preview: id,
    unreadCount,
    readThrough: '2026-08-20T00:00:00.000Z',
  };
}

function stubShell(conversations: () => Response) {
  stubFetch((url, init) => {
    if (url.endsWith('/health')) return json(HEALTH);
    if (url.includes('/approvals')) return json({ approvals: [] });
    if (url.endsWith('/journal/stream')) return sse([], { keepOpen: true, signal: init?.signal });
    if (url.includes('/conversations')) return conversations();
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

const list = (conversations: unknown[]) =>
  json({ conversations, scanned: 5, reachedStart: true, hiddenByLimit: 0 });

describe('左ナビ「会話」の未読の札', () => {
  it('未読のある会話の数が札に出て、リンクの名前にも入る', async () => {
    stubShell(() => list([conversation('a', 2), conversation('b', 0), conversation('c', 1)]));

    renderShell();

    const link = await screen.findByRole('link', { name: /未読のある会話 2 件/ });
    expect(link.getAttribute('href')).toBe('/chat');
    expect(link.textContent).toContain('2');
  });

  it('未読が無ければ札を出さない', async () => {
    stubShell(() => list([conversation('a', 0)]));

    renderShell();

    await screen.findByText('ダッシュボードの中身');
    await screen.findByRole('link', { name: '会話' });
    expect(screen.queryByLabelText(/未読/)).toBeNull();
  });

  it('一覧を読めていないときは、札無し（0 件）と区別できる「読めていない」印を出す', async () => {
    stubShell(() => json({ error: 'internal' }, 500));

    renderShell();

    expect(await screen.findByLabelText('未読の会話を読めていない')).toBeTruthy();
    expect(screen.getByTitle('未読の会話を読めていない')).toBeTruthy();
    expect(screen.queryByLabelText(/未読のある会話/)).toBeNull();
  });
});
