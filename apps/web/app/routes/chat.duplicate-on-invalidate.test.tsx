// @vitest-environment jsdom
import { cleanup, fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import { createMemoryRouter, RouterProvider, useParams } from 'react-router';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import { useJournalLive } from '@alteroid/swr';
import { json, Providers, sse, stubFetch, storeTestBaseUrl, type Route } from '~/test-support';

import Chat from './chat';

const CONVERSATION_ID = 'conv-1';

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

const STREAM = [
  { event: 'open', data: { conversationId: CONVERSATION_ID } },
  { event: 'text', data: { type: 'text', text: 'わかった' } },
  { event: 'done', data: { type: 'done' } },
];

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

async function setUpExistingConversationWithLiveInvalidation(): Promise<{
  stub: ReturnType<typeof stubFetch>;
}> {
  let afterSend = false;

  // 無効化の合図を時計で流さない: 待つ相手が時間内に終わる賭けは CI の実行環境で追い越され、再取得が afterSend より先に済んでしまうため
  let releaseInvalidation: () => void = () => {};
  const invalidationReleased = new Promise<void>((resolve) => {
    releaseInvalidation = resolve;
  });

  const route: Route = (url, init) => {
    if (url.endsWith('/journal/stream')) {
      return sse(
        [
          { event: 'open', data: { ok: true } },
          {
            event: 'exchange',
            data: {
              type: 'exchange',
              id: 'evt-live-1',
              at: '2026-08-20T00:00:10.000Z',
              with: 'human',
              role: 'inbound',
              text: '追加の発言',
              conversationId: CONVERSATION_ID,
            },
            after: invalidationReleased,
          },
        ],
        { keepOpen: true, signal: init?.signal },
      );
    }
    if (url.endsWith('/chat')) return sse(STREAM, { signal: init?.signal });
    if (url.includes(`/conversations/${CONVERSATION_ID}`)) {
      return json(
        afterSend
          ? {
              conversationId: CONVERSATION_ID,
              messages: [
                { id: 'm0', at: '2026-08-13T00:00:00Z', role: 'inbound', text: '以前の話' },
                { id: 'm0b', at: '2026-08-13T00:00:01Z', role: 'outbound', text: '以前の返事' },
                { id: 'm1', at: '2026-08-20T00:00:05.000Z', role: 'inbound', text: '追加の発言' },
                { id: 'm2', at: '2026-08-20T00:00:06.000Z', role: 'outbound', text: 'わかった' },
              ],
            }
          : {
              conversationId: CONVERSATION_ID,
              messages: [
                { id: 'm0', at: '2026-08-13T00:00:00Z', role: 'inbound', text: '以前の話' },
                { id: 'm0b', at: '2026-08-13T00:00:01Z', role: 'outbound', text: '以前の返事' },
              ],
            },
      );
    }
    if (url.includes('/approvals')) return json({ approvals: [] });
    if (url.includes('/conversations')) return json({ conversations: [], scanned: 0 });
    return undefined;
  };
  const stub = stubFetch(route);
  const detailFetchCount = () =>
    stub.calls.filter((url) => url.includes(`/conversations/${CONVERSATION_ID}`)).length;

  renderChat(`/chat/${CONVERSATION_ID}`);

  await screen.findByText('以前の話');
  expect(within(transcript()).queryAllByText('追加の発言')).toHaveLength(0);

  await send('追加の発言');
  expect(within(transcript()).getAllByText('追加の発言')).toHaveLength(1);

  await screen.findByText('わかった');

  afterSend = true;
  const detailFetchesBefore = detailFetchCount();

  releaseInvalidation();

  // 再取得が起きたこと自体を先に確かめる: でないと、無効化が届く前にアサーションへ進み、「たまたま踏まなかった」を「直っている」と読み違えるため
  await waitFor(
    () => {
      expect(detailFetchCount()).toBeGreaterThan(detailFetchesBefore);
    },
    { timeout: 3000 },
  );

  return { stub };
}

describe('既存の会話を開いたまま発言する — 履歴の再取得による二重描画', () => {
  it('人間の発言が2回描かれる（journal/stream 由来の無効化 → historyLines の再取得と、ローカル lines の両方に乗る）', async () => {
    await setUpExistingConversationWithLiveInvalidation();

    expect(within(transcript()).getAllByText('追加の発言')).toHaveLength(1);
  });

  it('クローンの返信も2回描かれる（人間の発言だけの偶然ではない）', async () => {
    await setUpExistingConversationWithLiveInvalidation();

    expect(within(transcript()).getAllByText('わかった')).toHaveLength(1);
  });
});
