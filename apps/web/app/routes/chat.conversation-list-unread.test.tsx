// @vitest-environment jsdom
/**
 * 会話の一覧（`GET /conversations`）の `unreadCount` が、一覧の項目の未読の印と
 * 読み上げの名前（「未読 N 件」）になる。0 件なら印を出さない。
 */
import { cleanup, render, screen } from '@testing-library/react';
import { createMemoryRouter, RouterProvider, useParams } from 'react-router';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import { json, Providers, storeTestBaseUrl, stubFetch } from '~/test-support';

import Chat from './chat';

const ChatRoute = Chat as unknown as (props: {
  loaderData: { conversationId: string | undefined };
}) => React.ReactElement;

function Harness() {
  const params = useParams();
  return <ChatRoute loaderData={{ conversationId: params.conversationId }} />;
}

function summary(id: string, preview: string, unreadCount: number) {
  return {
    conversationId: id,
    startedAt: '2026-08-20T00:00:00.000Z',
    updatedAt: '2026-08-20T00:01:00.000Z',
    messages: 2,
    preview,
    unreadCount,
    readThrough: '2026-08-20T00:00:00.000Z',
  };
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

describe('会話の一覧の未読の印', () => {
  it('未読のある項目だけ「未読 N 件」を名前に含む。0 件の項目には印が無い', async () => {
    stubFetch((url) => {
      if (url.includes('/approvals')) return json({ approvals: [] });
      if (url.includes('/conversations')) {
        return json({
          conversations: [summary('c1', '資料の件', 2), summary('c2', '日報の件', 0)],
          scanned: 2,
          reachedStart: true,
          hiddenByLimit: 0,
        });
      }
      return undefined;
    });
    const router = createMemoryRouter([{ path: '/chat', Component: Harness }], {
      initialEntries: ['/chat'],
    });
    render(
      <Providers>
        <RouterProvider router={router} />
      </Providers>,
    );

    const unread = await screen.findByRole('link', { name: /資料の件.*未読 2 件/ });
    expect(unread.getAttribute('href')).toBe('/chat/c1');
    const read = screen.getByRole('link', { name: /日報の件/ });
    expect(read.textContent).not.toContain('未読');
  });
});
