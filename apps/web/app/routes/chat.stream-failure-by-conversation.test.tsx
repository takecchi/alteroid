// @vitest-environment jsdom
import {
  act,
  cleanup,
  configure,
  fireEvent,
  render,
  screen,
  waitFor,
} from '@testing-library/react';
import { createMemoryRouter, RouterProvider, useParams } from 'react-router';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import {
  findShownConversation,
  queryShownConversation,
  json,
  Providers,
  sse,
  storeTestBaseUrl,
  stubFetch,
  type Route,
} from '~/test-support';

import Chat from './chat';

// 待つ予算を広げる: 計算機が混むと it 全体の既定 5000ms が先に切れるため
vi.setConfig({ testTimeout: 30_000 });
configure({ asyncUtilTimeout: 5000 });

const CONVERSATION_ID = 'conv-fail-1';
const OTHER_CONVERSATION_ID = 'conv-fail-2';
const ERROR_MESSAGE = 'いまは投げられない（テスト用の文言）';
const FOLLOW_UP_ERROR_MESSAGE = '投函に失敗した（テスト用の文言）';

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
  if (url.includes(`/conversations/${CONVERSATION_ID}`)) {
    return json({ conversationId: CONVERSATION_ID, messages: [] });
  }
  if (url.includes(`/conversations/${OTHER_CONVERSATION_ID}`)) {
    return json({ conversationId: OTHER_CONVERSATION_ID, messages: [] });
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

// test-support の sse() を使わない: フレームごとに実タイマーを挟み、受動効果との先着順が実行環境の速さへの賭けになるため
function chatStreamWithGatedError(
  gate: Promise<unknown>,
  signal: AbortSignal | null | undefined,
): Response {
  const encoder = new TextEncoder();
  const stream = new ReadableStream<Uint8Array>({
    async start(controller) {
      let aborted = signal?.aborted === true;
      const stop = () => {
        aborted = true;
        try {
          controller.error(new DOMException('The operation was aborted.', 'AbortError'));
        } catch {
          // 既に閉じている
        }
      };
      signal?.addEventListener('abort', stop, { once: true });
      const abortedPromise = new Promise<void>((resolve) => {
        if (signal === null || signal === undefined) return;
        if (signal.aborted) resolve();
        else signal.addEventListener('abort', () => resolve(), { once: true });
      });

      if (aborted) return;
      controller.enqueue(
        encoder.encode(
          `event: open\ndata: ${JSON.stringify({ conversationId: CONVERSATION_ID })}\n\n`,
        ),
      );

      await Promise.race([gate, abortedPromise]);
      if (aborted) return;
      controller.enqueue(
        encoder.encode(
          `event: error\ndata: ${JSON.stringify({ type: 'error', message: ERROR_MESSAGE, kind: 'other' })}\n\n`,
        ),
      );
      controller.close();
    },
  });
  return new Response(stream, { status: 200, headers: { 'content-type': 'text/event-stream' } });
}

describe('送信ストリームの error イベント（会話を見ずに立つ、#1576-1）', () => {
  it('A で送信中に B へ切り替え、B が commit された直後（効果が走る前）に A の error が届いても、B に出ない', async () => {
    let releaseError: () => void = () => {};
    const errorReleased = new Promise<void>((resolve) => {
      releaseError = resolve;
    });
    const route: Route = (url, init) => {
      const conversation = conversationRoutes(url);
      if (conversation !== undefined) return conversation;
      if (url.endsWith('/chat')) return chatStreamWithGatedError(errorReleased, init?.signal);
      return undefined;
    };
    const stub = stubFetch(route);

    const { router } = renderChat(`/chat/${CONVERSATION_ID}`);
    await typeAndSend('やあ');

    await waitFor(() => {
      expect(stub.entries.some((entry) => entry.url.endsWith('/chat'))).toBe(true);
    });
    expect(
      await screen.findByRole('button', { name: '受信をやめる（クローンのターンは止まらない）' }),
    ).toBeTruthy();

    let releasedInWindow = false;
    const observer = new MutationObserver(() => {
      if (releasedInWindow || queryShownConversation(OTHER_CONVERSATION_ID) === null) return;
      releasedInWindow = true;
      observer.disconnect();
      releaseError();
    });
    observer.observe(document.body, { childList: true, subtree: true, characterData: true });

    await router.navigate(`/chat/${OTHER_CONVERSATION_ID}`);
    expect(await findShownConversation(OTHER_CONVERSATION_ID)).toBeTruthy();
    expect(releasedInWindow).toBe(true);

    // 「出ない」は findBy/waitFor で直接待てないため、必ず起きる別の事実（「受信をやめる」ボタンが畳まれること）を待つ
    await waitFor(() => {
      expect(
        screen.queryByRole('button', { name: '受信をやめる（クローンのターンは止まらない）' }),
      ).toBeNull();
    });

    expect(screen.queryByText(ERROR_MESSAGE)).toBeNull();
    expect(screen.queryByRole('alert')).toBeNull();
  });

  it('対照: 同じ会話のまま error が届けば、今までどおり出る（切り替えていない）', async () => {
    stubFetch((url, init) => {
      const conversation = conversationRoutes(url);
      if (conversation !== undefined) return conversation;
      if (url.endsWith('/chat')) {
        return sse(
          [
            { event: 'open', data: { conversationId: CONVERSATION_ID } },
            { event: 'error', data: { type: 'error', message: ERROR_MESSAGE, kind: 'other' } },
          ],
          { signal: init?.signal },
        );
      }
      return undefined;
    });

    renderChat(`/chat/${CONVERSATION_ID}`);
    await typeAndSend('やあ');

    expect(await screen.findByText(ERROR_MESSAGE)).toBeTruthy();
  });
});

describe('追送（followUp）の失敗（投函先を見ずに立つ、#1576-2）', () => {
  it('A で受信中に追送し、B へ切り替えが完全に終わった後に投函が失敗しても、B に出ない', async () => {
    let releaseFollowUpFailure: () => void = () => {};
    const followUpReleased = new Promise<void>((resolve) => {
      releaseFollowUpFailure = resolve;
    });
    let chatCalls = 0;
    const route: Route = (url, init) => {
      const conversation = conversationRoutes(url);
      if (conversation !== undefined) return conversation;
      if (url.endsWith('/chat')) {
        chatCalls += 1;
        if (chatCalls === 1) {
          return sse([{ event: 'open', data: { conversationId: CONVERSATION_ID } }], {
            signal: init?.signal,
            keepOpen: true,
          });
        }
        return followUpReleased.then((): Response => {
          throw new TypeError(FOLLOW_UP_ERROR_MESSAGE);
        });
      }
      return undefined;
    };
    const stub = stubFetch(route);

    const { router } = renderChat(`/chat/${CONVERSATION_ID}`);
    await typeAndSend('一つ目');
    await waitFor(() => {
      expect(stub.entries.filter((entry) => entry.url.endsWith('/chat')).length).toBe(1);
    });
    expect(
      await screen.findByRole('button', { name: '受信をやめる（クローンのターンは止まらない）' }),
    ).toBeTruthy();

    await typeAndSend('二つ目');
    await waitFor(() => {
      expect(stub.entries.filter((entry) => entry.url.endsWith('/chat')).length).toBe(2);
    });

    await router.navigate(`/chat/${OTHER_CONVERSATION_ID}`);
    expect(await findShownConversation(OTHER_CONVERSATION_ID)).toBeTruthy();
    await act(async () => {});

    releaseFollowUpFailure();

    // マクロタスクの境界を1つ越えて待つ: followUp 自身は待てる目印を持たず、失敗は実タイマーを挟まないマイクロタスクの連鎖で届くため
    await act(async () => {
      await new Promise((resolve) => setTimeout(resolve, 0));
      await new Promise((resolve) => setTimeout(resolve, 0));
    });

    expect(screen.queryByText(FOLLOW_UP_ERROR_MESSAGE)).toBeNull();
    expect(screen.queryByRole('alert')).toBeNull();
  });

  it('対照: 同じ会話のまま投函が失敗すれば、今までどおり出る（切り替えていない）', async () => {
    let chatCalls = 0;
    stubFetch((url, init) => {
      const conversation = conversationRoutes(url);
      if (conversation !== undefined) return conversation;
      if (url.endsWith('/chat')) {
        chatCalls += 1;
        if (chatCalls === 1) {
          return sse([{ event: 'open', data: { conversationId: CONVERSATION_ID } }], {
            signal: init?.signal,
            keepOpen: true,
          });
        }
        return Promise.reject(new TypeError(FOLLOW_UP_ERROR_MESSAGE));
      }
      return undefined;
    });

    renderChat(`/chat/${CONVERSATION_ID}`);
    await typeAndSend('一つ目');
    expect(
      await screen.findByRole('button', { name: '受信をやめる（クローンのターンは止まらない）' }),
    ).toBeTruthy();

    await typeAndSend('二つ目');

    expect(await screen.findByText(FOLLOW_UP_ERROR_MESSAGE)).toBeTruthy();
  });
});
