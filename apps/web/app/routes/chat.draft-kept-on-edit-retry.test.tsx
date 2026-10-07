// @vitest-environment jsdom
import { cleanup, fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import { createMemoryRouter, RouterProvider, useParams } from 'react-router';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import { json, Providers, sse, storeTestBaseUrl, stubFetch } from '~/test-support';

import Chat from './chat';

const ID = 'conv-3391';

const ChatRoute = Chat as unknown as (props: {
  loaderData: { conversationId: string | undefined };
}) => React.ReactElement;

function Harness() {
  const params = useParams();
  return <ChatRoute loaderData={{ conversationId: params.conversationId }} />;
}

function renderChat() {
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

const history = (messages: unknown[]) => ({
  conversationId: ID,
  messages,
  scanned: messages.length,
  reachedStart: true,
  supersededCount: 0,
});

function route(messages: unknown[]) {
  return stubFetch((url, init) => {
    if (url.endsWith('/chat')) {
      return sse(
        [
          { event: 'open', data: { conversationId: ID } },
          { event: 'done', data: { type: 'done' } },
        ],
        { signal: init?.signal },
      );
    }
    if (url.includes('/approvals')) return json({ approvals: [] });
    if (url.includes(`/conversations/${ID}`)) return json(history(messages));
    if (url.includes('/conversations')) return json({ conversations: [], scanned: 0 });
    return undefined;
  });
}

const composer = () => screen.getByPlaceholderText(/クローンに話しかける/) as HTMLTextAreaElement;

describe('入力欄の書きかけは、入力欄の文を送らない送信で消えない（#3391）', () => {
  it('発言の編集を確定しても、入力欄の書きかけが残る', async () => {
    const stub = route([
      { id: 'm1', at: '2026-08-20T00:00:00.000Z', role: 'inbound', text: '元の文' },
      { id: 'm1r', at: '2026-08-20T00:00:01.000Z', role: 'outbound', text: '了解' },
    ]);
    renderChat();
    await screen.findByText('元の文');
    fireEvent.change(composer(), { target: { value: '別件の書きかけ' } });

    const row = within(screen.getByRole('list', { name: 'やりとり' }))
      .getByText('元の文')
      .closest('li') as HTMLElement;
    fireEvent.click(within(row).getByRole('button', { name: '発言を編集' }));
    const editor = await screen.findByRole('textbox', { name: '発言を編集する下書き' });
    fireEvent.change(editor, { target: { value: '直した文' } });
    fireEvent.keyDown(editor, { key: 'Enter', metaKey: true });

    await waitFor(() => expect(stub.entries.some((e) => e.url.endsWith('/chat'))).toBe(true));
    const body = await stub.entries
      .find((e) => e.url.endsWith('/chat'))
      ?.request?.clone()
      .json();
    expect(body).toMatchObject({ text: '直した文', supersedes: 'm1' });
    await waitFor(() =>
      expect(screen.queryByRole('textbox', { name: '発言を編集する下書き' })).toBeNull(),
    );
    expect(composer().value).toBe('別件の書きかけ');
  });

  it('失敗した返信の「もう一度送る」でも、入力欄の書きかけが残る', async () => {
    const stub = route([
      { id: 'm1', at: '2026-08-20T00:00:00.000Z', role: 'inbound', text: '前の発言' },
      {
        id: 'm1r',
        at: '2026-08-20T00:00:01.000Z',
        role: 'outbound',
        text: '失敗した',
        turnFailure: 'failed',
      },
    ]);
    renderChat();
    await screen.findByText('前の発言');
    fireEvent.change(composer(), { target: { value: '別件の書きかけ' } });

    fireEvent.click(await screen.findByRole('button', { name: 'もう一度送る' }));
    await waitFor(() => expect(stub.entries.some((e) => e.url.endsWith('/chat'))).toBe(true));
    const body = await stub.entries
      .find((e) => e.url.endsWith('/chat'))
      ?.request?.clone()
      .json();
    expect(body).toMatchObject({ text: '前の発言' });
    expect(composer().value).toBe('別件の書きかけ');
  });

  it('対照: 入力欄の文を送れば、入力欄は空になる', async () => {
    route([{ id: 'm1', at: '2026-08-20T00:00:00.000Z', role: 'inbound', text: '前の発言' }]);
    renderChat();
    await screen.findByText('前の発言');
    fireEvent.change(composer(), { target: { value: '送る文' } });
    fireEvent.click(screen.getByRole('button', { name: 'メッセージを送信' }));
    await waitFor(() => expect(composer().value).toBe(''));
  });
});
