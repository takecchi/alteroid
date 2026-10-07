// @vitest-environment jsdom
import { act, cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { createMemoryRouter, RouterProvider, useParams } from 'react-router';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import {
  findShownConversation,
  json,
  Providers,
  sse,
  storeTestBaseUrl,
  stubFetch,
} from '~/test-support';

import Chat from './chat';

const A = 'conv-3064-a';
const B = 'conv-3064-b';
const LONG = '大事な長い下書き';
const BOOM = '送信に失敗した（テスト用の文言、#3064）';

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
  if (url.includes(`/conversations/${A}`)) return json({ conversationId: A, messages: [] });
  if (url.includes(`/conversations/${B}`)) return json({ conversationId: B, messages: [] });
  if (url.includes('/approvals')) return json({ approvals: [] });
  if (url.includes('/conversations')) return json({ conversations: [], scanned: 0 });
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

async function box() {
  return (await screen.findByPlaceholderText(/クローンに話しかける/)) as HTMLTextAreaElement;
}

async function typeAndSend(text: string) {
  fireEvent.change(await box(), { target: { value: text } });
  fireEvent.click(screen.getByRole('button', { name: 'メッセージを送信' }));
}

function bubbleCount(text: string) {
  return screen.queryAllByText(text).filter((el) => el.tagName !== 'TEXTAREA').length;
}

describe('#3064: 送信が失敗したら書いた文を失わせない', () => {
  it('send が失敗 → 入力欄に文が戻り、吹き出しは外れ、再送で送り直せる', async () => {
    let calls = 0;
    stubFetch((url, init) => {
      const conversation = conversationRoutes(url);
      if (conversation !== undefined) return conversation;
      if (url.endsWith('/chat')) {
        calls += 1;
        if (calls === 1) return json({ error: BOOM }, 500);
        return sse([{ event: 'open', data: { conversationId: A } }], { signal: init?.signal });
      }
      return undefined;
    });

    renderChat(`/chat/${A}`);
    await typeAndSend(LONG);

    expect(await screen.findByText(BOOM)).toBeTruthy();
    // 戻るまで待つ: 入力欄へ戻すのは effect で失敗の表示より1描画遅れ、同期で読むと CI の負荷で '' を掴むため
    const restored = await box();
    await waitFor(() => expect(restored.value).toBe(LONG));
    expect(bubbleCount(LONG)).toBe(0);

    fireEvent.click(screen.getByRole('button', { name: '再送' }));
    await waitFor(() => expect(calls).toBe(2));
    await waitFor(() => expect(screen.queryByText(BOOM)).toBeNull());
    expect(bubbleCount(LONG)).toBeGreaterThan(0);
    expect((await box()).value).toBe('');
    expect(screen.queryByRole('button', { name: '再送' })).toBeNull();
  });

  it('followUp（受信中の追送）が失敗しても同じ', async () => {
    let calls = 0;
    stubFetch((url, init) => {
      const conversation = conversationRoutes(url);
      if (conversation !== undefined) return conversation;
      if (url.endsWith('/chat')) {
        calls += 1;
        if (calls === 1) {
          return sse([{ event: 'open', data: { conversationId: A } }], {
            signal: init?.signal,
            keepOpen: true,
          });
        }
        return Promise.reject(new TypeError(BOOM));
      }
      return undefined;
    });

    renderChat(`/chat/${A}`);
    await typeAndSend('一つ目');
    expect(
      await screen.findByRole('button', { name: '受信をやめる（クローンのターンは止まらない）' }),
    ).toBeTruthy();
    await typeAndSend(LONG);

    expect(await screen.findByText(BOOM)).toBeTruthy();
    // 戻るまで待つ: 入力欄へ戻すのは effect で失敗の表示より1描画遅れ、同期で読むと CI の負荷で '' を掴むため
    const restored = await box();
    await waitFor(() => expect(restored.value).toBe(LONG));
    expect(bubbleCount(LONG)).toBe(0);
    expect(screen.getByRole('button', { name: '再送' })).toBeTruthy();
  });

  it('失敗が届く前に新しく打ち始めていたら、その下書きを上書きしない（再送では送れる）', async () => {
    let rejectChat: (e: unknown) => void = () => undefined;
    let sent = 0;
    stubFetch((url, init) => {
      const conversation = conversationRoutes(url);
      if (conversation !== undefined) return conversation;
      if (url.endsWith('/chat')) {
        sent += 1;
        if (sent === 1) {
          return new Promise((resolve) => {
            rejectChat = () => resolve(json({ error: BOOM }, 500));
          });
        }
        return sse([{ event: 'open', data: { conversationId: A } }], { signal: init?.signal });
      }
      return undefined;
    });

    renderChat(`/chat/${A}`);
    await typeAndSend(LONG);
    fireEvent.change(await box(), { target: { value: '新しく打ち始めた' } });
    rejectChat(new TypeError(BOOM));

    expect(await screen.findByText(BOOM)).toBeTruthy();
    expect((await box()).value).toBe('新しく打ち始めた');
    expect(bubbleCount(LONG)).toBe(0);

    fireEvent.click(screen.getByRole('button', { name: '再送' }));
    await waitFor(() => expect(sent).toBe(2));
    expect(bubbleCount(LONG)).toBeGreaterThan(0);
    expect((await box()).value).toBe('新しく打ち始めた');
  });

  it('会話を切り替えた後に追送の失敗が届いたら、送った側（A）の下書きへ戻る', async () => {
    let rejectFollowUp: (e: unknown) => void = () => undefined;
    let calls = 0;
    stubFetch((url, init) => {
      const conversation = conversationRoutes(url);
      if (conversation !== undefined) return conversation;
      if (url.endsWith('/chat')) {
        calls += 1;
        if (calls === 1) {
          return sse([{ event: 'open', data: { conversationId: A } }], {
            signal: init?.signal,
            keepOpen: true,
          });
        }
        return new Promise((_, reject) => {
          rejectFollowUp = reject;
        });
      }
      return undefined;
    });

    const { router } = renderChat(`/chat/${A}`);
    await typeAndSend('一つ目');
    expect(
      await screen.findByRole('button', { name: '受信をやめる（クローンのターンは止まらない）' }),
    ).toBeTruthy();
    await typeAndSend(LONG);
    await router.navigate(`/chat/${B}`);
    expect(await findShownConversation(B)).toBeTruthy();
    await act(async () => {
      rejectFollowUp(new TypeError(BOOM));
    });

    expect((await box()).value).toBe('');
    expect(screen.queryByText(BOOM)).toBeNull();

    await router.navigate(`/chat/${A}`);
    expect(await findShownConversation(A)).toBeTruthy();
    expect(await screen.findByText(BOOM)).toBeTruthy();
    // 戻るまで待つ: 入力欄へ戻すのは effect で失敗の表示より1描画遅れ、同期で読むと CI の負荷で '' を掴むため
    const restored = await box();
    await waitFor(() => expect(restored.value).toBe(LONG));
    expect(bubbleCount(LONG)).toBe(0);
  });

  it('open の後の失敗（サーバが受け取った後）では戻さない', async () => {
    stubFetch((url, init) => {
      const conversation = conversationRoutes(url);
      if (conversation !== undefined) return conversation;
      if (url.endsWith('/chat')) {
        return sse(
          [
            { event: 'open', data: { conversationId: A } },
            { event: 'error', data: { type: 'error', message: BOOM } },
          ],
          { signal: init?.signal },
        );
      }
      return undefined;
    });
    renderChat(`/chat/${A}`);
    await typeAndSend(LONG);
    expect(await screen.findByText(BOOM)).toBeTruthy();
    expect((await box()).value).toBe('');
    expect(screen.queryByRole('button', { name: '再送' })).toBeNull();
  });
});
