// @vitest-environment jsdom
/**
 * **会話の一覧の「新しい会話」のボタンが、Tab の順路に残っていること。**
 *
 * 部品（`ConversationList`）の既定はこのボタンを Tab の順路から外す（`tabIndex=-1`）が、
 * 従来の画面ではリンクの中のボタンも Tab で止まっていた。**移行で変えてよいのは見た目だけ**
 * なので、画面は `newConversationTabStop` でその振る舞いを保っている。この歯はその側を押さえる。
 * 見た目（選択中の行・往復の数の包み・入力欄の帯の地色）は新しいテーマの既定を採っており、
 * ここでは固定しない。
 */
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

beforeEach(() => {
  originalFetch = globalThis.fetch;
  localStorage.clear();
  storeTestBaseUrl();
  stubFetch((url) => {
    if (url.includes(`/conversations/${ACTIVE_ID}`)) {
      return json({ conversationId: ACTIVE_ID, messages: [] });
    }
    if (url.includes('/approvals')) return json({ approvals: [] });
    if (url.includes('/conversations')) {
      return json({ conversations: CONVERSATIONS, scanned: 40, reachedStart: true });
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
});
