// @vitest-environment jsdom
import { cleanup, fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import { createMemoryRouter, RouterProvider, useParams } from 'react-router';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import { loadChatDraftMark } from '@alteroid/logic';

import { json, Providers, sse, storeTestBaseUrl, stubFetch } from '~/test-support';

import Chat from './chat';

const ID = 'conv-4069';
const ATT = {
  id: 'att-1',
  name: 'table.csv',
  mediaType: 'text/csv',
  size: 4,
  sha256: 'a'.repeat(64),
};

const ChatRoute = Chat as unknown as (props: {
  loaderData: { conversationId: string | undefined };
}) => React.ReactElement;

function Harness() {
  const params = useParams();
  return <ChatRoute loaderData={{ conversationId: params.conversationId }} />;
}

function renderChat() {
  const router = createMemoryRouter([{ path: '/chat/:conversationId', Component: Harness }], {
    initialEntries: [`/chat/${ID}`],
  });
  return render(
    <Providers>
      <RouterProvider router={router} />
    </Providers>,
  );
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
      if (posts === 1) return json({ error: 'boom' }, 500);
      return sse(
        [
          { event: 'open', data: { conversationId: ID } },
          { event: 'done', data: { type: 'done' } },
        ],
        { signal: init?.signal },
      );
    }
    if (url.includes('/approvals')) return json({ approvals: [] });
    if (url.includes(`/conversations/${ID}`)) {
      return json({
        conversationId: ID,
        messages: [
          {
            id: 'm1',
            at: '2026-08-20T00:00:00.000Z',
            role: 'inbound',
            text: '合計を出して',
            attachments: [ATT],
          },
        ],
        scanned: 1,
        reachedStart: true,
        supersededCount: 0,
      });
    }
    if (url.includes('/conversations')) return json({ conversations: [], scanned: 0 });
    return undefined;
  });
});
afterEach(() => {
  cleanup();
  globalThis.fetch = originalFetch;
});

const composer = () =>
  screen.findByPlaceholderText(/クローンに話しかける/) as Promise<HTMLTextAreaElement>;
const posted = async (nth: number) =>
  (await stub.entries
    .filter((e) => e.url.endsWith('/chat'))
    [nth]?.request?.clone()
    .json()) as { text: string; supersedes?: string; attachments?: string[] };

async function failEditAndReload() {
  const first = renderChat();
  await screen.findByText('合計を出して');
  const row = within(screen.getByRole('list', { name: 'やりとり' }))
    .getByText('合計を出して')
    .closest('li') as HTMLElement;
  fireEvent.click(within(row).getByRole('button', { name: '発言を編集' }));
  const editor = await screen.findByRole('textbox', { name: '発言を編集する下書き' });
  fireEvent.change(editor, { target: { value: '合計を出して。税込で' } });
  fireEvent.keyDown(editor, { key: 'Enter', metaKey: true });
  await waitFor(async () => expect((await composer()).value).toBe('合計を出して。税込で'));
  await waitFor(() => expect(loadChatDraftMark(ID)?.supersedes).toBe('m1'));
  first.unmount();
  cleanup();
}

describe('添付つきの編集の送信が失敗した後の再読み込み（#4069）', () => {
  it('引き継いだ元の添付は印に残り、再読み込みの後も添付のまま supersedes つきで送る', async () => {
    await failEditAndReload();
    renderChat();
    expect((await composer()).value).toBe('合計を出して。税込で');
    expect(screen.getByText(/発言の編集の続き/)).toBeTruthy();
    fireEvent.click(await screen.findByRole('button', { name: 'メッセージを送信' }));
    await waitFor(() => expect(posts).toBe(2));
    expect(await posted(1)).toMatchObject({
      text: '合計を出して。税込で',
      supersedes: 'm1',
      attachments: [ATT.id],
    });
    expect(document.querySelector('[data-lost-attachments]')).toBeNull();
  });

  it('戻せなかった添付（実体を失った分）は、編集の続きでも名前を挙げて案内する', async () => {
    sessionStorage.setItem(`alteroid.chatDraft:${ID}`, '直した版');
    sessionStorage.setItem(
      `alteroid.chatDraftMark:${ID}`,
      JSON.stringify({
        v: 1,
        clientMessageId: 'cm-edit',
        supersedes: 'm1',
        attachmentCount: 1,
        attachmentNames: ['added.png'],
      }),
    );
    renderChat();
    expect((await composer()).value).toBe('直した版');
    const note = await waitFor(() => {
      const found = document.querySelector('[data-lost-attachments]');
      expect(found).not.toBeNull();
      return found as HTMLElement;
    });
    expect(note.textContent).toContain('added.png');
  });
});
