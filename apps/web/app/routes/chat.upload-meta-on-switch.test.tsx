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

const A = 'conv-4057-a';
const B = 'conv-4057-b';

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

const metaOf = (id: string, name: string) => ({
  id,
  name,
  mediaType: 'text/plain',
  size: 3,
  sha256: 'a'.repeat(64),
});

const nodeFile = (name: string) =>
  new NodeFile([new Uint8Array([1, 2, 3])], name, { type: 'text/plain' }) as unknown as File;

function choose(files: File[]) {
  const input = document.querySelector('input[type=file]') as HTMLInputElement;
  Object.defineProperty(input, 'files', { value: files, configurable: true });
  fireEvent.change(input);
}

describe('上げ終えた添付の印は、会話を移っても元の会話の添えかけに戻る（#4057）', () => {
  it('1つ目を上げている最中に B へ移り、1つ目が上がった後に2つ目が失敗しても、A へ戻って送り直すと上げ直すのは2つ目だけ', async () => {
    let release: () => void = () => undefined;
    const gate = new Promise<void>((resolve) => {
      release = resolve;
    });
    const uploadedNames: string[] = [];
    let uploadCalls = 0;
    stubFetch((url) => {
      if (url.includes('/attachments?')) {
        const name = decodeURIComponent(/name=([^&]*)/.exec(url)?.[1] ?? '');
        if (uploadCalls === 2) return new Response('boom', { status: 500 });
        return json(metaOf(`att-${uploadCalls}`, name));
      }
      if (url.endsWith('/chat')) {
        return sse([
          { event: 'open', data: { conversationId: A } },
          { event: 'done', data: { type: 'done' } },
        ]);
      }
      if (url.includes('/approvals')) return json({ approvals: [] });
      if (url.includes(`/conversations/${A}`)) return json({ conversationId: A, messages: [] });
      if (url.includes(`/conversations/${B}`)) return json({ conversationId: B, messages: [] });
      if (url.includes('/conversations')) return json({ conversations: [], scanned: 0 });
      return undefined;
    });
    const inner = globalThis.fetch;
    globalThis.fetch = (async (input: RequestInfo | URL, init?: RequestInit) => {
      // 2つ目の上げだけを、使い手が B へ移るまで止めておく。
      if (input instanceof Request && input.url.includes('/attachments?')) {
        uploadCalls += 1;
        uploadedNames.push(decodeURIComponent(/name=([^&]*)/.exec(input.url)?.[1] ?? ''));
        if (uploadCalls === 1) await gate;
      }
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
    choose([nodeFile('first.txt'), nodeFile('second.txt')]);
    fireEvent.change(textbox, { target: { value: '本文' } });
    fireEvent.click(await screen.findByRole('button', { name: 'メッセージを送信' }));
    await screen.findByRole('button', { name: '添付を上げている' });
    // 1つ目の上げが止まっているあいだに B へ移る（上げ終えるのは移った後）
    await waitFor(() => expect(uploadedNames).toEqual(['first.txt']));

    await act(async () => {
      await router.navigate(`/chat/${B}`);
    });
    expect(await findShownConversation(B)).toBeTruthy();

    // 1つ目が上がり、続く2つ目が失敗する
    await act(async () => {
      release();
    });
    await waitFor(() => expect(uploadedNames).toEqual(['first.txt', 'second.txt']));
    await act(async () => undefined);

    await act(async () => {
      await router.navigate(`/chat/${A}`);
    });
    expect(await findShownConversation(A)).toBeTruthy();
    expect(await screen.findByRole('button', { name: 'first.txt を外す' })).toBeTruthy();
    expect(screen.getByRole('button', { name: 'second.txt を外す' })).toBeTruthy();

    fireEvent.click(await screen.findByRole('button', { name: 'メッセージを送信' }));
    await waitFor(() => expect(uploadedNames).toHaveLength(3));
    await act(async () => undefined);
    expect(uploadedNames).toEqual(['first.txt', 'second.txt', 'second.txt']);
  });
});
