// @vitest-environment jsdom
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

const A = 'conv-3303-a';
const B = 'conv-3303-b';
const TEXT = '中断した新しい会話の本文';

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

interface PostedBody {
  text: string;
  conversationId?: string;
  clientMessageId?: string;
}

let originalFetch: typeof fetch;
let stub: ReturnType<typeof stubFetch>;
let posted: PostedBody[] = [];
// サーバが最初の送信を受け取っているか（履歴に自分の id の発言が載るか）。
let acked = false;
// 先回りの確認の応答。テストが解く（実時間の待ちを使わない）。
let lookup: () => Promise<Response> = async () => json({ conversationId: A });

beforeEach(() => {
  originalFetch = globalThis.fetch;
  localStorage.clear();
  sessionStorage.clear();
  storeTestBaseUrl();
  posted = [];
  acked = false;
  lookup = async () => {
    received();
    return json({ conversationId: A });
  };
  stub = stubFetch((url, init) => {
    if (url.includes('/client-messages/')) return lookup();
    if (url.includes(`/conversations/${A}`)) {
      const messages = acked
        ? [
            {
              id: 'm1',
              at: '2026-08-20T00:00:00Z',
              role: 'inbound',
              text: TEXT,
              clientMessageId: posted[0]?.clientMessageId,
            },
          ]
        : [];
      return json({ conversationId: A, messages });
    }
    if (url.includes(`/conversations/${B}`)) return json({ conversationId: B, messages: [] });
    if (url.includes('/approvals')) return json({ approvals: [] });
    if (url.includes('/conversations')) return json({ conversations: [], scanned: 0 });
    if (url.endsWith('/chat')) {
      const request = stub.entries.at(-1)?.request;
      return (async () => {
        posted.push((await request?.clone().json()) as PostedBody);
        if (posted.length === 1) {
          return new Promise<Response>((_, reject) => {
            init?.signal?.addEventListener('abort', () =>
              reject(new DOMException('aborted', 'AbortError')),
            );
            request?.signal.addEventListener('abort', () =>
              reject(new DOMException('aborted', 'AbortError')),
            );
          });
        }
        return sse([{ event: 'open', data: { conversationId: A } }], { signal: request?.signal });
      })();
    }
    return undefined;
  });
});

afterEach(() => {
  cleanup();
  globalThis.fetch = originalFetch;
});

async function box() {
  return (await screen.findByPlaceholderText(/クローンに話しかける/)) as HTMLTextAreaElement;
}

const lookups = () => stub.entries.filter((e) => e.url.includes('/client-messages/'));

async function sendAndAbort() {
  const view = renderChat('/chat');
  fireEvent.change(await box(), { target: { value: TEXT } });
  fireEvent.click(screen.getByRole('button', { name: 'メッセージを送信' }));
  await waitFor(() => expect(posted).toHaveLength(1));
  const stop = await screen.findByRole('button', {
    name: '受信をやめる（クローンのターンは止まらない）',
  });
  await act(async () => {
    fireEvent.click(stop);
  });
  return view;
}

function received() {
  acked = true;
}

describe('#3303: 新しい会話で中断した送信は、中断の直後に受け取り済みか確かめる', () => {
  it('受け取り済みなら、次の送信を待たずにその会話へ移り、再送の案内が下りる', async () => {
    const { router } = await sendAndAbort();
    received();
    await waitFor(() => expect(router.state.location.pathname).toBe(`/chat/${A}`));
    expect(lookups()[0]?.url).toContain(`/client-messages/${posted[0]?.clientMessageId}`);
    await waitFor(() => expect(screen.queryByRole('button', { name: '再送' })).toBeNull());
    expect((await box()).value).toBe('');
    expect(posted).toHaveLength(1);
  });

  it('受け取られていなければ（404）移らず、案内は今のまま。ページが見えるようになったとき、もう一度確かめる', async () => {
    lookup = async () => json({ error: '受け取っていない' }, 404);
    const { router } = await sendAndAbort();
    expect(await screen.findByRole('button', { name: '再送' })).toBeTruthy();
    await waitFor(() => expect(lookups()).toHaveLength(1));
    expect(router.state.location.pathname).toBe('/chat');

    received();
    lookup = async () => json({ conversationId: A });
    await act(async () => {
      document.dispatchEvent(new Event('visibilitychange'));
    });
    await waitFor(() => expect(router.state.location.pathname).toBe(`/chat/${A}`));
    await waitFor(() => expect(screen.queryByRole('button', { name: '再送' })).toBeNull());
  });

  it('確かめている間に書き足したら、勝手に移らず書きかけも失わない。次の送信は見つけた会話へ向かう', async () => {
    let release: (response: Response) => void = () => {};
    lookup = () => new Promise<Response>((resolve) => (release = resolve));
    const { router } = await sendAndAbort();
    await waitFor(() => expect(lookups()).toHaveLength(1));
    fireEvent.change(await box(), { target: { value: `${TEXT}。書き足した` } });
    await act(async () => {
      release(json({ conversationId: A }));
    });
    await act(async () => {});
    expect(router.state.location.pathname).toBe('/chat');
    expect((await box()).value).toBe(`${TEXT}。書き足した`);

    fireEvent.click(screen.getByRole('button', { name: 'メッセージを送信' }));
    await waitFor(() => expect(posted).toHaveLength(2));
    expect(posted[1]).toMatchObject({ conversationId: A });
    expect(lookups()).toHaveLength(1);
  });

  it('確かめている間に別の会話へ移ったら、勝手に引き戻さず、そちらの書きかけも失わない', async () => {
    let release: (response: Response) => void = () => {};
    lookup = () => new Promise<Response>((resolve) => (release = resolve));
    const { router } = await sendAndAbort();
    await waitFor(() => expect(lookups()).toHaveLength(1));
    await router.navigate(`/chat/${B}`);
    expect(await findShownConversation(B)).toBeTruthy();
    fireEvent.change(await box(), { target: { value: 'B の書きかけ' } });
    await act(async () => {
      release(json({ conversationId: A }));
    });
    await act(async () => {});
    expect(router.state.location.pathname).toBe(`/chat/${B}`);
    expect((await box()).value).toBe('B の書きかけ');
  });
});
