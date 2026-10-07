// @vitest-environment jsdom
import { act, cleanup, fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import { createMemoryRouter, RouterProvider, useParams } from 'react-router';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { storeCredential } from '@alteroid/logic';

import { json, Providers, sse, storeTestBaseUrl, stubFetch } from '~/test-support';

import Chat from './chat';

const A = 'conv-3707';
const KEY = (id: string) => `alteroid.editDraft:${id}`;
const ATT = { id: 'att-1', name: 'a.png', mediaType: 'image/png', size: 4, sha256: 'a'.repeat(64) };

const ChatRoute = Chat as unknown as (props: {
  loaderData: { conversationId: string | undefined };
}) => React.ReactElement;

function Harness() {
  const params = useParams();
  return <ChatRoute loaderData={{ conversationId: params.conversationId }} />;
}

function renderChat() {
  const router = createMemoryRouter([{ path: '/chat/:conversationId', Component: Harness }], {
    initialEntries: [`/chat/${A}`],
  });
  return render(
    <Providers>
      <RouterProvider router={router} />
    </Providers>,
  );
}

let originalFetch: typeof fetch;
let stub: ReturnType<typeof stubFetch>;
beforeEach(() => {
  originalFetch = globalThis.fetch;
  localStorage.clear();
  sessionStorage.clear();
  storeTestBaseUrl();
  stub = stubFetch((url, init) => {
    if (url.endsWith('/chat')) {
      return sse(
        [
          { event: 'open', data: { conversationId: A } },
          { event: 'done', data: { type: 'done' } },
        ],
        { signal: init?.signal },
      );
    }
    if (url.includes('/approvals')) return json({ approvals: [] });
    if (url.includes(`/conversations/${A}`)) {
      return json({
        conversationId: A,
        messages: [
          { id: 'm1', at: '2026-08-20T00:00:00.000Z', role: 'inbound', text: '一つ目' },
          {
            id: 'm2',
            at: '2026-08-20T00:00:02.000Z',
            role: 'inbound',
            text: '二つ目',
            attachments: [ATT],
          },
        ],
        scanned: 2,
        reachedStart: true,
        supersededCount: 0,
      });
    }
    if (url.includes('/conversations')) return json({ conversations: [], scanned: 0 });
    return undefined;
  });
});
afterEach(() => {
  vi.useRealTimers();
  cleanup();
  globalThis.fetch = originalFetch;
});

const row = (text: string) =>
  within(screen.getByRole('list', { name: 'やりとり' }))
    .getByText(text)
    .closest('li') as HTMLElement;
const pencil = (text: string, name: RegExp = /^発言を編集/) =>
  within(row(text)).getByRole('button', { name });
const editor = () =>
  screen.queryByRole('textbox', { name: '発言を編集する下書き' }) as HTMLTextAreaElement | null;
const write = (value: string) =>
  fireEvent.change(editor() as HTMLTextAreaElement, { target: { value } });
const settle = () =>
  act(() => {
    vi.advanceTimersByTime(1000);
  });

describe('編集の書きかけを sessionStorage へ残す（#3707）', () => {
  it('間引いて書き、再読み込みの後は印が出て、鉛筆から書きかけを再開できる', async () => {
    const first = renderChat();
    await screen.findByText('一つ目');
    vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout'] });
    fireEvent.click(pencil('一つ目'));
    write('一つ目を直している');
    expect(sessionStorage.getItem(KEY('m1'))).toBeNull();
    settle();
    expect(JSON.parse(sessionStorage.getItem(KEY('m1')) ?? 'null')).toEqual({
      text: '一つ目を直している',
      attachments: [],
    });
    vi.useRealTimers();

    first.unmount();
    cleanup();
    renderChat();
    await screen.findByText('一つ目');
    expect(
      within(row('一つ目')).getByRole('button', { name: '発言を編集（書きかけあり）' }),
    ).toBeTruthy();
    fireEvent.click(pencil('一つ目'));
    expect(editor()?.value).toBe('一つ目を直している');
  });

  it('引き継ぐ添付の控えも残る。外した状態も残り、再読み込みの後に戻る', async () => {
    const first = renderChat();
    await screen.findByText('二つ目');
    vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout'] });
    fireEvent.click(pencil('二つ目'));
    write('添付つきを直す');
    fireEvent.click(screen.getByRole('button', { name: 'a.png を外す' }));
    settle();
    expect(JSON.parse(sessionStorage.getItem(KEY('m2')) ?? 'null')).toEqual({
      text: '添付つきを直す',
      attachments: [],
    });
    vi.useRealTimers();
    first.unmount();
    cleanup();
    renderChat();
    await screen.findByText('二つ目');
    fireEvent.click(pencil('二つ目', /発言を編集（書きかけあり）/));
    expect(editor()?.value).toBe('添付つきを直す');
    expect(screen.queryByRole('button', { name: 'a.png を外す' })).toBeNull();
  });

  it('元の本文と同じ（開いただけ・直して戻した）なら残さない', async () => {
    renderChat();
    await screen.findByText('一つ目');
    vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout'] });
    fireEvent.click(pencil('一つ目'));
    settle();
    expect(sessionStorage.getItem(KEY('m1'))).toBeNull();
    write('直した');
    settle();
    expect(sessionStorage.getItem(KEY('m1'))).not.toBeNull();
    write('一つ目');
    settle();
    expect(sessionStorage.getItem(KEY('m1'))).toBeNull();
  });

  it('pagehide では待たずに書く', async () => {
    renderChat();
    await screen.findByText('一つ目');
    vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout'] });
    fireEvent.click(pencil('一つ目'));
    write('タブが落ちる前');
    window.dispatchEvent(new Event('pagehide'));
    expect(JSON.parse(sessionStorage.getItem(KEY('m1')) ?? 'null').text).toBe('タブが落ちる前');
  });

  it('確定が通ったら（送った文が出て）書きかけは消える', async () => {
    renderChat();
    await screen.findByText('一つ目');
    vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout'] });
    fireEvent.click(pencil('一つ目'));
    write('確定する版');
    settle();
    expect(sessionStorage.getItem(KEY('m1'))).not.toBeNull();
    vi.useRealTimers();
    fireEvent.keyDown(editor() as HTMLTextAreaElement, { key: 'Enter', metaKey: true });
    await waitFor(() => expect(stub.entries.some((e) => e.url.endsWith('/chat'))).toBe(true));
    expect(sessionStorage.getItem(KEY('m1'))).toBeNull();
  });

  it('ログアウトで消える。書き出しの待ちの途中でログアウトしても書き戻らない', async () => {
    renderChat();
    await screen.findByText('一つ目');
    vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout'] });
    fireEvent.click(pencil('一つ目'));
    write('一つ目');
    write('ログアウト前の書きかけ');
    settle();
    expect(sessionStorage.getItem(KEY('m1'))).not.toBeNull();
    write('さらに打った');
    storeCredential('http://daemon.test', null);
    expect(sessionStorage.getItem(KEY('m1'))).toBeNull();
    settle();
    window.dispatchEvent(new Event('pagehide'));
    expect(sessionStorage.getItem(KEY('m1'))).toBeNull();
  });
});
