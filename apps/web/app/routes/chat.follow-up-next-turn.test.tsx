// @vitest-environment jsdom
import { act, cleanup, fireEvent, render, screen } from '@testing-library/react';
import { createMemoryRouter, RouterProvider, useParams } from 'react-router';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { gate, json, Providers, sse, storeTestBaseUrl, stubFetch } from '~/test-support';

import Chat from './chat';

const ID = 'conv-4085';

const ChatRoute = Chat as unknown as (props: {
  loaderData: { conversationId: string | undefined };
}) => React.ReactElement;

function Harness() {
  const params = useParams();
  return <ChatRoute loaderData={{ conversationId: params.conversationId }} />;
}

function renderApp(initial: string) {
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
beforeEach(() => {
  originalFetch = globalThis.fetch;
  localStorage.clear();
  storeTestBaseUrl();
  // 取り直しの待ちを実時間で待たない。
  vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout'] });
});
afterEach(() => {
  cleanup();
  vi.useRealTimers();
  globalThis.fetch = originalFetch;
});

async function settle(ms = 100) {
  await act(async () => {
    await vi.advanceTimersByTimeAsync(ms);
  });
}

async function send(text: string) {
  fireEvent.change(screen.getByPlaceholderText(/クローンに話しかける/), {
    target: { value: text },
  });
  fireEvent.click(screen.getByRole('button', { name: 'メッセージを送信' }));
  await settle();
}

type Frame = { event: string; data: unknown };

/**
 * 1通目は走っているターンへ、2通目（追送）は次のターンに回る筋書き。
 * `replays` は再生の口（`GET /chat/:id/stream`）の応答を、呼ばれた順に返す（最初の1回は画面を開いたとき）。
 */
function setup(replays: ((followUpId: string) => Frame[])[]) {
  const done = gate();
  let replayCalls = 0;
  const replay = async (signal: AbortSignal | null | undefined): Promise<Response> => {
    const make = replays[Math.min(replayCalls, replays.length - 1)];
    replayCalls += 1;
    const posted = stub.entries.filter((entry) => entry.url.endsWith('/chat'));
    const body = (await posted[1]?.request?.clone().text()) ?? '{}';
    const followUpId = (JSON.parse(body) as { clientMessageId?: string }).clientMessageId ?? '';
    return sse(make?.(followUpId) ?? [], { signal, delayMs: 0 });
  };
  const stub = stubFetch((url, init) => {
    if (/\/chat\/[^/]+\/stream$/.test(url)) return replay(init?.signal);
    if (url.endsWith('/chat')) {
      const posted = stub.entries.filter((entry) => entry.url.endsWith('/chat'));
      if (posted.length <= 1) {
        return sse(
          [
            { event: 'open', data: { conversationId: ID } },
            { event: 'text', data: { type: 'text', text: '一つ目の返信' } },
            { event: 'done', data: { type: 'done' }, after: done.promise },
          ],
          { signal: init?.signal, delayMs: 0 },
        );
      }
      return sse([{ event: 'open', data: { conversationId: ID } }], {
        signal: init?.signal,
        delayMs: 0,
        keepOpen: true,
      });
    }
    if (url.includes(`/conversations/${ID}`)) return json({ conversationId: ID, messages: [] });
    if (url.includes('/approvals')) return json({ approvals: [] });
    if (url.includes('/conversations')) return json({ conversations: [], scanned: 0 });
    return undefined;
  });
  const replayCount = () => replayCalls;
  return { done, replayCount };
}

const IDLE: Frame[] = [
  { event: 'open', data: { conversationId: ID, inProgress: false, pending: [] } },
];

describe('受信中に打った追送が次のターンに回ったとき（#4085）', () => {
  it('最初の done のあと、再生の口で取り直して、次のターンの返信が流れる', async () => {
    const { done, replayCount } = setup([
      () => IDLE,
      (followUpId) => [
        {
          event: 'open',
          data: {
            conversationId: ID,
            inProgress: true,
            pending: [{ clientMessageId: followUpId, state: 'running' }],
          },
        },
        { event: 'text', data: { type: 'text', text: '二つ目の返信' } },
        { event: 'done', data: { type: 'done' } },
      ],
      // 2つ目のターンが終わったあとの確かめ。追送はもう待っていない。
      () => IDLE,
    ]);
    renderApp(`/chat/${ID}`);
    await settle();
    await send('一つ目');
    expect(screen.getByText('一つ目の返信')).toBeTruthy();
    await send('二つ目');

    done.open();
    await settle();

    expect(screen.getByText('二つ目の返信')).toBeTruthy();
    expect(replayCount()).toBe(3);
  });

  it('次のターンがまだ始まっていない（starting）間は、待って取り直す', async () => {
    const { done, replayCount } = setup([
      () => IDLE,
      (followUpId) => [
        {
          event: 'open',
          data: {
            conversationId: ID,
            inProgress: false,
            pending: [{ clientMessageId: followUpId, state: 'starting' }],
          },
        },
      ],
      (followUpId) => [
        {
          event: 'open',
          data: {
            conversationId: ID,
            inProgress: true,
            pending: [{ clientMessageId: followUpId, state: 'running' }],
          },
        },
        { event: 'text', data: { type: 'text', text: '二つ目の返信' } },
        { event: 'done', data: { type: 'done' } },
      ],
      () => IDLE,
    ]);
    renderApp(`/chat/${ID}`);
    await settle();
    await send('一つ目');
    await send('二つ目');

    done.open();
    await settle(5_000);

    expect(screen.getByText('二つ目の返信')).toBeTruthy();
    expect(replayCount()).toBe(4);
  });

  it('陰性対照: 追送が最初のターンにまとめられた（pending が空）なら、取り直しは1回で止まる', async () => {
    const { done, replayCount } = setup([() => IDLE]);
    renderApp(`/chat/${ID}`);
    await settle();
    await send('一つ目');
    await send('二つ目');

    done.open();
    await settle(60_000);

    expect(replayCount()).toBe(2);
  });

  it('陰性対照: 追送を打っていなければ、done のあとに取り直さない', async () => {
    const { done, replayCount } = setup([() => IDLE]);
    renderApp(`/chat/${ID}`);
    await settle();
    await send('一つ目');

    done.open();
    await settle(60_000);

    expect(replayCount()).toBe(1);
  });
});
