// @vitest-environment jsdom
/**
 * `/notifications` 画面（issue #2515）。ここで固定したいのは:
 *
 * - `GET /notifications` の未読数と一覧がそのまま出る（画面で数え直さない）
 * - 「すべて既読にする」は、画面に出ている `latestAt` を `through` に渡す
 *   （「いま」で既読にしない）。応答の一覧で未読が減る
 * - 未読が無ければ既読のボタンは押せない
 * - 既読の位置が読めないことを、0件と混ぜずに出す
 */
import { cleanup, fireEvent, render, screen } from '@testing-library/react';
import { createMemoryRouter, RouterProvider } from 'react-router';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import { json, Providers, stubFetch, storeTestBaseUrl } from '~/test-support';

import Notifications from './notifications';

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

const ONE_UNREAD = {
  notifications: [
    {
      kind: 'approval_pending',
      approvalId: 'ap-1',
      at: '2026-10-01T00:00:01.000Z',
      question: '本番の DB を移してよいか',
      read: false,
    },
  ],
  unreadCount: 1,
  readThrough: null,
  latestAt: '2026-10-01T00:00:01.000Z',
};

const AFTER_READ = {
  ...ONE_UNREAD,
  notifications: [{ ...ONE_UNREAD.notifications[0], read: true }],
  unreadCount: 0,
  readThrough: '2026-10-01T00:00:01.000Z',
};

async function renderScreen(): Promise<void> {
  // 行から承認待ち・マネージャーの画面へ `Link` を張るので、ルーターの中で描く。
  const router = createMemoryRouter([{ path: '/', Component: Notifications }], {
    initialEntries: ['/'],
  });
  render(
    <Providers>
      <RouterProvider router={router} />
    </Providers>,
  );
  await screen.findByText('通知', { selector: 'h2' });
}

describe('/notifications 画面', () => {
  it('未読数と承認待ちの質問が出て、既読にすると latestAt を渡して未読が減る', async () => {
    const stub = stubFetch((url) => {
      if (url.endsWith('/notifications/read')) return json(AFTER_READ);
      if (url.endsWith('/notifications')) return json(ONE_UNREAD);
      return undefined;
    });

    await renderScreen();
    expect(await screen.findByText('本番の DB を移してよいか')).toBeTruthy();
    expect(screen.getByText('未読 1')).toBeTruthy();

    fireEvent.click(screen.getByRole('button', { name: 'すべて既読にする' }));
    expect(await screen.findByText('未読 0')).toBeTruthy();
    // openapi-fetch は `Request` で送るので、本文はそこから読む。
    const posts = stub.entries.filter((entry) => entry.url.endsWith('/notifications/read'));
    expect(posts).toHaveLength(1);
    expect(await posts[0]?.request?.clone().json()).toEqual({
      through: '2026-10-01T00:00:01.000Z',
    });
  });

  it('未読が無ければ既読のボタンは押せない', async () => {
    stubFetch((url) => (url.endsWith('/notifications') ? json(AFTER_READ) : undefined));
    await renderScreen();
    await screen.findByText('未読 0');
    const button = screen.getByRole('button', { name: 'すべて既読にする' }) as HTMLButtonElement;
    expect(button.disabled).toBe(true);
  });

  it('0件なら「通知は無い」', async () => {
    stubFetch((url) =>
      url.endsWith('/notifications')
        ? json({ notifications: [], unreadCount: 0, readThrough: null })
        : undefined,
    );
    await renderScreen();
    expect(await screen.findByText('通知は無い（未回答の承認待ちは無い）。')).toBeTruthy();
  });

  it('既読の位置が読めないことを、0件と混ぜずに出す', async () => {
    stubFetch((url) =>
      url.endsWith('/notifications')
        ? json({ ...ONE_UNREAD, cursorUnreadable: 'JSON として読めない' })
        : undefined,
    );
    await renderScreen();
    expect(await screen.findByText(/既読の位置が読めない/)).toBeTruthy();
  });
});
