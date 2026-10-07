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

const A = 'conv-3709-a';
const B = 'conv-3709-b';

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
  URL.createObjectURL = () => 'blob:fake';
  URL.revokeObjectURL = () => undefined;
});
afterEach(() => {
  cleanup();
  globalThis.fetch = originalFetch;
});

const meta = (id: string) => ({
  id,
  name: `${id}.txt`,
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

describe('添付を上げている最中の印は会話ごと（#3709）', () => {
  it('別の会話の上げ終わりが、今の会話の「上げている」印を消さない', async () => {
    const uploads: Array<() => void> = [];
    stubFetch((url, init) => {
      if (url.includes('/attachments?')) return json(meta(`att-${uploads.length}`));
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
      for (const id of [A, B]) {
        if (url.includes(`/conversations/${id}`)) return json({ conversationId: id, messages: [] });
      }
      if (url.includes('/conversations')) return json({ conversations: [], scanned: 0 });
      return undefined;
    });
    const inner = globalThis.fetch;
    globalThis.fetch = (async (input: RequestInfo | URL, init?: RequestInit) => {
      if (input instanceof Request && input.url.includes('/attachments?')) {
        await new Promise<void>((resolve) => uploads.push(resolve));
      }
      return inner(input, init);
    }) as typeof fetch;

    const router = createMemoryRouter([{ path: '/chat/:conversationId', Component: Harness }], {
      initialEntries: [`/chat/${A}`],
    });
    render(
      <Providers>
        <RouterProvider router={router} />
      </Providers>,
    );
    await screen.findByPlaceholderText(/クローンに話しかける/);

    choose([nodeFile('a.txt')]);
    fireEvent.click(await screen.findByRole('button', { name: 'メッセージを送信' }));
    await screen.findByRole('button', { name: '添付を上げている' });
    await waitFor(() => expect(uploads).toHaveLength(1));

    await router.navigate(`/chat/${B}`);
    expect(await findShownConversation(B)).toBeTruthy();
    expect(screen.queryByRole('button', { name: '添付を上げている' })).toBeNull();

    choose([nodeFile('b.txt')]);
    fireEvent.click(await screen.findByRole('button', { name: 'メッセージを送信' }));
    await screen.findByRole('button', { name: '添付を上げている' });
    await waitFor(() => expect(uploads).toHaveLength(2));

    uploads[0]?.();
    await waitFor(() => expect(uploads).toHaveLength(2));
    await act(async () => {});
    expect(screen.getByRole('button', { name: '添付を上げている' })).toBeTruthy();

    uploads[1]?.();
    await waitFor(() =>
      expect(screen.queryByRole('button', { name: '添付を上げている' })).toBeNull(),
    );
  });
});
