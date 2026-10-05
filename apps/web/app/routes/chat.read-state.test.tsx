// @vitest-environment jsdom
/**
 * 会話の既読（PR2、Web UI）。**1つの規則**: 会話の画面が表示されていて、タブが見えているとき、
 * 画面に出ている日誌由来の発言の最後のものまで既読にする（`docs/architecture.md`「会話の既読」）。
 *
 * - 開いて中身が出たら既読。裏のタブでは送らず、見えるようになったら送る
 * - 送信して完了まで居て、返答が日誌の発言として出た時点で既読。完了前に離れた・タブを
 *   裏にした・接続が切れて返答が出なかったときは送らない
 * - 受信の途中の一時的な文字（transient）では既読にしない
 *
 * 時計に賭けない: 順序は `after` に渡す約束（テストが解決する）で作り、待つのは `vi.waitFor`。
 */
import { act, cleanup, fireEvent, render, screen } from '@testing-library/react';
import { createMemoryRouter, RouterProvider, useParams } from 'react-router';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { useJournalLive } from '@alteroid/swr';
import { json, Providers, sse, stubFetch, storeTestBaseUrl, type Route } from '~/test-support';

import Chat from './chat';

const ID = 'conv-1';

const ChatRoute = Chat as unknown as (props: {
  loaderData: { conversationId: string | undefined };
}) => React.ReactElement;

function Harness() {
  useJournalLive();
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

type Message = { id: string; at: string; role: 'inbound' | 'outbound'; text: string };

const M_HUMAN: Message = {
  id: 'm1',
  at: '2026-08-20T00:00:00.000Z',
  role: 'inbound',
  text: '先に頼んだこと',
};
const M_REPLY: Message = {
  id: 'm2',
  at: '2026-08-20T00:01:00.000Z',
  role: 'outbound',
  text: '済ませておいた',
};
const M_LATE: Message = {
  id: 'm3',
  at: '2026-08-20T00:10:00.000Z',
  role: 'outbound',
  text: '続きの返答',
};

/** サーバ側の状態（テストが書き換える）。 */
interface Server {
  messages: Message[];
  readThrough: string;
  unreadCount: number;
  reads: string[];
}

function makeServer(messages: Message[], readThrough: string, unreadCount: number): Server {
  return { messages, readThrough, unreadCount, reads: [] };
}

function conversationRoute(server: Server, extra?: Route): Route {
  return (url, init) => {
    const custom = extra?.(url, init);
    if (custom !== undefined) return custom;
    if (url.endsWith('/journal/stream')) return sse([], { keepOpen: true, signal: init?.signal });
    if (url.includes(`/conversations/${ID}/read`)) {
      // 位置は後戻りしない（サーバの規則）。読んだ記録はヘルパーが `request` から取る。
      server.unreadCount = 0;
      return json({ conversationId: ID, readThrough: server.readThrough, unreadCount: 0 });
    }
    if (url.includes(`/conversations/${ID}`)) {
      return json({
        conversationId: ID,
        messages: server.messages,
        supersededCount: 0,
        readThrough: server.readThrough,
        unreadCount: server.unreadCount,
      });
    }
    if (url.includes('/approvals')) return json({ approvals: [] });
    if (url.includes('/conversations')) {
      return json({
        conversations: [],
        scanned: 0,
        reachedStart: true,
        hiddenByLimit: 0,
      });
    }
    return undefined;
  };
}

let originalFetch: typeof fetch;
let stub: ReturnType<typeof stubFetch>;

beforeEach(() => {
  originalFetch = globalThis.fetch;
  localStorage.clear();
  storeTestBaseUrl();
});

afterEach(() => {
  cleanup();
  globalThis.fetch = originalFetch;
  // `visibilityState` は document 自身の持ち物として差し替える。消せば prototype の既定（visible）へ戻る。
  Reflect.deleteProperty(document, 'visibilityState');
});

function setVisibility(state: 'visible' | 'hidden') {
  Object.defineProperty(document, 'visibilityState', { configurable: true, get: () => state });
}

function becomeVisible() {
  setVisibility('visible');
  document.dispatchEvent(new Event('visibilitychange'));
}

/** `POST /conversations/:id/read` の記録。送った `through` を順に返す。 */
async function readThroughs(): Promise<string[]> {
  const posts = stub.entries.filter(
    (entry) => entry.url.includes('/read') && entry.request?.method === 'POST',
  );
  return Promise.all(
    posts.map(async (entry) => {
      const body = (await entry.request?.clone().json()) as { through: string };
      return body.through;
    }),
  );
}

function deferred() {
  let resolve: () => void = () => {};
  const promise = new Promise<void>((r) => {
    resolve = r;
  });
  return { promise, resolve };
}

async function send(text: string) {
  const box = await screen.findByPlaceholderText(/クローンに話しかける/);
  fireEvent.change(box, { target: { value: text } });
  fireEvent.click(screen.getByRole('button', { name: /送る/ }));
}

describe('開いたとき・タブが見えるようになったとき', () => {
  it('開いて中身が出たら、最後の発言の id で既読にする（同じ id は重ねて送らない）', async () => {
    const server = makeServer([M_HUMAN, M_REPLY], '2026-08-19T00:00:00.000Z', 1);
    stub = stubFetch(conversationRoute(server));

    renderChat(`/chat/${ID}`);

    await screen.findByText(M_REPLY.text);
    await vi.waitFor(async () => expect(await readThroughs()).toEqual(['m2']));
    // 取り直されても（位置は進んだ）同じ id を送り直さない。
    fireEvent.focus(window);
    await screen.findByText(M_REPLY.text);
    expect(await readThroughs()).toEqual(['m2']);
  });

  it('すでに最後まで読んでいれば送らない', async () => {
    const server = makeServer([M_HUMAN, M_REPLY], M_REPLY.at, 0);
    stub = stubFetch(conversationRoute(server));

    renderChat(`/chat/${ID}`);

    await screen.findByText(M_REPLY.text);
    expect(await readThroughs()).toEqual([]);
  });

  it('タブが裏のあいだは送らず、見えるようになったら送る', async () => {
    setVisibility('hidden');
    const server = makeServer([M_HUMAN, M_REPLY], '2026-08-19T00:00:00.000Z', 1);
    stub = stubFetch(conversationRoute(server));

    renderChat(`/chat/${ID}`);

    await screen.findByText(M_REPLY.text);
    expect(await readThroughs()).toEqual([]);

    becomeVisible();

    await vi.waitFor(async () => expect(await readThroughs()).toEqual(['m2']));
  });

  it('送れなかった（失敗した）ときは黙って無視し、次の機会に送り直す', async () => {
    const server = makeServer([M_HUMAN, M_REPLY], '2026-08-19T00:00:00.000Z', 1);
    let failing = true;
    stub = stubFetch(
      conversationRoute(server, (url) =>
        failing && url.includes('/read') ? json({ error: 'internal' }, 500) : undefined,
      ),
    );

    renderChat(`/chat/${ID}`);

    await screen.findByText(M_REPLY.text);
    await vi.waitFor(async () => expect(await readThroughs()).toEqual(['m2']));
    expect(screen.queryByRole('alert')).toBeNull();

    failing = false;
    // 次の機会: 裏へ回って戻る。
    act(() => {
      setVisibility('hidden');
      document.dispatchEvent(new Event('visibilitychange'));
    });
    act(becomeVisible);
    await vi.waitFor(async () => expect((await readThroughs()).length).toBeGreaterThanOrEqual(2));
  });
});

describe('送信して、返答の完了まで居たとき', () => {
  /** 送信 → open / text（途中）→ done、返答は日誌の exchange で届く。 */
  function sendScenario() {
    const server = makeServer([M_HUMAN], M_HUMAN.at, 0);
    const chatDone = deferred();
    const journalReply = deferred();
    const route = conversationRoute(server, (url, init) => {
      if (url.endsWith('/journal/stream')) {
        return sse(
          [
            {
              event: 'exchange',
              data: {
                type: 'exchange',
                id: M_LATE.id,
                at: M_LATE.at,
                with: 'human',
                role: 'outbound',
                text: M_LATE.text,
                conversationId: ID,
              },
              after: journalReply.promise,
            },
          ],
          { keepOpen: true, signal: init?.signal },
        );
      }
      if (url.endsWith('/chat')) {
        return sse(
          [
            { event: 'open', data: { conversationId: ID } },
            { event: 'text', data: { type: 'text', text: '考え中の途中の文字' } },
            { event: 'done', data: { type: 'done' }, after: chatDone.promise },
          ],
          { signal: init?.signal },
        );
      }
      return undefined;
    });
    stub = stubFetch(route);
    /** サーバが返答を日誌へ載せ、画面が追いつく。 */
    const replyLands = () => {
      server.messages = [M_HUMAN, M_LATE];
      server.readThrough = M_HUMAN.at;
      server.unreadCount = 1;
      journalReply.resolve();
    };
    return { server, chatDone, replyLands };
  }

  it('完了まで画面に居て、返答が日誌の発言として出たら、その id で既読にする（途中の文字では送らない）', async () => {
    const { chatDone, replyLands } = sendScenario();
    renderChat(`/chat/${ID}`);
    await screen.findByText(M_HUMAN.text);

    await send('続きもお願い');
    await screen.findByText('考え中の途中の文字');
    // 途中の文字は日誌の発言ではない: これで既読にしない。
    expect(await readThroughs()).toEqual([]);

    replyLands();
    chatDone.resolve();

    await screen.findByText(M_LATE.text);
    await vi.waitFor(async () => expect(await readThroughs()).toEqual(['m3']));
  });

  it('完了前に画面を離れた（アンマウント）ら、返答の id では送らない', async () => {
    const { chatDone, replyLands } = sendScenario();
    const view = renderChat(`/chat/${ID}`);
    await screen.findByText(M_HUMAN.text);
    await send('続きもお願い');
    await screen.findByText('考え中の途中の文字');

    view.unmount();
    replyLands();
    chatDone.resolve();
    // 画面が無いので何も走らない。取り込み待ちの発火を流してから確かめる。
    await Promise.resolve();
    await Promise.resolve();

    expect(await readThroughs()).toEqual([]);
  });

  it('完了前にタブを裏にしたら、裏のあいだは返答の id で送らず、表に戻って見えた時点で送る', async () => {
    const { chatDone, replyLands } = sendScenario();
    renderChat(`/chat/${ID}`);
    await screen.findByText(M_HUMAN.text);
    await send('続きもお願い');
    await screen.findByText('考え中の途中の文字');

    setVisibility('hidden');
    document.dispatchEvent(new Event('visibilitychange'));
    replyLands();
    chatDone.resolve();

    await screen.findByText(M_LATE.text);
    expect(await readThroughs()).toEqual([]);

    // 表に戻って見えた時点で既読にする（1つの規則: 見えているタブで、画面に出ている発言まで）。
    act(becomeVisible);
    await vi.waitFor(async () => expect(await readThroughs()).toEqual(['m3']));
  });

  it('接続が切れて返答が出なかったら、送らない', async () => {
    const server = makeServer([M_HUMAN], M_HUMAN.at, 0);
    stub = stubFetch(
      conversationRoute(server, (url, init) =>
        url.endsWith('/chat')
          ? sse(
              [
                { event: 'open', data: { conversationId: ID } },
                { event: 'text', data: { type: 'text', text: '考え中の途中の文字' } },
                { event: 'error', data: { type: 'error', message: '接続が切れた' } },
              ],
              { signal: init?.signal },
            )
          : undefined,
      ),
    );
    renderChat(`/chat/${ID}`);
    await screen.findByText(M_HUMAN.text);

    await send('続きもお願い');
    await screen.findByRole('alert');

    expect(await readThroughs()).toEqual([]);
  });
});
