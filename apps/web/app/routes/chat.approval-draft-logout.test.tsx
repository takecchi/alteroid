// @vitest-environment jsdom
/**
 * #3706。ログアウトで、承認カードの書きかけ（`alteroid.approvalDrafts`）も消す。メモリに残った書きかけを、
 * ログアウトの後にチャットの画面が書き戻さない（待っている書き込みにも epoch を掛ける）。
 * 承認の画面（`routes/approvals.tsx`）の書き込みも同じ。
 */
import { act, cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { createMemoryRouter, RouterProvider } from 'react-router';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import { loadApprovalDrafts, storeCredential } from '@alteroid/logic';

import { json, Providers, sse, storeTestBaseUrl, stubFetch } from '~/test-support';

import Approvals from './approvals';
import Chat from './chat';

const CONV = 'conv-3706';
const BASE = {
  id: 'ap-1',
  createdAt: '2026-10-06T00:00:05.000Z',
  updatedAt: '2026-10-06T00:00:05.000Z',
  question: '本番に出してよいか',
};

const ChatRoute = Chat as unknown as (props: {
  loaderData: { conversationId: string | undefined };
}) => React.ReactElement;

let originalFetch: typeof fetch;
let approvalsVersion = 0;
beforeEach(() => {
  originalFetch = globalThis.fetch;
  localStorage.clear();
  sessionStorage.clear();
  storeTestBaseUrl();
  approvalsVersion = 0;
  stubFetch((url, init) => {
    if (url.endsWith('/chat')) {
      return sse(
        [
          { event: 'open', data: { conversationId: CONV } },
          { event: 'done', data: { type: 'done' } },
        ],
        { signal: init?.signal },
      );
    }
    if (url.includes('/approvals')) {
      // 取り直すたびに別の応答（一覧の形が変わる）にして、保存の effect をもう一度走らせる。
      return json({ approvals: [{ ...BASE, question: `本番に出してよいか ${approvalsVersion}` }] });
    }
    if (url.includes(`/conversations/${CONV}`)) {
      return json({ conversationId: CONV, messages: [], scanned: 0, reachedStart: true });
    }
    if (url.includes('/conversations')) return json({ conversations: [], scanned: 0 });
    return undefined;
  });
});
afterEach(() => {
  cleanup();
  globalThis.fetch = originalFetch;
});

function mountChat() {
  const router = createMemoryRouter(
    [
      {
        path: '/chat/:conversationId',
        Component: () => <ChatRoute loaderData={{ conversationId: CONV }} />,
      },
    ],
    { initialEntries: [`/chat/${CONV}`] },
  );
  return render(
    <Providers>
      <RouterProvider router={router} />
    </Providers>,
  );
}

describe('承認カードの書きかけはログアウトで消える（#3706）', () => {
  it('チャットの画面: ログアウトで消え、その後に書き戻らない（unmount でも）', async () => {
    const view = mountChat();
    fireEvent.change(await screen.findByPlaceholderText(/答える（書いておくと/), {
      target: { value: '前の人の回答' },
    });
    await waitFor(() => expect(loadApprovalDrafts().texts).toEqual({ 'ap-1': '前の人の回答' }));

    storeCredential('http://daemon.test', null);
    expect(sessionStorage.getItem('alteroid.approvalDrafts')).toBeNull();
    // 画面の state には書きかけが残っている。承認を取り直す（送信が終わると取り直す）と保存の effect が
    // 走り直すが、ログアウトの後なので書き戻さない。
    approvalsVersion = 1;
    fireEvent.change(screen.getByPlaceholderText(/クローンに話しかける/), {
      target: { value: 'x' },
    });
    fireEvent.click(screen.getByRole('button', { name: 'メッセージを送信' }));
    await screen.findByText(/本番に出してよいか 1/);
    await act(async () => {});
    view.unmount();
    expect(sessionStorage.getItem('alteroid.approvalDrafts')).toBeNull();
  });

  it('承認の画面: ログアウトの後は書き戻さない。ログアウト後に書き始めれば保存される', async () => {
    const router = createMemoryRouter([{ path: '/approvals', Component: Approvals }], {
      initialEntries: ['/approvals'],
    });
    render(
      <Providers>
        <RouterProvider router={router} />
      </Providers>,
    );
    const input = await screen.findByPlaceholderText(/答える/);
    fireEvent.change(input, { target: { value: '承認の画面の書きかけ' } });
    await waitFor(() =>
      expect(loadApprovalDrafts().texts).toEqual({ 'ap-1': '承認の画面の書きかけ' }),
    );
    storeCredential('http://daemon.test', null);
    expect(sessionStorage.getItem('alteroid.approvalDrafts')).toBeNull();
    fireEvent.change(input, { target: { value: '次の人が書いた' } });
    await waitFor(() => expect(loadApprovalDrafts().texts).toEqual({ 'ap-1': '次の人が書いた' }));
  });
});
