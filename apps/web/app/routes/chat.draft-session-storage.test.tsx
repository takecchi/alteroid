// @vitest-environment jsdom
/**
 * #3400。入力欄の書きかけの本文を、会話ごとに `sessionStorage` へ残す。再読み込み（unmount →
 * もう一度描画）で戻る。入力のたびには書かず（間引く）、空にしたら消し、送れば消える。
 * 待ちは偽のタイマーで進める（実時間では待たない）。
 */
import { act, cleanup, fireEvent, render, screen } from '@testing-library/react';
import { createMemoryRouter, RouterProvider, useParams } from 'react-router';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import {
  findShownConversation,
  json,
  Providers,
  sse,
  storeTestBaseUrl,
  stubFetch,
} from '~/test-support';

import { storeCredential } from '@alteroid/logic';

import Chat from './chat';

const A = 'conv-3400-a';
const B = 'conv-3400-b';

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
});
afterEach(() => {
  vi.useRealTimers();
  cleanup();
  globalThis.fetch = originalFetch;
});

function mount(initial: string) {
  stubFetch((url, init) => {
    if (url.endsWith('/chat')) {
      return sse(
        [
          { event: 'open', data: { conversationId: A } },
          { event: 'done', data: { type: 'done' } },
        ],
        {
          signal: init?.signal,
        },
      );
    }
    if (url.includes('/approvals')) return json({ approvals: [] });
    for (const id of [A, B]) {
      if (url.includes(`/conversations/${id}`)) {
        return json({ conversationId: id, messages: [], scanned: 0, reachedStart: true });
      }
    }
    if (url.includes('/conversations')) return json({ conversations: [], scanned: 0 });
    return undefined;
  });
  const router = createMemoryRouter(
    [
      { path: '/chat', Component: Harness },
      { path: '/chat/:conversationId', Component: Harness },
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

const box = () =>
  screen.findByPlaceholderText(/クローンに話しかける/) as Promise<HTMLTextAreaElement>;
const stored = (id: string) => sessionStorage.getItem(`alteroid.chatDraft:${id}`);

describe('書きかけの本文を sessionStorage へ残す（#3400）', () => {
  it('打鍵が止まって少し待つと書かれ、再読み込み（unmount → 描画）で戻る', async () => {
    const first = mount(`/chat/${A}`);
    const input = await box();
    vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout'] });
    fireEvent.change(input, { target: { value: '長い下書き' } });
    // 入力のたびには書かない（間引く）。
    expect(stored(A)).toBeNull();
    act(() => {
      vi.advanceTimersByTime(1000);
    });
    expect(stored(A)).toBe('長い下書き');
    vi.useRealTimers();

    first.view.unmount();
    cleanup();
    mount(`/chat/${A}`);
    expect((await box()).value).toBe('長い下書き');
  });

  it('待っている途中で画面を離れても、書きかけは書かれる（unmount で書き出す）', async () => {
    const first = mount(`/chat/${A}`);
    const input = await box();
    vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout'] });
    fireEvent.change(input, { target: { value: '途中で離れる' } });
    expect(stored(A)).toBeNull();
    first.view.unmount();
    expect(stored(A)).toBe('途中で離れる');
  });

  it('pagehide（タブを閉じる・破棄）でも待たずに書く', async () => {
    mount(`/chat/${A}`);
    const input = await box();
    vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout'] });
    fireEvent.change(input, { target: { value: 'タブが落ちる前に' } });
    window.dispatchEvent(new Event('pagehide'));
    expect(stored(A)).toBe('タブが落ちる前に');
  });

  it('会話ごとに別の鍵。会話を移っても取り違えない', async () => {
    const { router } = mount(`/chat/${A}`);
    const input = await box();
    vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout'] });
    fireEvent.change(input, { target: { value: 'A の下書き' } });
    vi.useRealTimers();
    await act(async () => {
      await router.navigate(`/chat/${B}`);
    });
    expect(await findShownConversation(B)).toBeTruthy();
    expect(stored(A)).toBe('A の下書き');
    expect(stored(B)).toBeNull();
    expect((await box()).value).toBe('');
  });

  it('空にすれば待たずに消える。保存した本文は別の会話の入力欄には出ない', async () => {
    sessionStorage.setItem(`alteroid.chatDraft:${B}`, 'B に残してあった');
    mount(`/chat/${A}`);
    const input = await box();
    expect(input.value).toBe('');
    vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout'] });
    fireEvent.change(input, { target: { value: 'x' } });
    act(() => {
      vi.advanceTimersByTime(1000);
    });
    expect(stored(A)).toBe('x');
    fireEvent.change(input, { target: { value: '' } });
    expect(stored(A)).toBeNull();
  });

  it('送信すると（入力欄が空になるので）書きかけは消える', async () => {
    mount(`/chat/${A}`);
    const input = await box();
    vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout'] });
    fireEvent.change(input, { target: { value: '送る文' } });
    act(() => {
      vi.advanceTimersByTime(1000);
    });
    expect(stored(A)).toBe('送る文');
    vi.useRealTimers();
    fireEvent.click(screen.getByRole('button', { name: 'メッセージを送信' }));
    await vi.waitFor(() => expect(stored(A)).toBeNull());
    expect(input.value).toBe('');
  });

  it('ログアウトの直前に打った本文は、ログアウトの後（タイマー・pagehide・unmount）に書き戻らない', async () => {
    const first = mount(`/chat/${A}`);
    const input = await box();
    vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout'] });
    fireEvent.change(input, { target: { value: 'ログアウト直前に打った' } });
    expect(stored(A)).toBeNull();
    // 書き出しの待ちが明ける前にログアウトする。
    storeCredential('http://daemon.test', null);
    act(() => {
      vi.advanceTimersByTime(1000);
    });
    expect(stored(A)).toBeNull();
    window.dispatchEvent(new Event('pagehide'));
    first.view.unmount();
    expect(stored(A)).toBeNull();
    expect(sessionStorage.length).toBe(0);
  });
});
