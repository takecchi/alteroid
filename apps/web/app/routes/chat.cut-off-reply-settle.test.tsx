// @vitest-environment jsdom
import { cleanup, fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import { createMemoryRouter, RouterProvider, useParams } from 'react-router';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import { json, Providers, sse, stubFetch, storeTestBaseUrl, type Route } from '~/test-support';

import Chat from './chat';

const ID = 'conv-4084';
const CLOSED_EARLY = /応答が途中で切れた（done も error も来ないまま接続が閉じた）/;

const ChatRoute = Chat as unknown as (props: {
  loaderData: { conversationId: string | undefined };
}) => React.ReactElement;

function Harness() {
  const params = useParams();
  return <ChatRoute loaderData={{ conversationId: params.conversationId }} />;
}

function renderApp(initial: string) {
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

/** `open` と `text` を1度に渡したあと、本文の読み取りがネットワーク断で失敗する応答。 */
function cutAfterText(): Response {
  const encoder = new TextEncoder();
  const head =
    `event: open\ndata: ${JSON.stringify({ conversationId: ID })}\n\n` +
    `event: text\ndata: ${JSON.stringify({ type: 'text', text: 'こんにち' })}\n\n`;
  return new Response(
    new ReadableStream<Uint8Array>({
      start(controller) {
        controller.enqueue(encoder.encode(head));
      },
      pull(controller) {
        controller.error(new TypeError('Failed to fetch'));
      },
    }),
    { status: 200, headers: { 'content-type': 'text/event-stream' } },
  );
}

function setup(state: { finished: boolean }, how: 'closed' | 'network') {
  const route: Route = (url, init) => {
    if (/\/chat\/[^/]+\/stream$/.test(url)) {
      return sse([{ event: 'open', data: { conversationId: ID, inProgress: false } }], {
        signal: init?.signal,
        delayMs: 0,
      });
    }
    if (url.endsWith('/chat')) {
      if (how === 'network') return cutAfterText();
      return sse(
        [
          { event: 'open', data: { conversationId: ID } },
          { event: 'text', data: { type: 'text', text: 'こんにち' } },
        ],
        { signal: init?.signal, delayMs: 0 },
      );
    }
    if (url.includes(`/conversations/${ID}`)) {
      return json({
        conversationId: ID,
        messages: [
          { id: 'm1', at: '2026-10-01T00:00:00.000Z', role: 'inbound', text: 'やあ' },
          ...(state.finished
            ? [
                {
                  id: 'm-reply',
                  at: '2026-10-01T00:00:01.000Z',
                  role: 'outbound',
                  text: 'こんにちは、元気です',
                },
              ]
            : []),
        ],
      });
    }
    if (url.includes('/approvals')) return json({ approvals: [] });
    if (url.includes('/conversations')) return json({ conversations: [], scanned: 0 });
    if (url.endsWith('/journal/stream')) {
      return sse([{ event: 'open', data: { ok: true } }], {
        keepOpen: true,
        signal: init?.signal,
        delayMs: 0,
      });
    }
    return undefined;
  };
  stubFetch(route);
}

async function send() {
  await screen.findByText('やあ');
  fireEvent.change(screen.getByPlaceholderText(/クローンに話しかける/), {
    target: { value: 'おーい' },
  });
  fireEvent.click(screen.getByRole('button', { name: 'メッセージを送信' }));
  expect(await within(transcript()).findByText('こんにち')).toBeTruthy();
}

describe('応答の途中で接続が切れたあと、履歴が完全な返信を出したら途中の行と帯を畳む（#4084）', () => {
  it('終端なしで閉じた: 履歴に返信が載ると、途中の行も「途中で切れた」の帯も消える', async () => {
    const state = { finished: false };
    setup(state, 'closed');
    renderApp(`/chat/${ID}`);
    await send();
    expect(await screen.findByText(CLOSED_EARLY)).toBeTruthy();

    state.finished = true;
    window.dispatchEvent(new Event('focus'));

    expect(await within(transcript()).findByText('こんにちは、元気です')).toBeTruthy();
    await waitFor(() => {
      expect(within(transcript()).queryAllByText('こんにち')).toHaveLength(0);
    });
    expect(screen.queryByText(CLOSED_EARLY)).toBeNull();
  });

  it('陰性対照: 履歴が新しい返信を出さないあいだは、途中の行も帯も残す', async () => {
    const state = { finished: false };
    setup(state, 'closed');
    renderApp(`/chat/${ID}`);
    await send();
    expect(await screen.findByText(CLOSED_EARLY)).toBeTruthy();

    window.dispatchEvent(new Event('focus'));
    await waitFor(() => {
      expect(within(transcript()).getAllByText('やあ')).toHaveLength(1);
    });
    expect(within(transcript()).getAllByText('こんにち')).toHaveLength(1);
    expect(screen.getByText(CLOSED_EARLY)).toBeTruthy();
  });

  it('open のあとのネットワーク断: 受け取り済みなので「もう一度試して」と勧めず、履歴に返信が載ると畳む', async () => {
    const state = { finished: false };
    setup(state, 'network');
    renderApp(`/chat/${ID}`);
    await send();

    expect(await screen.findByText(/発言は受け取り済み/)).toBeTruthy();
    expect(screen.queryByText(/もう一度試してください/)).toBeNull();
    expect(screen.queryByText(/接続先のサーバにつながっていません/)).toBeNull();

    state.finished = true;
    window.dispatchEvent(new Event('focus'));

    expect(await within(transcript()).findByText('こんにちは、元気です')).toBeTruthy();
    await waitFor(() => {
      expect(within(transcript()).queryAllByText('こんにち')).toHaveLength(0);
    });
    expect(screen.queryByText(/発言は受け取り済み/)).toBeNull();
  });
});
