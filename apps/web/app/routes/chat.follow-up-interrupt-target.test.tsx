// @vitest-environment jsdom
import { act, cleanup, fireEvent, render, screen } from '@testing-library/react';
import { createMemoryRouter, RouterProvider, useParams } from 'react-router';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { gate, json, Providers, sse, storeTestBaseUrl, stubFetch } from '~/test-support';

import Chat from './chat';

const ID = 'conv-3990-follow';
const NO_TARGET = '止める対象が分からないので、何も止めていません';

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

const IDLE: Frame[] = [
  { event: 'open', data: { conversationId: ID, inProgress: false, pending: [] } },
];

/**
 * 1通目は走っているターン、2通目（追送）は順番待ちになる筋書き。`afterFirst` は最初のターンが終わった後の再生の応答
 * （追送の `clientMessageId` を受けて組む）。画面を開いたときの再生は空。
 */
function setup(afterFirst: (followUpId: string) => Frame[], outcome = 'withdrawn') {
  const done = gate();
  let replayCalls = 0;
  const stub = stubFetch(async (url, init) => {
    if (/\/chat\/[^/]+\/stream$/.test(url)) {
      replayCalls += 1;
      if (replayCalls === 1) return sse(IDLE, { signal: init?.signal, delayMs: 0 });
      const posted = stub.entries.filter((entry) => entry.url.endsWith('/chat'));
      const body = (await posted[1]?.request?.clone().text()) ?? '{}';
      const followUpId = (JSON.parse(body) as { clientMessageId?: string }).clientMessageId ?? '';
      const frames = replayCalls === 2 ? afterFirst(followUpId) : IDLE;
      return sse(frames, { signal: init?.signal, delayMs: 0, keepOpen: frames.length > 1 });
    }
    if (url.endsWith('/clone/interrupt')) return json({ outcome });
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
  return { done, stub, replayCount: () => replayCalls };
}

const interrupts = (stub: { entries: { url: string }[] }) =>
  stub.entries.filter((entry) => entry.url.endsWith('/clone/interrupt'));

async function followUpIdOf(stub: ReturnType<typeof setup>['stub']): Promise<string> {
  const posted = stub.entries.filter((entry) => entry.url.endsWith('/chat'));
  const body = (await posted[1]?.request?.clone().text()) ?? '{}';
  return (JSON.parse(body) as { clientMessageId?: string }).clientMessageId ?? '';
}

async function reachFollowUpWait(done: ReturnType<typeof gate>) {
  renderApp(`/chat/${ID}`);
  await settle();
  await send('一つ目');
  await send('二つ目');
  done.open();
  await settle();
}

const press = () =>
  fireEvent.click(screen.getByRole('button', { name: 'クローンのターンを止める' }));

describe('追送だけが順番待ちのときの「ターンを止める」（#3990）', () => {
  it('取り直しを待っている間（受信が無い）は、追送を対象に付けて取り下げ、取り直しを畳む', async () => {
    const { done, stub, replayCount } = setup((followUpId) => [
      {
        event: 'open',
        data: {
          conversationId: ID,
          inProgress: false,
          pending: [{ clientMessageId: followUpId, state: 'queued' }],
        },
      },
    ]);
    await reachFollowUpWait(done);

    press();
    await settle();

    const calls = interrupts(stub);
    expect(calls).toHaveLength(1);
    expect(await calls[0]?.request?.clone().json()).toEqual({
      conversationId: ID,
      clientMessageId: await followUpIdOf(stub),
    });
    expect(screen.getByText(/順番待ちだった発言を取り下げました/)).toBeTruthy();
    // 取り下げた追送を待ち続けない。
    const before = replayCount();
    await settle(60_000);
    expect(replayCount()).toBe(before);
  });

  it('先客のターンの再生中に自分の追送だけが queued なら、その追送を対象に取り下げる', async () => {
    const { done, stub } = setup((followUpId) => [
      {
        event: 'open',
        data: {
          conversationId: ID,
          inProgress: true,
          pending: [{ clientMessageId: followUpId, state: 'queued' }],
        },
      },
      { event: 'text', data: { type: 'text', text: '先客のターンの途中' } },
    ]);
    await reachFollowUpWait(done);
    expect(screen.getByText('先客のターンの途中')).toBeTruthy();

    press();
    await settle();

    const calls = interrupts(stub);
    expect(calls).toHaveLength(1);
    expect(await calls[0]?.request?.clone().json()).toEqual({
      conversationId: ID,
      clientMessageId: await followUpIdOf(stub),
    });
  });

  it('陰性対照: queued が自分の追送でなければ対象にせず、呼ばずに「止める対象が分からない」と言う', async () => {
    const { done, stub } = setup(() => [
      {
        event: 'open',
        data: {
          conversationId: ID,
          inProgress: true,
          pending: [{ clientMessageId: 'someone-else', state: 'queued' }],
        },
      },
      { event: 'text', data: { type: 'text', text: '先客のターンの途中' } },
    ]);
    await reachFollowUpWait(done);

    press();
    await settle();

    expect(screen.getByText(new RegExp(NO_TARGET))).toBeTruthy();
    expect(interrupts(stub)).toHaveLength(0);
  });
});
