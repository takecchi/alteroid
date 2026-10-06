// @vitest-environment jsdom
/**
 * **IME で変換している最中の送信ショートカットを、送信として拾わないこと。**
 *
 * 送るのは ⌘ + Enter / Ctrl + Enter（OS を問わずどちらも）だけで、Enter 単体・Shift + Enter では
 * 送らない（textarea の既定の改行）。変換中でも `input` は飛ぶので、`draft` に入っているのは
 * 確定前の途中の文字列であり、門が無いとそれが投函される。
 *
 * **測り方**: 同じ入力・同じキーで `isComposing` だけを反転させ、`POST /chat` が立つか立たないかを見る。
 * 片側だけでは「そもそも送れていない」と区別が付かないので、**必ず両側を1本の中で通す**
 * （変換中→0本、確定後→1本）。案内の文だけが OS に合わせて変わる（`navigator.platform` を差し替えて確かめる）。
 */
import { act, cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { createMemoryRouter, RouterProvider, useParams } from 'react-router';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { json, Providers, setTouchOnly, sse, storeTestBaseUrl, stubFetch } from '~/test-support';

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

/**
 * 会話一覧と履歴。**この試験の対象ではない**ので、どちらも空で返す。
 * `/approvals` も同じ扱い——issue #2210 以降 `conversationApprovals.error` が
 * `ErrorNote` を出すので、未ハンドルのまま（`Failed to fetch`）にせず0件で
 * 成功させる。
 */
function background(url: string): Response | undefined {
  if (url.includes(`/conversations/${CONVERSATION_ID}`)) {
    return json({ conversationId: CONVERSATION_ID, messages: [] });
  }
  if (url.includes('/approvals')) return json({ approvals: [] });
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
  for (let i = 0; i < 30; i += 1) await Promise.resolve();
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

/** `navigator.platform` を差し替える（jsdom は空で、Ctrl 側になる）。 */
function pretendPlatform(platform: string) {
  vi.spyOn(navigator, 'platform', 'get').mockReturnValue(platform);
}

const BODY = (text: string) => ({
  text,
  conversationId: CONVERSATION_ID,
  clientMessageId: expect.stringMatching(/^[A-Za-z0-9_-]{1,128}$/),
});

describe('IME 変換中の送信ショートカット', () => {
  afterEach(() => {
    vi.restoreAllMocks();
    setTouchOnly(false);
  });

  it('案内は OS に合わせて出し、指だけの端末では隠す。送信ボタンの名前は残る', async () => {
    setUpChat();
    renderChat(`/chat/${CONVERSATION_ID}`);
    await typeInto('x');
    expect(screen.getByText('Ctrl + Enter で送信')).toBeTruthy();
    act(() => setTouchOnly(true));
    expect(screen.queryByText(/Enter で送信/)).toBeNull();
    expect(screen.getByRole('button', { name: 'メッセージを送信' })).toBeTruthy();
  });

  it('Ctrl + Enter（Mac 以外）は、変換中（isComposing: true）は送らず、確定後（false）は送る', async () => {
    const { bodies } = setUpChat();
    renderChat(`/chat/${CONVERSATION_ID}`);
    const box = await typeInto('こんにちは');

    fireEvent.keyDown(box, { key: 'Enter', ctrlKey: true, isComposing: true });
    await settle();
    expect(bodies).toEqual([]);

    fireEvent.keyDown(box, { key: 'Enter', ctrlKey: true, isComposing: false });
    await waitFor(() => {
      expect(bodies.length).toBe(1);
    });
    expect(JSON.parse(bodies[0] ?? '{}')).toEqual(BODY('こんにちは'));
  });

  it('⌘ + Enter も同じ（Mac でも Mac 以外でも、⌘ と Ctrl のどちらでも送る）', async () => {
    pretendPlatform('MacIntel');
    const { bodies } = setUpChat();
    renderChat(`/chat/${CONVERSATION_ID}`);
    const box = await typeInto('へんかんちゅう');

    fireEvent.keyDown(box, { key: 'Enter', metaKey: true, isComposing: true });
    await settle();
    expect(bodies).toEqual([]);

    fireEvent.keyDown(box, { key: 'Enter', metaKey: true, isComposing: false });
    await waitFor(() => {
      expect(bodies.length).toBe(1);
    });
    expect(JSON.parse(bodies[0] ?? '{}')).toEqual(BODY('へんかんちゅう'));
  });

  /**
   * `isComposing` が false のまま変換確定の Enter を配る実装への備え（`keyCode === 229`）。
   * ⚠️ 測れているのは分岐の存在だけで、実機（Android の IME・古い WebKit）では確かめていない。
   */
  it('keyCode 229（isComposing は false）の Ctrl + Enter でも送らない', async () => {
    const { bodies } = setUpChat();
    renderChat(`/chat/${CONVERSATION_ID}`);
    const box = await typeInto('へんかん');

    fireEvent.keyDown(box, { key: 'Enter', ctrlKey: true, isComposing: false, keyCode: 229 });
    await settle();
    expect(bodies).toEqual([]);

    fireEvent.keyDown(box, { key: 'Enter', ctrlKey: true, isComposing: false, keyCode: 13 });
    await waitFor(() => {
      expect(bodies.length).toBe(1);
    });
  });

  it('Enter 単体・Shift + Enter では送らない（既定の改行のまま）。送信ボタンは生きている', async () => {
    const { bodies } = setUpChat();
    renderChat(`/chat/${CONVERSATION_ID}`);
    const box = await typeInto('修飾キー無し');

    // fireEvent の戻り値は「既定動作が止められなかったか」。止めていない = 改行の既定が生きている。
    expect(fireEvent.keyDown(box, { key: 'Enter', isComposing: false })).toBe(true);
    expect(fireEvent.keyDown(box, { key: 'Enter', shiftKey: true, isComposing: false })).toBe(true);
    await settle();
    expect(bodies).toEqual([]);

    fireEvent.click(screen.getByRole('button', { name: 'メッセージを送信' }));
    await waitFor(() => {
      expect(bodies.length).toBe(1);
    });
  });
});
