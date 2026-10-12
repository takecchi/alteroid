// @vitest-environment jsdom
import { act, cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { createMemoryRouter, RouterProvider, useParams } from 'react-router';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import { json, Providers, sse, storeTestBaseUrl, stubFetch } from '~/test-support';

import Chat from './chat';

const ID = 'conv-fu-early';

const ChatRoute = Chat as unknown as (props: {
  loaderData: { conversationId: string | undefined };
}) => React.ReactElement;

function Harness() {
  const params = useParams();
  return <ChatRoute loaderData={{ conversationId: params.conversationId }} />;
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
  const box = (await screen.findByPlaceholderText(/クローンに話しかける/)) as HTMLTextAreaElement;
  fireEvent.change(box, { target: { value: text } });
  fireEvent.click(screen.getByRole('button', { name: 'メッセージを送信' }));
  return box;
}

/** 1本目は返答が流れ続け、2本目（追送）の応答は `secondOpens` で開くか開かずに閉じるかを選ぶ。 */
function setup(secondOpens: boolean): {
  chatCalls: () => number;
  secondSignal: () => AbortSignal | undefined;
} {
  let chatCalls = 0;
  let secondSignal: AbortSignal | undefined;
  stubFetch((url, init) => {
    if (/\/chat\/[^/]+\/stream$/.test(url)) {
      return sse([{ event: 'open', data: { conversationId: ID, inProgress: false } }], {
        signal: init?.signal,
      });
    }
    if (url.endsWith('/chat')) {
      chatCalls += 1;
      if (chatCalls === 1) {
        return sse(
          [
            { event: 'open', data: { conversationId: ID } },
            { event: 'text', data: { type: 'text', text: '考え中' } },
          ],
          { signal: init?.signal, keepOpen: true },
        );
      }
      secondSignal = init?.signal ?? undefined;
      return secondOpens
        ? sse([{ event: 'open', data: { conversationId: ID } }], {
            signal: init?.signal,
            keepOpen: true,
          })
        : sse([], { signal: init?.signal });
    }
    if (url.includes(`/conversations/${ID}`)) return json({ conversationId: ID, messages: [] });
    if (url.includes('/approvals')) return json({ approvals: [] });
    if (url.includes('/conversations')) return json({ conversations: [], scanned: 0 });
    if (url.endsWith('/journal/stream')) {
      return sse([{ event: 'open', data: { ok: true } }], { keepOpen: true, signal: init?.signal });
    }
    return undefined;
  });
  const router = createMemoryRouter(
    [
      { path: '/chat', Component: Harness },
      { path: '/chat/:conversationId', Component: Harness },
    ],
    { initialEntries: [`/chat/${ID}`] },
  );
  render(
    <Providers>
      <RouterProvider router={router} />
    </Providers>,
  );
  return { chatCalls: () => chatCalls, secondSignal: () => secondSignal };
}

describe('受信中の追送の POST が open を返さずに閉じたとき（#4531）', () => {
  it('送れた扱いにせず、文を入力欄へ戻して「再送」を出す', async () => {
    const { chatCalls } = setup(false);

    await send('一つ目');
    expect(await screen.findByText(/考え中/)).toBeTruthy();
    const box = await send('二つ目の追送');
    await waitFor(() => expect(chatCalls()).toBe(2));

    await waitFor(() => expect(box.value).toBe('二つ目の追送'));
    expect(screen.getByRole('button', { name: '再送' })).toBeTruthy();
  });

  it('対照: 追送が open を返したら、入力欄は空のままで「再送」は出ない', async () => {
    const { chatCalls, secondSignal } = setup(true);

    await send('一つ目');
    expect(await screen.findByText(/考え中/)).toBeTruthy();
    const box = await send('二つ目の追送');
    await waitFor(() => expect(chatCalls()).toBe(2));

    // 実時間で待たない（#2146）: 追送は open を読んだら finally で POST を abort し、同じ流れで後始末を終える。abort を見てから描画を流す
    await waitFor(() => expect(secondSignal()?.aborted).toBe(true));
    await act(async () => {
      await Promise.resolve();
    });
    expect(box.value).toBe('');
    expect(screen.queryByRole('button', { name: '再送' })).toBeNull();
  });
});
