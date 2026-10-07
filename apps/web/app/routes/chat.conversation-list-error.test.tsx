// @vitest-environment jsdom
import { cleanup, render, screen } from '@testing-library/react';
import { createMemoryRouter, RouterProvider, useParams } from 'react-router';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import { json, Providers, storeTestBaseUrl, stubFetch } from '~/test-support';

import Chat from './chat';

const EMPTY_TEXT = 'まだ会話がない。';

const ChatRoute = Chat as unknown as (props: {
  loaderData: { conversationId: string | undefined };
}) => React.ReactElement;

function Harness() {
  const params = useParams();
  return <ChatRoute loaderData={{ conversationId: params.conversationId }} />;
}

function renderChat() {
  const router = createMemoryRouter(
    [
      { path: '/chat', Component: Harness },
      { path: '/chat/:conversationId', Component: Harness },
    ],
    { initialEntries: ['/chat'] },
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
});

afterEach(() => {
  cleanup();
  globalThis.fetch = originalFetch;
});

describe('会話の一覧の取得（issue #2323）', () => {
  it('サーバの失敗（500）: エラーは出し、「まだ会話がない。」は出さない', async () => {
    stubFetch((url) => {
      if (url.includes('/approvals')) return json({ approvals: [] });
      if (url.includes('/conversations')) return json({ error: 'internal' }, 500);
      return undefined;
    });

    renderChat();

    expect(await screen.findByRole('alert')).toBeTruthy();
    expect(screen.queryByText(EMPTY_TEXT)).toBeNull();
  });

  it('本当に0件で成功したら、いままでどおり「まだ会話がない。」と言う', async () => {
    stubFetch((url) => {
      if (url.includes('/approvals')) return json({ approvals: [] });
      if (url.includes('/conversations')) return json({ conversations: [], scanned: 0 });
      return undefined;
    });

    renderChat();

    expect(await screen.findByText(EMPTY_TEXT)).toBeTruthy();
    expect(screen.queryByRole('alert')).toBeNull();
  });
});
