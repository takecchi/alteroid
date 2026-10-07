// @vitest-environment jsdom
import { File as NodeFile } from 'node:buffer';

import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { createMemoryRouter, RouterProvider, useParams } from 'react-router';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import { json, Providers, sse, storeTestBaseUrl, stubFetch } from '~/test-support';

import Chat from './chat';

const A = 'conv-4071';

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

const nodeFile = (name: string) =>
  new NodeFile([new Uint8Array([1, 2, 3])], name, { type: 'text/plain' }) as unknown as File;

function choose(files: File[]) {
  const input = document.querySelector('input[type=file]') as HTMLInputElement;
  Object.defineProperty(input, 'files', { value: files, configurable: true });
  fireEvent.change(input);
}

describe('入力欄へ戻っていない再送の途中で上げが失敗したら、上げ終えた分の印を控えへ戻す（#4071）', () => {
  it('2つ目の上げが失敗した後の再送で、上げ直すのは2つ目だけ', async () => {
    let release: () => void = () => undefined;
    const gate = new Promise<void>((resolve) => {
      release = resolve;
    });
    const uploaded: string[] = [];
    let chats = 0;
    stubFetch((url, init) => {
      if (url.includes('/attachments?')) {
        const name = decodeURIComponent(/name=([^&]*)/.exec(url)?.[1] ?? '');
        uploaded.push(name);
        // 再送の最初の上げ直し（全体の4回目）の2つ目だけ失敗させる
        if (uploaded.length === 4) return json({ error: 'boom' }, 500);
        return json({
          id: `att-${uploaded.length}`,
          name,
          mediaType: 'text/plain',
          size: 3,
          sha256: 'a'.repeat(64),
        });
      }
      if (url.endsWith('/chat')) {
        chats += 1;
        if (chats === 1) {
          // 最初の送信は、使い手が新しく打ち始めた後に、添付の期限切れで断られる
          return gate.then(() =>
            json(
              { error: '添付が見つからない（期限切れの可能性）', code: 'attachment_missing' },
              400,
            ),
          );
        }
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
      if (url.includes('/conversations')) return json({ conversations: [], scanned: 0 });
      return undefined;
    });

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
    const textbox = (await screen.findByPlaceholderText(
      /クローンに話しかける/,
    )) as HTMLTextAreaElement;
    choose([nodeFile('first.txt'), nodeFile('second.txt')]);
    fireEvent.change(textbox, { target: { value: '添付つき' } });
    fireEvent.click(await screen.findByRole('button', { name: 'メッセージを送信' }));
    await waitFor(() => expect(chats).toBe(1));
    fireEvent.change(textbox, { target: { value: '新しく打ち始めた' } });
    release();

    // 断られた後、控え（入力欄へは戻らない）から再送する。2つ目の上げが失敗する
    fireEvent.click(await screen.findByRole('button', { name: '再送' }));
    await waitFor(() => expect(uploaded).toHaveLength(4));
    expect(chats).toBe(1);

    fireEvent.click(await screen.findByRole('button', { name: '再送' }));
    await waitFor(() => expect(chats).toBe(2));
    expect(uploaded).toEqual(['first.txt', 'second.txt', 'first.txt', 'second.txt', 'second.txt']);
  });
});
