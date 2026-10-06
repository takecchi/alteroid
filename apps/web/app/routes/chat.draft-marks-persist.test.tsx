// @vitest-environment jsdom
/**
 * #3708。入力欄へ戻した文の印（`unconfirmed`・`supersedes`・`clientMessageId`）も本文と一緒に
 * `sessionStorage` へ残す。再読み込みの後も「送れたか確かめられなかった」の案内と、同じ
 * `clientMessageId` での再送を出す。編集の続きは `supersedes` を保つ。古い形（印の鍵が無い本文だけの値）は
 * 今までどおり普通の下書きとして戻る。
 */
import { File as NodeFile } from 'node:buffer';

import { act, cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
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
/** 2回目以降の `POST /chat` の応答を差し替える（無ければ受け取られて終わる）。 */
let laterChat: ((n: number) => Response) | undefined;
/** 履歴（A）。 */
let history: unknown[] = [];
let stub: ReturnType<typeof stubFetch>;
beforeEach(() => {
  originalFetch = globalThis.fetch;
  localStorage.clear();
  sessionStorage.clear();
  storeTestBaseUrl();
  posts = 0;
  laterChat = undefined;
  history = [];
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
      if (laterChat !== undefined) return laterChat(posts);
      return sse(
        [
          { event: 'open', data: { conversationId: A } },
          { event: 'done', data: { type: 'done' } },
        ],
        { signal: init?.signal },
      );
    }
    if (url.includes('/attachments?')) {
      return json({
        id: 'att-1',
        name: 'mine.txt',
        mediaType: 'text/plain',
        size: 3,
        sha256: 'a'.repeat(64),
      });
    }
    if (url.includes('/approvals')) return json({ approvals: [] });
    if (url.includes(`/conversations/${A}`)) return json({ conversationId: A, messages: history });
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

const nodeFile = () =>
  new NodeFile([new Uint8Array([1, 2, 3])], 'mine.txt', { type: 'text/plain' }) as unknown as File;
const LOST = /添えていたファイル 1 件（mine\.txt）は、再読み込みで戻せなかった/;

/** 添付つきで送り、`open` の前に会話を切り替えて中断させ、再読み込みする。 */
async function abortWithAttachmentAndReload() {
  const first = renderChat(`/chat/${A}`);
  await box();
  const input = document.querySelector('input[type=file]') as HTMLInputElement;
  Object.defineProperty(input, 'files', { value: [nodeFile()], configurable: true });
  fireEvent.change(input);
  fireEvent.change(await box(), { target: { value: '添付つきの文' } });
  fireEvent.click(await screen.findByRole('button', { name: 'メッセージを送信' }));
  await waitFor(() => expect(posts).toBe(1));
  const firstId = (await sentBody(0)).clientMessageId as string;
  await first.router.navigate(`/chat/${B}`);
  expect(await findShownConversation(B)).toBeTruthy();
  await waitFor(() => expect(loadChatDraftMark(A)?.attachmentCount).toBe(1));
  first.view.unmount();
  cleanup();
  return firstId;
}

describe('添付つきだった印は、戻せなかったことを言う（#3708）', () => {
  it('件数と名前を印に残し、再読み込みの後に案内の隣へ出す。本文だけの再送は同じ id で1回だけ送る', async () => {
    const firstId = await abortWithAttachmentAndReload();
    expect(loadChatDraftMark(A)).toMatchObject({
      attachmentCount: 1,
      attachmentNames: ['mine.txt'],
    });
    renderChat(`/chat/${A}`);
    expect(await screen.findByText(NOTICE)).toBeTruthy();
    expect(await screen.findByText(LOST)).toBeTruthy();
    fireEvent.click(screen.getByRole('button', { name: '再送' }));
    await waitFor(() => expect(posts).toBe(2));
    const resent = await sentBody(1);
    expect(resent).toMatchObject({ text: '添付つきの文', clientMessageId: firstId });
    expect((resent as { attachments?: string[] }).attachments ?? []).toEqual([]);
    expect(posts).toBe(2);
  });

  it('元の送信が届いていた（履歴に同じ clientMessageId）なら、案内も再送も出さず、二重に送らない', async () => {
    const firstId = await abortWithAttachmentAndReload();
    history = [
      {
        id: 'm1',
        at: '2026-10-06T00:00:00Z',
        role: 'inbound',
        text: '添付つきの文',
        clientMessageId: firstId,
      },
    ];
    renderChat(`/chat/${A}`);
    await screen.findByText('添付つきの文');
    await waitFor(() => expect(screen.queryByRole('button', { name: '再送' })).toBeNull());
    expect(screen.queryByText(LOST)).toBeNull();
    expect(posts).toBe(1);
  });

  it('中身が違うと断られた（409）ときは、次の再送だけが新しい id で、全部で1通ずつ', async () => {
    const firstId = await abortWithAttachmentAndReload();
    laterChat = (n) =>
      n === 2
        ? json({ error: '中身が違う', code: 'client_message_id_mismatch' }, 409)
        : sse([
            { event: 'open', data: { conversationId: A } },
            { event: 'done', data: { type: 'done' } },
          ]);
    renderChat(`/chat/${A}`);
    fireEvent.click(await screen.findByRole('button', { name: '再送' }));
    expect(await screen.findByText('中身が違う')).toBeTruthy();
    expect(posts).toBe(2);
    fireEvent.click(await screen.findByRole('button', { name: '再送' }));
    await waitFor(() => expect(posts).toBe(3));
    const third = await sentBody(2);
    expect(third.clientMessageId).toBeTruthy();
    expect(third.clientMessageId).not.toBe(firstId);
    expect(third.text).toBe('添付つきの文');
    await act(async () => {});
    expect(posts).toBe(3);
  });

  it('古い形の印（件数の欄が無い）は、添付なしとして読む', async () => {
    sessionStorage.setItem(`alteroid.chatDraft:${A}`, '古い印');
    sessionStorage.setItem(
      `alteroid.chatDraftMark:${A}`,
      JSON.stringify({ v: 1, clientMessageId: 'cm-old', unconfirmed: true }),
    );
    renderChat(`/chat/${A}`);
    expect(await screen.findByText(NOTICE)).toBeTruthy();
    expect(document.querySelector('[data-lost-attachments]')).toBeNull();
    expect(loadChatDraftMark(A)?.attachmentCount).toBeUndefined();
  });
});
