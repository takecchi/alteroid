// @vitest-environment jsdom
import { cleanup, render, screen } from '@testing-library/react';
import { createMemoryRouter, RouterProvider, useParams } from 'react-router';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import { json, Providers, storeTestBaseUrl, stubFetch } from '~/test-support';

import Chat from './chat';

const TOKEN = `ghp_${'A1b2C3d4E5'.repeat(4)}`;

const ChatRoute = Chat as unknown as (props: {
  loaderData: { conversationId: string | undefined };
}) => React.ReactElement;

function Harness() {
  const params = useParams();
  return <ChatRoute loaderData={{ conversationId: params.conversationId }} />;
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

describe('会話の一覧の見出し（preview）の伏せ字', () => {
  it('本文と同じく、見出しに入ったトークンを伏せて出す', async () => {
    stubFetch((url) => {
      if (url.includes('/approvals')) return json({ approvals: [] });
      if (url.includes('/conversations')) {
        return json({
          conversations: [
            {
              conversationId: 'c1',
              startedAt: '2026-10-06T00:00:00.000Z',
              updatedAt: '2026-10-06T00:01:00.000Z',
              messages: 2,
              preview: `token は ${TOKEN}`,
              unreadCount: 0,
              readThrough: '2026-10-06T00:01:00.000Z',
            },
          ],
          scanned: 2,
          reachedStart: true,
          hiddenByLimit: 0,
        });
      }
      return undefined;
    });
    const router = createMemoryRouter(
      [
        { path: '/chat', Component: Harness },
        { path: '/chat/:conversationId', Component: Harness },
      ],
      { initialEntries: ['/chat'] },
    );
    render(
      <Providers>
        <RouterProvider router={router} />
      </Providers>,
    );
    const list = await screen.findByRole('list', { name: '会話' });
    expect(list.textContent).toContain('token は');
    expect(list.textContent).not.toContain(TOKEN);
  });
});
