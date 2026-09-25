// @vitest-environment jsdom
/**
 * Issue #1576。#1570（PR #1572）と同じ窓が、`failure`（画面下の `ErrorNote`）にも
 * 2箇所あった。
 *
 * 1. **新規ストリームの `error` イベント**（`send` の event loop）。
 *    `append`/`setTransient` は `writable()`（`owns() && !stopped()`）で締めて
 *    いるが、`case 'error'` はそれを見ずに `failure` を直接立てていた。
 *    `owns()` が読む `shownIdRef.current` は受動効果の中でしか進まないため、
 *    #1570 と同じ窓（会話を切り替えた render から、`useEffect(() => {
 *    shownIdRef.current = shownId; ... }, [shownId])` が走るまでの間）で
 *    `error` が届くと、`writable()` に頼っても同じ理由で漏れる。
 * 2. **追送（`followUp`）の `catch`**。投函先を見ずに `failure` を立てていた
 *    ため、A で追送を打って B へ切り替えた後に投函が失敗すると、B の画面に
 *    出ていた。こちらは「窓」ではなく単純な順序（A で打つ → B へ切り替える →
 *    失敗が返る）で再現する。
 *
 * **直し方は #1570（PR #1572）と同じ形。** `sendFailure: { conversationId,
 * error }` を持ち、`handleInterrupt(shownId)` と同じく呼び出し元がその render
 * で決まっている `shownId`／`stream.id` を渡す。出すかどうかは描画する時点の
 * `shownId` と突き合わせてから決める（`visibleSendFailure`、`chat.tsx`）。
 *
 * 1本目は #1572 の `chat.interrupt.test.tsx` に足したテストと同じく
 * `MutationObserver` で「B の DOM が commit された直後・受動効果が走る前」の
 * 窓を突く。`MutationObserver` のコールバックはマイクロタスクとして走るので、
 * そこで応答（ここでは `error` イベント）を返せば、受動効果（マクロタスク）
 * より確実に先へ届く。
 */
import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { createMemoryRouter, RouterProvider, useParams } from 'react-router';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import { json, Providers, sse, storeTestBaseUrl, stubFetch, type Route } from '~/test-support';

import Chat from './chat';

const CONVERSATION_ID = 'conv-failure-1';
const OTHER_CONVERSATION_ID = 'conv-failure-2';

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

/** `/approvals` はこの試験の対象ではない。未ハンドルのまま（`chat.edit-message.test.tsx` と同じ）。 */
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

async function send(text: string) {
  const box = await screen.findByPlaceholderText(/クローンに話しかける/);
  fireEvent.change(box, { target: { value: text } });
  fireEvent.click(screen.getByRole('button', { name: '送る' }));
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

describe('新規ストリームの error イベント（#1576 の1）', () => {
  it('B の画面が commit された直後（効果が走る前）に A のストリームの error が届いても、B に出ない', async () => {
    const errorMessage = 'サーバから壊れた応答が返った';

    /*
     * `test-support.tsx` の `sse()` は使わない——`after` で待ってもフレーム
     * ごとに実時間の `setTimeout(delayMs)` を必ず挟むため、`MutationObserver`
     * のコールバック（マイクロタスク）で応答を返しても、その直後にもう一段
     * 実時間のマクロタスクが挟まり、受動効果（同じくマクロタスク）と競走に
     * なってしまう（先着が決まらない）。ここではマイクロタスクだけで進む
     * 素の `ReadableStream` を自分で組み立てる。
     */
    let releaseError: () => void = () => {};
    const errorReleased = new Promise<void>((resolve) => {
      releaseError = resolve;
    });
    const route: Route = (url) => {
      const conversation = conversationRoutes(url);
      if (conversation !== undefined) return conversation;
      if (url.endsWith('/chat')) {
        const encoder = new TextEncoder();
        const body = new ReadableStream<Uint8Array>({
          async start(controller) {
            controller.enqueue(
              encoder.encode(
                `event: open\ndata: ${JSON.stringify({ conversationId: CONVERSATION_ID })}\n\n`,
              ),
            );
            await errorReleased;
            controller.enqueue(
              encoder.encode(
                `event: error\ndata: ${JSON.stringify({ type: 'error', message: errorMessage })}\n\n`,
              ),
            );
            controller.close();
          },
        });
        return new Response(body, {
          status: 200,
          headers: { 'content-type': 'text/event-stream' },
        });
      }
      return undefined;
    };
    const stub = stubFetch(route);

    const { router } = renderChat(`/chat/${CONVERSATION_ID}`);
    await send('こんにちは');

    await waitFor(() => {
      expect(stub.entries.some((entry) => entry.url.endsWith('/chat'))).toBe(true);
    });
    // 受信中であることの裏取り（`sending` が真のあいだだけ出るボタン）。
    expect(await screen.findByRole('button', { name: '受信をやめる' })).toBeTruthy();

    // `navigate` を呼ぶ前に張る——DOM が B に変わった瞬間（マイクロタスク）を
    // 逃さないため。
    let released = false;
    const observer = new MutationObserver(() => {
      if (released) return;
      if (document.body.textContent?.includes(OTHER_CONVERSATION_ID) !== true) return;
      released = true;
      observer.disconnect();
      // まだ `MutationObserver` のコールバック（マイクロタスク）の中——
      // 受動効果（マクロタスク）はまだ走っていない。
      releaseError();
    });
    observer.observe(document.body, { childList: true, subtree: true, characterData: true });

    try {
      await router.navigate(`/chat/${OTHER_CONVERSATION_ID}`);

      /*
       * 『出ない』は `findBy`/`waitFor` では直接待てないので、必ず起きるはず
       * の別の事実——ストリームが終わって `finally` が `sending` を畳み、
       * 「受信をやめる」ボタンが消えること——を待つ。`setSendFailure` の
       * 呼び出し（呼ぶ／呼ばない）は、それより前の同じ同期区間で済んでいる。
       */
      await waitFor(() => {
        expect(screen.queryByRole('button', { name: '受信をやめる' })).toBeNull();
      });
      // observer が実際に発火して `releaseError` を呼んだことの裏取り。
      expect(released).toBe(true);
      expect(screen.queryByRole('alert')).toBeNull();
    } finally {
      observer.disconnect();
    }
  });
});

describe('追送（followUp）の catch（#1576 の2）', () => {
  it('A で追送を打って B へ切り替えた後に投函が失敗しても、B に出ない', async () => {
    const errorMessage = '追送がネットワーク断で失敗した';
    let chatCalls = 0;
    let rejectFollowUp: (reason: unknown) => void = () => {};
    const followUpResult = new Promise<Response>((_resolve, reject) => {
      rejectFollowUp = reject;
    });
    // テストが reject を呼ぶまでの間、握っているだけの unhandled rejection を防ぐ。
    followUpResult.catch(() => {});

    const route: Route = (url) => {
      const conversation = conversationRoutes(url);
      if (conversation !== undefined) return conversation;
      if (url.endsWith('/chat')) {
        chatCalls += 1;
        if (chatCalls === 1) {
          // 最初の送信は受信中のまま保つ——`streamRef.current` を保ち、
          // 2件目が `followUp`（追送）の経路を通るようにする。
          return sse([{ event: 'open', data: { conversationId: CONVERSATION_ID } }], {
            keepOpen: true,
          });
        }
        // 追送: 投函先の応答を、テストが reject するまで待たせる。
        return followUpResult;
      }
      return undefined;
    };
    const stub = stubFetch(route);

    const { router } = renderChat(`/chat/${CONVERSATION_ID}`);
    await send('一つ目');
    expect(await screen.findByRole('button', { name: '受信をやめる' })).toBeTruthy();

    await send('二つ目（追送）');
    await waitFor(() => {
      expect(stub.entries.filter((entry) => entry.url.endsWith('/chat')).length).toBe(2);
    });

    await router.navigate(`/chat/${OTHER_CONVERSATION_ID}`);
    expect(await screen.findByText(OTHER_CONVERSATION_ID)).toBeTruthy();

    // ここで、追送の投函が失敗したことにする。
    rejectFollowUp(new Error(errorMessage));

    /*
     * `followUp` の catch 自体（`postChat` の内部の `fetch` の解決・SSE の
     * 読み取り）はマイクロタスクだけで進むが、そこで呼ぶ `setSendFailure`
     * が実際に画面（DOM）へ commit されるところは React の scheduler 任せ
     * であり、マイクロタスクだけでは待てない（jsdom には `MessageChannel`
     * が無く `setTimeout` にフォールバックするため）。競走ではなく単純な
     * 順序の確認なので、マイクロタスクを十分回してから、実時間のタイマーを
     * 1周させて commit を確定させる。
     */
    for (let i = 0; i < 50; i += 1) {
      await Promise.resolve();
    }
    await new Promise((resolve) => setTimeout(resolve, 0));

    expect(screen.queryByRole('alert')).toBeNull();
  });
});
