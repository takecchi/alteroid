// @vitest-environment jsdom
/**
 * 画面を離れて戻っても、処理中の会話の途中経過に戻れること（Issue #2652 の2本目、Web）。
 *
 * 同じタブで別の画面へ行って戻る（アンマウント → 再マウント）・再読み込み（新規マウントで
 * 途中から入る）・同じ画面で会話を切り替えて戻る、のどれでも、`GET /chat/:id/stream` を
 * 張り直して「考えている…」とそれまでの文章を出し、続きをそのまま流す。
 *
 * **実時間を待たない。** 「続きが来る」順序は `sse()` の `after`（テスト側が解決するゲート）で
 * 作る。待つのは画面に出るかどうかだけ。
 */
import { useJournalLive } from '@alteroid/swr';
import { act, cleanup, fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import { createMemoryRouter, RouterProvider, useParams } from 'react-router';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import {
  json,
  Providers,
  sse,
  stubFetch,
  storeTestBaseUrl,
  untilOpenSettled,
  type Route,
} from '~/test-support';

import Chat from './chat';

const ID = 'conv-1';
const OTHER = 'conv-2';

const ChatRoute = Chat as unknown as (props: {
  loaderData: { conversationId: string | undefined };
}) => React.ReactElement;

function Harness() {
  useJournalLive();
  const params = useParams();
  return <ChatRoute loaderData={{ conversationId: params.conversationId }} />;
}

function renderApp(initial: string) {
  const router = createMemoryRouter(
    [
      { path: '/chat', Component: Harness },
      { path: '/chat/:conversationId', Component: Harness },
      // 別の画面（チャットをアンマウントさせる）。
      { path: '/elsewhere', Component: () => <p>別の画面</p> },
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

/** 再生の口 1 回ぶんの応答。 */
interface Replay {
  frames: Frames;
  /** true なら閉じずに待つ（まだ走っているターン）。 */
  keepOpen: boolean;
  /** 中断の合図を渡さない（abort でも本文が止まらない最悪条件）。 */
  ignoreSignal?: boolean;
  /** 503（この器は途中経過を持たない）で断る。 */
  unsupported?: boolean;
}

interface Setup {
  /** 再生の口へ来た順に返す応答。 */
  replays: Replay[];
  /** 会話の履歴（会話 id ごと）。 */
  history?: () => Record<string, { id: string; at: string; role: string; text: string }[]>;
  /** 承認の台帳（ask_human の質問）。 */
  approvals?: () => unknown[];
  /** `POST /chat` の応答。 */
  chat?: Frames;
}

function setup({ replays, history, approvals, chat }: Setup) {
  const aborted: boolean[] = [];
  let replayIndex = 0;
  const route: Route = (url, init) => {
    const stream = /\/chat\/([^/]+)\/stream$/.exec(url);
    if (stream !== null) {
      const replay = replays[replayIndex++];
      if (replay === undefined) throw new Error(`再生の口が想定より多く張られた: ${url}`);
      if (replay.unsupported === true) return json({ error: '途中経過を持たない' }, 503);
      const slot = aborted.push(false) - 1;
      init?.signal?.addEventListener('abort', () => (aborted[slot] = true), { once: true });
      return sse(replay.frames, {
        keepOpen: replay.keepOpen,
        signal: replay.ignoreSignal === true ? null : init?.signal,
        delayMs: 0,
      });
    }
    if (url.endsWith('/chat')) {
      return sse(chat ?? [{ event: 'open', data: { conversationId: ID } }], {
        signal: init?.signal,
        delayMs: 0,
      });
    }
    const detail = /\/conversations\/([^/?]+)/.exec(url);
    if (detail !== null) {
      const id = detail[1] as string;
      return json({ conversationId: id, messages: history?.()[id] ?? [] });
    }
    if (url.includes('/approvals')) return json({ approvals: approvals?.() ?? [] });
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
  return { stub, aborted, streamCalls };
}

const transcript = () => screen.getByRole('list', { name: 'やりとり' });
const inProgress = (inProgressValue: boolean, id = ID) => ({
  event: 'open',
  data: { conversationId: id, inProgress: inProgressValue },
});
const human = { id: 'm1', at: '2026-10-01T00:00:00.000Z', role: 'inbound', text: 'やあ' };

describe('画面に戻ったとき、処理中の会話の途中経過に戻る', () => {
  it('別の画面へ行って戻ると、途中の文章が見え、続きがそのまま流れる。離れたときに購読は切れる', async () => {
    const more = gate();
    const { aborted, streamCalls } = setup({
      history: () => ({ [ID]: [human] }),
      replays: [
        {
          frames: [inProgress(true), { event: 'text', data: { type: 'text', text: 'ここまで' } }],
          keepOpen: true,
        },
        {
          frames: [
            inProgress(true),
            // 隣り合う text は 1 つにまとまって来る（daemon の約束）
            { event: 'text', data: { type: 'text', text: 'ここまでと、' } },
            { event: 'text', data: { type: 'text', text: 'つづき' }, after: more.promise },
            { event: 'done', data: { type: 'done' } },
          ],
          keepOpen: false,
        },
      ],
    });

    const { router } = renderApp(`/chat/${ID}`);
    expect(
      await within(await screen.findByRole('list', { name: 'やりとり' })).findByText('ここまで'),
    ).toBeTruthy();
    expect(streamCalls()).toBe(1);

    await router.navigate('/elsewhere');
    expect(await screen.findByText('別の画面')).toBeTruthy();
    // アンマウントで購読を切る
    await waitFor(() => expect(aborted[0]).toBe(true));

    await router.navigate(`/chat/${ID}`);
    expect(
      await within(await screen.findByRole('list', { name: 'やりとり' })).findByText(
        'ここまでと、',
      ),
    ).toBeTruthy();
    expect(streamCalls()).toBe(2);

    more.open();
    expect(await within(transcript()).findByText('ここまでと、つづき')).toBeTruthy();
  });

  it('再読み込み相当（新規マウントで途中から入る）でも「考えている…」が見え、受信中の見た目になる。続きで文章に替わる', async () => {
    const more = gate();
    setup({
      history: () => ({ [ID]: [human] }),
      replays: [
        {
          frames: [
            inProgress(true),
            { event: 'thinking', data: { type: 'thinking' } },
            { event: 'text', data: { type: 'text', text: 'お待たせ' }, after: more.promise },
            { event: 'done', data: { type: 'done' } },
          ],
          keepOpen: false,
        },
      ],
    });

    renderApp(`/chat/${ID}`);
    expect(await screen.findByText('考えている…')).toBeTruthy();
    expect(screen.getByRole('button', { name: '受信をやめる' })).toBeTruthy();

    more.open();
    expect(await within(transcript()).findByText('お待たせ')).toBeTruthy();
    // done で畳まれる: 受信中の見た目も戻る
    await waitFor(() => expect(screen.queryByRole('button', { name: '受信をやめる' })).toBeNull());
    expect(screen.queryByText('考えている…')).toBeNull();
  });

  it('順番待ちと道具の実行中も、そのまま見える', async () => {
    const more = gate();
    setup({
      history: () => ({ [ID]: [human] }),
      replays: [
        {
          frames: [
            inProgress(true),
            { event: 'queued', data: { type: 'queued' } },
            { event: 'tool', data: { type: 'tool', tool: 'journal_search' }, after: more.promise },
          ],
          keepOpen: true,
        },
      ],
    });

    renderApp(`/chat/${ID}`);
    expect(await screen.findByText('順番を待っている…')).toBeTruthy();
    more.open();
    expect(await screen.findByText('journal_search を実行中…')).toBeTruthy();
  });

  it('inProgress が false なら何も出さず、張りっぱなしにしない', async () => {
    const { streamCalls, aborted } = setup({
      history: () => ({ [ID]: [human] }),
      replays: [{ frames: [inProgress(false)], keepOpen: true }],
    });

    renderApp(`/chat/${ID}`);
    expect(
      await within(await screen.findByRole('list', { name: 'やりとり' })).findByText('やあ'),
    ).toBeTruthy();
    await waitFor(() => expect(streamCalls()).toBe(1));
    // 閉じられずに残っていない（サーバが閉じなくても、こちらから畳む）
    await waitFor(() => expect(aborted[0]).toBe(true));
    expect(screen.queryByText('考えている…')).toBeNull();
    expect(screen.queryByRole('button', { name: '受信をやめる' })).toBeNull();
    // 再描画をまたいでも張り直さない
    fireEvent.change(screen.getByPlaceholderText(/クローンに話しかける/), {
      target: { value: 'あ' },
    });
    expect(streamCalls()).toBe(1);
  });

  it('再生の口が開けない（古いデーモン等）ときは、何も出さず履歴だけが見える', async () => {
    const { streamCalls } = setup({
      history: () => ({ [ID]: [human] }),
      replays: [{ frames: [], keepOpen: false, unsupported: true }],
    });
    renderApp(`/chat/${ID}`);
    expect(
      await within(await screen.findByRole('list', { name: 'やりとり' })).findByText('やあ'),
    ).toBeTruthy();
    await waitFor(() => expect(streamCalls()).toBe(1));
    expect(screen.queryByRole('alert')).toBeNull();
    expect(screen.queryByRole('button', { name: '受信をやめる' })).toBeNull();
  });

  it('自分の送信中は張らない（新しい会話で送っても、再生の口は 1 回も叩かれない）', async () => {
    const finish = gate();
    // 本文は、`open` の後始末（URL の付け替え）が済んでから流す（`test-support.tsx` の `gate` の doc）。
    const reply = gate();
    const { streamCalls } = setup({
      replays: [],
      chat: [
        { event: 'open', data: { conversationId: ID } },
        { event: 'text', data: { type: 'text', text: 'へんじ' }, after: reply.promise },
        { event: 'done', data: { type: 'done' }, after: finish.promise },
      ],
    });

    const { router } = renderApp('/chat');
    const box = await screen.findByPlaceholderText(/クローンに話しかける/);
    fireEvent.change(box, { target: { value: 'やあ' } });
    fireEvent.click(screen.getByRole('button', { name: 'メッセージを送信' }));

    // 送信の途中（open で会話 id が決まり、URL が追いついた後）に数える
    await untilOpenSettled(router, ID);
    reply.open();
    expect(await within(transcript()).findByText('へんじ')).toBeTruthy();
    await waitFor(() => expect(router.state.location.pathname).toBe(`/chat/${ID}`));
    expect(streamCalls()).toBe(0);
    finish.open();
    await waitFor(() => expect(screen.queryByRole('button', { name: '受信をやめる' })).toBeNull());
    expect(streamCalls()).toBe(0);
  });

  it('既存の会話で自分が送っている間も張らない', async () => {
    const finish = gate();
    const { streamCalls } = setup({
      history: () => ({ [ID]: [human] }),
      replays: [{ frames: [inProgress(false)], keepOpen: false }],
      chat: [
        { event: 'open', data: { conversationId: ID } },
        { event: 'text', data: { type: 'text', text: 'へんじ' } },
        { event: 'done', data: { type: 'done' }, after: finish.promise },
      ],
    });
    renderApp(`/chat/${ID}`);
    await waitFor(() => expect(streamCalls()).toBe(1));
    const box = await screen.findByPlaceholderText(/クローンに話しかける/);
    fireEvent.change(box, { target: { value: 'もう一つ' } });
    fireEvent.click(screen.getByRole('button', { name: 'メッセージを送信' }));
    expect(await within(transcript()).findByText('へんじ')).toBeTruthy();
    finish.open();
    await waitFor(() => expect(screen.queryByRole('button', { name: '受信をやめる' })).toBeNull());
    expect(streamCalls()).toBe(1);
  });

  it('open を見る前に離れても、購読は切れる', async () => {
    const never = gate();
    const { aborted } = setup({
      history: () => ({ [ID]: [human] }),
      replays: [{ frames: [{ ...inProgress(true), after: never.promise }], keepOpen: true }],
    });
    const { router } = renderApp(`/chat/${ID}`);
    await screen.findByText('やあ');
    await waitFor(() => expect(aborted).toHaveLength(1));
    expect(aborted[0]).toBe(false);
    await router.navigate('/elsewhere');
    await screen.findByText('別の画面');
    await waitFor(() => expect(aborted[0]).toBe(true));
  });

  it('再生のあと履歴を取り直しても、返信は二重にならない', async () => {
    let finished = false;
    const more = gate();
    const { stub } = setup({
      history: () => ({
        [ID]: finished
          ? [
              human,
              { id: 'm2', at: '2026-10-01T00:00:05.000Z', role: 'outbound', text: 'わかった' },
            ]
          : [human],
      }),
      replays: [
        {
          frames: [
            inProgress(true),
            { event: 'text', data: { type: 'text', text: 'わかっ' } },
            { event: 'text', data: { type: 'text', text: 'た' }, after: more.promise },
            { event: 'done', data: { type: 'done' } },
          ],
          keepOpen: false,
        },
      ],
    });

    renderApp(`/chat/${ID}`);
    expect(
      await within(await screen.findByRole('list', { name: 'やりとり' })).findByText('わかっ'),
    ).toBeTruthy();
    // ターンが終わり、サーバが返信を日誌へ載せた体にする
    finished = true;
    more.open();
    await waitFor(() => expect(within(transcript()).getAllByText('わかった')).toHaveLength(1));
    // 履歴の取り直しを起こす（フォーカス復帰）。取り直し後の履歴に返信がある
    const detailFetches = () => stub.calls.filter((u) => u.includes(`/conversations/${ID}`)).length;
    const before = detailFetches();
    window.dispatchEvent(new Event('focus'));
    await waitFor(() => expect(detailFetches()).toBeGreaterThan(before));
    await waitFor(() => expect(screen.queryByRole('button', { name: '受信をやめる' })).toBeNull());
    expect(within(transcript()).getAllByText('わかった')).toHaveLength(1);
    expect(within(transcript()).getAllByText('やあ')).toHaveLength(1);
  });

  it('再生で届いた確認（ask_human）は履歴由来の行と同じ文面で、取り直しても二重にならない', async () => {
    let recorded = false;
    const more = gate();
    setup({
      history: () => ({ [ID]: [human] }),
      approvals: () =>
        recorded ? [{ id: 'ap-1', createdAt: '2026-10-01T00:00:02.000Z', question: 'いいか' }] : [],
      replays: [
        {
          frames: [
            inProgress(true),
            {
              event: 'ask_human',
              data: { type: 'ask_human', approvalId: 'ap-1', question: 'いいか' },
            },
            { event: 'done', data: { type: 'done' }, after: more.promise },
          ],
          keepOpen: false,
        },
      ],
    });
    const line = '確認したいことがある: いいか （承認待ちの画面から答えられる）';

    renderApp(`/chat/${ID}`);
    expect(
      await within(await screen.findByRole('list', { name: 'やりとり' })).findByText(line),
    ).toBeTruthy();
    recorded = true;
    more.open();
    window.dispatchEvent(new Event('focus'));
    await waitFor(() => expect(screen.queryByRole('button', { name: '受信をやめる' })).toBeNull());
    await waitFor(() => expect(within(transcript()).getAllByText(line)).toHaveLength(1));
  });

  it('会話の切り替えと同じ tick に前の会話の再生から届いた文章は、画面に出ない', async () => {
    const stray = gate();
    setup({
      history: () => ({ [ID]: [human], [OTHER]: [{ ...human, id: 'o1', text: '別の話' }] }),
      replays: [
        {
          frames: [
            inProgress(true),
            { event: 'text', data: { type: 'text', text: 'こちら' } },
            { event: 'text', data: { type: 'text', text: 'もれた' }, after: stray.promise },
          ],
          keepOpen: true,
          ignoreSignal: true,
        },
        { frames: [inProgress(false, OTHER)], keepOpen: false },
      ],
    });

    const { router } = renderApp(`/chat/${ID}`);
    expect(
      await within(await screen.findByRole('list', { name: 'やりとり' })).findByText('こちら'),
    ).toBeTruthy();

    const navigating = router.navigate(`/chat/${OTHER}`);
    stray.open();
    await navigating;
    expect(await screen.findByText('別の話')).toBeTruthy();
    // 実時間では待たない（#2146）。この再生の偽 SSE は `delayMs: 0` なので、ゲートを外した
    // 後の1枠は数回のマクロタスクのうちに投入され、読み手へ渡る。その分だけ回して、
    // 追いついてくる可能性のある描画を拾う。
    for (let turn = 0; turn < 5; turn += 1) {
      await act(async () => {
        await new Promise((resolve) => setTimeout(resolve, 0));
      });
    }
    expect(screen.queryByText(/もれた/)).toBeNull();
    expect(screen.queryByText(/こちら/)).toBeNull();
  });

  it('同じ画面で会話を A→B→A と切り替えて戻ると、A の途中経過が戻り、続きが来る', async () => {
    const more = gate();
    const { aborted, streamCalls } = setup({
      history: () => ({ [ID]: [human], [OTHER]: [{ ...human, id: 'o1', text: '別の話' }] }),
      replays: [
        {
          frames: [inProgress(true), { event: 'text', data: { type: 'text', text: 'A の途中' } }],
          keepOpen: true,
        },
        { frames: [inProgress(false, OTHER)], keepOpen: false },
        {
          frames: [
            inProgress(true),
            { event: 'text', data: { type: 'text', text: 'A の途中' } },
            { event: 'text', data: { type: 'text', text: 'と続き' }, after: more.promise },
            { event: 'done', data: { type: 'done' } },
          ],
          keepOpen: false,
        },
      ],
    });

    const { router } = renderApp(`/chat/${ID}`);
    expect(
      await within(await screen.findByRole('list', { name: 'やりとり' })).findByText('A の途中'),
    ).toBeTruthy();

    await router.navigate(`/chat/${OTHER}`);
    expect(await screen.findByText('別の話')).toBeTruthy();
    expect(aborted[0]).toBe(true);
    // B の再生の口が張られた（2本目の応答を B が取った）のを見てから戻る。見ずに戻ると、
    // B の口が張られる前に A へ戻った回は、A が2本目（B 向けの応答）を受け取ってしまう。
    await waitFor(() => expect(streamCalls()).toBe(2));

    await router.navigate(`/chat/${ID}`);
    // 戻った直後の「A の途中」は、再生からではなく、直前の会話として残した行
    // （`retainedBy`）からも出る（実測: 3本目の再生から「A の途中」を抜いても、
    // この findByText は通った）。だから文字が見えたことは「3本目の口が張られた」の
    // 合図にならない。口の数は、文字とは別に待つ（CI で同期の toBe(3) が 2 を見て
    // 落ちた: run 37067638577）。3本目の再生が本当に届いたかは、下の「と続き」が見る。
    expect(await within(transcript()).findByText('A の途中')).toBeTruthy();
    await waitFor(() => expect(streamCalls()).toBe(3));
    more.open();
    expect(await within(transcript()).findByText('A の途中と続き')).toBeTruthy();
  });

  it('再生中に送った発言は追送になり、2 本目の購読を張らず、同じ応答が二重に流れない', async () => {
    const stub = setup({
      history: () => ({ [ID]: [human] }),
      replays: [
        {
          frames: [inProgress(true), { event: 'thinking', data: { type: 'thinking' } }],
          keepOpen: true,
        },
      ],
      // 追送が自分で購読していたら、これが画面に出てしまう
      chat: [
        { event: 'open', data: { conversationId: ID } },
        { event: 'text', data: { type: 'text', text: 'もう一本の応答' } },
      ],
    });

    renderApp(`/chat/${ID}`);
    await screen.findByText('考えている…');

    const box = screen.getByPlaceholderText(/クローンに話しかける/);
    fireEvent.change(box, { target: { value: 'つづけて' } });
    fireEvent.click(screen.getByRole('button', { name: 'メッセージを送信' }));

    expect(await within(transcript()).findByText('つづけて')).toBeTruthy();
    const post = await waitFor(() => {
      const entry = stub.stub.entries.find(
        (e) => e.url.endsWith('/chat') && e.request !== undefined,
      );
      expect(entry).toBeDefined();
      return entry;
    });
    expect(await post?.request?.clone().json()).toMatchObject({
      text: 'つづけて',
      conversationId: ID,
    });
    expect(stub.streamCalls()).toBe(1);
    expect(screen.queryByText('もう一本の応答')).toBeNull();
    // 再生はまだ走っている
    expect(screen.getByText('考えている…')).toBeTruthy();
  });
});
