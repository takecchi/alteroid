// @vitest-environment jsdom
/**
 * 「受信をやめる」のあと、履歴が完全な返信を出したら途中の返信行は畳まれる（Issue #3761、Web）。
 *
 * 受信を止めても、クローンのターンはサーバ側で続く。終わると履歴に完全な発言が載るが、
 * 止めた時点で手元に残した途中の返信行は本文が違うので履歴と突き合わず、二重に並んでいた。
 *
 * **実時間を待たない。** 順序は `finished` の旗と、フォーカスによる履歴の再取得で作る。
 */
import { cleanup, fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import { createMemoryRouter, RouterProvider, useParams } from 'react-router';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import { json, Providers, sse, stubFetch, storeTestBaseUrl, type Route } from '~/test-support';

import Chat from './chat';

const ID = 'conv-1';

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

function setup(state: { finished: boolean }) {
  const route: Route = (url, init) => {
    if (/\/chat\/[^/]+\/stream$/.test(url)) {
      return sse([{ event: 'open', data: { conversationId: ID, inProgress: false } }], {
        keepOpen: false,
        signal: init?.signal,
        delayMs: 0,
      });
    }
    if (url.endsWith('/chat')) {
      return sse(
        [
          { event: 'open', data: { conversationId: ID } },
          { event: 'text', data: { type: 'text', text: 'こんにち' } },
        ],
        { keepOpen: true, signal: init?.signal, delayMs: 0 },
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

async function sendAndStop() {
  await screen.findByText('やあ');
  fireEvent.change(screen.getByPlaceholderText(/クローンに話しかける/), {
    target: { value: 'おーい' },
  });
  fireEvent.click(screen.getByRole('button', { name: 'メッセージを送信' }));
  expect(await within(transcript()).findByText('こんにち')).toBeTruthy();
  fireEvent.click(screen.getByRole('button', { name: /受信をやめる/ }));
  await waitFor(() => {
    expect(screen.queryByRole('button', { name: /受信をやめる/ })).toBeNull();
  });
}

describe('受信をやめたあと、履歴が完全な返信を出したら途中の行は畳まれる', () => {
  it('止めた直後は途中の本文が残り、履歴に完全な発言が載ると1つだけになる', async () => {
    const state = { finished: false };
    setup(state);
    renderApp(`/chat/${ID}`);
    await sendAndStop();

    // 止めた直後: これまでの本文は残る（今の挙動を変えない）。
    expect(within(transcript()).getAllByText('こんにち')).toHaveLength(1);

    // ターンが終わり、履歴が完全な発言を出す。
    state.finished = true;
    window.dispatchEvent(new Event('focus'));

    expect(await within(transcript()).findByText('こんにちは、元気です')).toBeTruthy();
    await waitFor(() => {
      expect(within(transcript()).queryAllByText('こんにち')).toHaveLength(0);
    });
    expect(within(transcript()).getAllByText('こんにちは、元気です')).toHaveLength(1);
  });

  it('陰性対照: 履歴が新しい発言を出さないあいだは、途中の本文を消さない', async () => {
    const state = { finished: false };
    setup(state);
    renderApp(`/chat/${ID}`);
    await sendAndStop();

    window.dispatchEvent(new Event('focus'));
    await waitFor(() => {
      expect(within(transcript()).getAllByText('やあ')).toHaveLength(1);
    });
    expect(within(transcript()).getAllByText('こんにち')).toHaveLength(1);
  });
});
