// @vitest-environment jsdom
/**
 * Issue #3567。「添付を上げている」「ターンを止めている」「会話を終えている」は、押した会話の
 * 画面だけに出す。別の会話へ移った先の入力欄・ボタンを塞がない（`interruptNotice` と同じ形）。
 * 待ちは `fetch` の通り道で止めた門（gate）で作る。実時間の待ちは使わない。
 */
import { File as NodeFile } from 'node:buffer';

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

const A = 'conv-3567-a';
const B = 'conv-3567-b';

const ChatRoute = Chat as unknown as (props: {
  loaderData: { conversationId: string | undefined };
}) => React.ReactElement;

function Harness() {
  const params = useParams();
  return <ChatRoute loaderData={{ conversationId: params.conversationId }} />;
}

function renderChat(initial: string) {
  const router = createMemoryRouter(
    [
      { path: '/chat', Component: Harness },
      { path: '/chat/:conversationId', Component: Harness },
    ],
    { initialEntries: [initial] },
  );
  render(
    <Providers>
      <RouterProvider router={router} />
    </Providers>,
  );
  return router;
}

function gate() {
  let release: () => void = () => undefined;
  const promise = new Promise<void>((resolve) => {
    release = resolve;
  });
  return { promise, release };
}

function baseRoutes(url: string) {
  for (const id of [A, B]) {
    if (url.includes(`/conversations/${id}`)) return json({ conversationId: id, messages: [] });
  }
  if (url.includes('/approvals')) return json({ approvals: [] });
  if (url.includes('/conversations')) return json({ conversations: [], scanned: 0 });
  return undefined;
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

describe('会話をまたいで塞がない（#3567）', () => {
  it('A で添付を上げている最中に B へ移ると、B の送信ボタンは「添付を上げている」にならず、A へ戻ると出る', async () => {
    const upload = gate();
    stubFetch((url) => {
      if (url.includes('/attachments?')) {
        return upload.promise.then(() =>
          json({
            id: 'att-1',
            name: 'a.txt',
            mediaType: 'text/plain',
            size: 3,
            sha256: 'a'.repeat(64),
          }),
        );
      }
      return baseRoutes(url);
    });
    const router = renderChat(`/chat/${A}`);
    const box = await screen.findByPlaceholderText(/クローンに話しかける/);
    const input = document.querySelector('input[type=file]') as HTMLInputElement;
    const file = new NodeFile([new Uint8Array([1, 2, 3])], 'a.txt', {
      type: 'text/plain',
    }) as unknown as File;
    Object.defineProperty(input, 'files', { value: [file], configurable: true });
    fireEvent.change(input);
    fireEvent.change(box, { target: { value: 'A への発言' } });
    fireEvent.click(await screen.findByRole('button', { name: 'メッセージを送信' }));
    await screen.findByRole('button', { name: '添付を上げている' });

    await router.navigate(`/chat/${B}`);
    expect(await findShownConversation(B)).toBeTruthy();
    await act(async () => {});
    expect(screen.queryByRole('button', { name: '添付を上げている' })).toBeNull();

    await router.navigate(`/chat/${A}`);
    expect(await findShownConversation(A)).toBeTruthy();
    expect(await screen.findByRole('button', { name: '添付を上げている' })).toBeTruthy();
    upload.release();
  });

  it('A で「ターンを止める」の応答待ちの最中に B へ移ると、B のボタンは押せる', async () => {
    const interrupt = gate();
    const stub = stubFetch((url) => {
      if (url.endsWith('/clone/interrupt')) {
        return interrupt.promise.then(() => json({ outcome: 'interrupted' }));
      }
      return baseRoutes(url);
    });
    const router = renderChat(`/chat/${A}`);
    const button = await screen.findByRole('button', { name: 'クローンのターンを止める' });
    fireEvent.click(button);
    await waitFor(() =>
      expect(stub.entries.some((e) => e.url.endsWith('/clone/interrupt'))).toBe(true),
    );
    expect((button as HTMLButtonElement).disabled).toBe(true);

    await router.navigate(`/chat/${B}`);
    expect(await findShownConversation(B)).toBeTruthy();
    await act(async () => {});
    const inB = screen.getByRole('button', {
      name: 'クローンのターンを止める',
    }) as HTMLButtonElement;
    expect(inB.disabled).toBe(false);
    interrupt.release();
  });

  it('A で「会話を終える」の応答待ちの最中に B へ移ると、B のボタンは押せる', async () => {
    const end = gate();
    const stub = stubFetch((url) => {
      if (url.endsWith('/end')) return end.promise.then(() => json({ ok: true }));
      return baseRoutes(url);
    });
    const router = renderChat(`/chat/${A}`);
    fireEvent.click(await screen.findByRole('button', { name: '会話を終える' }));
    fireEvent.click(await screen.findByRole('button', { name: '終える' }));
    await waitFor(() => expect(stub.entries.some((e) => e.url.endsWith('/end'))).toBe(true));
    expect(
      (screen.getByRole('button', { name: '会話を終える' }) as HTMLButtonElement).disabled,
    ).toBe(true);

    await router.navigate(`/chat/${B}`);
    expect(await findShownConversation(B)).toBeTruthy();
    await act(async () => {});
    expect(
      (screen.getByRole('button', { name: '会話を終える' }) as HTMLButtonElement).disabled,
    ).toBe(false);
    end.release();
  });
});
