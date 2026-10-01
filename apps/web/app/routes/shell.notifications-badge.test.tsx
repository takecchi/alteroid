// @vitest-environment jsdom
/**
 * 外枠の「通知」の札（issue #2515）。
 *
 * 測る保証は3つ — (1) 未読があれば件数の札が「通知」の行き先に付く (2) 未読 0 なら
 * 札は無い (3) 取れない・形が違う応答は「0件（札無し）」ではなく「読めていない」の札に
 * なる（承認待ちの札と同じ判断。issue #2105）。数えるのはデーモンで、ここは
 * `unreadCount` をそのまま描くだけである。
 */
import { cleanup, render, screen, within } from '@testing-library/react';
import { createMemoryRouter, RouterProvider } from 'react-router';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import { json, Providers, sse, stubFetch, storeTestBaseUrl } from '~/test-support';

import Shell from './shell';

const HEALTH = {
  ok: true,
  pid: 1,
  operator: true,
  storage: '/tmp/alteroid',
  auth: { enabled: false, providers: [] },
};

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

function stubNotifications(reply: { status?: number; body: unknown }) {
  return stubFetch((url, init) => {
    if (url.endsWith('/health')) return json(HEALTH);
    if (url.includes('/approvals')) return json({ approvals: [] });
    if (url.endsWith('/notifications')) return json(reply.body, reply.status ?? 200);
    if (url.endsWith('/journal/stream')) return sse([], { keepOpen: true, signal: init?.signal });
    return undefined;
  });
}

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

async function notificationsLink(): Promise<HTMLElement> {
  expect(await screen.findByText('ダッシュボードの中身')).toBeTruthy();
  return screen.getByRole('link', { name: /通知/ });
}

describe('外枠の「通知」の札', () => {
  it('未読があれば件数の札が付く', async () => {
    stubNotifications({ body: { notifications: [], unreadCount: 2, readThrough: null } });
    renderShell();
    const link = await notificationsLink();
    expect(await within(link).findByText('2')).toBeTruthy();
    expect(link.getAttribute('href')).toBe('/notifications');
  });

  it('未読 0 なら札は無い', async () => {
    stubNotifications({ body: { notifications: [], unreadCount: 0, readThrough: null } });
    renderShell();
    const link = await notificationsLink();
    // 取得が終わるのを待ってから「無い」を見る（読み込み中の札無しと区別するため）。
    await new Promise((resolve) => setTimeout(resolve, 50));
    expect(within(link).queryByText('0')).toBeNull();
    expect(screen.queryByLabelText('通知を読めていない')).toBeNull();
  });

  it.each([
    ['取得が失敗した（500）', { status: 500, body: { error: '壊れた' } }],
    ['unreadCount が数でない（版のずれ）', { body: {} }],
  ])('%s ときは「読めていない」の札になる', async (_name, reply) => {
    stubNotifications(reply);
    renderShell();
    await notificationsLink();
    expect(await screen.findByLabelText('通知を読めていない')).toBeTruthy();
  });
});
