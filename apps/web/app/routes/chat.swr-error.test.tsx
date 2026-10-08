// @vitest-environment jsdom
import { cleanup, render, screen } from '@testing-library/react';
import { createMemoryRouter, RouterProvider, useParams } from 'react-router';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import { json, Providers, storeTestBaseUrl, stubFetch } from '~/test-support';

import Chat from './chat';

const CONVERSATION_A = 'conv-2210-a';
const CONVERSATION_B = 'conv-2210-b';

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
  return {
    router,
    ...render(
      <Providers>
        <RouterProvider router={router} />
      </Providers>,
    ),
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

const GUIDANCE_TEXT = '目的や価値観を伝えると、クローンはそれを記憶に蒸留して次の判断に使う。';

describe('history.error（issue #2210）', () => {
  it('(a) GET /conversations/:id が失敗すると ErrorNote が出て、新しい会話の案内文言は出ない', async () => {
    stubFetch((url) => {
      if (url.includes(`/conversations/${CONVERSATION_A}`)) {
        return json({ error: 'internal' }, 500);
      }
      if (url.includes('/approvals')) return json({ approvals: [] });
      if (url.includes('/conversations')) return json({ conversations: [], scanned: 0 });
      return undefined;
    });

    renderChat(`/chat/${CONVERSATION_A}`);

    expect(await screen.findByRole('alert')).toBeTruthy();
    expect(screen.queryByText(GUIDANCE_TEXT)).toBeNull();
    expect(screen.queryByText('履歴を読み込み中')).toBeNull();
  });
});

describe('conversationApprovals.error（issue #2210）', () => {
  it('(b) その会話の承認待ちが読めないと、読めていないことを示す ErrorNote が出る（本文は読めている）', async () => {
    stubFetch((url) => {
      if (url.includes(`/conversations/${CONVERSATION_A}`)) {
        return json({
          conversationId: CONVERSATION_A,
          messages: [{ id: 'm1', at: '2026-08-20T00:00:00.000Z', role: 'inbound', text: 'やあ' }],
        });
      }
      if (url.includes('/approvals')) return json({ error: 'internal' }, 500);
      if (url.includes('/conversations')) return json({ conversations: [], scanned: 0 });
      return undefined;
    });

    renderChat(`/chat/${CONVERSATION_A}`);

    expect(await screen.findByText('やあ')).toBeTruthy();
    expect(await screen.findByRole('alert')).toBeTruthy();
  });
});

describe('会話を切り替えると前の会話の失敗は残らない（issue #2210）', () => {
  it('(c) history が失敗している A から、成功する B へ切り替えると ErrorNote は消える', async () => {
    stubFetch((url) => {
      if (url.includes(`/conversations/${CONVERSATION_A}`)) {
        return json({ error: 'internal' }, 500);
      }
      if (url.includes(`/conversations/${CONVERSATION_B}`)) {
        return json({
          conversationId: CONVERSATION_B,
          messages: [
            { id: 'm1', at: '2026-08-13T00:00:00.000Z', role: 'inbound', text: '別の会話' },
          ],
        });
      }
      if (url.includes('/approvals')) return json({ approvals: [] });
      if (url.includes('/conversations')) return json({ conversations: [], scanned: 0 });
      return undefined;
    });

    const { router } = renderChat(`/chat/${CONVERSATION_A}`);
    expect(await screen.findByRole('alert')).toBeTruthy();

    await router.navigate(`/chat/${CONVERSATION_B}`);

    expect(await screen.findByText('別の会話')).toBeTruthy();
    expect(screen.queryByRole('alert')).toBeNull();
  });
});
