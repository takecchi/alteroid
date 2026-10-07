// @vitest-environment jsdom
/**
 * Issue #3766。新しい会話（`/chat`）の添付を上げているあいだに別の会話 B へ移ったら、
 * 上げ終えたあとも B にとどまる（直す前は、いま作られた新しい会話の画面へ移された）。
 *
 * アップロードは `fetch` の通り道で止め（`gate`）、止めているあいだに会話を移してから放す。
 * 実時間の待ちは使わない。
 */
import { File as NodeFile } from 'node:buffer';

import { act, cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { createMemoryRouter, RouterProvider, useParams } from 'react-router';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import {
  findShownConversation,
  json,
  Providers,
  sse,
  storeTestBaseUrl,
  stubFetch,
} from '~/test-support';

import Chat from './chat';

const NEW_ID = 'conv-3766-new';
const B = 'conv-3766-b';

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
  URL.createObjectURL = () => 'blob:fake';
  URL.revokeObjectURL = () => undefined;
});
afterEach(() => {
  cleanup();
  globalThis.fetch = originalFetch;
});

const META = {
  id: 'att-1',
  name: 'first.txt',
  mediaType: 'text/plain',
  size: 3,
  sha256: 'a'.repeat(64),
};

const nodeFile = (name: string) =>
  new NodeFile([new Uint8Array([1, 2, 3])], name, { type: 'text/plain' }) as unknown as File;

function choose(files: File[]) {
  const input = document.querySelector('input[type=file]') as HTMLInputElement;
  Object.defineProperty(input, 'files', { value: files, configurable: true });
  fireEvent.change(input);
}

describe('新しい会話の添付を上げているあいだに別の会話へ移ったら、移った先にとどまる（#3766）', () => {
  it('上げ終えても B の画面のまま。受信は張らず、B の入力欄にも触れない。送った発言は新しい会話として投函される', async () => {
    let release: () => void = () => undefined;
    const gate = new Promise<void>((resolve) => {
      release = resolve;
    });
    const stub = stubFetch((url, init) => {
      if (url.includes('/attachments?')) return json(META);
      if (url.endsWith('/chat')) {
        return sse(
          [
            { event: 'open', data: { conversationId: NEW_ID } },
            { event: 'text', data: { type: 'text', text: '返事' } },
            { event: 'done', data: { type: 'done' } },
          ],
          { signal: init?.signal },
        );
      }
      if (url.includes('/approvals')) return json({ approvals: [] });
      if (url.includes(`/conversations/${B}`)) return json({ conversationId: B, messages: [] });
      if (url.includes('/conversations')) return json({ conversations: [], scanned: 0 });
      return undefined;
    });
    const inner = globalThis.fetch;
    globalThis.fetch = (async (input: RequestInfo | URL, init?: RequestInit) => {
      if (input instanceof Request && input.url.includes('/attachments?')) await gate;
      return inner(input, init);
    }) as typeof fetch;

    const router = createMemoryRouter(
      [
        { path: '/chat', Component: Harness },
        { path: '/chat/:conversationId', Component: Harness },
      ],
      { initialEntries: ['/chat'] },
    );
    render(
      <Providers>
        <RouterProvider router={router} />
      </Providers>,
    );
    const textbox = await screen.findByPlaceholderText(/クローンに話しかける/);
    choose([nodeFile('first.txt')]);
    fireEvent.change(textbox, { target: { value: '新しい本文' } });
    fireEvent.click(await screen.findByRole('button', { name: 'メッセージを送信' }));
    await screen.findByRole('button', { name: '添付を上げている' });

    await act(async () => {
      await router.navigate(`/chat/${B}`);
    });
    expect(await findShownConversation(B)).toBeTruthy();
    // B の入力欄に書きかけを置く。上げ終えても触られない。
    fireEvent.change(screen.getByPlaceholderText(/クローンに話しかける/), {
      target: { value: 'B の書きかけ' },
    });

    await act(async () => {
      release();
    });
    const chatPosts = () =>
      stub.entries.filter((entry) => entry.url.endsWith('/chat') && entry.request !== undefined);
    await waitFor(() => expect(chatPosts()).toHaveLength(1));
    await act(async () => undefined);
    await act(async () => undefined);

    // 新しい会話として投函された（会話 id を付けない）。
    const body = (await chatPosts()[0]?.request?.clone().json()) as {
      conversationId?: string;
      text?: string;
    };
    expect(body.conversationId).toBeUndefined();
    expect(body.text).toBe('新しい本文');
    // B にとどまる。
    expect(router.state.location.pathname).toBe(`/chat/${B}`);
    // B の画面に「受信中」が立たない。
    expect(screen.queryByRole('button', { name: /受信をやめる/ })).toBeNull();
    // B の入力欄・応答の表示に触れない。
    expect((screen.getByPlaceholderText(/クローンに話しかける/) as HTMLTextAreaElement).value).toBe(
      'B の書きかけ',
    );
    expect(screen.queryByText('返事')).toBeNull();
  });
});
