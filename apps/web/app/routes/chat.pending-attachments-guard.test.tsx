// @vitest-environment jsdom
// ファイルは Node の File（node:buffer）で作る: jsdom の File は Node の Request の本文として読めないため
import { File as NodeFile } from 'node:buffer';

import { act, cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { createMemoryRouter, RouterProvider, useParams } from 'react-router';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import { json, Providers, storeTestBaseUrl, stubFetch } from '~/test-support';

import Chat from './chat';

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
      { path: '/approvals', Component: () => <p>承認の画面</p> },
    ],
    { initialEntries: [initial] },
  );
  const view = render(
    <Providers>
      <RouterProvider router={router} />
    </Providers>,
  );
  return { router, view };
}

let originalFetch: typeof fetch;

beforeEach(() => {
  originalFetch = globalThis.fetch;
  localStorage.clear();
  sessionStorage.clear();
  storeTestBaseUrl();
  stubFetch((url) => {
    if (url.includes('/approvals')) return json({ approvals: [] });
    if (url.includes('/conversations/')) return json({ conversationId: 'c1', messages: [] });
    if (url.includes('/conversations')) return json({ conversations: [], scanned: 0 });
    return undefined;
  });
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

function unloadPrevented(): boolean {
  const event = new Event('beforeunload', { cancelable: true });
  window.dispatchEvent(event);
  return event.defaultPrevented;
}

const box = () => screen.findByPlaceholderText(/クローンに話しかける/);
const LOST = /添えていたファイル 1 件（memo\.txt）は戻せませんでした/;

describe('添えかけのファイルを、確認も案内も無く失わない（#4019）', () => {
  it('添えかけが在るあいだだけ、再読み込みの前に確認を出す', async () => {
    renderChat('/chat/c1');
    await box();
    expect(unloadPrevented()).toBe(false);

    act(() => choose([nodeFile('memo.txt')]));
    await screen.findByText('memo.txt');
    expect(unloadPrevented()).toBe(true);

    fireEvent.click(screen.getByRole('button', { name: /memo\.txt.*(外す|取り除く|削除)/ }));
    await waitFor(() => expect(unloadPrevented()).toBe(false));
  });

  it('他の画面へ移るときは確認し、やめれば添えかけを残す', async () => {
    const { router } = renderChat('/chat/c1');
    await box();
    act(() => choose([nodeFile('memo.txt')]));
    await screen.findByText('memo.txt');

    act(() => {
      void router.navigate('/approvals');
    });
    await screen.findByText('添えかけのファイルがあります');
    fireEvent.click(screen.getByRole('button', { name: 'やめる' }));
    expect(router.state.location.pathname).toBe('/chat/c1');
    expect(screen.getByText('memo.txt')).toBeTruthy();

    act(() => {
      void router.navigate('/approvals');
    });
    fireEvent.click(await screen.findByRole('button', { name: '破棄して離れる' }));
    await screen.findByText('承認の画面');
  });

  it('会話を切り替えるだけなら確認しない（添えかけはしまって戻す）', async () => {
    const { router } = renderChat('/chat/c1');
    await box();
    act(() => choose([nodeFile('memo.txt')]));
    await screen.findByText('memo.txt');

    await act(() => router.navigate('/chat/c2'));
    expect(router.state.location.pathname).toBe('/chat/c2');
    expect(screen.queryByText('添えかけのファイルがあります')).toBeNull();
    expect(screen.queryByText('memo.txt')).toBeNull();

    await act(() => router.navigate('/chat/c1'));
    await screen.findByText('memo.txt');
  });

  it('再読み込みでファイルを失ったら、戻ったときに件数と名前を言う。閉じれば消える', async () => {
    const first = renderChat('/chat/c1');
    await box();
    act(() => choose([nodeFile('memo.txt')]));
    await screen.findByText('memo.txt');
    first.view.unmount();

    renderChat('/chat/c1');
    await screen.findByText(LOST);
    fireEvent.click(screen.getByRole('button', { name: '閉じる' }));
    expect(screen.queryByText(LOST)).toBeNull();

    cleanup();
    renderChat('/chat/c1');
    await box();
    expect(screen.queryByText(LOST)).toBeNull();
  });

  it('外して送った（添えかけが無い）ときは、戻っても何も言わない', async () => {
    const first = renderChat('/chat/c1');
    await box();
    act(() => choose([nodeFile('memo.txt')]));
    await screen.findByText('memo.txt');
    fireEvent.click(screen.getByRole('button', { name: /memo\.txt.*(外す|取り除く|削除)/ }));
    await waitFor(() => expect(sessionStorage.length).toBe(0));
    first.view.unmount();

    renderChat('/chat/c1');
    await box();
    expect(screen.queryByText(/戻せませんでした/)).toBeNull();
  });
});
