// @vitest-environment jsdom
import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
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
  return render(
    <Providers>
      <RouterProvider router={router} />
    </Providers>,
  );
}

const RAW = `まず確認した\n${Array.from({ length: 20 }, () => 'court').join('\n')}`;
const COLLAPSED = 'まず確認した\ncourt\n（以下、同じ「court」が 20 回続いたので省いた）';

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

// 履歴の再取得が済む前にアサーションへ進まない（待つ相手を時計にしない）
async function runTurn(done: Record<string, unknown>): Promise<void> {
  let afterSend = false;
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
              text: '状況は',
              conversationId: CONVERSATION_ID,
            },
            after: invalidationReleased,
          },
        ],
        { keepOpen: true, signal: init?.signal },
      );
    }
    if (url.endsWith('/chat')) {
      return sse(
        [
          { event: 'open', data: { conversationId: CONVERSATION_ID } },
          { event: 'text', data: { type: 'text', text: RAW } },
          { event: 'done', data: { type: 'done', ...done } },
        ],
        { signal: init?.signal },
      );
    }
    if (url.includes(`/conversations/${CONVERSATION_ID}`)) {
      return json({
        conversationId: CONVERSATION_ID,
        messages: [
          { id: 'm0', at: '2026-08-13T00:00:00Z', role: 'inbound', text: '以前の話' },
          ...(afterSend
            ? [
                { id: 'm1', at: '2026-08-20T00:00:05.000Z', role: 'inbound', text: '状況は' },
                { id: 'm2', at: '2026-08-20T00:00:06.000Z', role: 'outbound', text: COLLAPSED },
              ]
            : []),
        ],
      });
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

  const box = await screen.findByPlaceholderText(/クローンに話しかける/);
  fireEvent.change(box, { target: { value: '状況は' } });
  fireEvent.click(screen.getByRole('button', { name: 'メッセージを送信' }));
  await waitFor(() => expect(transcript().textContent).toContain('まず確認した'));

  afterSend = true;
  const before = detailFetchCount();
  releaseInvalidation();
  await waitFor(() => expect(detailFetchCount()).toBeGreaterThan(before), { timeout: 3000 });
}

describe('繰り返しの崩壊を切り詰めた返信は、同じ画面に1つだけ出る（#4142）', () => {
  it('done の collapsed で受信行が履歴と同じ本文になり、履歴が引き取って二重にならない', async () => {
    await runTurn({ collapsed: [{ from: RAW, to: COLLAPSED }] });

    await waitFor(() => {
      const text = transcript().textContent ?? '';
      expect(text.match(/まず確認した/g)).toHaveLength(1);
      expect(text.match(/以下、同じ/g)).toHaveLength(1);
      expect(text).not.toContain('court\ncourt');
    });
  });
});
