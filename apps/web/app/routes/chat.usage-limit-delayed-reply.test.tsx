// @vitest-environment jsdom
import { cleanup, fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import { createMemoryRouter, RouterProvider, useParams } from 'react-router';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import { useJournalLive } from '@alteroid/swr';
import {
  gate,
  json,
  Providers,
  sse,
  stubFetch,
  storeTestBaseUrl,
  untilOpenSettled,
  type Route,
} from '~/test-support';

import Chat from './chat';

const CONVERSATION_ID = 'conv-1';
const LIMIT_MESSAGE =
  "利用上限に当たった。この文言で仕事が止まっている: You've hit your individual spend limit for this account.";
const DELAYED_REPLY = '枠が開いたので、待たせていた分に返す。';

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

async function send(text: string) {
  const box = await screen.findByPlaceholderText(/クローンに話しかける/);
  fireEvent.change(box, { target: { value: text } });
  fireEvent.click(screen.getByRole('button', { name: 'メッセージを送信' }));
}

const transcript = () => screen.getByRole('list', { name: 'やりとり' });

describe('枠（利用上限）で待たされた発言の返信は、同じタブに居続けても後から出る', () => {
  it('この画面で始めた会話でも、遅れて日誌に載った返信が現れる', async () => {
    let retried = false;

    // 順序を時計で作らない: 待つ相手が時間内に終わる賭けは追い越され、無効化が retried を立てる前に届いて返信の無いまま二度目も来ないため
    let releaseRetryNotice: () => void = () => {};
    const retryNoticeReleased = new Promise<void>((resolve) => {
      releaseRetryNotice = resolve;
    });

    const limited = gate();

    const route: Route = (url, init) => {
      if (url.endsWith('/journal/stream')) {
        return sse(
          [
            { event: 'open', data: { ok: true } },
            {
              event: 'exchange',
              data: {
                type: 'exchange',
                id: 'evt-retry-reply',
                at: '2026-08-20T00:10:00.000Z',
                with: 'human',
                role: 'outbound',
                text: DELAYED_REPLY,
                conversationId: CONVERSATION_ID,
              },
              after: retryNoticeReleased,
            },
          ],
          { keepOpen: true, signal: init?.signal },
        );
      }
      if (url.endsWith('/chat')) {
        return sse(
          [
            { event: 'open', data: { conversationId: CONVERSATION_ID } },
            {
              event: 'usage_limited',
              data: { type: 'usage_limited', message: LIMIT_MESSAGE },
              after: limited.promise,
            },
            { event: 'error', data: { type: 'error', message: LIMIT_MESSAGE } },
          ],
          { signal: init?.signal },
        );
      }
      if (url.includes(`/conversations/${CONVERSATION_ID}`)) {
        return json({
          conversationId: CONVERSATION_ID,
          messages: [
            { id: 'm1', at: '2026-08-20T00:00:00Z', role: 'inbound', text: '待たされる発言' },
            ...(retried
              ? [
                  {
                    id: 'm2',
                    at: '2026-08-20T00:10:00Z',
                    role: 'outbound' as const,
                    text: DELAYED_REPLY,
                  },
                ]
              : []),
          ],
        });
      }
      if (url.includes('/approvals')) return json({ approvals: [] });
      if (url.includes('/conversations')) return json({ conversations: [], scanned: 0 });
      return undefined;
    };
    stubFetch(route);

    const { router } = renderChat('/chat');
    await send('待たされる発言');
    await untilOpenSettled(router, CONVERSATION_ID);
    limited.open();

    // やりとりの中に限って探す: 同じ文言は直後の error で ErrorNote にも出て、画面全体から探すと複数見つかって落ちるため
    await within(transcript()).findByText(new RegExp('利用上限に当たった'));
    await screen.findByRole('alert');
    expect(within(transcript()).queryAllByText(DELAYED_REPLY)).toHaveLength(0);

    retried = true;
    releaseRetryNotice();

    await waitFor(
      () => {
        expect(within(transcript()).getAllByText(DELAYED_REPLY)).toHaveLength(1);
      },
      { timeout: 3000 },
    );

    expect(within(transcript()).getAllByText('待たされる発言')).toHaveLength(1);
  });
});
