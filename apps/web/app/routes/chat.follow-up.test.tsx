// @vitest-environment jsdom
/**
 * **順番待ちのあいだに続けて打てること**、そしてその追送が**購読を張らない**こと。
 *
 * サーバは、順番待ちのあいだに積み上がった同じ会話の発言を1ターンにまとめて読む
 * （`packages/core/src/clone.ts` の `#mergedHumanBatch` / `humanTurnText`）。だが
 * 画面が受信中の入力を塞いでいたため、その機構へ Web UI からは一度も届かなかった。
 *
 * ここで守るのは2つある。
 *
 * 1. 受信中でも打てて、追送が `POST /chat` として投函される（会話 id 付きで）
 * 2. 追送は `open` を見た時点で接続を捨てる — 2本目の購読を張ると、同じ会話へ
 *    流れる応答が二度画面に出る（`clone.subscribe` は会話単位で、購読者全員へ配る）
 */
import { cleanup, fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import { createMemoryRouter, RouterProvider, useParams } from 'react-router';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import { json, Providers, sse, storeTestBaseUrl, stubFetch } from '~/test-support';

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

/**
 * テスト側が開ける関門。**`delayMs` で順序を作らない** — あれは時計への賭けで、
 * 遅い実行環境では追い越される（`test-support.tsx` の `sse` の doc）。
 */
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
  fireEvent.click(screen.getByRole('button', { name: /送る/ }));
}

const transcript = () => screen.getByRole('list', { name: 'やりとり' });

/**
 * `POST /chat` の**本文**を集める。
 *
 * `stubFetch` の経路には本文が渡ってこない — 画面は `fetch(new Request(...), {signal})`
 * の形で呼ぶ（`app/lib/api.tsx`）ので、本文は `Request` の側に居て `init` には無い。
 * そこで `stubFetch` が据えた `fetch` をもう一枚包んで、通り道で読む。
 */
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

/** 会話一覧と履歴。**この試験の対象ではない**ので、どちらも空で返す。 */
function background(url: string): Response | undefined {
  if (url.includes(`/conversations/${CONVERSATION_ID}`)) {
    return json({ conversationId: CONVERSATION_ID, messages: [] });
  }
  if (url.includes('/conversations')) return json({ conversations: [], scanned: 0 });
  return undefined;
}

describe('順番待ちのあいだの追送', () => {
  it('受信中でも打てて、追送は会話 id 付きで投函される', async () => {
    const reply = gate();
    let chatCalls = 0;
    /** `POST /chat` ごとの中断の合図。**接続が閉じたか**をここで見る。 */
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
              // 応答は関門を開けるまで来ない＝そのあいだ画面は順番待ちのまま。
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
        /*
         * 追送の側。**流し終えても閉じない**（`keepOpen`）のが要点である。
         * 閉じる形にすると、最後まで読んでから畳む実装でも `aborted` が真に
         * なってしまい、下の検査が「`open` で切っている」ことを測れなくなる。
         *
         * 本文も流す。画面がここを読んでいれば二度出る。関門を付けない
         * （＝すぐ流す）ので、下で「まとめて答える」が出るころには、この本文は
         * とうに届く機会を過ぎている — 出ていないなら、読んでいない。
         */
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

    // 受信中でも入力欄は生きている（ここを塞いでいたのが元の欠陥）。
    const box = await screen.findByPlaceholderText(/クローンに話しかける/);
    expect((box as HTMLTextAreaElement).disabled).toBe(false);

    await send('二つ目');
    await waitFor(() => {
      expect(bodies.length).toBe(2);
    });
    expect(JSON.parse(bodies[1] ?? '{}')).toEqual({
      text: '二つ目',
      conversationId: CONVERSATION_ID,
    });

    /*
     * **ここがこの試験の核である。** 追送の接続は `open` を見た時点で閉じ、
     * 走っている方は生きたまま — この2つが同時に成り立っていないと、応答が
     * 二度流れる（両方生きている）か、取りこぼす（両方閉じる／張り替える）。
     */
    await waitFor(() => {
      expect(signals[1]?.aborted).toBe(true);
    });
    expect(signals[0]?.aborted).toBe(false);

    // 走っているストリームは切れていない。応答はそちらへ流れてくる。
    reply.open();
    expect(await screen.findByText('まとめて答える')).toBeTruthy();

    expect(within(transcript()).getByText('一つ目')).toBeTruthy();
    expect(within(transcript()).getByText('二つ目')).toBeTruthy();
    /*
     * 追送の接続から流れた本文は画面に出ない。
     *
     * **これ自体は弱い保証である**（`followUp` はそもそも本文を描く道を持たない
     * ので、上の中断が無くても通る）。残してあるのは、追送に描画を足す変更が
     * 入ったときに落ちる網としてである — 「閉じている」ことの証拠は上の
     * `signals[1].aborted` の方が持つ。
     */
    expect(screen.queryByText('にせもの')).toBeNull();
  });

  it('新しい会話では、id が決まるまで追送を待たせてから投函する', async () => {
    const opened = gate();
    let chatCalls = 0;

    stubFetch((url, init) => {
      if (url.endsWith('/chat')) {
        chatCalls += 1;
        if (chatCalls === 1) {
          return sse(
            [
              // **id が決まるのを遅らせる。** 新しい会話の id は `open` まで無い。
              {
                event: 'open',
                data: { conversationId: CONVERSATION_ID },
                after: opened.promise,
              },
              { event: 'text', data: { type: 'text', text: 'まとめて答える' } },
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

    renderChat('/chat');
    await send('一つ目');
    await send('二つ目');

    /*
     * **まだ投函していない。** id 無しで送ると、続きのつもりの発言が別の会話
     * として立つ。待つのが正しい（`followUp` の doc）。
     */
    expect(bodies.length).toBe(1);

    opened.open();
    await waitFor(() => {
      expect(bodies.length).toBe(2);
    });
    expect(JSON.parse(bodies[1] ?? '{}')).toEqual({
      text: '二つ目',
      conversationId: CONVERSATION_ID,
    });

    expect(await screen.findByText('まとめて答える')).toBeTruthy();
    expect(within(transcript()).getByText('一つ目')).toBeTruthy();
    expect(within(transcript()).getByText('二つ目')).toBeTruthy();
  });
});
