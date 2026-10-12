// @vitest-environment jsdom
import { act, cleanup, fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import { createMemoryRouter, RouterProvider, useParams } from 'react-router';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { json, Providers, storeTestBaseUrl } from '~/test-support';

import Chat from './chat';

const A = 'conv-del-edit';
const KEY = (id: string) => `alteroid.editDraft:${id}`;

const ChatRoute = Chat as unknown as (props: {
  loaderData: { conversationId: string | undefined };
}) => React.ReactElement;

function Harness() {
  const params = useParams();
  return <ChatRoute loaderData={{ conversationId: params.conversationId }} />;
}

const DELETED = {
  conversationId: A,
  tombstoneId: 'tomb-1',
  deletedAt: '2026-10-08T00:00:00.000Z',
  hiddenCount: 1,
  attachmentsRemoved: 0,
  commitmentsRemoved: 0,
  queuedDropped: 0,
  approvalsLinked: 0,
  incomplete: [],
  remainsIn: [],
};

let originalFetch: typeof fetch;
beforeEach(() => {
  originalFetch = globalThis.fetch;
  localStorage.clear();
  sessionStorage.clear();
  storeTestBaseUrl();
  globalThis.fetch = (async (input: RequestInfo | URL, init?: RequestInit) => {
    const request = input instanceof Request ? input : null;
    const url = request?.url ?? (typeof input === 'string' ? input : String(input));
    const method = request?.method ?? init?.method ?? 'GET';
    if (method === 'DELETE' && url.endsWith(`/conversations/${A}`)) return json(DELETED);
    if (url.includes(`/conversations/${A}`)) {
      return json({
        conversationId: A,
        messages: [{ id: 'm1', at: '2026-08-20T00:00:00.000Z', role: 'inbound', text: '一つ目' }],
        scanned: 1,
        reachedStart: true,
        supersededCount: 0,
      });
    }
    if (url.includes('/approvals')) return json({ approvals: [] });
    if (url.includes('/conversations')) return json({ conversations: [], scanned: 0 });
    throw new TypeError(`Failed to fetch: ${url}`);
  }) as typeof fetch;
});
afterEach(() => {
  vi.useRealTimers();
  cleanup();
  globalThis.fetch = originalFetch;
});

describe('会話を削除したときの編集の書きかけ（#4571）', () => {
  it('消した会話の発言の編集の書きかけを sessionStorage に残さない', async () => {
    const router = createMemoryRouter([{ path: '/chat/:conversationId?', Component: Harness }], {
      initialEntries: [`/chat/${A}`],
    });
    render(
      <Providers>
        <RouterProvider router={router} />
      </Providers>,
    );
    await screen.findByText('一つ目');
    vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout'] });
    const row = screen.getByText('一つ目').closest('li') as HTMLElement;
    fireEvent.click(within(row).getByRole('button', { name: /^発言を編集/ }));
    fireEvent.change(
      screen.getByRole('textbox', { name: '発言を編集する下書き' }) as HTMLTextAreaElement,
      { target: { value: '直している秘密の本文' } },
    );
    act(() => {
      vi.advanceTimersByTime(1000);
    });
    vi.useRealTimers();
    expect(sessionStorage.getItem(KEY('m1'))).not.toBeNull();

    fireEvent.click(await screen.findByRole('button', { name: '会話を削除' }));
    fireEvent.click(await screen.findByRole('button', { name: '削除する' }));
    await waitFor(() => expect(router.state.location.pathname).toBe('/chat'));
    await screen.findByText(/会話を削除しました/);

    expect(sessionStorage.getItem(KEY('m1'))).toBeNull();

    // 間を置いて走る保存（保存待ちの写し）が、消した後で書き戻さない
    vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout'] });
    act(() => {
      vi.advanceTimersByTime(1000);
    });
    vi.useRealTimers();
    expect(sessionStorage.getItem(KEY('m1'))).toBeNull();
  });
});
