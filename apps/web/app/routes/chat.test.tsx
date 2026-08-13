// @vitest-environment jsdom
/**
 * 新しい会話の**最初の応答が最後まで画面に残る**こと。
 *
 * 新しい会話の id は受信の途中（`open`）で決まり、そこで URL を揃える。ここで
 * 画面を作り直すと、その cleanup が同じリクエストを中断し、続く text / done が
 * 二度と届かない — しかも「静かに終わった」ようにしか見えない。
 */
import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { createMemoryRouter, RouterProvider, useParams } from 'react-router';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import { json, Providers, sse, stubFetch, storeTestBaseUrl } from '~/test-support';

import Chat from './chat';

const CONVERSATION_ID = 'conv-1';

/**
 * **本物の `Chat` を描く。**
 *
 * 直したのは `Chat` が `ChatPane` をどう置くか（`key` を付けない）なので、
 * `ChatPane` を自分で組み立てて試すと、まさに直した所を迂回してしまう。
 * framework mode が渡す `loaderData` だけを手で与える。
 */
const ChatRoute = Chat as unknown as (props: {
  loaderData: { conversationId: string | undefined };
}) => React.ReactElement;

function Harness() {
  const params = useParams();
  return <ChatRoute loaderData={{ conversationId: params.conversationId }} />;
}

function renderChat(initial = '/chat') {
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
  { event: 'thinking', data: { type: 'thinking' } },
  { event: 'text', data: { type: 'text', text: 'こんにちは' } },
  { event: 'text', data: { type: 'text', text: '、元気にやっている' } },
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
  fireEvent.click(screen.getByRole('button', { name: /送る/ }));
}

describe('新しい会話', () => {
  it('open で URL が変わっても、受信中のストリームが切れない', async () => {
    const stub = stubFetch((url, init) => {
      if (url.endsWith('/chat')) return sse(STREAM, { signal: init?.signal });
      if (url.includes('/conversations')) return json({ conversations: [], scanned: 0 });
      return undefined;
    });

    const { router } = renderChat();
    await send('やあ');

    // open の後に届いた分まで、全部同じ画面に残っている
    expect(await screen.findByText(/こんにちは、元気にやっている/)).toBeTruthy();
    // 自分の発言も消えていない
    expect(screen.getByText('やあ')).toBeTruthy();

    // URL は id へ揃っている
    await waitFor(() => {
      expect(router.state.location.pathname).toBe(`/chat/${CONVERSATION_ID}`);
    });

    // **履歴を読み直していない。** この画面で始めた会話は手元の内容が全文なので、
    // 日誌から再構成したものを重ねると同じ発言が二重に出る。
    expect(stub.calls.some((url) => url.includes(`/conversations/${CONVERSATION_ID}`))).toBe(false);
  });

  it('受信が終わると入力へ戻る（送信中のままにしない）', async () => {
    stubFetch((url, init) => {
      if (url.endsWith('/chat')) return sse(STREAM, { signal: init?.signal });
      if (url.includes('/conversations')) return json({ conversations: [], scanned: 0 });
      return undefined;
    });

    renderChat();
    await send('やあ');

    await screen.findByText(/こんにちは、元気にやっている/);
    await waitFor(() => {
      expect(screen.queryByRole('button', { name: /受信をやめる/ })).toBeNull();
    });
    expect(screen.getByRole('button', { name: /送る/ })).toBeTruthy();
  });
});

describe('受信をやめる', () => {
  /**
   * 人間が購読だけ止めたとき。
   *
   * クローンのターンは止まらないので「やめた」のは受信だけだが、**画面には
   * 止まったことが見えていなければならない**。進行中の合図が残ると、動いていない
   * ものを動いているように見せ続けることになる。
   */
  it('進行中の合図が消え、それまでの本文は残る', async () => {
    stubFetch((url, init) => {
      if (url.endsWith('/chat')) {
        return sse(
          [
            { event: 'open', data: { conversationId: CONVERSATION_ID } },
            { event: 'text', data: { type: 'text', text: 'ここまでは届いた' } },
            { event: 'thinking', data: { type: 'thinking' } },
          ],
          // まだ考えている（`done` を送らない）
          { keepOpen: true, signal: init?.signal },
        );
      }
      if (url.includes('/conversations')) return json({ conversations: [], scanned: 0 });
      return undefined;
    });

    renderChat();
    await send('やあ');

    expect(await screen.findByText('考えている…')).toBeTruthy();
    fireEvent.click(screen.getByRole('button', { name: /受信をやめる/ }));

    // ① 進行中の合図が消える
    await waitFor(() => {
      expect(screen.queryByText('考えている…')).toBeNull();
    });
    // ② 送信できる状態へ戻る
    expect(screen.getByRole('button', { name: /送る/ })).toBeTruthy();
    // ③ それまでに届いた本文は残る
    expect(screen.getByText('ここまでは届いた')).toBeTruthy();
    expect(screen.getByText('やあ')).toBeTruthy();
  });

  it('ツール実行中の表示でも同じ', async () => {
    stubFetch((url, init) => {
      if (url.endsWith('/chat')) {
        return sse(
          [
            { event: 'open', data: { conversationId: CONVERSATION_ID } },
            { event: 'tool', data: { type: 'tool', tool: 'manager_start' } },
          ],
          { keepOpen: true, signal: init?.signal },
        );
      }
      if (url.includes('/conversations')) return json({ conversations: [], scanned: 0 });
      return undefined;
    });

    renderChat();
    await send('やあ');

    expect(await screen.findByText(/manager_start を実行中/)).toBeTruthy();
    fireEvent.click(screen.getByRole('button', { name: /受信をやめる/ }));

    await waitFor(() => {
      expect(screen.queryByText(/manager_start を実行中/)).toBeNull();
    });
    expect(screen.getByRole('button', { name: /送る/ })).toBeTruthy();
  });
});

describe('会話の切り替え', () => {
  it('人間が別の会話を選んだら、前の会話の内容を捨てる', async () => {
    stubFetch((url, init) => {
      if (url.endsWith('/chat')) return sse(STREAM, { signal: init?.signal });
      if (url.includes('/conversations/other')) {
        return json({
          conversationId: 'other',
          messages: [{ id: 'm1', at: '2026-08-13T00:00:00Z', role: 'inbound', text: '別の会話' }],
        });
      }
      if (url.includes('/conversations')) return json({ conversations: [], scanned: 0 });
      return undefined;
    });

    const { router } = renderChat();
    await send('やあ');
    await screen.findByText(/こんにちは、元気にやっている/);

    // 自分が採番した id への同期ではなく、人間の切り替え
    await router.navigate('/chat/other');

    expect(await screen.findByText('別の会話')).toBeTruthy();
    await waitFor(() => {
      expect(screen.queryByText(/こんにちは、元気にやっている/)).toBeNull();
    });
  });
});
