// @vitest-environment jsdom
import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { createMemoryRouter, RouterProvider, useParams } from 'react-router';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import {
  findShownConversation,
  json,
  Providers,
  sse,
  storeTestBaseUrl,
  stubFetch,
  type Route,
} from '~/test-support';

import Chat from './chat';

const CONVERSATION_A = 'conv-1585-a';
const CONVERSATION_B = 'conv-1585-b';
const ERROR_MESSAGE = 'いまは投げられない（テスト用の文言、#1585）';
const FOLLOW_UP_ERROR_MESSAGE = '投函に失敗した（テスト用の文言、#1585）';

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

function conversationRoutes(url: string) {
  if (url.includes(`/conversations/${CONVERSATION_A}`)) {
    return json({ conversationId: CONVERSATION_A, messages: [] });
  }
  if (url.includes(`/conversations/${CONVERSATION_B}`)) {
    return json({ conversationId: CONVERSATION_B, messages: [] });
  }
  if (url.includes('/approvals')) {
    return json({ approvals: [] });
  }
  if (url.includes('/conversations')) {
    return json({ conversations: [], scanned: 0 });
  }
  return undefined;
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

async function typeAndSend(text: string) {
  const box = await screen.findByPlaceholderText(/クローンに話しかける/);
  fireEvent.change(box, { target: { value: text } });
  fireEvent.click(screen.getByRole('button', { name: 'メッセージを送信' }));
}

describe('#1585: 送信/追送の失敗は会話ごとに持ち、切り替えでは消えない', () => {
  it('(a) A で追送が失敗 → B では出ない → A へ戻ると出る', async () => {
    let chatCalls = 0;
    const route: Route = (url, init) => {
      const conversation = conversationRoutes(url);
      if (conversation !== undefined) return conversation;
      if (url.endsWith('/chat')) {
        chatCalls += 1;
        if (chatCalls === 1) {
          return sse([{ event: 'open', data: { conversationId: CONVERSATION_A } }], {
            signal: init?.signal,
            keepOpen: true,
          });
        }
        return Promise.reject(new TypeError(FOLLOW_UP_ERROR_MESSAGE));
      }
      return undefined;
    };
    stubFetch(route);

    const { router } = renderChat(`/chat/${CONVERSATION_A}`);
    await typeAndSend('一つ目');
    expect(
      await screen.findByRole('button', { name: '受信をやめる（クローンのターンは止まらない）' }),
    ).toBeTruthy();

    await typeAndSend('二つ目');

    expect(await screen.findByText(FOLLOW_UP_ERROR_MESSAGE)).toBeTruthy();
    await waitFor(() => {
      const input = screen.getByPlaceholderText(/クローンに話しかける/) as HTMLTextAreaElement;
      expect(input.value).toBe('二つ目');
    });

    await router.navigate(`/chat/${CONVERSATION_B}`);
    expect(await findShownConversation(CONVERSATION_B)).toBeTruthy();
    expect(screen.queryByText(FOLLOW_UP_ERROR_MESSAGE)).toBeNull();

    await router.navigate(`/chat/${CONVERSATION_A}`);
    expect(await screen.findByText(FOLLOW_UP_ERROR_MESSAGE)).toBeTruthy();
  });

  it('(b) メインの send（ストリームの error イベント）でも同じ', async () => {
    stubFetch((url, init) => {
      const conversation = conversationRoutes(url);
      if (conversation !== undefined) return conversation;
      if (url.endsWith('/chat')) {
        return sse(
          [
            { event: 'open', data: { conversationId: CONVERSATION_A } },
            { event: 'error', data: { type: 'error', message: ERROR_MESSAGE } },
          ],
          { signal: init?.signal },
        );
      }
      return undefined;
    });

    const { router } = renderChat(`/chat/${CONVERSATION_A}`);
    await typeAndSend('やあ');

    expect(await screen.findByText(ERROR_MESSAGE)).toBeTruthy();

    await router.navigate(`/chat/${CONVERSATION_B}`);
    expect(await findShownConversation(CONVERSATION_B)).toBeTruthy();
    expect(screen.queryByText(ERROR_MESSAGE)).toBeNull();

    await router.navigate(`/chat/${CONVERSATION_A}`);
    expect(await screen.findByText(ERROR_MESSAGE)).toBeTruthy();
  });

  it('(c) A の失敗は、A で次の送信を始めると消える', async () => {
    let chatCalls = 0;
    stubFetch((url, init) => {
      const conversation = conversationRoutes(url);
      if (conversation !== undefined) return conversation;
      if (url.endsWith('/chat')) {
        chatCalls += 1;
        if (chatCalls === 1) {
          return sse(
            [
              { event: 'open', data: { conversationId: CONVERSATION_A } },
              { event: 'error', data: { type: 'error', message: ERROR_MESSAGE } },
            ],
            { signal: init?.signal },
          );
        }
        return sse(
          [
            { event: 'open', data: { conversationId: CONVERSATION_A } },
            { event: 'done', data: { type: 'done' } },
          ],
          { signal: init?.signal },
        );
      }
      return undefined;
    });

    renderChat(`/chat/${CONVERSATION_A}`);
    await typeAndSend('一つ目');
    expect(await screen.findByText(ERROR_MESSAGE)).toBeTruthy();
    // 1回目のストリームが完全に畳まれるのを待つ: でないと2回目が followUp に回り、send の冒頭のクリアを通らないため
    await waitFor(() => {
      expect(
        screen.queryByRole('button', { name: '受信をやめる（クローンのターンは止まらない）' }),
      ).toBeNull();
    });

    await typeAndSend('二つ目');

    await waitFor(() => {
      expect(screen.queryByText(ERROR_MESSAGE)).toBeNull();
    });
  });

  it('(d) B の失敗と A の失敗は混ざらない（B で失敗させて A へ移ると、A には B の失敗が出ない）', async () => {
    stubFetch((url, init) => {
      const conversation = conversationRoutes(url);
      if (conversation !== undefined) return conversation;
      if (url.endsWith('/chat')) {
        return sse(
          [
            { event: 'open', data: { conversationId: CONVERSATION_B } },
            { event: 'error', data: { type: 'error', message: ERROR_MESSAGE } },
          ],
          { signal: init?.signal },
        );
      }
      return undefined;
    });

    const { router } = renderChat(`/chat/${CONVERSATION_B}`);
    await typeAndSend('B から送る');
    expect(await screen.findByText(ERROR_MESSAGE)).toBeTruthy();

    await router.navigate(`/chat/${CONVERSATION_A}`);
    expect(await findShownConversation(CONVERSATION_A)).toBeTruthy();
    expect(screen.queryByText(ERROR_MESSAGE)).toBeNull();
  });
});

describe('#2460: 新しい会話（鍵 undefined）の失敗は、別の白紙の新しい会話へ持ち越さない', () => {
  const NEW_CONVERSATION_ERROR = '新しい会話の投函に失敗した（テスト用の文言、#2460）';
  const CONVERSATION_C = 'conv-2460-c';

  function stubNewConversationFailure() {
    stubFetch((url) => {
      if (url.includes(`/conversations/${CONVERSATION_C}`)) {
        return json({ conversationId: CONVERSATION_C, messages: [] });
      }
      const conversation = conversationRoutes(url);
      if (conversation !== undefined) return conversation;
      if (url.endsWith('/chat')) return Promise.reject(new TypeError(NEW_CONVERSATION_ERROR));
      return undefined;
    });
  }

  it('新しい会話で失敗 → B → C → もう一度新しい会話: 白紙の新しい会話に出ない', async () => {
    stubNewConversationFailure();
    const { router } = renderChat('/chat');
    await typeAndSend('送れない発言');
    expect(await screen.findByText(NEW_CONVERSATION_ERROR)).toBeTruthy();

    await router.navigate(`/chat/${CONVERSATION_B}`);
    expect(await findShownConversation(CONVERSATION_B)).toBeTruthy();
    await router.navigate(`/chat/${CONVERSATION_C}`);
    expect(await findShownConversation(CONVERSATION_C)).toBeTruthy();

    await router.navigate('/chat');
    expect(await screen.findByPlaceholderText(/クローンに話しかける/)).toBeTruthy();
    // 「出ていない状態になる」のを待つ: 入力欄は前の画面にも在り、見つかっても切り替えの描画が済んだとは限らないため
    await waitFor(() => {
      expect(screen.queryByText(NEW_CONVERSATION_ERROR)).toBeNull();
    });
  });

  it('対照: 失敗した新しい会話から離れないあいだは、失敗が出続ける', async () => {
    stubNewConversationFailure();
    renderChat('/chat');
    await typeAndSend('送れない発言');
    expect(await screen.findByText(NEW_CONVERSATION_ERROR)).toBeTruthy();

    // 実時間で待たない: 器が混むと実時間の待ちは足りなくなるため
    for (let i = 0; i < 2; i += 1) {
      await new Promise((resolve) => setTimeout(resolve, 0));
    }
    expect(screen.getByText(NEW_CONVERSATION_ERROR)).toBeTruthy();
  });

  it('対照: id のある会話の失敗は、新しい会話を経由しても消えない（#1587）', async () => {
    stubFetch((url, init) => {
      const conversation = conversationRoutes(url);
      if (conversation !== undefined) return conversation;
      if (url.endsWith('/chat')) {
        return sse(
          [
            { event: 'open', data: { conversationId: CONVERSATION_A } },
            { event: 'error', data: { type: 'error', message: ERROR_MESSAGE } },
          ],
          { signal: init?.signal },
        );
      }
      return undefined;
    });

    const { router } = renderChat(`/chat/${CONVERSATION_A}`);
    await typeAndSend('やあ');
    expect(await screen.findByText(ERROR_MESSAGE)).toBeTruthy();

    await router.navigate('/chat');
    expect(await screen.findByPlaceholderText(/クローンに話しかける/)).toBeTruthy();
    await waitFor(() => {
      expect(screen.queryByText(ERROR_MESSAGE)).toBeNull();
    });

    await router.navigate(`/chat/${CONVERSATION_A}`);
    expect(await screen.findByText(ERROR_MESSAGE)).toBeTruthy();
  });
});
