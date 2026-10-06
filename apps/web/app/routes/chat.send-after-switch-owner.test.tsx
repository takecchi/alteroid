// @vitest-environment jsdom
/**
 * #3395。添付を上げているあいだに別の会話へ移っても、送った発言は**送った先の会話の行**で、
 * 移った先の画面に出ない。移った先に進行中のストリームがあっても、そこへは投函されない。
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

const A = 'conv-3395-a';
const B = 'conv-3395-b';

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

const empty = (id: string) => ({
  conversationId: id,
  messages: [],
  scanned: 0,
  reachedStart: true,
  supersededCount: 0,
});

/** A で本文と添付を入れて送り、上げているあいだに B へ移って、アップロードを放す。 */
async function sendThenSwitch(options: { bIsRunning: boolean }) {
  let release: () => void = () => undefined;
  const gate = new Promise<void>((resolve) => {
    release = resolve;
  });
  const stub = stubFetch((url, init) => {
    if (url.includes('/attachments?')) return json(META);
    // B に進行中のターンがある（戻ってきた再生）。
    if (options.bIsRunning && url.endsWith(`/chat/${B}/stream`)) {
      return sse([{ event: 'open', data: { inProgress: true, conversationId: B } }], {
        signal: init?.signal,
        keepOpen: true,
      });
    }
    if (url.endsWith('/stream')) {
      return sse([{ event: 'open', data: { inProgress: false, conversationId: A } }], {
        signal: init?.signal,
      });
    }
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
    if (url.includes(`/conversations/${A}`)) return json(empty(A));
    if (url.includes(`/conversations/${B}`)) return json(empty(B));
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
  fireEvent.change(textbox, { target: { value: 'Aへの本文' } });
  fireEvent.click(await screen.findByRole('button', { name: 'メッセージを送信' }));
  await screen.findByRole('button', { name: '添付を上げている' });

  await act(async () => {
    await router.navigate(`/chat/${B}`);
  });
  expect(await findShownConversation(B)).toBeTruthy();
  if (options.bIsRunning) {
    // B の再生が張られ、「受信中」になっている。
    await screen.findByRole('button', { name: '受信をやめる（クローンのターンは止まらない）' });
  }

  await act(async () => {
    release();
  });
  await waitFor(() => expect(stub.entries.some((e) => e.url.endsWith('/chat'))).toBe(true));
  return { router, stub };
}

const postedBodies = async (stub: ReturnType<typeof stubFetch>) =>
  Promise.all(
    stub.entries.filter((e) => e.url.endsWith('/chat')).map((e) => e.request?.clone().json()),
  );

describe('送った発言は送った先の会話の行で、移った先の画面に出ない（#3395）', () => {
  it('上げているあいだに B へ移っても、B のやりとりに A への発言は出ず、A へ投函される', async () => {
    const { router, stub } = await sendThenSwitch({ bIsRunning: false });
    expect(await postedBodies(stub)).toEqual([
      expect.objectContaining({ text: 'Aへの本文', conversationId: A, attachments: ['att-1'] }),
    ]);
    // 投函が済むまで流し切ってから見る。
    await act(async () => undefined);
    const list = screen.queryByRole('list', { name: 'やりとり' });
    expect(list?.textContent ?? '').not.toContain('Aへの本文');
    // B の画面は「受信中」にならない（A への投函のために購読は張らない）。
    expect(
      screen.queryByRole('button', { name: '受信をやめる（クローンのターンは止まらない）' }),
    ).toBeNull();

    // A へ戻ると、送った発言は A の行として居て、書いた本文は入力欄に戻ってこない。
    await act(async () => {
      await router.navigate(`/chat/${A}`);
    });
    expect(await findShownConversation(A)).toBeTruthy();
    expect((screen.getByPlaceholderText(/クローンに話しかける/) as HTMLTextAreaElement).value).toBe(
      '',
    );
    expect(screen.getByRole('list', { name: 'やりとり' }).textContent).toContain('Aへの本文');
  });

  it('B に進行中のターンがあっても、A への発言は B へ投函されず、B の行にもならない', async () => {
    const { stub } = await sendThenSwitch({ bIsRunning: true });
    const bodies = await postedBodies(stub);
    expect(bodies).toHaveLength(1);
    expect(bodies[0]).toMatchObject({ text: 'Aへの本文', conversationId: A });
    await act(async () => undefined);
    expect(screen.queryByRole('list', { name: 'やりとり' })?.textContent ?? '').not.toContain(
      'Aへの本文',
    );
    // B の「受信中」は B のまま（A への投函で止まらない・増えない）。
    expect(
      screen.getByRole('button', { name: '受信をやめる（クローンのターンは止まらない）' }),
    ).toBeTruthy();
  });
});
