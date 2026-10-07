// @vitest-environment jsdom
import { act, cleanup, fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import { createMemoryRouter, RouterProvider, useParams } from 'react-router';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import { json, Providers, sse, storeTestBaseUrl, stubFetch } from '~/test-support';

import Chat from './chat';

const A = 'conv-3565-a';
const B = 'conv-3565-b';

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
  render(
    <Providers>
      <RouterProvider router={router} />
    </Providers>,
  );
  return router;
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

const body = (id: string, messages: unknown[]) => ({
  conversationId: id,
  messages,
  scanned: messages.length,
  reachedStart: true,
  supersededCount: 0,
});

const human = (id: string, text: string, at: string) => ({ id, at, role: 'inbound', text });

function route(
  extra?: (url: string, init?: RequestInit) => Response | Promise<Response> | undefined,
) {
  return stubFetch((url, init) => {
    const custom = extra?.(url, init);
    if (custom !== undefined) return custom;
    if (url.includes('/approvals')) return json({ approvals: [] });
    if (url.includes(`/conversations/${A}`)) {
      return json(
        body(A, [
          human('m1', '一つ目', '2026-08-20T00:00:00.000Z'),
          human('m2', '二つ目', '2026-08-20T00:00:02.000Z'),
        ]),
      );
    }
    if (url.includes(`/conversations/${B}`)) {
      return json(body(B, [human('b1', '別の会話', '2026-08-20T00:00:00.000Z')]));
    }
    if (url.includes('/conversations')) return json({ conversations: [], scanned: 0 });
    return undefined;
  });
}

const row = (text: string) =>
  within(screen.getByRole('list', { name: 'やりとり' }))
    .getByText(text)
    .closest('li') as HTMLElement;
const pencil = (text: string) => within(row(text)).getByRole('button', { name: /^発言を編集/ });
const editor = () =>
  screen.queryByRole('textbox', { name: '発言を編集する下書き' }) as HTMLTextAreaElement | null;
const write = (value: string) =>
  fireEvent.change(editor() as HTMLTextAreaElement, { target: { value } });

describe('発言の編集の書きかけは発言ごとに持つ（#3565）', () => {
  it('Escape で閉じても、鉛筆をもう一度押すと書きかけから再開する', async () => {
    route();
    renderChat(`/chat/${A}`);
    await screen.findByText('一つ目');
    fireEvent.click(pencil('一つ目'));
    write('一つ目を直している');
    fireEvent.keyDown(editor() as HTMLTextAreaElement, { key: 'Escape' });
    expect(editor()).toBeNull();
    fireEvent.click(pencil('一つ目'));
    expect(editor()?.value).toBe('一つ目を直している');
  });

  it('「キャンセル」で閉じても残る', async () => {
    route();
    renderChat(`/chat/${A}`);
    await screen.findByText('一つ目');
    fireEvent.click(pencil('一つ目'));
    write('途中');
    fireEvent.click(screen.getByRole('button', { name: /キャンセル/ }));
    expect(editor()).toBeNull();
    fireEvent.click(pencil('一つ目'));
    expect(editor()?.value).toBe('途中');
  });

  it('別の発言の鉛筆を押しても、先の書きかけは上書きされず、戻れば再開する', async () => {
    route();
    renderChat(`/chat/${A}`);
    await screen.findByText('二つ目');
    fireEvent.click(pencil('一つ目'));
    write('一つ目の書きかけ');
    fireEvent.click(pencil('二つ目'));
    expect(editor()?.value).toBe('二つ目');
    fireEvent.click(pencil('一つ目'));
    expect(editor()?.value).toBe('一つ目の書きかけ');
    fireEvent.keyDown(editor() as HTMLTextAreaElement, { key: 'Escape' });
    fireEvent.click(pencil('二つ目'));
    expect(editor()?.value).toBe('二つ目');
  });

  it('会話を切り替えて戻っても残る', async () => {
    route();
    const router = renderChat(`/chat/${A}`);
    await screen.findByText('一つ目');
    fireEvent.click(pencil('一つ目'));
    write('切り替え前の書きかけ');
    await act(async () => {
      await router.navigate(`/chat/${B}`);
    });
    await screen.findByText('別の会話');
    expect(editor()).toBeNull();
    await act(async () => {
      await router.navigate(`/chat/${A}`);
    });
    await screen.findByText('一つ目');
    fireEvent.click(pencil('一つ目'));
    expect(editor()?.value).toBe('切り替え前の書きかけ');
  });

  it('書きかけのある発言にだけ印が出る。開いただけ・元のままに戻した発言には出ない', async () => {
    route();
    renderChat(`/chat/${A}`);
    await screen.findByText('一つ目');
    fireEvent.click(pencil('一つ目'));
    write('直した');
    fireEvent.keyDown(editor() as HTMLTextAreaElement, { key: 'Escape' });
    expect(
      within(row('一つ目')).getByRole('button', { name: '発言を編集（書きかけあり）' }),
    ).toBeTruthy();
    expect(within(row('二つ目')).getByRole('button', { name: '発言を編集' })).toBeTruthy();

    fireEvent.click(pencil('二つ目'));
    fireEvent.keyDown(editor() as HTMLTextAreaElement, { key: 'Escape' });
    expect(within(row('二つ目')).getByRole('button', { name: '発言を編集' })).toBeTruthy();

    fireEvent.click(pencil('一つ目'));
    write('一つ目');
    fireEvent.keyDown(editor() as HTMLTextAreaElement, { key: 'Escape' });
    expect(within(row('一つ目')).getByRole('button', { name: '発言を編集' })).toBeTruthy();
  });

  it('再開した書きかけを確定すると、その文が supersedes 付きで送られ、書きかけは消える', async () => {
    const stub = route((url, init) =>
      url.endsWith('/chat')
        ? sse(
            [
              { event: 'open', data: { conversationId: A } },
              { event: 'done', data: { type: 'done' } },
            ],
            { signal: init?.signal },
          )
        : undefined,
    );
    renderChat(`/chat/${A}`);
    await screen.findByText('一つ目');
    fireEvent.click(pencil('一つ目'));
    write('直した一つ目');
    fireEvent.keyDown(editor() as HTMLTextAreaElement, { key: 'Escape' });
    fireEvent.click(pencil('一つ目'));
    fireEvent.keyDown(editor() as HTMLTextAreaElement, { key: 'Enter', metaKey: true });
    await waitFor(() => expect(stub.entries.some((e) => e.url.endsWith('/chat'))).toBe(true));
    const sent = await stub.entries
      .find((e) => e.url.endsWith('/chat'))
      ?.request?.clone()
      .json();
    expect(sent).toMatchObject({ text: '直した一つ目', supersedes: 'm1' });
    await waitFor(() => expect(editor()).toBeNull());
    expect(within(row('二つ目')).queryByRole('button', { name: /書きかけあり/ })).toBeNull();
  });
});

describe('やりとり欄のライブ領域（#3568）', () => {
  it('role=status は常にあり、受信を始めたときと返信が終わったときだけ読み上げる', async () => {
    route((url, init) =>
      url.endsWith('/chat')
        ? sse(
            [
              { event: 'open', data: { conversationId: A } },
              { event: 'text', data: { type: 'text', text: '返' } },
              { event: 'text', data: { type: 'text', text: '事' } },
              { event: 'done', data: { type: 'done' } },
            ],
            { signal: init?.signal },
          )
        : undefined,
    );
    renderChat(`/chat/${A}`);
    await screen.findByText('一つ目');
    const status = screen
      .getAllByRole('status')
      .find((el) => el.classList.contains('sr-only')) as HTMLElement;
    expect(status.textContent).toBe('');
    fireEvent.change(screen.getByPlaceholderText(/クローンに話しかける/), {
      target: { value: 'こんにちは' },
    });
    fireEvent.click(screen.getByRole('button', { name: 'メッセージを送信' }));
    await waitFor(() => expect(status.textContent).toBe('返信が終わった'));
    expect(status.textContent).not.toContain('返事');
  });

  it('失敗では「返信が終わった」と言わない', async () => {
    route((url, init) =>
      url.endsWith('/chat')
        ? sse(
            [
              { event: 'open', data: { conversationId: A } },
              { event: 'error', data: { type: 'error', message: 'だめだった', kind: 'other' } },
            ],
            { signal: init?.signal },
          )
        : undefined,
    );
    renderChat(`/chat/${A}`);
    await screen.findByText('一つ目');
    const status = screen
      .getAllByRole('status')
      .find((el) => el.classList.contains('sr-only')) as HTMLElement;
    fireEvent.change(screen.getByPlaceholderText(/クローンに話しかける/), {
      target: { value: 'こんにちは' },
    });
    fireEvent.click(screen.getByRole('button', { name: 'メッセージを送信' }));
    await screen.findAllByRole('alert');
    expect(status.textContent).toBe('');
  });
});
