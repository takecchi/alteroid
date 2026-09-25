// @vitest-environment jsdom
/**
 * Issue #1585（PR #1579 / #1572 のレビューで見つかった穴）。
 *
 * PR #1579（#1576）は `failure` を `{ conversationId, error }` にして、描画の
 * 時点の `shownId` と一致するときだけ出すようにした——「別の会話（B）の画面に
 * 出る」（#1576 の穴）はそれで直った。**だが `ChatPane` は会話を切り替える
 * たびに、どの会話へ向かうかを見ずにその1つだけの `failure` を
 * `setFailure(undefined)` で消していた。** A で追送が B を見ている間に
 * 失敗すると、その失敗は B にも、A へ戻ったときにも出なかった——「間違った
 * 会話に出る」バグが「どこにも出ない」バグに変わっていた。
 *
 * この試験は、直した後の性質を確かめる:
 * 1. A で追送が失敗 → B では出ない → A へ戻ると出る
 * 2. メインの `send`（ストリームの `error` イベント）でも同じ
 * 3. A の失敗は、A で次の送信を始めると消える
 * 4. B の失敗と A の失敗は混ざらない（B で失敗させて A へ移っても、A には
 *    B の失敗が出ない）
 *
 * #1576 の回帰試験（`chat.stream-failure-by-conversation.test.tsx`）と違い、
 * ここは「効果が走る前の窓」を突く必要が無い——切り替えを完全に終わらせた後の
 * 性質（「消えない」「次の送信で消える」「混ざらない」）を確かめるだけなので、
 * 実タイマーを避けた自前の ReadableStream は使わず、共有の `sse()` と
 * `findBy`/`waitFor` で待つ。
 */
import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { createMemoryRouter, RouterProvider, useParams } from 'react-router';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import { json, Providers, sse, storeTestBaseUrl, stubFetch, type Route } from '~/test-support';

import Chat from './chat';

const CONVERSATION_A = 'conv-1585-a';
const CONVERSATION_B = 'conv-1585-b';
const ERROR_MESSAGE = 'いまは投げられない（テスト用の文言、#1585）';
const FOLLOW_UP_ERROR_MESSAGE = '投函に失敗した（テスト用の文言、#1585）';

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

/** `/approvals` はこの試験の対象ではない。未ハンドルのまま（既存の同型試験と同じ）。 */
function conversationRoutes(url: string) {
  if (url.includes(`/conversations/${CONVERSATION_A}`)) {
    return json({ conversationId: CONVERSATION_A, messages: [] });
  }
  if (url.includes(`/conversations/${CONVERSATION_B}`)) {
    return json({ conversationId: CONVERSATION_B, messages: [] });
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

describe('#1585: 送信/追送の失敗は会話ごとに持ち、切り替えでは消えない', () => {
  it('(a) A で追送が失敗 → B では出ない → A へ戻ると出る', async () => {
    let chatCalls = 0;
    const route: Route = (url, init) => {
      const conversation = conversationRoutes(url);
      if (conversation !== undefined) return conversation;
      if (url.endsWith('/chat')) {
        chatCalls += 1;
        if (chatCalls === 1) {
          // 最初の送信: 開いたまま受信を続ける。追送はこのストリームへ相乗りしない。
          return sse([{ event: 'open', data: { conversationId: CONVERSATION_A } }], {
            signal: init?.signal,
            keepOpen: true,
          });
        }
        // 追送そのもの: 投函が失敗する（ネットワーク断を模す）。
        return Promise.reject(new TypeError(FOLLOW_UP_ERROR_MESSAGE));
      }
      return undefined;
    };
    stubFetch(route);

    const { router } = renderChat(`/chat/${CONVERSATION_A}`);
    await typeAndSend('一つ目');
    expect(await screen.findByRole('button', { name: '受信をやめる' })).toBeTruthy();

    await typeAndSend('二つ目');

    // A に居るあいだ、追送の失敗が出る（ベースライン）。
    expect(await screen.findByText(FOLLOW_UP_ERROR_MESSAGE)).toBeTruthy();
    /*
     * Issue #1585 の「確かめていないこと」の1つ:
     * **失敗した発言そのものは、投函に失敗しても A の履歴に残って見える。**
     * `showOwnLine` はフェッチの前に楽観的に積んでいて、`followUp` の
     * `catch` は行を取り除かない——`ErrorNote`（上で確かめた別枠の表示）が
     * 唯一の手がかりで、どの発言が失敗したかは行そのものからは分からない。
     */
    expect(screen.getByText('二つ目')).toBeTruthy();

    // B へ切り替える。
    await router.navigate(`/chat/${CONVERSATION_B}`);
    expect(await screen.findByText(CONVERSATION_B)).toBeTruthy();
    // B には A の追送失敗が出ない（#1576 で直った性質。ここでは前提として確かめる）。
    expect(screen.queryByText(FOLLOW_UP_ERROR_MESSAGE)).toBeNull();

    // A へ戻る。
    await router.navigate(`/chat/${CONVERSATION_A}`);
    // #1585 の本体: 戻った A に、消えずに出る。
    expect(await screen.findByText(FOLLOW_UP_ERROR_MESSAGE)).toBeTruthy();
  });

  it('(b) メインの send（ストリームの error イベント）でも同じ', async () => {
    stubFetch((url, init) => {
      const conversation = conversationRoutes(url);
      if (conversation !== undefined) return conversation;
      if (url.endsWith('/chat')) {
        return sse(
          [
            { event: 'open', data: { conversationId: CONVERSATION_A } },
            { event: 'error', data: { type: 'error', message: ERROR_MESSAGE } },
          ],
          { signal: init?.signal },
        );
      }
      return undefined;
    });

    const { router } = renderChat(`/chat/${CONVERSATION_A}`);
    await typeAndSend('やあ');

    // A に居るあいだ、error イベントの失敗が出る（ベースライン）。
    expect(await screen.findByText(ERROR_MESSAGE)).toBeTruthy();

    // B へ切り替える。
    await router.navigate(`/chat/${CONVERSATION_B}`);
    expect(await screen.findByText(CONVERSATION_B)).toBeTruthy();
    expect(screen.queryByText(ERROR_MESSAGE)).toBeNull();

    // A へ戻る。
    await router.navigate(`/chat/${CONVERSATION_A}`);
    expect(await screen.findByText(ERROR_MESSAGE)).toBeTruthy();
  });

  it('(c) A の失敗は、A で次の送信を始めると消える', async () => {
    let chatCalls = 0;
    stubFetch((url, init) => {
      const conversation = conversationRoutes(url);
      if (conversation !== undefined) return conversation;
      if (url.endsWith('/chat')) {
        chatCalls += 1;
        if (chatCalls === 1) {
          return sse(
            [
              { event: 'open', data: { conversationId: CONVERSATION_A } },
              { event: 'error', data: { type: 'error', message: ERROR_MESSAGE } },
            ],
            { signal: init?.signal },
          );
        }
        // 2回目（立て直しの送信）は成功して終わる。
        return sse(
          [
            { event: 'open', data: { conversationId: CONVERSATION_A } },
            { event: 'done', data: { type: 'done' } },
          ],
          { signal: init?.signal },
        );
      }
      return undefined;
    });

    renderChat(`/chat/${CONVERSATION_A}`);
    await typeAndSend('一つ目');
    expect(await screen.findByText(ERROR_MESSAGE)).toBeTruthy();
    // 1回目のストリームが完全に畳まれ、`streamRef.current` が空になるのを待つ
    // （でないと2回目が `followUp` に回り、`send` の冒頭のクリアを通らない）。
    await waitFor(() => {
      expect(screen.queryByRole('button', { name: '受信をやめる' })).toBeNull();
    });

    // 同じ A で次の送信をやり直す。
    await typeAndSend('二つ目');

    await waitFor(() => {
      expect(screen.queryByText(ERROR_MESSAGE)).toBeNull();
    });
  });

  it('(d) B の失敗と A の失敗は混ざらない（B で失敗させて A へ移ると、A には B の失敗が出ない）', async () => {
    stubFetch((url, init) => {
      const conversation = conversationRoutes(url);
      if (conversation !== undefined) return conversation;
      if (url.endsWith('/chat')) {
        return sse(
          [
            { event: 'open', data: { conversationId: CONVERSATION_B } },
            { event: 'error', data: { type: 'error', message: ERROR_MESSAGE } },
          ],
          { signal: init?.signal },
        );
      }
      return undefined;
    });

    const { router } = renderChat(`/chat/${CONVERSATION_B}`);
    await typeAndSend('B から送る');
    expect(await screen.findByText(ERROR_MESSAGE)).toBeTruthy();

    await router.navigate(`/chat/${CONVERSATION_A}`);
    expect(await screen.findByText(CONVERSATION_A)).toBeTruthy();
    expect(screen.queryByText(ERROR_MESSAGE)).toBeNull();
  });
});
