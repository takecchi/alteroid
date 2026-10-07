// @vitest-environment jsdom
// await act(async () => {}) を挟んでから呼び出し回数を比べる: 追従の判定は commit の後に走る受動効果で、本文が見えた一瞬にはまだ走っていないことがあるため
import { act, cleanup, fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import { createMemoryRouter, RouterProvider, useParams } from 'react-router';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import {
  json,
  Providers,
  sse,
  storeTestBaseUrl,
  stubFetch,
  untilOpenSettled,
} from '~/test-support';

import Chat from './chat';

const CONVERSATION_ID = 'conv-follow-scroll';

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

function gate() {
  let open: () => void = () => {};
  const promise = new Promise<void>((resolve) => {
    open = resolve;
  });
  return { promise, open: () => open() };
}

async function send(text: string) {
  const box = await screen.findByPlaceholderText(/クローンに話しかける/);
  fireEvent.change(box, { target: { value: text } });
  fireEvent.click(screen.getByRole('button', { name: 'メッセージを送信' }));
}

const transcript = () => screen.getByRole('list', { name: 'やりとり' });

function scrollContainer(): HTMLElement {
  const el = transcript().parentElement;
  if (el === null) throw new Error('scroll container not found');
  return el;
}

// scrollTop だけ writable にする: 本物のブラウザでも scrollHeight / clientHeight は読み取り専用で、同じ形にしないと偽物だけが書き込みを許して見逃すため
function setScrollMetrics(
  el: HTMLElement,
  metrics: { scrollTop: number; scrollHeight: number; clientHeight: number },
) {
  Object.defineProperty(el, 'scrollTop', {
    configurable: true,
    writable: true,
    value: metrics.scrollTop,
  });
  Object.defineProperty(el, 'scrollHeight', {
    configurable: true,
    value: metrics.scrollHeight,
  });
  Object.defineProperty(el, 'clientHeight', {
    configurable: true,
    value: metrics.clientHeight,
  });
}

function background(url: string): Response | undefined {
  if (url.includes(`/conversations/${CONVERSATION_ID}`)) {
    return json({ conversationId: CONVERSATION_ID, messages: [] });
  }
  if (url.includes('/approvals')) return json({ approvals: [] });
  if (url.includes('/conversations')) return json({ conversations: [], scanned: 0 });
  return undefined;
}

let originalFetch: typeof fetch;
let scrollIntoView: ReturnType<typeof vi.spyOn>;

beforeEach(() => {
  originalFetch = globalThis.fetch;
  localStorage.clear();
  storeTestBaseUrl();
  scrollIntoView = vi.spyOn(Element.prototype, 'scrollIntoView');
});

afterEach(() => {
  cleanup();
  scrollIntoView.mockRestore();
  globalThis.fetch = originalFetch;
});

describe('会話画面のスクロール追従（#247 の 1）', () => {
  it('最下部にいるとき、新しい行が来たら追従する', async () => {
    const chunk1 = gate();
    const chunk2 = gate();
    stubFetch((url, init) => {
      if (url.endsWith('/chat')) {
        return sse(
          [
            { event: 'open', data: { conversationId: CONVERSATION_ID } },
            { event: 'text', data: { type: 'text', text: '最初の一文' }, after: chunk1.promise },
            { event: 'text', data: { type: 'text', text: '、続きの一文' }, after: chunk2.promise },
            { event: 'done', data: { type: 'done' } },
          ],
          { signal: init?.signal },
        );
      }
      return background(url);
    });

    const { router } = renderChat('/chat');
    await send('質問');
    await untilOpenSettled(router, CONVERSATION_ID);
    chunk1.open();
    expect(await screen.findByText('最初の一文')).toBeTruthy();

    setScrollMetrics(scrollContainer(), { scrollTop: 468, scrollHeight: 500, clientHeight: 32 });
    fireEvent.scroll(scrollContainer());

    const callsBeforeChunk2 = scrollIntoView.mock.calls.length;
    chunk2.open();
    await waitFor(() => {
      expect(within(transcript()).getByText(/続きの一文/)).toBeTruthy();
    });

    await act(async () => {});

    expect(scrollIntoView.mock.calls.length).toBeGreaterThan(callsBeforeChunk2);
  });

  it('最下部にいないとき、新しい行が来ても追従しない', async () => {
    const chunk1 = gate();
    const chunk2 = gate();
    stubFetch((url, init) => {
      if (url.endsWith('/chat')) {
        return sse(
          [
            { event: 'open', data: { conversationId: CONVERSATION_ID } },
            { event: 'text', data: { type: 'text', text: '最初の一文' }, after: chunk1.promise },
            { event: 'text', data: { type: 'text', text: '、続きの一文' }, after: chunk2.promise },
            { event: 'done', data: { type: 'done' } },
          ],
          { signal: init?.signal },
        );
      }
      return background(url);
    });

    const { router } = renderChat('/chat');
    await send('質問');
    await untilOpenSettled(router, CONVERSATION_ID);
    chunk1.open();
    expect(await screen.findByText('最初の一文')).toBeTruthy();

    setScrollMetrics(scrollContainer(), { scrollTop: 0, scrollHeight: 1000, clientHeight: 200 });
    fireEvent.scroll(scrollContainer());

    const callsBeforeChunk2 = scrollIntoView.mock.calls.length;
    chunk2.open();
    await waitFor(() => {
      expect(within(transcript()).getByText(/続きの一文/)).toBeTruthy();
    });

    await act(async () => {});

    expect(scrollIntoView.mock.calls.length).toBe(callsBeforeChunk2);
  });

  it('遡って読んでいても、自分が送った直後は追従する', async () => {
    const reply = gate();
    const stub = stubFetch((url, init) => {
      if (url.endsWith('/chat')) {
        return sse(
          [
            { event: 'open', data: { conversationId: CONVERSATION_ID } },
            { event: 'text', data: { type: 'text', text: '最初の応答' }, after: reply.promise },
            { event: 'done', data: { type: 'done' } },
          ],
          { signal: init?.signal },
        );
      }
      return background(url);
    });

    const { router } = renderChat('/chat');
    await send('一つ目');
    await waitFor(() => {
      expect(stub.calls.some((url) => url.includes('/chat'))).toBe(true);
    });
    await untilOpenSettled(router, CONVERSATION_ID);
    reply.open();
    await screen.findByText('最初の応答');

    setScrollMetrics(scrollContainer(), { scrollTop: 0, scrollHeight: 1000, clientHeight: 200 });
    fireEvent.scroll(scrollContainer());

    const callsBeforeSend = scrollIntoView.mock.calls.length;
    await send('二つ目');
    await waitFor(() => {
      expect(within(transcript()).getByText('二つ目')).toBeTruthy();
    });

    await act(async () => {});

    expect(scrollIntoView.mock.calls.length).toBeGreaterThan(callsBeforeSend);
  });
});

describe('会話の切り替え（#247 の 1 の追加分）', () => {
  const CONV_A = 'conv-switch-a';
  const CONV_B = 'conv-switch-b';

  function backgroundForSwitch(url: string): Response | undefined {
    if (url.includes(`/conversations/${CONV_A}`)) {
      return json({
        conversationId: CONV_A,
        messages: [{ id: 'a1', at: '2026-08-20T00:00:00Z', role: 'inbound', text: '会話Aの発言' }],
      });
    }
    if (url.includes(`/conversations/${CONV_B}`)) {
      return json({
        conversationId: CONV_B,
        messages: [{ id: 'b1', at: '2026-08-20T00:00:00Z', role: 'inbound', text: '会話Bの発言' }],
      });
    }
    if (url.includes('/approvals')) return json({ approvals: [] });
    if (url.includes('/conversations')) return json({ conversations: [], scanned: 0 });
    return undefined;
  }

  it('会話 A で上へ遡った状態から会話 B へ移ると、B は最下部へ送られる', async () => {
    stubFetch((url) => backgroundForSwitch(url));

    const { router } = renderChat(`/chat/${CONV_A}`);
    await screen.findByText('会話Aの発言');

    setScrollMetrics(scrollContainer(), { scrollTop: 0, scrollHeight: 1000, clientHeight: 200 });
    fireEvent.scroll(scrollContainer());

    const callsBeforeSwitch = scrollIntoView.mock.calls.length;
    await router.navigate(`/chat/${CONV_B}`);
    await screen.findByText('会話Bの発言');

    await act(async () => {});

    expect(scrollIntoView.mock.calls.length).toBeGreaterThan(callsBeforeSwitch);
  });

  it('会話 B へ移った後も、B の中で上へ遡ったら追従しない', async () => {
    const chunk2 = gate();
    stubFetch((url, init) => {
      if (url.endsWith('/chat')) {
        return sse(
          [
            { event: 'open', data: { conversationId: CONV_B } },
            { event: 'text', data: { type: 'text', text: '最初の一文' } },
            { event: 'text', data: { type: 'text', text: '、続きの一文' }, after: chunk2.promise },
            { event: 'done', data: { type: 'done' } },
          ],
          { signal: init?.signal },
        );
      }
      return backgroundForSwitch(url);
    });

    const { router } = renderChat(`/chat/${CONV_A}`);
    await screen.findByText('会話Aの発言');
    await router.navigate(`/chat/${CONV_B}`);
    await screen.findByText('会話Bの発言');

    await send('質問');
    await screen.findByText('最初の一文');

    setScrollMetrics(scrollContainer(), { scrollTop: 0, scrollHeight: 1000, clientHeight: 200 });
    fireEvent.scroll(scrollContainer());

    const callsBeforeChunk2 = scrollIntoView.mock.calls.length;
    chunk2.open();
    await waitFor(() => {
      expect(within(transcript()).getByText(/続きの一文/)).toBeTruthy();
    });

    await act(async () => {});

    expect(scrollIntoView.mock.calls.length).toBe(callsBeforeChunk2);
  });
});
