// @vitest-environment jsdom
// ファイルは Node の File（node:buffer）で作る: jsdom の File は Node の Request の本文として読めないため
import { File as NodeFile } from 'node:buffer';

import { act, cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { createMemoryRouter, RouterProvider, useParams } from 'react-router';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import { loadChatDraft, loadPendingAttachmentsNote, saveChatDraft } from '@alteroid/logic';

import { json, Providers, storeTestBaseUrl } from '~/test-support';

import Chat from './chat';

const CONVERSATION_ID = 'conv-del-1';

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
      { path: '/approvals', Component: () => <p>承認の画面</p> },
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
  if (url.includes('/conversations/conv-keep')) {
    return json({ conversationId: 'conv-keep', messages: [] });
  }
  if (url.includes('/approvals')) return json({ approvals: [] });
  if (url.includes('/conversations')) return json({ conversations: [], scanned: 0 });
  return undefined;
}

const DELETED = {
  conversationId: CONVERSATION_ID,
  tombstoneId: 'tomb-1',
  deletedAt: '2026-10-08T00:00:00.000Z',
  hiddenCount: 12,
  attachmentsRemoved: 2,
  commitmentsRemoved: 1,
  queuedDropped: 0,
  approvalsLinked: 0,
  incomplete: [],
  remainsIn: ['クローンの SDK セッションの生ログ', '蒸留済みの記憶・日報'],
};

// DELETE と GET が同じ URL を使うので、`stubFetch`（URL だけで振り分ける）では書けない。openapi-fetch は `Request` を渡してくる
function stubDaemon(onDelete: () => Response): { deletes: number } {
  const seen = { deletes: 0 };
  globalThis.fetch = (async (input: RequestInfo | URL, init?: RequestInit) => {
    const request = input instanceof Request ? input : null;
    const url = request?.url ?? (typeof input === 'string' ? input : String(input));
    const method = request?.method ?? init?.method ?? 'GET';
    if (method === 'DELETE' && url.endsWith(`/conversations/${CONVERSATION_ID}`)) {
      seen.deletes += 1;
      return onDelete();
    }
    const reply = conversationRoutes(url);
    if (reply === undefined) throw new TypeError(`Failed to fetch: ${url}`);
    return reply;
  }) as typeof fetch;
  return seen;
}

let originalFetch: typeof fetch;

beforeEach(() => {
  originalFetch = globalThis.fetch;
  localStorage.clear();
  sessionStorage.clear();
  storeTestBaseUrl();
});

afterEach(() => {
  cleanup();
  globalThis.fetch = originalFetch;
});

async function openConfirm() {
  fireEvent.click(await screen.findByRole('button', { name: '会話を削除' }));
}

describe('「会話を削除」ボタン', () => {
  it('確認の文に「読めなくなる・元に戻せない」を書く。やめるなら DELETE を呼ばない', async () => {
    const seen = stubDaemon(() => json(DELETED));
    const { router } = renderChat(`/chat/${CONVERSATION_ID}`);
    await openConfirm();

    expect(
      await screen.findByText(/どの画面・クローンからも読めなくなります。元に戻せません/),
    ).toBeTruthy();
    fireEvent.click(screen.getByRole('button', { name: 'やめる' }));
    await act(async () => {});

    expect(seen.deletes).toBe(0);
    expect(router.state.location.pathname).toBe(`/chat/${CONVERSATION_ID}`);
  });

  it('確認を経ると DELETE を呼び、/chat へ移り、結果（件数・remainsIn）が画面に残る。下書きも消える', async () => {
    saveChatDraft(CONVERSATION_ID, '書きかけ');
    const seen = stubDaemon(() => json(DELETED));
    const { router } = renderChat(`/chat/${CONVERSATION_ID}`);
    await openConfirm();
    fireEvent.click(await screen.findByRole('button', { name: '削除する' }));

    await waitFor(() => expect(router.state.location.pathname).toBe('/chat'));
    expect(seen.deletes).toBe(1);
    const notice = await screen.findByText(/会話を削除しました/);
    const text = notice.closest('[role="status"]')?.textContent ?? '';
    expect(text).toContain('発言 12 件');
    expect(text).toContain('添付 2 件');
    expect(text).toContain('台帳の約束 1 件');
    expect(text).toContain('クローンの SDK セッションの生ログ');
    expect(text).toContain('蒸留済みの記憶・日報');
    expect(text).not.toContain('終わっていません');
    expect(loadChatDraft(CONVERSATION_ID)).toBe('');
  });

  it('incomplete が空でないときは、後始末が終わっていないと出す', async () => {
    stubDaemon(() => json({ ...DELETED, incomplete: ['受信箱の未処理の発言を外せなかった'] }));
    renderChat(`/chat/${CONVERSATION_ID}`);
    await openConfirm();
    fireEvent.click(await screen.findByRole('button', { name: '削除する' }));

    const warning = await screen.findByText(/次の後始末が終わっていません/);
    expect(warning.closest('[role="status"]')?.textContent).toContain(
      '受信箱の未処理の発言を外せなかった',
    );
  });

  const nodeFile = (name: string) =>
    new NodeFile([new Uint8Array([1, 2, 3])], name, { type: 'text/plain' }) as unknown as File;
  function choose(files: File[]) {
    const input = document.querySelector('input[type=file]') as HTMLInputElement;
    Object.defineProperty(input, 'files', { value: files, configurable: true });
    fireEvent.change(input);
  }
  function unloadPrevented(): boolean {
    const event = new Event('beforeunload', { cancelable: true });
    window.dispatchEvent(event);
    return event.defaultPrevented;
  }

  it('添えかけのある会話を削除したら、離れる確認も控えも残さない（#4350）', async () => {
    stubDaemon(() => json(DELETED));
    const { router } = renderChat(`/chat/${CONVERSATION_ID}`);
    await screen.findByPlaceholderText(/クローンに話しかける/);
    act(() => choose([nodeFile('memo.txt')]));
    await screen.findByText('memo.txt');
    expect(unloadPrevented()).toBe(true);
    expect(loadPendingAttachmentsNote(CONVERSATION_ID)).toBeDefined();

    await openConfirm();
    fireEvent.click(await screen.findByRole('button', { name: '削除する' }));
    await waitFor(() => expect(router.state.location.pathname).toBe('/chat'));
    await screen.findByText(/会話を削除しました/);

    await waitFor(() => expect(unloadPrevented()).toBe(false));
    expect(loadPendingAttachmentsNote(CONVERSATION_ID)).toBeUndefined();
    act(() => {
      void router.navigate('/approvals');
    });
    await screen.findByText('承認の画面');
    expect(screen.queryByText('添えかけのファイルがあります')).toBeNull();
  });

  it('削除しなかった別の会話の添えかけは残る（#4350）', async () => {
    stubDaemon(() => json(DELETED));
    const { router } = renderChat('/chat/conv-keep');
    await screen.findByPlaceholderText(/クローンに話しかける/);
    act(() => choose([nodeFile('keep.txt')]));
    await screen.findByText('keep.txt');
    act(() => {
      void router.navigate(`/chat/${CONVERSATION_ID}`);
    });
    await waitFor(() => expect(router.state.location.pathname).toBe(`/chat/${CONVERSATION_ID}`));

    await openConfirm();
    fireEvent.click(await screen.findByRole('button', { name: '削除する' }));
    await waitFor(() => expect(router.state.location.pathname).toBe('/chat'));
    await screen.findByText(/会話を削除しました/);

    expect(unloadPrevented()).toBe(true);
    expect(loadPendingAttachmentsNote('conv-keep')).toBeDefined();
  });

  it('404 なら、その error を出し、/chat へは移らない', async () => {
    stubDaemon(() =>
      json({ error: '会話が無い: conv-del-1', code: 'conversation_not_found' }, 404),
    );
    const { router } = renderChat(`/chat/${CONVERSATION_ID}`);
    await openConfirm();
    fireEvent.click(await screen.findByRole('button', { name: '削除する' }));

    expect((await screen.findByRole('alert')).textContent).toContain('会話が無い: conv-del-1');
    expect(router.state.location.pathname).toBe(`/chat/${CONVERSATION_ID}`);
  });
});
