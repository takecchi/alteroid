// @vitest-environment jsdom
/**
 * 「会話を終える」ボタン（Issue #2171）。
 *
 * 直す前は `void endConversation(shownId).then(() => navigate('/chat'));`
 * だけで、`POST /chat/:conversationId/end` が失敗しても画面に何も出ず
 * （コンソールに unhandled rejection が残るだけ）、遷移もしなかった。押している
 * 間の `loading`/`disabled` も無いので二度押しで2回撃てた。
 *
 * ここで固定したいのは3つ（issue 本文の「直し方」どおり、`manager-detail.tsx`
 * の「停止する」・同じ画面の「ターンを止める」（`chat.interrupt.test.tsx`）と
 * 同じ形）:
 *
 * (a) 失敗を返すと `ErrorNote` が出て、`/chat` へは遷移しない
 * (b) 押している間はもう一度押せない（`disabled`）
 * (c) 成功すると `/chat` へ遷移する
 */
import { act, cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { createMemoryRouter, RouterProvider, useParams } from 'react-router';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import { json, Providers, storeTestBaseUrl, stubFetch, type Route } from '~/test-support';

import Chat from './chat';

const CONVERSATION_ID = 'conv-end-1';

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

/** `/approvals` はこの試験の対象ではない。未ハンドルのまま（`chat.interrupt.test.tsx` と同じ）。 */
function conversationRoutes(url: string) {
  if (url.includes(`/conversations/${CONVERSATION_ID}`)) {
    return json({ conversationId: CONVERSATION_ID, messages: [] });
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

async function findEndButton() {
  return screen.findByRole('button', { name: '会話を終える' });
}

/** 同期版。`waitFor` の中で使う（`disabled` が畳まれたかを見るため）。 */
function endButton() {
  return screen.getByRole('button', { name: '会話を終える' });
}

describe('「会話を終える」ボタン', () => {
  it('(a) 失敗すると ErrorNote に理由が出て、/chat へは遷移しない', async () => {
    stubFetch((url) => {
      const conversation = conversationRoutes(url);
      if (conversation !== undefined) return conversation;
      if (url.endsWith('/end')) return json({ error: '許可が無い' }, 403);
      return undefined;
    });

    const { router } = renderChat(`/chat/${CONVERSATION_ID}`);
    fireEvent.click(await findEndButton());

    expect(await screen.findByRole('alert')).toBeTruthy();
    expect(screen.getByRole('alert').textContent).toContain('許可が無い');
    // 遷移していない——URL は会話の画面のまま。
    expect(router.state.location.pathname).toBe(`/chat/${CONVERSATION_ID}`);
  });

  it('(b) 押している間はもう一度押せない（disabled）', async () => {
    let releaseEnd: () => void = () => {};
    const endReleased = new Promise<void>((resolve) => {
      releaseEnd = resolve;
    });
    const route: Route = (url) => {
      const conversation = conversationRoutes(url);
      if (conversation !== undefined) return conversation;
      if (url.endsWith('/end')) return endReleased.then(() => json({}));
      return undefined;
    };
    const stub = stubFetch(route);

    renderChat(`/chat/${CONVERSATION_ID}`);
    fireEvent.click(await findEndButton());

    await waitFor(() => {
      expect((endButton() as HTMLButtonElement).disabled).toBe(true);
    });

    // 押せない状態のまま、もう一度クリックしても2回目は飛ばない。
    fireEvent.click(endButton());
    await act(async () => {});
    const calls = stub.entries.filter((entry) => entry.url.endsWith('/end'));
    expect(calls).toHaveLength(1);

    releaseEnd();
    await waitFor(() => {
      expect(screen.queryByRole('button', { name: '会話を終える' })).toBeNull();
    });
  });

  it('(c) 成功すると /chat へ遷移する', async () => {
    stubFetch((url) => {
      const conversation = conversationRoutes(url);
      if (conversation !== undefined) return conversation;
      if (url.endsWith('/end')) return json({});
      return undefined;
    });

    const { router } = renderChat(`/chat/${CONVERSATION_ID}`);
    fireEvent.click(await findEndButton());

    await waitFor(() => {
      expect(router.state.location.pathname).toBe('/chat');
    });
  });
});
