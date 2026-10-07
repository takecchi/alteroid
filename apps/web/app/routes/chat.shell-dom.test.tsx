// @vitest-environment jsdom
import { cleanup, render, screen } from '@testing-library/react';
import { createMemoryRouter, RouterProvider, useParams } from 'react-router';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import { json, Providers, storeTestBaseUrl, stubFetch } from '~/test-support';

import Chat from './chat';

const ACTIVE_ID = 'conv-active';

const ChatRoute = Chat as unknown as (props: {
  loaderData: { conversationId: string | undefined };
}) => React.ReactElement;

function Harness() {
  const params = useParams();
  return <ChatRoute loaderData={{ conversationId: params.conversationId }} />;
}

function renderChat(initial: string) {
  const router = createMemoryRouter(
    [
      { path: '/chat', Component: Harness },
      { path: '/chat/:conversationId', Component: Harness },
    ],
    { initialEntries: [initial] },
  );
  return render(
    <Providers>
      <RouterProvider router={router} />
    </Providers>,
  );
}

const CONVERSATIONS = [
  {
    conversationId: ACTIVE_ID,
    startedAt: '2026-08-20T00:00:00Z',
    updatedAt: '2026-08-20T00:00:00Z',
    messages: 4,
    preview: '選んでいる会話',
  },
  {
    conversationId: 'conv-other',
    startedAt: '2026-08-19T00:00:00Z',
    updatedAt: '2026-08-19T00:00:00Z',
    messages: 2,
    preview: '別の会話',
  },
];

let originalFetch: typeof fetch;
let reachedStart: boolean | undefined;

beforeEach(() => {
  originalFetch = globalThis.fetch;
  reachedStart = true;
  localStorage.clear();
  storeTestBaseUrl();
  stubFetch((url) => {
    if (url.includes(`/conversations/${ACTIVE_ID}`)) {
      return json({ conversationId: ACTIVE_ID, messages: [] });
    }
    if (url.includes('/approvals')) return json({ approvals: [] });
    if (url.includes('/conversations')) {
      return json({ conversations: CONVERSATIONS, scanned: 40, reachedStart });
    }
    return undefined;
  });
});

afterEach(() => {
  cleanup();
  globalThis.fetch = originalFetch;
});

describe('会話の一覧', () => {
  it('「新しい会話」のボタンは Tab の順路に残り（tabindex を付けない）、リンクは /chat を指す', async () => {
    renderChat(`/chat/${ACTIVE_ID}`);

    const button = await screen.findByRole('button', { name: '新しい会話' });
    expect(button.hasAttribute('tabindex')).toBe(false);
    const link = button.closest('a');
    expect(link?.getAttribute('href')).toBe('/chat');
  });

  it('各行は「発言 N 件」と出し、窓が先頭に届いているなら「以上」を付けない', async () => {
    renderChat(`/chat/${ACTIVE_ID}`);

    const row = (await screen.findByText('別の会話')).closest('a');
    expect(row?.textContent).toMatch(/発言 2 件$/);
    expect(row?.textContent).not.toContain('往復');
  });

  it('reachedStart が false なら、どの行も「発言 N 件以上」と出す', async () => {
    reachedStart = false;
    renderChat(`/chat/${ACTIVE_ID}`);

    const other = (await screen.findByText('別の会話')).closest('a');
    expect(other?.textContent).toMatch(/発言 2 件以上$/);
    const active = screen.getByText('選んでいる会話').closest('a');
    expect(active?.textContent).toMatch(/発言 4 件以上$/);
  });

  it('reachedStart が無い応答では「以上」を付けない', async () => {
    reachedStart = undefined;
    renderChat(`/chat/${ACTIVE_ID}`);

    const row = (await screen.findByText('別の会話')).closest('a');
    expect(row?.textContent).toMatch(/発言 2 件$/);
  });
});
