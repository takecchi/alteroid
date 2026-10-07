// @vitest-environment jsdom
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

const A = 'conv-3249-a';
const B = 'conv-3249-b';

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

describe('送った添付は、会話を移っても元の会話の添えかけに戻らない（#3249）', () => {
  it('上げている最中に B へ移り、上げ終えてから A に戻っても first.txt は現れない', async () => {
    let release: () => void = () => undefined;
    const gate = new Promise<void>((resolve) => {
      release = resolve;
    });
    let chatPosted = 0;
    stubFetch((url, init) => {
      if (url.includes('/attachments?')) return json(META);
      if (url.endsWith('/chat')) {
        chatPosted += 1;
        return sse(
          [
            { event: 'open', data: { conversationId: A } },
            { event: 'done', data: { type: 'done' } },
          ],
          { signal: init?.signal },
        );
      }
      if (url.includes('/approvals')) return json({ approvals: [] });
      if (url.includes(`/conversations/${A}`)) return json({ conversationId: A, messages: [] });
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
      { initialEntries: [`/chat/${A}`] },
    );
    render(
      <Providers>
        <RouterProvider router={router} />
      </Providers>,
    );
    const textbox = await screen.findByPlaceholderText(/クローンに話しかける/);
    choose([nodeFile('first.txt')]);
    fireEvent.change(textbox, { target: { value: '本文' } });
    fireEvent.click(await screen.findByRole('button', { name: 'メッセージを送信' }));
    await screen.findByRole('button', { name: '添付を上げている' });

    // 移る操作は act の中で流し切る: B の受動 effect が放す前に走り終えていないと、上げ終えたストリームを止めて別の筋書きになるため
    await act(async () => {
      await router.navigate(`/chat/${B}`);
    });
    expect(await findShownConversation(B)).toBeTruthy();
    expect(screen.queryByRole('button', { name: 'first.txt を外す' })).toBeNull();

    await act(async () => {
      release();
    });
    await waitFor(() => expect(chatPosted).toBe(1));

    await act(async () => {
      await router.navigate(`/chat/${A}`);
    });
    expect(await findShownConversation(A)).toBeTruthy();
    await act(async () => undefined);
    expect(screen.queryByRole('button', { name: 'first.txt を外す' })).toBeNull();
  });
});
