// @vitest-environment jsdom
import { cleanup, fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import { createMemoryRouter, RouterProvider, useParams } from 'react-router';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import {
  json,
  Providers,
  sse,
  storeTestBaseUrl,
  stubFetch,
  untilOpenSettled,
} from '~/test-support';

import Chat from './chat';

const CONVERSATION_ID = 'conv-follow-up';

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

// delayMs で順序を作らない: 時計への賭けは遅い実行環境で追い越されるため
function gate() {
  let open: () => void = () => {};
  const promise = new Promise<void>((resolve) => {
    open = resolve;
  });
  return { promise, open: () => open() };
}

let originalFetch: typeof fetch;

beforeEach(() => {
  originalFetch = globalThis.fetch;
  localStorage.clear();
  storeTestBaseUrl();
});

afterEach(() => {
  cleanup();
  globalThis.fetch = originalFetch;
});

async function send(text: string) {
  const box = await screen.findByPlaceholderText(/クローンに話しかける/);
  fireEvent.change(box, { target: { value: text } });
  fireEvent.click(screen.getByRole('button', { name: 'メッセージを送信' }));
}

const transcript = () => screen.getByRole('list', { name: 'やりとり' });

function captureChatBodies(): string[] {
  const bodies: string[] = [];
  const inner = globalThis.fetch;
  globalThis.fetch = (async (input: RequestInfo | URL, init?: RequestInit) => {
    if (input instanceof Request && input.url.endsWith('/chat')) {
      bodies.push(await input.clone().text());
    }
    return inner(input, init);
  }) as typeof fetch;
  return bodies;
}

function background(url: string): Response | undefined {
  if (url.includes(`/conversations/${CONVERSATION_ID}`)) {
    return json({ conversationId: CONVERSATION_ID, messages: [] });
  }
  if (url.includes('/approvals')) return json({ approvals: [] });
  if (url.includes('/conversations')) return json({ conversations: [], scanned: 0 });
  return undefined;
}

describe('順番待ちのあいだの追送', () => {
  it('受信中でも打てて、追送は会話 id 付きで投函される', async () => {
    const reply = gate();
    let chatCalls = 0;
    const signals: (AbortSignal | undefined)[] = [];

    stubFetch((url, init) => {
      if (url.endsWith('/chat')) {
        chatCalls += 1;
        signals.push(init?.signal ?? undefined);
        if (chatCalls === 1) {
          return sse(
            [
              { event: 'open', data: { conversationId: CONVERSATION_ID } },
              { event: 'queued', data: { type: 'queued' } },
              {
                event: 'text',
                data: { type: 'text', text: 'まとめて答える' },
                after: reply.promise,
              },
              { event: 'done', data: { type: 'done' } },
            ],
            { signal: init?.signal },
          );
        }
        // 流し終えても閉じない（keepOpen）: 閉じる形だと、最後まで読んでから畳む実装でも aborted が真になり、open で切っていることを測れなくなるため
        return sse(
          [
            { event: 'open', data: { conversationId: CONVERSATION_ID } },
            { event: 'text', data: { type: 'text', text: 'にせもの' } },
          ],
          { signal: init?.signal, keepOpen: true },
        );
      }
      return background(url);
    });
    const bodies = captureChatBodies();

    renderChat(`/chat/${CONVERSATION_ID}`);
    await send('一つ目');
    expect(await screen.findByText('順番を待っている…')).toBeTruthy();

    const box = await screen.findByPlaceholderText(/クローンに話しかける/);
    expect((box as HTMLTextAreaElement).disabled).toBe(false);

    await send('二つ目');
    await waitFor(() => {
      expect(bodies.length).toBe(2);
    });
    expect(JSON.parse(bodies[1] ?? '{}')).toEqual({
      text: '二つ目',
      conversationId: CONVERSATION_ID,
      clientMessageId: expect.stringMatching(/^[A-Za-z0-9_-]{1,128}$/),
    });

    await waitFor(() => {
      expect(signals[1]?.aborted).toBe(true);
    });
    expect(signals[0]?.aborted).toBe(false);

    reply.open();
    expect(await screen.findByText('まとめて答える')).toBeTruthy();

    expect(within(transcript()).getByText('一つ目')).toBeTruthy();
    expect(within(transcript()).getByText('二つ目')).toBeTruthy();
    expect(screen.queryByText('にせもの')).toBeNull();
  });

  it('新しい会話では、id が決まるまで追送を待たせてから投函する', async () => {
    const opened = gate();
    const reply = gate();
    let chatCalls = 0;

    stubFetch((url, init) => {
      if (url.endsWith('/chat')) {
        chatCalls += 1;
        if (chatCalls === 1) {
          return sse(
            [
              {
                event: 'open',
                data: { conversationId: CONVERSATION_ID },
                after: opened.promise,
              },
              {
                event: 'text',
                data: { type: 'text', text: 'まとめて答える' },
                after: reply.promise,
              },
              { event: 'done', data: { type: 'done' } },
            ],
            { signal: init?.signal },
          );
        }
        return sse([{ event: 'open', data: { conversationId: CONVERSATION_ID } }], {
          signal: init?.signal,
          keepOpen: true,
        });
      }
      return background(url);
    });
    const bodies = captureChatBodies();

    const { router } = renderChat('/chat');
    await send('一つ目');
    await send('二つ目');

    expect(bodies.length).toBe(1);

    opened.open();
    await waitFor(() => {
      expect(bodies.length).toBe(2);
    });
    expect(JSON.parse(bodies[1] ?? '{}')).toEqual({
      text: '二つ目',
      conversationId: CONVERSATION_ID,
      clientMessageId: expect.stringMatching(/^[A-Za-z0-9_-]{1,128}$/),
    });

    await untilOpenSettled(router, CONVERSATION_ID);
    reply.open();
    expect(await screen.findByText('まとめて答える')).toBeTruthy();
    expect(within(transcript()).getByText('一つ目')).toBeTruthy();
    expect(within(transcript()).getByText('二つ目')).toBeTruthy();
  });
});
