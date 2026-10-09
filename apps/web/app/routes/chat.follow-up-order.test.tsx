// @vitest-environment jsdom
import { useJournalLive } from '@alteroid/swr';
import { cleanup, fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import { createMemoryRouter, RouterProvider, useParams } from 'react-router';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import { json, Providers, sse, storeTestBaseUrl, stubFetch } from '~/test-support';

import Chat from './chat';

// #4391: 返信の本文が流れ終わってもターンが続いているあいだに人間が続けて発言すると、その発言が返信より上に出ていた。
// デーモンは発言を記録するとき、それまでの返信を先に日誌へ書き、同じ同期区間で `queued` を流す。画面はその `queued` で返信の行を分ける。

const ID = 'conv-follow-up-order';
const QUESTION = '二つ目の質問';
const REPLY = 'AIの回答2の本文';
const FOLLOW = '回答2への返事';
const TAIL = '返事を受けた続き';
// 道具を挟んで再開した本文: 日誌では区切りの空行（#4339）を挟んで TAIL と1発言になる
const AFTER_TOOL = '道具の後の本文';

const ChatRoute = Chat as unknown as (props: {
  loaderData: { conversationId: string | undefined };
}) => React.ReactElement;

function Harness() {
  useJournalLive();
  const params = useParams();
  return <ChatRoute loaderData={{ conversationId: params.conversationId }} />;
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

function gate() {
  let open: () => void = () => {};
  const promise = new Promise<void>((resolve) => {
    open = resolve;
  });
  return { promise, open: () => open() };
}

async function send(text: string) {
  fireEvent.change(await screen.findByPlaceholderText(/クローンに話しかける/), {
    target: { value: text },
  });
  fireEvent.click(screen.getByRole('button', { name: 'メッセージを送信' }));
}

const items = () =>
  within(screen.getByRole('list', { name: 'やりとり' }))
    .getAllByRole('listitem')
    .map((li) => li.textContent ?? '');

const indexOf = (shown: string[], text: string) => shown.findIndex((item) => item.includes(text));
const countOf = (shown: string[], text: string) =>
  shown.filter((item) => item.includes(text)).length;

type Message = { id: string; at: string; role: 'inbound' | 'outbound'; text: string };

const question: Message = {
  id: 'm1',
  at: '2026-10-10T01:00:00.000Z',
  role: 'inbound',
  text: QUESTION,
};
const follow: Message = { id: 'm3', at: '2026-10-10T01:00:20.000Z', role: 'inbound', text: FOLLOW };

describe.each([
  {
    label: '割るデーモン（#4391 以降）',
    split: true,
    // 発言の記録の前に、そこまでの返信が書かれる
    whenQueued: [
      question,
      { id: 'm2', at: '2026-10-10T01:00:19.000Z', role: 'outbound', text: REPLY },
      follow,
    ] as Message[],
    whenDone: [
      question,
      { id: 'm2', at: '2026-10-10T01:00:19.000Z', role: 'outbound', text: REPLY },
      follow,
      {
        id: 'm4',
        at: '2026-10-10T01:00:40.000Z',
        role: 'outbound',
        text: `${TAIL}\n\n${AFTER_TOOL}`,
      },
    ] as Message[],
  },
  {
    label: '割らない古いデーモン',
    split: false,
    whenQueued: [question, follow] as Message[],
    whenDone: [
      question,
      follow,
      // 追送の割り目には区切りが入らず、道具の境目にだけ入る
      {
        id: 'm4',
        at: '2026-10-10T01:00:40.000Z',
        role: 'outbound',
        text: `${REPLY}${TAIL}\n\n${AFTER_TOOL}`,
      },
    ] as Message[],
  },
])('ターン中の追送: $label', ({ split, whenQueued, whenDone }) => {
  it('返信は追送の前と後に分かれて出て、確定しても写しが残らない', async () => {
    const queued = gate();
    const tail = gate();
    const finished = gate();
    const recorded = gate();
    const settled = gate();
    let messages: Message[] = [question];
    let chatCalls = 0;

    stubFetch((url, init) => {
      if (url.endsWith('/chat')) {
        chatCalls += 1;
        if (chatCalls === 1) {
          return sse(
            [
              { event: 'open', data: { conversationId: ID } },
              { event: 'text', data: { type: 'text', text: REPLY } },
              { event: 'queued', data: { type: 'queued' }, after: queued.promise },
              { event: 'text', data: { type: 'text', text: TAIL }, after: tail.promise },
              { event: 'tool', data: { type: 'tool', tool: 'journal_search' } },
              { event: 'text', data: { type: 'text', text: AFTER_TOOL } },
              { event: 'done', data: { type: 'done' }, after: finished.promise },
            ],
            { signal: init?.signal },
          );
        }
        return sse([{ event: 'open', data: { conversationId: ID } }], {
          signal: init?.signal,
          keepOpen: true,
        });
      }
      if (url.endsWith('/journal/stream')) {
        const exchange = (id: string, text: string) => ({
          type: 'exchange',
          id,
          at: '2026-10-10T01:00:20.000Z',
          with: 'human',
          role: 'inbound',
          text,
          conversationId: ID,
        });
        return sse(
          [
            { event: 'open', data: { ok: true } },
            { event: 'exchange', data: exchange('j1', FOLLOW), after: recorded.promise },
            { event: 'exchange', data: exchange('j2', TAIL), after: settled.promise },
          ],
          { keepOpen: true, signal: init?.signal, delayMs: 0 },
        );
      }
      if (url.includes(`/conversations/${ID}`)) {
        return json({ conversationId: ID, messages, scanned: 0, reachedStart: true });
      }
      if (url.includes('/approvals')) return json({ approvals: [] });
      if (url.includes('/conversations')) return json({ conversations: [], scanned: 0 });
      return undefined;
    });

    const router = createMemoryRouter(
      [
        { path: '/chat', Component: Harness },
        { path: '/chat/:conversationId', Component: Harness },
      ],
      { initialEntries: [`/chat/${ID}`] },
    );
    render(
      <Providers>
        <RouterProvider router={router} />
      </Providers>,
    );

    await send(QUESTION);
    await screen.findByText(REPLY);
    await send(FOLLOW);
    await waitFor(() => {
      expect(chatCalls).toBe(2);
    });

    // デーモンが追送を記録した: 返信の行が分かれ、履歴に追送が入る
    messages = whenQueued;
    queued.open();
    recorded.open();
    if (split) {
      await waitFor(() => {
        const shown = items();
        expect(countOf(shown, FOLLOW)).toBe(1);
        expect(countOf(shown, REPLY)).toBe(1);
        expect(indexOf(shown, REPLY)).toBeLessThan(indexOf(shown, FOLLOW));
      });
    }

    tail.open();
    await waitFor(() => {
      const shown = items();
      expect(countOf(shown, TAIL)).toBe(1);
      expect(countOf(shown, AFTER_TOOL)).toBe(1);
      // 追送の後に流れた続きは、追送より下に出る
      expect(indexOf(shown, FOLLOW)).toBeLessThan(indexOf(shown, TAIL));
    });

    const expectSettled = () => {
      const shown = items();
      expect(countOf(shown, REPLY)).toBe(1);
      expect(countOf(shown, TAIL)).toBe(1);
      expect(countOf(shown, AFTER_TOOL)).toBe(1);
      expect(countOf(shown, FOLLOW)).toBe(1);
      if (split) {
        expect(indexOf(shown, QUESTION)).toBeLessThan(indexOf(shown, REPLY));
        expect(indexOf(shown, REPLY)).toBeLessThan(indexOf(shown, FOLLOW));
        expect(indexOf(shown, FOLLOW)).toBeLessThan(indexOf(shown, TAIL));
      }
    };

    // 日誌に残りの返信が載った（`done` はまだ）: 手元の写しは履歴と照合して引き取られる。
    // `done` の後に見るだけだと、受信を閉じた後の後片付けが写しを消すので照合の穴が隠れる
    messages = whenDone;
    settled.open();
    await waitFor(() => {
      expect(items().filter((item) => item.includes(TAIL) && item.includes(AFTER_TOOL))).toEqual([
        expect.any(String),
      ]);
    });
    expectSettled();

    finished.open();
    await waitFor(() => {
      expect(screen.queryByText(/返信が終わった/)).not.toBeNull();
    });
    expectSettled();
  });
});
