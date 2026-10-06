// @vitest-environment jsdom
/**
 * #3708。入力欄へ戻した文の印（`unconfirmed`・`supersedes`・`clientMessageId`）も本文と一緒に
 * `sessionStorage` へ残す。再読み込みの後も「送れたか確かめられなかった」の案内と、同じ
 * `clientMessageId` での再送を出す。編集の続きは `supersedes` を保つ。古い形（印の鍵が無い本文だけの値）は
 * 今までどおり普通の下書きとして戻る。
 */
import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { createMemoryRouter, RouterProvider, useParams } from 'react-router';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import { loadChatDraftMark } from '@alteroid/logic';

import {
  findShownConversation,
  json,
  Providers,
  sse,
  storeTestBaseUrl,
  stubFetch,
} from '~/test-support';

import Chat from './chat';

const A = 'conv-3708-a';
const B = 'conv-3708-b';

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
  const view = render(
    <Providers>
      <RouterProvider router={router} />
    </Providers>,
  );
  return { router, view };
}

let originalFetch: typeof fetch;
let posts = 0;
let stub: ReturnType<typeof stubFetch>;
beforeEach(() => {
  originalFetch = globalThis.fetch;
  localStorage.clear();
  sessionStorage.clear();
  storeTestBaseUrl();
  posts = 0;
  stub = stubFetch((url, init) => {
    if (url.endsWith('/chat')) {
      posts += 1;
      // 最初の送信は `open` の前に止まる（中断される）。2回目からは受け取られる。
      if (posts === 1) {
        return new Promise((_, reject) => {
          init?.signal?.addEventListener('abort', () =>
            reject(new DOMException('aborted', 'AbortError')),
          );
        });
      }
      return sse(
        [
          { event: 'open', data: { conversationId: A } },
          { event: 'done', data: { type: 'done' } },
        ],
        { signal: init?.signal },
      );
    }
    if (url.includes('/approvals')) return json({ approvals: [] });
    for (const id of [A, B]) {
      if (url.includes(`/conversations/${id}`)) {
        return json({ conversationId: id, messages: [], scanned: 0, reachedStart: true });
      }
    }
    if (url.includes('/conversations')) return json({ conversations: [], scanned: 0 });
    return undefined;
  });
});
afterEach(() => {
  cleanup();
  globalThis.fetch = originalFetch;
});

const box = () =>
  screen.findByPlaceholderText(/クローンに話しかける/) as Promise<HTMLTextAreaElement>;
const NOTICE = /送れたか確かめられなかった/;

async function sentBody(index: number) {
  const entries = stub.entries.filter((e) => e.url.endsWith('/chat') && e.request !== undefined);
  return (await entries[index]?.request?.clone().json()) as {
    text: string;
    clientMessageId?: string;
    supersedes?: string;
  };
}

describe('確かめられなかった送信の印を、再読み込みの後も出す（#3708）', () => {
  it('中断した文は本文と印を残し、再読み込みの後も同じ案内と同じ clientMessageId の再送を出す', async () => {
    const first = renderChat(`/chat/${A}`);
    fireEvent.change(await box(), { target: { value: '送れたか不明な文' } });
    fireEvent.click(screen.getByRole('button', { name: 'メッセージを送信' }));
    await waitFor(() => expect(posts).toBe(1));
    const firstId = (await sentBody(0)).clientMessageId;
    expect(firstId).toBeTruthy();
    // `open` の前に会話を切り替えて中断させる。見ていない会話のあいだに再読み込みされても残る。
    await first.router.navigate(`/chat/${B}`);
    expect(await findShownConversation(B)).toBeTruthy();
    await waitFor(() => expect(loadChatDraftMark(A)?.clientMessageId).toBe(firstId));
    expect(sessionStorage.getItem(`alteroid.chatDraft:${A}`)).toBe('送れたか不明な文');

    first.view.unmount();
    cleanup();
    renderChat(`/chat/${A}`);
    expect((await box()).value).toBe('送れたか不明な文');
    expect(await screen.findByText(NOTICE)).toBeTruthy();
    fireEvent.click(screen.getByRole('button', { name: '再送' }));
    await waitFor(() => expect(posts).toBe(2));
    expect(await sentBody(1)).toMatchObject({
      text: '送れたか不明な文',
      clientMessageId: firstId,
    });
  });

  it('破棄すると、本文も印も消える（再読み込みで復元されない）', async () => {
    sessionStorage.setItem(`alteroid.chatDraft:${A}`, '確かめられなかった');
    sessionStorage.setItem(
      `alteroid.chatDraftMark:${A}`,
      JSON.stringify({ v: 1, clientMessageId: 'cm-1', unconfirmed: true }),
    );
    renderChat(`/chat/${A}`);
    expect(await screen.findByText(NOTICE)).toBeTruthy();
    fireEvent.click(screen.getByRole('button', { name: '破棄' }));
    await waitFor(() => expect(screen.queryByText(NOTICE)).toBeNull());
    expect(loadChatDraftMark(A)).toBeUndefined();
    expect((await box()).value).toBe('');
  });

  it('編集の続きは、再読み込みの後も supersedes を保って送る', async () => {
    sessionStorage.setItem(`alteroid.chatDraft:${A}`, '直した版');
    sessionStorage.setItem(
      `alteroid.chatDraftMark:${A}`,
      JSON.stringify({ v: 1, clientMessageId: 'cm-edit', supersedes: 'm-old' }),
    );
    renderChat(`/chat/${A}`);
    expect((await box()).value).toBe('直した版');
    await waitFor(() =>
      expect(screen.getByRole('button', { name: 'メッセージを送信' })).toBeTruthy(),
    );
    fireEvent.click(screen.getByRole('button', { name: 'メッセージを送信' }));
    await waitFor(() => expect(posts).toBe(1));
    expect(await sentBody(0)).toMatchObject({ text: '直した版', supersedes: 'm-old' });
  });

  it('古い形（本文だけで印の鍵が無い）や、壊れた印は、普通の下書きとして戻る', async () => {
    sessionStorage.setItem(`alteroid.chatDraft:${A}`, '古い形の下書き');
    sessionStorage.setItem(`alteroid.chatDraftMark:${B}`, '{壊れた');
    renderChat(`/chat/${A}`);
    expect((await box()).value).toBe('古い形の下書き');
    expect(screen.queryByText(NOTICE)).toBeNull();
  });

  it('本文が無い（空にした）なら印だけでは復元せず、印も消す', async () => {
    sessionStorage.setItem(
      `alteroid.chatDraftMark:${A}`,
      JSON.stringify({ v: 1, clientMessageId: 'cm-1', unconfirmed: true }),
    );
    renderChat(`/chat/${A}`);
    await box();
    await waitFor(() => expect(loadChatDraftMark(A)).toBeUndefined());
    expect(screen.queryByText(NOTICE)).toBeNull();
  });
});
