// @vitest-environment jsdom
/**
 * 存在しない会話の URL を開いたとき。
 * 手元で始めた会話ではないなら 404 を取り直さず、「見つからない」と新しい会話への導線を出す。
 * 手元で始めた会話の 404 は、日誌への反映待ちかもしれないので従来どおり取り直す。
 */
import { cleanup, fireEvent, render, screen } from '@testing-library/react';
import { createMemoryRouter, RouterProvider, useParams } from 'react-router';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { json, Providers, sse, storeTestBaseUrl, stubFetch } from '~/test-support';

import Chat from './chat';

const MISSING = 'conv-4086-missing';
const STARTED = 'conv-4086-started';
const NOTICE = 'この会話は見つからない。消されたか、URL が違っているかもしれない。';

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
  return render(
    <Providers>
      <RouterProvider router={router} />
    </Providers>,
  );
}

let originalFetch: typeof fetch;
let hits: (id: string) => number;

function stub(extra?: (url: string, init?: RequestInit) => Response | undefined) {
  const handle = stubFetch((url, init) => {
    const found = extra?.(url, init);
    if (found !== undefined) return found;
    if (url.includes('/conversations/')) return json({ error: 'not found' }, 404);
    if (url.includes('/approvals')) return json({ approvals: [] });
    if (url.includes('/conversations')) return json({ conversations: [], scanned: 0 });
    return undefined;
  });
  hits = (id) => handle.calls.filter((url) => url.includes(`/conversations/${id}`)).length;
}

beforeEach(() => {
  originalFetch = globalThis.fetch;
  localStorage.clear();
  storeTestBaseUrl();
  vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout'] });
});

afterEach(() => {
  vi.useRealTimers();
  cleanup();
  globalThis.fetch = originalFetch;
});

describe('存在しない会話を URL で開く（#4086）', () => {
  it('404 を取り直さない', async () => {
    stub();
    renderChat(`/chat/${MISSING}`);
    await vi.waitFor(() => expect(screen.getByText(NOTICE)).toBeTruthy());
    expect(hits(MISSING)).toBe(1);
    await vi.advanceTimersByTimeAsync(10 * 60 * 1000);
    expect(hits(MISSING)).toBe(1);
  });

  it('日本語の案内と、新しい会話への導線を出し、素の「not found」は出さない', async () => {
    stub();
    renderChat(`/chat/${MISSING}`);
    await vi.waitFor(() => expect(screen.getByText(NOTICE)).toBeTruthy());
    const link = screen.getByRole('link', { name: '新しい会話を始める' });
    expect(link.getAttribute('href')).toBe('/chat');
    expect(screen.queryByText(/not found/i)).toBeNull();
  });
});

describe('手元で始めた会話の 404（#4086）', () => {
  it('従来どおり取り直し、「見つからない」とは言わない', async () => {
    stub((url, init) => {
      if (url.endsWith('/chat')) {
        return sse(
          [
            { event: 'open', data: { conversationId: STARTED } },
            { event: 'done', data: { type: 'done' } },
          ],
          { signal: init?.signal },
        );
      }
      return undefined;
    });
    renderChat('/chat');
    const box = await vi.waitFor(() => screen.getByPlaceholderText(/クローンに話しかける/));
    fireEvent.change(box, { target: { value: 'はじめまして' } });
    fireEvent.click(screen.getByRole('button', { name: 'メッセージを送信' }));
    await vi.waitFor(() => expect(hits(STARTED)).toBeGreaterThanOrEqual(1));
    await vi.advanceTimersByTimeAsync(10 * 60 * 1000);
    expect(hits(STARTED)).toBeGreaterThan(1);
    expect(screen.queryByText(NOTICE)).toBeNull();
  });
});
