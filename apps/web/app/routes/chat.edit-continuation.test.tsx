// @vitest-environment jsdom
/**
 * #3393。編集の確定が `open` の前に失敗して入力欄へ戻った文は、**編集の続き**のままである。
 * ⌘/Ctrl + Enter（いつもの送り方）でも `supersedes` 付きで送られ、その状態が見え、やめられる。
 */
import { cleanup, fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import { createMemoryRouter, RouterProvider, useParams } from 'react-router';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import { json, Providers, sse, storeTestBaseUrl, stubFetch } from '~/test-support';

import Chat from './chat';

const ID = 'conv-3393';

const ChatRoute = Chat as unknown as (props: {
  loaderData: { conversationId: string | undefined };
}) => React.ReactElement;

function Harness() {
  const params = useParams();
  return <ChatRoute loaderData={{ conversationId: params.conversationId }} />;
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

/** 最初の `POST /chat` は 500、以降は成功。 */
async function failEditOnce() {
  let posts = 0;
  const stub = stubFetch((url, init) => {
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
        messages: [{ id: 'm1', at: '2026-08-20T00:00:00.000Z', role: 'inbound', text: '元の文' }],
        scanned: 1,
        reachedStart: true,
        supersededCount: 0,
      });
    }
    if (url.includes('/conversations')) return json({ conversations: [], scanned: 0 });
    return undefined;
  });
  const router = createMemoryRouter(
    [
      { path: '/chat', Component: Harness },
      { path: '/chat/:conversationId', Component: Harness },
    ],
    { initialEntries: [`/chat/${ID}`] },
  );
  render(
    <Providers>
      <RouterProvider router={router} />
    </Providers>,
  );
  await screen.findByText('元の文');
  const row = within(screen.getByRole('list', { name: 'やりとり' }))
    .getByText('元の文')
    .closest('li') as HTMLElement;
  fireEvent.click(within(row).getByRole('button', { name: '発言を編集' }));
  const editor = await screen.findByRole('textbox', { name: '発言を編集する下書き' });
  fireEvent.change(editor, { target: { value: '直した文' } });
  fireEvent.keyDown(editor, { key: 'Enter', metaKey: true });
  await waitFor(() => expect(composer().value).toBe('直した文'));
  return stub;
}

const composer = () => screen.getByPlaceholderText(/クローンに話しかける/) as HTMLTextAreaElement;
const posted = async (stub: ReturnType<typeof stubFetch>, nth: number) =>
  stub.entries
    .filter((e) => e.url.endsWith('/chat'))
    [nth]?.request?.clone()
    .json();

describe('失敗して入力欄へ戻った編集は、編集の続きとして送る（#3393）', () => {
  it('戻った文には「編集の続き」の印が出て、⌘ + Enter で supersedes 付きで送られる', async () => {
    const stub = await failEditOnce();
    expect(screen.getByText(/発言の編集の続き/)).toBeTruthy();

    fireEvent.keyDown(composer(), { key: 'Enter', metaKey: true });
    await waitFor(() =>
      expect(stub.entries.filter((e) => e.url.endsWith('/chat'))).toHaveLength(2),
    );
    expect(await posted(stub, 1)).toMatchObject({ text: '直した文', supersedes: 'm1' });
    // 送れたら印は消える。
    await waitFor(() => expect(screen.queryByText(/発言の編集の続き/)).toBeNull());
  });

  it('戻った文をさらに直しても、編集のまま（新しい id で supersedes 付き）', async () => {
    const stub = await failEditOnce();
    fireEvent.change(composer(), { target: { value: '直し直した文' } });
    fireEvent.click(screen.getByRole('button', { name: 'メッセージを送信' }));
    await waitFor(() =>
      expect(stub.entries.filter((e) => e.url.endsWith('/chat'))).toHaveLength(2),
    );
    const first = await posted(stub, 0);
    const second = await posted(stub, 1);
    expect(second).toMatchObject({ text: '直し直した文', supersedes: 'm1' });
    expect(second.clientMessageId).not.toBe(first.clientMessageId);
  });

  it('「編集をやめる」で、文は残したまま新しい発言になる（supersedes なし・印は消える）', async () => {
    const stub = await failEditOnce();
    fireEvent.click(screen.getByRole('button', { name: '編集をやめる' }));
    expect(screen.queryByText(/発言の編集の続き/)).toBeNull();
    expect(composer().value).toBe('直した文');

    fireEvent.keyDown(composer(), { key: 'Enter', metaKey: true });
    await waitFor(() =>
      expect(stub.entries.filter((e) => e.url.endsWith('/chat'))).toHaveLength(2),
    );
    const second = await posted(stub, 1);
    expect(second.text).toBe('直した文');
    expect(second.supersedes).toBeUndefined();
  });
});
