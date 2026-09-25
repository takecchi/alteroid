// @vitest-environment jsdom
/**
 * Issue #1576（#1570 / PR #1572 と同じ窓）。
 *
 * `ChatPane`（`chat.tsx`）は会話を切り替えても作り直されない。`failure`
 * （画面下の `ErrorNote`）が会話を見ずに立つ経路が2つある:
 *
 * 1. **送信のストリームの `error` イベント**: `send` のイベントループの
 *    `case 'error': setFailure(new Error(event.message))` は、同じループの
 *    `append`/`setTransient` が締めている `writable()`（`owns() && !stopped()`）
 *    を見ない。会話を切り替えたときにストリームを止める効果
 *    （`useEffect(() => { shownIdRef.current = shownId; ...abort()... },
 *    [shownId])`）が走るより前——B の画面が commit された直後の窓——で A の
 *    ストリームに `error` が届くと、B の画面に A のエラーが出る。**この窓の
 *    外（効果が先に走って `abort()` 済み）では、`abort()` がストリームの
 *    読み取りそのものを打ち切るので `error` イベントは届かず、代わりに
 *    outer の `catch` が `controller.signal.aborted` で締めて表示しない
 *    ——つまりこの経路は #1570 と同じく本当に「窓の中だけ」で起きる。**
 * 2. **追送（`followUp`）の `catch (caught) { setFailure(caught); }`**:
 *    投函先の会話を見ていない。`followUp` は自分専用の `AbortController` を
 *    持ち、会話切り替えの効果（上）はそれを一切触らない——つまりこちらは
 *    窓に依らず、**切り替えた後ならいつ投函が失敗しても**常に別の会話の
 *    画面に出る。
 *
 * **窓の突き方（1）**: #1572 と同じく、MutationObserver のコールバック
 * （マイクロタスク）の中で応答を流す。**ただし共有の `sse()`（`test-support.tsx`）
 * はフレームごとに実タイマー（`delayMs`、既定5ms）を挟む**——`after` の解決から
 * enqueue までの間にその実タイマーが挟まると、受動効果（別マクロタスク）との
 * 先着順が実行環境の速さに賭けになってしまう（`chat.test.tsx`「会話の切り替え」の
 * 節が同じ理由で赤くなった実例を記録している）。そこでこの窓を突く1本だけは
 * `sse()` を使わず、実タイマーを挟まない自前の `ReadableStream` で `error` を
 * 流す。`findBy`/`act()` で待つと効果まで流れてしまい窓を越えるので、それらも使わない。
 */
import { act, cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { createMemoryRouter, RouterProvider, useParams } from 'react-router';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import { json, Providers, sse, storeTestBaseUrl, stubFetch, type Route } from '~/test-support';

import Chat from './chat';

const CONVERSATION_ID = 'conv-fail-1';
const OTHER_CONVERSATION_ID = 'conv-fail-2';
const ERROR_MESSAGE = 'いまは投げられない（テスト用の文言）';
const FOLLOW_UP_ERROR_MESSAGE = '投函に失敗した（テスト用の文言）';

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

/** `/approvals` はこの試験の対象ではない。未ハンドルのまま（`chat.interrupt.test.tsx` と同じ）。 */
function conversationRoutes(url: string) {
  if (url.includes(`/conversations/${CONVERSATION_ID}`)) {
    return json({ conversationId: CONVERSATION_ID, messages: [] });
  }
  if (url.includes(`/conversations/${OTHER_CONVERSATION_ID}`)) {
    return json({ conversationId: OTHER_CONVERSATION_ID, messages: [] });
  }
  if (url.includes('/conversations')) {
    return json({ conversations: [], scanned: 0 });
  }
  return undefined;
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

async function typeAndSend(text: string) {
  const box = await screen.findByPlaceholderText(/クローンに話しかける/);
  fireEvent.change(box, { target: { value: text } });
  fireEvent.click(screen.getByRole('button', { name: '送る' }));
}

/**
 * `open` をすぐに流し、`gate` が解決したら `error` を流して閉じる SSE 応答。
 *
 * **`test-support.tsx` の `sse()` を使わない。** あちらはフレームごとに実
 * タイマー（`delayMs`）を挟むため、`gate` の解決から `error` の enqueue までの
 * 間に実タイマーが挟まり、受動効果（別マクロタスク）との先着順が環境の速さに
 * 賭けになる。ここは `gate` の解決から enqueue までを純粋なマイクロタスクの
 * 連鎖だけにして、MutationObserver のコールバック（マイクロタスク）で解決すれば
 * 受動効果より確実に先着するようにしてある。
 */
function chatStreamWithGatedError(
  gate: Promise<unknown>,
  signal: AbortSignal | null | undefined,
): Response {
  const encoder = new TextEncoder();
  const stream = new ReadableStream<Uint8Array>({
    async start(controller) {
      let aborted = signal?.aborted === true;
      const stop = () => {
        aborted = true;
        try {
          controller.error(new DOMException('The operation was aborted.', 'AbortError'));
        } catch {
          // 既に閉じている
        }
      };
      signal?.addEventListener('abort', stop, { once: true });
      const abortedPromise = new Promise<void>((resolve) => {
        if (signal === null || signal === undefined) return;
        if (signal.aborted) resolve();
        else signal.addEventListener('abort', () => resolve(), { once: true });
      });

      if (aborted) return;
      controller.enqueue(
        encoder.encode(
          `event: open\ndata: ${JSON.stringify({ conversationId: CONVERSATION_ID })}\n\n`,
        ),
      );

      await Promise.race([gate, abortedPromise]);
      if (aborted) return;
      controller.enqueue(
        encoder.encode(
          `event: error\ndata: ${JSON.stringify({ type: 'error', message: ERROR_MESSAGE })}\n\n`,
        ),
      );
      controller.close();
    },
  });
  return new Response(stream, { status: 200, headers: { 'content-type': 'text/event-stream' } });
}

describe('送信ストリームの error イベント（会話を見ずに立つ、#1576-1）', () => {
  it('A で送信中に B へ切り替え、B が commit された直後（効果が走る前）に A の error が届いても、B に出ない', async () => {
    let releaseError: () => void = () => {};
    const errorReleased = new Promise<void>((resolve) => {
      releaseError = resolve;
    });
    const route: Route = (url, init) => {
      const conversation = conversationRoutes(url);
      if (conversation !== undefined) return conversation;
      if (url.endsWith('/chat')) return chatStreamWithGatedError(errorReleased, init?.signal);
      return undefined;
    };
    const stub = stubFetch(route);

    const { router } = renderChat(`/chat/${CONVERSATION_ID}`);
    await typeAndSend('やあ');

    // ストリームが実際に開いた（まだ error は届いていない）ことを確かめてから切り替える。
    await waitFor(() => {
      expect(stub.entries.some((entry) => entry.url.endsWith('/chat'))).toBe(true);
    });
    expect(await screen.findByRole('button', { name: '受信をやめる' })).toBeTruthy();

    let releasedInWindow = false;
    const observer = new MutationObserver(() => {
      if (releasedInWindow || screen.queryByText(OTHER_CONVERSATION_ID) === null) return;
      releasedInWindow = true;
      observer.disconnect();
      releaseError();
    });
    observer.observe(document.body, { childList: true, subtree: true, characterData: true });

    await router.navigate(`/chat/${OTHER_CONVERSATION_ID}`);
    expect(await screen.findByText(OTHER_CONVERSATION_ID)).toBeTruthy();
    expect(releasedInWindow).toBe(true);

    /*
     * 『出ない』は `findBy`/`waitFor` では直接待てない（出る方向にしか待てない）
     * ので、必ず起きるはずの別の事実――A のストリームが終わって `finally` の
     * `setSending(false)` が「受信をやめる」ボタンを畳むこと――を待つ
     * （`chat.interrupt.test.tsx` の `disabled` の扱いと同じ理由）。
     */
    await waitFor(() => {
      expect(screen.queryByRole('button', { name: '受信をやめる' })).toBeNull();
    });

    // B の画面に A の error が出ていない。
    expect(screen.queryByText(ERROR_MESSAGE)).toBeNull();
    expect(screen.queryByRole('alert')).toBeNull();
  });

  it('対照: 同じ会話のまま error が届けば、今までどおり出る（切り替えていない）', async () => {
    stubFetch((url, init) => {
      const conversation = conversationRoutes(url);
      if (conversation !== undefined) return conversation;
      if (url.endsWith('/chat')) {
        return sse(
          [
            { event: 'open', data: { conversationId: CONVERSATION_ID } },
            { event: 'error', data: { type: 'error', message: ERROR_MESSAGE } },
          ],
          { signal: init?.signal },
        );
      }
      return undefined;
    });

    renderChat(`/chat/${CONVERSATION_ID}`);
    await typeAndSend('やあ');

    expect(await screen.findByText(ERROR_MESSAGE)).toBeTruthy();
  });
});

describe('追送（followUp）の失敗（投函先を見ずに立つ、#1576-2）', () => {
  /**
   * `followUp` は自分専用の `AbortController` を持ち、会話切り替えの効果
   * （`streamRef.current` だけを見て `abort()` する）に一切触れられない。
   * つまりこちらの経路は #1570 のような「窓」を必要としない——B へ切り替えを
   * 完全に終わらせた後（受動効果も含めてすべて流れた後）に投函を失敗させても、
   * 直っていなければ別の会話（B）の画面に出る。
   */
  it('A で受信中に追送し、B へ切り替えが完全に終わった後に投函が失敗しても、B に出ない', async () => {
    let releaseFollowUpFailure: () => void = () => {};
    const followUpReleased = new Promise<void>((resolve) => {
      releaseFollowUpFailure = resolve;
    });
    let chatCalls = 0;
    const route: Route = (url, init) => {
      const conversation = conversationRoutes(url);
      if (conversation !== undefined) return conversation;
      if (url.endsWith('/chat')) {
        chatCalls += 1;
        if (chatCalls === 1) {
          // 最初の送信: 開いたまま受信を続ける。追送はこのストリームへは相乗り
          // しない——`followUp` は自分で新しい `POST /chat` を叩く（`followUp` の doc）。
          return sse([{ event: 'open', data: { conversationId: CONVERSATION_ID } }], {
            signal: init?.signal,
            keepOpen: true,
          });
        }
        // 追送そのもの: 投函が失敗する（ネットワーク断を模す）。
        return followUpReleased.then((): Response => {
          throw new TypeError(FOLLOW_UP_ERROR_MESSAGE);
        });
      }
      return undefined;
    };
    const stub = stubFetch(route);

    const { router } = renderChat(`/chat/${CONVERSATION_ID}`);
    await typeAndSend('一つ目');
    await waitFor(() => {
      expect(stub.entries.filter((entry) => entry.url.endsWith('/chat')).length).toBe(1);
    });
    expect(await screen.findByRole('button', { name: '受信をやめる' })).toBeTruthy();

    await typeAndSend('二つ目');
    await waitFor(() => {
      expect(stub.entries.filter((entry) => entry.url.endsWith('/chat')).length).toBe(2);
    });

    // B への切り替えを完全に終わらせる（受動効果も含めて流す）。
    await router.navigate(`/chat/${OTHER_CONVERSATION_ID}`);
    expect(await screen.findByText(OTHER_CONVERSATION_ID)).toBeTruthy();
    await act(async () => {});

    // ここで、追送の失敗を遅れて起こす。
    releaseFollowUpFailure();

    /*
     * ここはメインのストリームのような `sending`/「受信をやめる」に相当する
     * 目印を `followUp` 自身が持たない。だが `followUp` の失敗はタイマーを
     * 一切挟まないマイクロタスクの連鎖だけで `setFailure` まで届く
     * （モックの `fetch` の reject → `openapi-fetch` → `postChat` →
     * `followUp` の `catch` はどれも `await`/`Promise` チェーンで、実タイマーを
     * 挟む箇所が無い）。**マクロタスクの境界を1つ越えれば、その前に積まれた
     * マイクロタスクは必ず処理し切られている**（仕様上の保証。`delayMs` の
     * ような「速さへの賭け」ではない——ここでは何かと競走しているのではなく、
     * 既に確定した順序（B への切り替えは終わっている）の後に、単に十分な数の
     * tick を空けて確実に読み切るだけである）。
     */
    await act(async () => {
      await new Promise((resolve) => setTimeout(resolve, 0));
      await new Promise((resolve) => setTimeout(resolve, 0));
    });

    expect(screen.queryByText(FOLLOW_UP_ERROR_MESSAGE)).toBeNull();
    expect(screen.queryByRole('alert')).toBeNull();
  });

  it('対照: 同じ会話のまま投函が失敗すれば、今までどおり出る（切り替えていない）', async () => {
    let chatCalls = 0;
    stubFetch((url, init) => {
      const conversation = conversationRoutes(url);
      if (conversation !== undefined) return conversation;
      if (url.endsWith('/chat')) {
        chatCalls += 1;
        if (chatCalls === 1) {
          return sse([{ event: 'open', data: { conversationId: CONVERSATION_ID } }], {
            signal: init?.signal,
            keepOpen: true,
          });
        }
        return Promise.reject(new TypeError(FOLLOW_UP_ERROR_MESSAGE));
      }
      return undefined;
    });

    renderChat(`/chat/${CONVERSATION_ID}`);
    await typeAndSend('一つ目');
    expect(await screen.findByRole('button', { name: '受信をやめる' })).toBeTruthy();

    await typeAndSend('二つ目');

    expect(await screen.findByText(FOLLOW_UP_ERROR_MESSAGE)).toBeTruthy();
  });
});
