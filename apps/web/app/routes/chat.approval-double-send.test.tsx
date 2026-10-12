// @vitest-environment jsdom
import { act, cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { createMemoryRouter, RouterProvider, useParams } from 'react-router';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import {
  findShownConversation,
  json,
  Providers,
  storeTestBaseUrl,
  stubFetch,
} from '~/test-support';

import Chat from './chat';

const A = 'conv-dbl-a';
const B = 'conv-dbl-b';
const PLACEHOLDER = /答える（書いておくと/;

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
  sessionStorage.clear();
  storeTestBaseUrl();
});
afterEach(() => {
  cleanup();
  globalThis.fetch = originalFetch;
});

const APPROVAL = {
  id: 'ap-1',
  createdAt: '2026-08-20T00:00:05.000Z',
  updatedAt: '2026-08-20T00:00:05.000Z',
  question: '本番に出してよいか',
};

describe('承認への回答の送信中に会話を移って戻っても、同じ承認へ二重に送らない（#4539）', () => {
  it('戻った後のカードは送信中のまま押せず、POST は1本だけ。応答が返れば押せる状態へ戻る', async () => {
    let release: () => void = () => undefined;
    const held = new Promise<void>((resolve) => {
      release = resolve;
    });
    // 回答の POST は openapi-fetch が Request を渡すので、init の method では見分けない
    const stub = stubFetch((url) => {
      if (url.includes('/approvals/ap-1/answer')) return held.then(() => json({ ok: true }));
      if (url.includes('/approvals')) return json({ approvals: url.includes(A) ? [APPROVAL] : [] });
      if (url.includes(`/conversations/${A}`)) {
        return json({ conversationId: A, messages: [], scanned: 0, reachedStart: true });
      }
      if (url.includes(`/conversations/${B}`)) {
        return json({ conversationId: B, messages: [], scanned: 0, reachedStart: true });
      }
      if (url.includes('/conversations')) return json({ conversations: [], scanned: 0 });
      return undefined;
    });
    const posts = () =>
      stub.entries.filter((entry) => entry.url.includes('/approvals/ap-1/answer')).length;
    // 実アプリと同じく1本の route（`chat/:conversationId?`）にする
    const router = createMemoryRouter([{ path: '/chat/:conversationId?', Component: Harness }], {
      initialEntries: [`/chat/${A}`],
    });
    render(
      <Providers>
        <RouterProvider router={router} />
      </Providers>,
    );
    const there = async (id: string) => {
      await router.navigate(`/chat/${id}`);
      expect(await findShownConversation(id)).toBeTruthy();
    };

    fireEvent.change(await screen.findByPlaceholderText(PLACEHOLDER), {
      target: { value: 'はい' },
    });
    fireEvent.click(await screen.findByRole('button', { name: /回答する/ }));
    await waitFor(() => expect(posts()).toBe(1));

    await there(B);
    await waitFor(() => expect(screen.queryByPlaceholderText(PLACEHOLDER)).toBeNull());
    await there(A);
    const back = (await screen.findByPlaceholderText(PLACEHOLDER)) as HTMLTextAreaElement;
    await act(async () => {});

    // 書いた答えは手元に残り、送信中なので押せない
    expect(back.value).toBe('はい');
    const again = screen.getByRole('button', { name: /回答する/ }) as HTMLButtonElement;
    expect(again.disabled).toBe(true);
    fireEvent.click(again);
    await act(async () => {});
    expect(posts()).toBe(1);

    // 応答が返ったら送信中は解ける（印が残り続けてカードを塞がない）
    await act(async () => {
      release();
      await held;
    });
    const field = (await screen.findByPlaceholderText(PLACEHOLDER)) as HTMLTextAreaElement;
    fireEvent.change(field, { target: { value: '追って補足' } });
    await waitFor(() =>
      expect((screen.getByRole('button', { name: /回答する/ }) as HTMLButtonElement).disabled).toBe(
        false,
      ),
    );
    expect(posts()).toBe(1);
  });
});
