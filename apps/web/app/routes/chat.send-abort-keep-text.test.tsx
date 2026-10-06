// @vitest-environment jsdom
/**
 * Issue #3121。`open` が届く前に送信が中断（「受信をやめる」・会話の切り替え）
 * されても、使い手が書いた文を黙って失わせない。ただし自動では送り直さない
 * （サーバが受け取っていれば二重になる）。
 *
 * - 文は入力欄へ戻り（空のときだけ）、吹き出しは外れる
 * - 「送れたか確かめられなかった」旨の表示に「再送」「破棄」が出る
 * - 切り替えて中断したら、送った側の会話へ戻り、切り替えた先には入らない
 * - 履歴に自分の `clientMessageId` を持つ人間の発言が現れたら、積んだ文と表示を自動で下ろす
 *   （同じ文でも別の id なら下ろさない。#3203。`chat.client-message-id.test.tsx`）
 */
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

const A = 'conv-3121-a';
const B = 'conv-3121-b';
const LONG = '大事な長い下書き';

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

let historyOfA: {
  id: string;
  at: string;
  role: string;
  text: string;
  clientMessageId?: string;
}[] = [];
let stub: ReturnType<typeof stubFetch>;

/** 最初の `POST /chat` に付いていた `clientMessageId`（openapi-fetch は `Request` で呼ぶ）。 */
async function firstPostedClientMessageId(): Promise<string> {
  const entry = stub.entries.find((e) => e.url.endsWith('/chat') && e.request !== undefined);
  const body = (await entry?.request?.clone().json()) as { clientMessageId?: string } | undefined;
  expect(body?.clientMessageId).toBeTruthy();
  return body?.clientMessageId as string;
}

/**
 * 1回目の `POST /chat` は `open` を返さず、中断（abort）されて初めて終わる。
 * 2回目以降（再送）は `open` まで返す。
 */
function stubAbortableSend(counter: { posts: number }) {
  stub = stubFetch((url, init) => {
    if (url.includes(`/conversations/${A}`)) {
      return json({ conversationId: A, messages: historyOfA });
    }
    if (url.includes(`/conversations/${B}`)) return json({ conversationId: B, messages: [] });
    if (url.includes('/approvals')) return json({ approvals: [] });
    if (url.includes('/conversations')) return json({ conversations: [], scanned: 0 });
    if (url.endsWith('/chat')) {
      counter.posts += 1;
      if (counter.posts === 1) {
        return new Promise((_, reject) => {
          init?.signal?.addEventListener('abort', () =>
            reject(new DOMException('aborted', 'AbortError')),
          );
        });
      }
      return sse([{ event: 'open', data: { conversationId: A } }], { signal: init?.signal });
    }
    return undefined;
  });
}

let originalFetch: typeof fetch;

beforeEach(() => {
  originalFetch = globalThis.fetch;
  localStorage.clear();
  storeTestBaseUrl();
  historyOfA = [];
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

/** 吹き出し（会話の流れの中）に同じ文があるか。入力欄の中身は数えない。 */
function bubbleCount(text: string) {
  return screen.queryAllByText(text).filter((el) => el.tagName !== 'TEXTAREA').length;
}

async function stopReceiving() {
  const stop = await screen.findByRole('button', { name: '受信をやめる' });
  await act(async () => {
    fireEvent.click(stop);
  });
}

describe('#3121: open の前に中断された送信は、書いた文を失わせない', () => {
  it('「受信をやめる」で中断 → 文が入力欄へ戻り、再送・破棄が出る。自動では送らない', async () => {
    const counter = { posts: 0 };
    stubAbortableSend(counter);
    renderChat(`/chat/${A}`);
    await typeAndSend(LONG);
    await waitFor(() => expect(counter.posts).toBe(1));
    await stopReceiving();

    await waitFor(async () => expect((await box()).value).toBe(LONG));
    expect(bubbleCount(LONG)).toBe(0);
    expect(screen.getByRole('button', { name: '再送' })).toBeTruthy();
    expect(screen.getByRole('button', { name: '破棄' })).toBeTruthy();
    expect(counter.posts).toBe(1);

    // 再送すれば同じ文が送られる。
    fireEvent.click(screen.getByRole('button', { name: '再送' }));
    await waitFor(() => expect(counter.posts).toBe(2));
    await waitFor(() => expect(screen.queryByRole('button', { name: '再送' })).toBeNull());
    expect(bubbleCount(LONG)).toBeGreaterThan(0);
    expect((await box()).value).toBe('');
  });

  it('中断後に新しく打ち始めていたら上書きしない（再送は文を持っている）', async () => {
    const counter = { posts: 0 };
    stubAbortableSend(counter);
    renderChat(`/chat/${A}`);
    await typeAndSend(LONG);
    await waitFor(() => expect(counter.posts).toBe(1));
    fireEvent.change(await box(), { target: { value: '新しく打ち始めた' } });
    await stopReceiving();

    const resend = await screen.findByRole('button', { name: '再送' });
    expect((await box()).value).toBe('新しく打ち始めた');
    expect(bubbleCount(LONG)).toBe(0);

    fireEvent.click(resend);
    await waitFor(() => expect(counter.posts).toBe(2));
    expect(bubbleCount(LONG)).toBeGreaterThan(0);
    expect((await box()).value).toBe('新しく打ち始めた');
  });

  it('「破棄」で積んだ文と表示を下ろす', async () => {
    const counter = { posts: 0 };
    stubAbortableSend(counter);
    renderChat(`/chat/${A}`);
    await typeAndSend(LONG);
    await waitFor(() => expect(counter.posts).toBe(1));
    await stopReceiving();

    fireEvent.click(await screen.findByRole('button', { name: '破棄' }));
    await waitFor(() => expect(screen.queryByRole('button', { name: '再送' })).toBeNull());
    expect((await box()).value).toBe('');
    expect(counter.posts).toBe(1);
  });

  it('会話を切り替えて中断 → 切り替えた先には入らず、元の会話へ戻ると戻る', async () => {
    const counter = { posts: 0 };
    stubAbortableSend(counter);
    const { router } = renderChat(`/chat/${A}`);
    await typeAndSend(LONG);
    await waitFor(() => expect(counter.posts).toBe(1));

    await router.navigate(`/chat/${B}`);
    expect(await findShownConversation(B)).toBeTruthy();
    // 中断の反映（state・effect）まで流し切ってから見る。
    await act(async () => {});

    expect((await box()).value).toBe('');
    expect(screen.queryByRole('button', { name: '再送' })).toBeNull();

    await router.navigate(`/chat/${A}`);
    expect(await findShownConversation(A)).toBeTruthy();
    expect(await screen.findByRole('button', { name: '再送' })).toBeTruthy();
    expect((await box()).value).toBe(LONG);
    expect(bubbleCount(LONG)).toBe(0);
    expect(counter.posts).toBe(1);
  });

  it('履歴に自分の clientMessageId を持つ発言が現れたら、積んだ文と表示を下ろす（手を入れていない入力欄も空にする）', async () => {
    const counter = { posts: 0 };
    stubAbortableSend(counter);
    const { router } = renderChat(`/chat/${A}`);
    await typeAndSend(LONG);
    await waitFor(() => expect(counter.posts).toBe(1));
    await router.navigate(`/chat/${B}`);
    expect(await findShownConversation(B)).toBeTruthy();
    await act(async () => {});

    // サーバは実は受け取っていた。次に A を開くと履歴に出る。
    historyOfA = [
      {
        id: 'm1',
        at: '2026-08-20T00:00:00Z',
        role: 'inbound',
        text: LONG,
        clientMessageId: await firstPostedClientMessageId(),
      },
    ];
    await router.navigate(`/chat/${A}`);
    expect(await findShownConversation(A)).toBeTruthy();
    await waitFor(() => expect(bubbleCount(LONG)).toBe(1));
    await waitFor(() => expect(screen.queryByRole('button', { name: '再送' })).toBeNull());
    expect((await box()).value).toBe('');
    expect(counter.posts).toBe(1);
  });

  it('履歴にもともと同じ文があっても、それだけでは下ろさない', async () => {
    historyOfA = [{ id: 'm0', at: '2026-08-19T00:00:00Z', role: 'inbound', text: LONG }];
    const counter = { posts: 0 };
    stubAbortableSend(counter);
    renderChat(`/chat/${A}`);
    expect(await findShownConversation(A)).toBeTruthy();
    await waitFor(() => expect(bubbleCount(LONG)).toBe(1));
    await typeAndSend(LONG);
    await waitFor(() => expect(counter.posts).toBe(1));
    await stopReceiving();

    expect(await screen.findByRole('button', { name: '再送' })).toBeTruthy();
    expect((await box()).value).toBe(LONG);
    expect(bubbleCount(LONG)).toBe(1);
  });
});
