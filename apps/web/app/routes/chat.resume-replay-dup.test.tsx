// @vitest-environment jsdom
/**
 * 再生し直しても、前の途中経過が残って二重にならないこと（Issue #2662、Web）。
 *
 * サーバの `GET /chat/:id/stream` は進行中のターンの途中経過を**頭から**再生する。
 * 終端（`done`/`error`）を見ずに終わった前のストリームが積んだ返信行が残っていると、
 * 張り直した再生が新しい行を頭から積んで、同じ文章が2行並ぶ。張り直しが起きるのは次の3つ。
 *
 * - 再生の最中に資格が替わる（`ApiProvider` が新しい client を作る → 効果が張り直す）
 * - 同じ画面で会話を A→B→A と切り替えて戻る
 * - 自分の送信で途中まで受けた返信が残ったまま、別の会話へ行って戻る
 *
 * **実時間を待たない。** 順序は `sse()` の `after`（テスト側が解決するゲート）で作る。
 */
import { useApiContext, useJournalLive } from '@alteroid/swr';
import { act, cleanup, fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import { useRef } from 'react';
import { createMemoryRouter, RouterProvider, useParams } from 'react-router';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import { json, Providers, sse, stubFetch, storeTestBaseUrl, type Route } from '~/test-support';

import Chat from './chat';

const ID = 'conv-1';
const OTHER = 'conv-2';

const ChatRoute = Chat as unknown as (props: {
  loaderData: { conversationId: string | undefined };
}) => React.ReactElement;

/** 資格を替える口（`ApiProvider` の `setCredential` を画面の中から呼ぶ）。 */
function CredentialSwitch() {
  const { setCredential } = useApiContext();
  const count = useRef(0);
  return (
    <button
      type="button"
      onClick={() =>
        setCredential({
          token: `token-${(count.current += 1)}`,
          account: { id: 'a1', name: 'テスト' } as never,
          grantedAtClaim: true,
          createdAt: '2026-10-01T00:00:00.000Z',
        })
      }
    >
      資格を替える
    </button>
  );
}

function Harness() {
  useJournalLive();
  const params = useParams();
  return (
    <>
      <CredentialSwitch />
      <ChatRoute loaderData={{ conversationId: params.conversationId }} />
    </>
  );
}

function renderApp(initial: string) {
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
  return { router, ...view };
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
  return { promise, open };
}

type Frames = Parameters<typeof sse>[0];

interface Replay {
  frames: Frames;
  keepOpen: boolean;
}

function setup({
  replays,
  chat,
}: {
  replays: Replay[];
  chat?: { frames: Frames; keepOpen: boolean };
}) {
  let replayIndex = 0;
  const route: Route = (url, init) => {
    const stream = /\/chat\/([^/]+)\/stream$/.exec(url);
    if (stream !== null) {
      const replay = replays[replayIndex++];
      if (replay === undefined) throw new Error(`再生の口が想定より多く張られた: ${url}`);
      return sse(replay.frames, { keepOpen: replay.keepOpen, signal: init?.signal, delayMs: 0 });
    }
    if (url.endsWith('/chat')) {
      return sse(chat?.frames ?? [{ event: 'open', data: { conversationId: ID } }], {
        keepOpen: chat?.keepOpen ?? false,
        signal: init?.signal,
        delayMs: 0,
      });
    }
    const detail = /\/conversations\/([^/?]+)/.exec(url);
    if (detail !== null) {
      const id = detail[1] as string;
      return json({
        conversationId: id,
        messages: [
          {
            id: `m-${id}`,
            at: '2026-10-01T00:00:00.000Z',
            role: 'inbound',
            text: id === ID ? 'やあ' : '別の話',
          },
        ],
      });
    }
    if (url.includes('/approvals')) return json({ approvals: [] });
    if (url.includes('/conversations')) return json({ conversations: [], scanned: 0 });
    if (url.endsWith('/journal/stream')) {
      return sse([{ event: 'open', data: { ok: true } }], {
        keepOpen: true,
        signal: init?.signal,
        delayMs: 0,
      });
    }
    return undefined;
  };
  const stub = stubFetch(route);
  const streamCalls = () => stub.calls.filter((url) => /\/chat\/[^/]+\/stream$/.test(url)).length;
  return { streamCalls };
}

const transcript = () => screen.getByRole('list', { name: 'やりとり' });
const open = (inProgress: boolean, id = ID) => ({
  event: 'open',
  data: { conversationId: id, inProgress },
});
const text = (value: string) => ({ event: 'text', data: { type: 'text', text: value } });
const done = { event: 'done', data: { type: 'done' } };

describe('再生し直しても、前の途中経過が残って二重にならない', () => {
  it('再生の最中に資格が替わって頭から再生し直されても、途中の行は1行のまま伸びる', async () => {
    const more = gate();
    const { streamCalls } = setup({
      replays: [
        { frames: [open(true), text('こんにち')], keepOpen: true },
        {
          frames: [open(true), text('こんにち'), { ...text('は'), after: more.promise }, done],
          keepOpen: false,
        },
      ],
    });

    renderApp(`/chat/${ID}`);
    expect(
      await within(await screen.findByRole('list', { name: 'やりとり' })).findByText('こんにち'),
    ).toBeTruthy();
    expect(streamCalls()).toBe(1);

    fireEvent.click(screen.getByRole('button', { name: '資格を替える' }));
    await waitFor(() => expect(streamCalls()).toBe(2));
    // 2 回目の再生が頭から積んだ時点で、同じ文章は 1 行だけ
    await waitFor(() => expect(within(transcript()).getAllByText('こんにち')).toHaveLength(1));

    more.open();
    expect(await within(transcript()).findByText('こんにちは')).toBeTruthy();
    expect(within(transcript()).queryAllByText('こんにち')).toHaveLength(0);
    expect(within(transcript()).getAllByText('こんにちは')).toHaveLength(1);
  });

  it('同じ画面で会話を A→B→A と切り替えて戻っても、A の途中の行は二重にならない', async () => {
    const more = gate();
    const { streamCalls } = setup({
      replays: [
        { frames: [open(true), text('こんにち')], keepOpen: true },
        { frames: [open(false, OTHER)], keepOpen: false },
        {
          frames: [open(true), text('こんにち'), { ...text('は'), after: more.promise }, done],
          keepOpen: false,
        },
      ],
    });

    const { router } = renderApp(`/chat/${ID}`);
    expect(
      await within(await screen.findByRole('list', { name: 'やりとり' })).findByText('こんにち'),
    ).toBeTruthy();
    await router.navigate(`/chat/${OTHER}`);
    expect(await screen.findByText('別の話')).toBeTruthy();
    await router.navigate(`/chat/${ID}`);
    await waitFor(() => expect(streamCalls()).toBe(3));
    await waitFor(() => expect(within(transcript()).getAllByText('こんにち')).toHaveLength(1));

    more.open();
    expect(await within(transcript()).findByText('こんにちは')).toBeTruthy();
    expect(within(transcript()).queryAllByText('こんにち')).toHaveLength(0);
  });

  it('自分の送信で途中まで受けた返信が残ったまま会話を離れて戻っても、再生が二重に積まない', async () => {
    const more = gate();
    const { streamCalls } = setup({
      chat: {
        frames: [{ event: 'open', data: { conversationId: ID } }, text('こんにち')],
        keepOpen: true,
      },
      replays: [
        { frames: [open(false)], keepOpen: false },
        { frames: [open(false, OTHER)], keepOpen: false },
        {
          frames: [open(true), text('こんにち'), { ...text('は'), after: more.promise }, done],
          keepOpen: false,
        },
      ],
    });

    const { router } = renderApp(`/chat/${ID}`);
    await screen.findByText('やあ');
    fireEvent.change(screen.getByPlaceholderText(/クローンに話しかける/), {
      target: { value: 'おーい' },
    });
    fireEvent.click(screen.getByRole('button', { name: /送る/ }));
    expect(await within(transcript()).findByText('こんにち')).toBeTruthy();

    await router.navigate(`/chat/${OTHER}`);
    expect(await screen.findByText('別の話')).toBeTruthy();
    await router.navigate(`/chat/${ID}`);
    await waitFor(() => expect(streamCalls()).toBe(3));
    await waitFor(() => expect(within(transcript()).getAllByText('こんにち')).toHaveLength(1));

    more.open();
    expect(await within(transcript()).findByText('こんにちは')).toBeTruthy();
    expect(within(transcript()).queryAllByText('こんにち')).toHaveLength(0);
  });

  it('陰性対照: 前のストリームが done まで届いて確定した行は、次の再生で消えない', async () => {
    const more = gate();
    const { streamCalls } = setup({
      replays: [
        { frames: [open(true), text('済んだ返事'), done], keepOpen: false },
        { frames: [open(false, OTHER)], keepOpen: false },
        {
          frames: [open(true), text('次の途中'), { ...text('と続き'), after: more.promise }, done],
          keepOpen: false,
        },
      ],
    });

    const { router } = renderApp(`/chat/${ID}`);
    expect(
      await within(await screen.findByRole('list', { name: 'やりとり' })).findByText('済んだ返事'),
    ).toBeTruthy();
    await router.navigate(`/chat/${OTHER}`);
    expect(await screen.findByText('別の話')).toBeTruthy();
    await router.navigate(`/chat/${ID}`);
    await waitFor(() => expect(streamCalls()).toBe(3));
    expect(await within(transcript()).findByText('次の途中')).toBeTruthy();
    expect(within(transcript()).getAllByText('済んだ返事')).toHaveLength(1);

    more.open();
    expect(await within(transcript()).findByText('次の途中と続き')).toBeTruthy();
    expect(within(transcript()).getAllByText('済んだ返事')).toHaveLength(1);
  });

  it('陰性対照: 確定済みの行を残したまま、終端を見なかった途中の行だけを捨てる', async () => {
    const more = gate();
    const { streamCalls } = setup({
      replays: [
        { frames: [open(true), text('済んだ返事'), done], keepOpen: false },
        { frames: [open(true), text('こんにち')], keepOpen: true },
        {
          frames: [open(true), text('こんにち'), { ...text('は'), after: more.promise }, done],
          keepOpen: false,
        },
      ],
    });

    renderApp(`/chat/${ID}`);
    expect(
      await within(await screen.findByRole('list', { name: 'やりとり' })).findByText('済んだ返事'),
    ).toBeTruthy();
    fireEvent.click(screen.getByRole('button', { name: '資格を替える' }));
    expect(await within(transcript()).findByText('こんにち')).toBeTruthy();
    fireEvent.click(screen.getByRole('button', { name: '資格を替える' }));
    await waitFor(() => expect(streamCalls()).toBe(3));

    more.open();
    expect(await within(transcript()).findByText('こんにちは')).toBeTruthy();
    expect(within(transcript()).queryAllByText('こんにち')).toHaveLength(0);
    expect(within(transcript()).getAllByText('済んだ返事')).toHaveLength(1);
  });

  it('陰性対照: 再生中でない会話で資格が替わっても、既にある行は消えない', async () => {
    const { streamCalls } = setup({
      replays: [
        { frames: [open(false)], keepOpen: false },
        { frames: [open(false)], keepOpen: false },
      ],
    });

    renderApp(`/chat/${ID}`);
    expect(await screen.findByText('やあ')).toBeTruthy();
    fireEvent.click(screen.getByRole('button', { name: '資格を替える' }));
    await waitFor(() => expect(streamCalls()).toBe(2));
    await act(async () => {});
    expect(within(transcript()).getAllByText('やあ')).toHaveLength(1);
  });

  it('陰性対照: 資格が替わらない普通の再生では、途中の行は1行', async () => {
    const more = gate();
    setup({
      replays: [
        {
          frames: [open(true), text('こんにち'), { ...text('は'), after: more.promise }, done],
          keepOpen: false,
        },
      ],
    });

    renderApp(`/chat/${ID}`);
    expect(
      await within(await screen.findByRole('list', { name: 'やりとり' })).findByText('こんにち'),
    ).toBeTruthy();
    expect(within(transcript()).getAllByText('こんにち')).toHaveLength(1);
    more.open();
    expect(await within(transcript()).findByText('こんにちは')).toBeTruthy();
    expect(within(transcript()).getAllByText('こんにちは')).toHaveLength(1);
  });
});
