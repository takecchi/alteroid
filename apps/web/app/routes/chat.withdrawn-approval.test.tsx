// @vitest-environment jsdom
import { cleanup, render, screen, within } from '@testing-library/react';
import { createMemoryRouter, RouterProvider, useParams } from 'react-router';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import { useJournalLive } from '@alteroid/swr';
import { json, Providers, stubFetch, storeTestBaseUrl, type Route } from '~/test-support';

import Chat from './chat';

const ChatRoute = Chat as unknown as (props: {
  loaderData: { conversationId: string | undefined };
}) => React.ReactElement;

function Harness() {
  useJournalLive();
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

const transcript = () => screen.getByRole('list', { name: 'やりとり' });

const CONVERSATION_ID = 'conv-withdrawn';
const QUESTION_LINE = '本番に出してよいか';

function stubConversationAndApprovals(approval: Record<string, unknown>) {
  const route: Route = (url) => {
    if (url.includes(`/conversations/${CONVERSATION_ID}`)) {
      return json({
        conversationId: CONVERSATION_ID,
        messages: [
          {
            id: 'm1',
            at: '2026-08-20T00:00:00.000Z',
            role: 'inbound',
            text: '進めてよいか確認して',
          },
        ],
        scanned: 1,
        reachedStart: true,
      });
    }
    if (url.includes('/approvals')) {
      expect(url).toContain(`conversationId=${CONVERSATION_ID}`);
      return json({ approvals: [approval] });
    }
    if (url.includes('/conversations')) return json({ conversations: [], scanned: 0 });
    return undefined;
  };
  stubFetch(route);
}

describe('取り下げられた確認が会話のタイムラインに出る（issue #974）', () => {
  it('理由付きで取り下げられた確認は、同じカードに取り下げ済みの状態と理由が出る', async () => {
    stubConversationAndApprovals({
      id: 'ap-1',
      createdAt: '2026-08-20T00:00:05.000Z',
      question: '本番に出してよいか',
      withdrawnAt: '2026-08-20T00:01:00.000Z',
      withdrawnReason: '要件が変わったため確認自体が不要になった',
    });

    renderChat(`/chat/${CONVERSATION_ID}`);

    await screen.findByText(QUESTION_LINE);
    expect(await screen.findByText('要件が変わったため確認自体が不要になった')).toBeTruthy();
    const cards = within(transcript())
      .getAllByRole('listitem')
      .filter((item) => item.textContent?.includes(QUESTION_LINE));
    expect(cards).toHaveLength(1);
    expect(cards[0]?.textContent).toContain('取り下げ済');
    expect(cards[0]?.textContent).toContain('取り下げ:');

    expect(screen.queryByText('回答する')).toBeNull();
  });

  it('取り下げの理由が欠けている行でも、取り下げられた事実の行は出る', async () => {
    stubConversationAndApprovals({
      id: 'ap-1',
      createdAt: '2026-08-20T00:00:05.000Z',
      question: '本番に出してよいか',
      withdrawnAt: '2026-08-20T00:01:00.000Z',
    });

    renderChat(`/chat/${CONVERSATION_ID}`);

    await screen.findByText(QUESTION_LINE);
    expect(await screen.findByText('（理由の記録なし）')).toBeTruthy();
  });
});
