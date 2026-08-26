// @vitest-environment jsdom
/**
 * **IME で変換している最中の Enter を、送信として拾わないこと。**
 *
 * ⭐ **この歯が守っている門は、いまは誰も踏まない。** 送信条件は `⌘/Ctrl + Enter`
 * だけで、Enter 単体で送る道が `chat.tsx` にまだ無いからである（#247 の 2）。
 * それでも歯を置くのは、**Enter 単体送信を足した瞬間に、門が無いと IME の
 * 「変換を確定する Enter」がそのまま誤送信になる**ためで、足す人がそのときに
 * 門の不在へ気づく契機を持たない。下の3本目（「Enter 単体では送らない」）が、
 * その人をここへ連れてくる網である。
 *
 * **いま既に効いている分もある**（1本目・2本目）— 変換中に `⌘/Ctrl + Enter` を
 * 打つと、`draft` に入っているのは確定前の途中の文字列（変換中でも `input` は
 * 飛ぶ）なので、門が無ければそれが投函される。
 *
 * **測り方**: 同じ入力・同じキーで `isComposing` だけを反転させ、`POST /chat` が
 * 立つか立たないかを見る。片側だけでは「そもそも送れていない」と区別が付かない
 * ので、**必ず両側を1本の中で通す**（変換中→0本、確定後→1本）。
 *
 * `isComposing` が jsdom の `KeyboardEvent` から React の `nativeEvent` まで
 * 実際に運ばれることは、この歯を書く前に別立てで実測してある（`fireEvent.keyDown`
 * の init に載せた値が、そのまま `event.nativeEvent.isComposing` に出る）。
 */
import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { createMemoryRouter, RouterProvider, useParams } from 'react-router';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import { json, Providers, sse, storeTestBaseUrl, stubFetch } from '~/test-support';

import Chat from './chat';

const CONVERSATION_ID = 'conv-ime-enter';

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
  return render(
    <Providers>
      <RouterProvider router={router} />
    </Providers>,
  );
}

/** 会話一覧と履歴。**この試験の対象ではない**ので、どちらも空で返す。 */
function background(url: string): Response | undefined {
  if (url.includes(`/conversations/${CONVERSATION_ID}`)) {
    return json({ conversationId: CONVERSATION_ID, messages: [] });
  }
  if (url.includes('/conversations')) return json({ conversations: [], scanned: 0 });
  return undefined;
}

/**
 * `POST /chat` を数え、届いた本文を控える。
 *
 * 本文は `stubFetch` の `init` には来ない（画面は `fetch(new Request(...), {signal})`
 * の形で呼ぶ）ので、据えられた `fetch` をもう一枚包んで通り道で読む
 * （`chat.follow-up.test.tsx` の `captureChatBodies` と同じ理由）。
 */
function setUpChat(): { bodies: string[] } {
  const bodies: string[] = [];
  stubFetch((url, init) => {
    if (url.endsWith('/chat')) {
      return sse(
        [
          { event: 'open', data: { conversationId: CONVERSATION_ID } },
          { event: 'done', data: { type: 'done' } },
        ],
        { signal: init?.signal },
      );
    }
    return background(url);
  });
  const inner = globalThis.fetch;
  globalThis.fetch = (async (input: RequestInfo | URL, init?: RequestInit) => {
    if (input instanceof Request && input.url.endsWith('/chat')) {
      bodies.push(await input.clone().text());
    }
    return inner(input, init);
  }) as typeof fetch;
  return { bodies };
}

/**
 * 「送られていない」を測るための待ち。
 *
 * ⚠️ **`expect(bodies.length).toBe(0)` をキー押下の直後に置くだけでは足りない** —
 * 送信は非同期なので、まだ立っていないだけの状態と区別が付かない。React の更新と
 * マイクロタスクを一巡させてから測る。**すぐ下で `isComposing: false` の側が
 * 同じ待ちの後に1本立つ**ので、この待ちが短すぎれば2本目も 0 本になり、
 * 「常に緑」にはならない。
 */
async function settle(): Promise<void> {
  for (let i = 0; i < 5; i += 1) await Promise.resolve();
  await new Promise((resolve) => setTimeout(resolve, 20));
}

async function typeInto(text: string): Promise<HTMLTextAreaElement> {
  const box = (await screen.findByPlaceholderText(/クローンに話しかける/)) as HTMLTextAreaElement;
  fireEvent.change(box, { target: { value: text } });
  return box;
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

describe('IME 変換中の Enter', () => {
  it('⌘ + Enter は、変換中（isComposing: true）は送らず、確定後（false）は送る', async () => {
    const { bodies } = setUpChat();
    renderChat(`/chat/${CONVERSATION_ID}`);
    const box = await typeInto('こんにちは');

    // 変換中。**この Enter は「変換を確定する Enter」であって、送信ではない。**
    fireEvent.keyDown(box, { key: 'Enter', metaKey: true, isComposing: true });
    await settle();
    expect(bodies).toEqual([]);

    // 確定後。同じキー・同じ本文で、`isComposing` だけが違う。
    fireEvent.keyDown(box, { key: 'Enter', metaKey: true, isComposing: false });
    await waitFor(() => {
      expect(bodies.length).toBe(1);
    });
    expect(JSON.parse(bodies[0] ?? '{}')).toEqual({
      text: 'こんにちは',
      conversationId: CONVERSATION_ID,
    });
  });

  it('Ctrl + Enter でも同じ（門は修飾キーの種類に依らない）', async () => {
    const { bodies } = setUpChat();
    renderChat(`/chat/${CONVERSATION_ID}`);
    const box = await typeInto('へんかんちゅう');

    fireEvent.keyDown(box, { key: 'Enter', ctrlKey: true, isComposing: true });
    await settle();
    expect(bodies).toEqual([]);

    fireEvent.keyDown(box, { key: 'Enter', ctrlKey: true, isComposing: false });
    await waitFor(() => {
      expect(bodies.length).toBe(1);
    });
    expect(JSON.parse(bodies[0] ?? '{}')).toEqual({
      text: 'へんかんちゅう',
      conversationId: CONVERSATION_ID,
    });
  });

  /**
   * ⭐ **これは「いまの仕様」を留めている歯である**（欠陥を固定しているのではない）。
   *
   * **Enter 単体送信を足すことになったら、この本は反転させてよい。** ただし
   * そのときは `chat.tsx` の `onKeyDown` にある `event.nativeEvent.isComposing`
   * の門が **Enter 単体の枝も通っていること**を必ず確かめること — 通っていないと、
   * IME で変換を確定した Enter が、そのまま途中の文字列を投函する。
   * **この本が落ちることが、その確認を促す唯一の合図である。**
   */
  it('Enter 単体では送らない（いまの仕様。ここを反転するときは上の門を必ず通すこと）', async () => {
    const { bodies } = setUpChat();
    renderChat(`/chat/${CONVERSATION_ID}`);
    const box = await typeInto('修飾キー無し');

    fireEvent.keyDown(box, { key: 'Enter', isComposing: false });
    await settle();
    expect(bodies).toEqual([]);

    // 送る口そのものは生きている（上が「そもそも送れない」で緑になっていない）。
    fireEvent.click(screen.getByRole('button', { name: /送る/ }));
    await waitFor(() => {
      expect(bodies.length).toBe(1);
    });
  });
});
