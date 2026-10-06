// @vitest-environment jsdom
/**
 * Issue #3215。添付を上げているあいだに足した添付・打ち足した本文が、上げ終えた時点で
 * 黙って消えないこと。消すのは「送った分」だけ（添付は送った key、本文は送った時点の値の
 * ままのときだけ）。
 *
 * アップロードは `fetch` の通り道で止め（`gate`）、止めているあいだに足してから放す。
 * 実時間の待ちは使わない。
 */
import { File as NodeFile } from 'node:buffer';

import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { createMemoryRouter, RouterProvider, useParams } from 'react-router';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import { json, Providers, sse, storeTestBaseUrl, stubFetch } from '~/test-support';

import Chat from './chat';

const CONVERSATION_ID = 'conv-during-upload';

const ChatRoute = Chat as unknown as (props: {
  loaderData: { conversationId: string | undefined };
}) => React.ReactElement;

function Harness() {
  const params = useParams();
  return <ChatRoute loaderData={{ conversationId: params.conversationId }} />;
}

function renderChat() {
  const router = createMemoryRouter(
    [
      { path: '/chat', Component: Harness },
      { path: '/chat/:conversationId', Component: Harness },
    ],
    { initialEntries: ['/chat'] },
  );
  return render(
    <Providers>
      <RouterProvider router={router} />
    </Providers>,
  );
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

/** アップロードだけを止め、放すと続きが進む。`/chat` の本文も控える。 */
function setUp() {
  let release: () => void = () => undefined;
  const gate = new Promise<void>((resolve) => {
    release = resolve;
  });
  const chatBodies: string[] = [];
  stubFetch((url, init) => {
    if (url.includes('/attachments?')) return json(META);
    if (url.endsWith('/chat')) {
      return sse(
        [
          { event: 'open', data: { conversationId: CONVERSATION_ID } },
          { event: 'done', data: { type: 'done' } },
        ],
        { signal: init?.signal },
      );
    }
    if (url.includes('/approvals')) return json({ approvals: [] });
    if (url.includes('/conversations/'))
      return json({ conversationId: CONVERSATION_ID, messages: [] });
    if (url.includes('/conversations')) return json({ conversations: [], scanned: 0 });
    return undefined;
  });
  const inner = globalThis.fetch;
  globalThis.fetch = (async (input: RequestInfo | URL, init?: RequestInit) => {
    if (input instanceof Request && input.url.includes('/attachments?')) await gate;
    if (input instanceof Request && input.url.endsWith('/chat')) {
      chatBodies.push(await input.clone().text());
    }
    return inner(input, init);
  }) as typeof fetch;
  return { release, chatBodies };
}

describe('アップロード中に足したものを、完了時に消さない（#3215）', () => {
  it('上げているあいだに足した添付は残り、送った添付だけが消える', async () => {
    const { release, chatBodies } = setUp();
    renderChat();
    const textbox = await screen.findByPlaceholderText(/クローンに話しかける/);
    choose([nodeFile('first.txt')]);
    fireEvent.change(textbox, { target: { value: '本文' } });
    fireEvent.click(await screen.findByRole('button', { name: 'メッセージを送信' }));
    // 上げている最中（送信ボタンが「添付を上げている」になる）
    await screen.findByRole('button', { name: '添付を上げている' });

    choose([nodeFile('second.txt')]);
    expect(await screen.findByRole('button', { name: 'second.txt を外す' })).toBeTruthy();

    release();
    await waitFor(() => {
      expect(chatBodies.length).toBe(1);
    });
    expect(JSON.parse(chatBodies[0] ?? '{}').attachments).toEqual(['att-1']);
    await waitFor(() => {
      expect(screen.queryByRole('button', { name: 'first.txt を外す' })).toBeNull();
    });
    expect(screen.getByRole('button', { name: 'second.txt を外す' })).toBeTruthy();
  });

  it('上げているあいだに打ち足した本文は残る', async () => {
    const { release, chatBodies } = setUp();
    renderChat();
    const textbox = (await screen.findByPlaceholderText(
      /クローンに話しかける/,
    )) as HTMLTextAreaElement;
    choose([nodeFile('first.txt')]);
    fireEvent.change(textbox, { target: { value: '送る本文' } });
    fireEvent.click(await screen.findByRole('button', { name: 'メッセージを送信' }));
    await screen.findByRole('button', { name: '添付を上げている' });

    fireEvent.change(textbox, { target: { value: '送る本文 と、あとから足した続き' } });

    release();
    await waitFor(() => {
      expect(chatBodies.length).toBe(1);
    });
    expect(JSON.parse(chatBodies[0] ?? '{}').text).toBe('送る本文');
    await waitFor(() => {
      expect(screen.queryByRole('button', { name: 'first.txt を外す' })).toBeNull();
    });
    expect(textbox.value).toBe('送る本文 と、あとから足した続き');
  });

  it('陰性対照: 足さなければ、送った本文と添付は消える', async () => {
    const { release, chatBodies } = setUp();
    renderChat();
    const textbox = (await screen.findByPlaceholderText(
      /クローンに話しかける/,
    )) as HTMLTextAreaElement;
    choose([nodeFile('first.txt')]);
    fireEvent.change(textbox, { target: { value: '送る本文' } });
    fireEvent.click(await screen.findByRole('button', { name: 'メッセージを送信' }));
    await screen.findByRole('button', { name: '添付を上げている' });
    release();
    await waitFor(() => {
      expect(chatBodies.length).toBe(1);
    });
    await waitFor(() => {
      expect(textbox.value).toBe('');
    });
    expect(screen.queryByRole('button', { name: 'first.txt を外す' })).toBeNull();
  });
});
