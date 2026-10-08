// @vitest-environment jsdom
import { File as NodeFile } from 'node:buffer';

import { act, cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { createMemoryRouter, RouterProvider, useParams } from 'react-router';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import {
  findShownConversation,
  json,
  Providers,
  storeTestBaseUrl,
  stubFetch,
} from '~/test-support';

import Chat from './chat';

const A = 'conv-notice-a';
const B = 'conv-notice-b';

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
  return {
    router,
    ...render(
      <Providers>
        <RouterProvider router={router} />
      </Providers>,
    ),
  };
}

let originalFetch: typeof fetch;
let posts = 0;
beforeEach(() => {
  originalFetch = globalThis.fetch;
  localStorage.clear();
  storeTestBaseUrl();
  posts = 0;
  URL.createObjectURL = vi.fn(() => 'blob:fake');
  URL.revokeObjectURL = vi.fn();
});
afterEach(() => {
  cleanup();
  globalThis.fetch = originalFetch;
});

const bigImage = () => {
  const file = new NodeFile([new Uint8Array([1])], 'big.png', {
    type: 'image/png',
  }) as unknown as File;
  Object.defineProperty(file, 'size', { value: 5 * 1024 * 1024 + 1 });
  return file;
};

function choose(files: File[]) {
  const input = document.querySelector('input[type=file]') as HTMLInputElement;
  Object.defineProperty(input, 'files', { value: files, configurable: true });
  fireEvent.change(input);
}

const REFUSED = /big\.png: 画像は 1 つ 5 MiB まで（5,242,881 バイトある）/;

describe('添付を断った理由は、他の知らせと並べて出る', () => {
  it('送信の失敗が出ているあいだも、断った理由が出る（失敗も残る）', async () => {
    stubFetch((url) => {
      if (url.endsWith('/chat')) return json({ error: 'こわれた' }, 500);
      if (url.includes('/approvals')) return json({ approvals: [] });
      if (url.includes('/conversations')) return json({ conversations: [], scanned: 0 });
      return undefined;
    });
    renderChat('/chat');
    fireEvent.change(await screen.findByPlaceholderText(/クローンに話しかける/), {
      target: { value: 'こんにちは' },
    });
    fireEvent.click(screen.getByRole('button', { name: 'メッセージを送信' }));
    await waitFor(() => expect(screen.getAllByRole('alert').length).toBeGreaterThan(0));
    const failureAlerts = screen.getAllByRole('alert').length;

    choose([bigImage()]);
    expect(await screen.findByText(REFUSED)).toBeTruthy();
    expect(screen.getAllByRole('alert').length).toBe(failureAlerts + 1);
  });

  it('未確認の送信の「再送／破棄」が出ているあいだも、断った理由が出る（操作も残る）', async () => {
    stubFetch((url, init) => {
      if (url.includes(`/conversations/${A}`)) return json({ conversationId: A, messages: [] });
      if (url.includes(`/conversations/${B}`)) return json({ conversationId: B, messages: [] });
      if (url.includes('/approvals')) return json({ approvals: [] });
      if (url.includes('/conversations')) return json({ conversations: [], scanned: 0 });
      if (url.endsWith('/chat')) {
        posts += 1;
        return new Promise((_, reject) => {
          init?.signal?.addEventListener('abort', () =>
            reject(new DOMException('aborted', 'AbortError')),
          );
        });
      }
      return undefined;
    });
    const { router } = renderChat(`/chat/${A}`);
    fireEvent.change(await screen.findByPlaceholderText(/クローンに話しかける/), {
      target: { value: '送れたか不明' },
    });
    fireEvent.click(screen.getByRole('button', { name: 'メッセージを送信' }));
    await waitFor(() => expect(posts).toBe(1));
    await router.navigate(`/chat/${B}`);
    expect(await findShownConversation(B)).toBeTruthy();
    await act(async () => {});
    await router.navigate(`/chat/${A}`);
    expect(await findShownConversation(A)).toBeTruthy();
    expect(await screen.findByRole('button', { name: '再送' })).toBeTruthy();

    choose([bigImage()]);
    expect(await screen.findByText(REFUSED)).toBeTruthy();
    expect(screen.getByRole('button', { name: '再送' })).toBeTruthy();
    expect(screen.getByRole('button', { name: '破棄' })).toBeTruthy();
  });
});
