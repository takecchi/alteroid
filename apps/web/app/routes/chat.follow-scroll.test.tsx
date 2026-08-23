// @vitest-environment jsdom
/**
 * #247 の 1: **最下部にいるときだけ**新しい行に追従してスクロールすること。
 *
 * 直す前は `bottomRef.current?.scrollIntoView({ block: 'end' })` を新しい行が
 * 来るたび無条件に呼んでいたため、長い会話を遡って読んでいる最中に新しい行が
 * 届くと下端へ引き戻されていた（Issue #247 の実測）。
 *
 * **画面は誰も見られない**（この枝には preview が付かない。`vercel.json` の
 * `deploymentEnabled`、jsdom はレイアウトを持たない）。ここで測れるのは
 * 「`scrollIntoView` が呼ばれたかどうか」だけであり、実際に画面が動いて見える
 * かどうかはこのテストの証拠にならない。
 *
 * jsdom は `scrollTop` / `scrollHeight` / `clientHeight` を常に 0 として扱う
 * （レイアウトを持たないため）。「最下部にいる」「最下部にいない」を作るには、
 * `Object.defineProperty` でこれらの値を自分で差し込む必要がある
 * （`~/test-support` の `ResizeObserver` の doc に書かれている、jsdom の
 * レイアウト不在という同じ制約の別の現れ）。
 */
import { cleanup, fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import { createMemoryRouter, RouterProvider, useParams } from 'react-router';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { json, Providers, sse, storeTestBaseUrl, stubFetch } from '~/test-support';

import Chat from './chat';

const CONVERSATION_ID = 'conv-follow-scroll';

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

/** テスト側が開ける関門。`delayMs` で順序を作らない（`sse` の doc）。 */
function gate() {
  let open: () => void = () => {};
  const promise = new Promise<void>((resolve) => {
    open = resolve;
  });
  return { promise, open: () => open() };
}

async function send(text: string) {
  const box = await screen.findByPlaceholderText(/クローンに話しかける/);
  fireEvent.change(box, { target: { value: text } });
  fireEvent.click(screen.getByRole('button', { name: /送る/ }));
}

const transcript = () => screen.getByRole('list', { name: 'やりとり' });

/**
 * やりとりの `<ul>` は、スクロールする器（`chat.tsx` の `overflow-y-auto` の
 * `div`）の直接の子である。**testid を新設しない** — 既に `aria-label` で
 * 一意に取れる要素があるので、`parentElement` で器そのものへ辿る。
 */
function scrollContainer(): HTMLElement {
  const el = transcript().parentElement;
  if (el === null) throw new Error('scroll container not found');
  return el;
}

/**
 * jsdom には無い `scrollTop` / `scrollHeight` / `clientHeight` を差し込む。
 *
 * `scrollTop` だけ `writable` にする — 本物のブラウザでも `scrollTop` は
 * 書き込める一方、`scrollHeight` / `clientHeight` は読み取り専用（レイアウトから
 * 導出される）。同じ形にしておかないと、製品側が万一 `scrollHeight` へ書き込む
 * ような変更をしたとき、テストの偽物だけがそれを許して見逃す。
 */
function setScrollMetrics(
  el: HTMLElement,
  metrics: { scrollTop: number; scrollHeight: number; clientHeight: number },
) {
  Object.defineProperty(el, 'scrollTop', {
    configurable: true,
    writable: true,
    value: metrics.scrollTop,
  });
  Object.defineProperty(el, 'scrollHeight', {
    configurable: true,
    value: metrics.scrollHeight,
  });
  Object.defineProperty(el, 'clientHeight', {
    configurable: true,
    value: metrics.clientHeight,
  });
}

/** 会話一覧と履歴。**この試験の対象ではない**ので、どちらも空で返す。 */
function background(url: string): Response | undefined {
  if (url.includes(`/conversations/${CONVERSATION_ID}`)) {
    return json({ conversationId: CONVERSATION_ID, messages: [] });
  }
  if (url.includes('/conversations')) return json({ conversations: [], scanned: 0 });
  return undefined;
}

let originalFetch: typeof fetch;
let scrollIntoView: ReturnType<typeof vi.spyOn>;

beforeEach(() => {
  originalFetch = globalThis.fetch;
  localStorage.clear();
  storeTestBaseUrl();
  // `test-support.tsx` が埋めた no-op を包む。**中身は差し替えない**
  // （`scrollIntoView` を「何もしない」のままにしておく方針は変えない）ので
  // `mockImplementation` は呼ばない — 呼ばれた回数だけを見る。
  scrollIntoView = vi.spyOn(Element.prototype, 'scrollIntoView');
});

afterEach(() => {
  cleanup();
  scrollIntoView.mockRestore();
  globalThis.fetch = originalFetch;
});

describe('会話画面のスクロール追従（#247 の 1）', () => {
  it('最下部にいるとき、新しい行が来たら追従する', async () => {
    const chunk2 = gate();
    stubFetch((url, init) => {
      if (url.endsWith('/chat')) {
        return sse(
          [
            { event: 'open', data: { conversationId: CONVERSATION_ID } },
            { event: 'text', data: { type: 'text', text: '最初の一文' } },
            { event: 'text', data: { type: 'text', text: '、続きの一文' }, after: chunk2.promise },
            { event: 'done', data: { type: 'done' } },
          ],
          { signal: init?.signal },
        );
      }
      return background(url);
    });

    renderChat('/chat');
    await send('質問');
    expect(await screen.findByText('最初の一文')).toBeTruthy();

    // 最下部にいる、と器に言わせる（余裕 32px 以内）。
    setScrollMetrics(scrollContainer(), { scrollTop: 468, scrollHeight: 500, clientHeight: 32 });
    fireEvent.scroll(scrollContainer());

    const callsBeforeChunk2 = scrollIntoView.mock.calls.length;
    chunk2.open();
    await waitFor(() => {
      expect(within(transcript()).getByText(/続きの一文/)).toBeTruthy();
    });

    // **ここが本題。** 最下部にいたので、新しい行の到着で追従したはずである。
    expect(scrollIntoView.mock.calls.length).toBeGreaterThan(callsBeforeChunk2);
  });

  it('最下部にいないとき、新しい行が来ても追従しない', async () => {
    const chunk2 = gate();
    stubFetch((url, init) => {
      if (url.endsWith('/chat')) {
        return sse(
          [
            { event: 'open', data: { conversationId: CONVERSATION_ID } },
            { event: 'text', data: { type: 'text', text: '最初の一文' } },
            { event: 'text', data: { type: 'text', text: '、続きの一文' }, after: chunk2.promise },
            { event: 'done', data: { type: 'done' } },
          ],
          { signal: init?.signal },
        );
      }
      return background(url);
    });

    renderChat('/chat');
    await send('質問');
    expect(await screen.findByText('最初の一文')).toBeTruthy();

    // 遡って読んでいる、と器に言わせる（最下部まで 800px の隙間）。
    setScrollMetrics(scrollContainer(), { scrollTop: 0, scrollHeight: 1000, clientHeight: 200 });
    fireEvent.scroll(scrollContainer());

    const callsBeforeChunk2 = scrollIntoView.mock.calls.length;
    chunk2.open();
    await waitFor(() => {
      expect(within(transcript()).getByText(/続きの一文/)).toBeTruthy();
    });

    // **ここが本題。** 最下部にいなかったので、新しい行が来ても追従していない
    // はずである（呼ばれた回数が増えていない）。
    expect(scrollIntoView.mock.calls.length).toBe(callsBeforeChunk2);
  });

  it('遡って読んでいても、自分が送った直後は追従する', async () => {
    const stub = stubFetch((url, init) => {
      if (url.endsWith('/chat')) {
        return sse(
          [
            { event: 'open', data: { conversationId: CONVERSATION_ID } },
            { event: 'text', data: { type: 'text', text: '最初の応答' } },
            { event: 'done', data: { type: 'done' } },
          ],
          { signal: init?.signal },
        );
      }
      return background(url);
    });

    renderChat('/chat');
    await send('一つ目');
    await waitFor(() => {
      expect(stub.calls.some((url) => url.includes('/chat'))).toBe(true);
    });
    await screen.findByText('最初の応答');

    // 会話を遡って読んでいる状態を作る。
    setScrollMetrics(scrollContainer(), { scrollTop: 0, scrollHeight: 1000, clientHeight: 200 });
    fireEvent.scroll(scrollContainer());

    const callsBeforeSend = scrollIntoView.mock.calls.length;
    // 器の metrics は据え置き（＝最下部にいないまま）で、自分の発言だけを送る。
    await send('二つ目');
    await waitFor(() => {
      expect(within(transcript()).getByText('二つ目')).toBeTruthy();
    });

    // **ここが本題。** 最下部にいなくても、自分が送った直後は追従したはずである。
    expect(scrollIntoView.mock.calls.length).toBeGreaterThan(callsBeforeSend);
  });
});

/**
 * `ChatPane` は会話を切り替えても作り直されない（`key` を付けない設計、
 * `chat.tsx` の該当コメント参照）。`isAtBottomRef` は `ChatPane` が生きている
 * あいだ値を保つ `useRef` なので、直さなければ**会話 A で遡った状態が会話 B へ
 * 持ち越ってしまう** — 会話を開いたのに最新が見えない、という別の欠陥になる。
 */
describe('会話の切り替え（#247 の 1 の追加分）', () => {
  const CONV_A = 'conv-switch-a';
  const CONV_B = 'conv-switch-b';

  function backgroundForSwitch(url: string): Response | undefined {
    if (url.includes(`/conversations/${CONV_A}`)) {
      return json({
        conversationId: CONV_A,
        messages: [{ id: 'a1', at: '2026-08-20T00:00:00Z', role: 'inbound', text: '会話Aの発言' }],
      });
    }
    if (url.includes(`/conversations/${CONV_B}`)) {
      return json({
        conversationId: CONV_B,
        messages: [{ id: 'b1', at: '2026-08-20T00:00:00Z', role: 'inbound', text: '会話Bの発言' }],
      });
    }
    if (url.includes('/conversations')) return json({ conversations: [], scanned: 0 });
    return undefined;
  }

  it('会話 A で上へ遡った状態から会話 B へ移ると、B は最下部へ送られる', async () => {
    stubFetch((url) => backgroundForSwitch(url));

    const { router } = renderChat(`/chat/${CONV_A}`);
    await screen.findByText('会話Aの発言');

    // 会話 A を上へ遡っている、と器に言わせる。
    setScrollMetrics(scrollContainer(), { scrollTop: 0, scrollHeight: 1000, clientHeight: 200 });
    fireEvent.scroll(scrollContainer());

    const callsBeforeSwitch = scrollIntoView.mock.calls.length;
    // 一覧のクリックではなく URL の遷移そのもの（`ChatPane` は同じインスタンスの
    // まま `routeId` prop だけが変わる。既存の「会話の切り替え」試験
    // （`chat.test.tsx`）と同じ手段）。
    await router.navigate(`/chat/${CONV_B}`);
    await screen.findByText('会話Bの発言');

    // **ここが本題。** 会話 A で遡っていても、会話 B は最下部へ送られたはずである。
    await waitFor(() => {
      expect(scrollIntoView.mock.calls.length).toBeGreaterThan(callsBeforeSwitch);
    });
  });

  it('会話 B へ移った後も、B の中で上へ遡ったら追従しない', async () => {
    const chunk2 = gate();
    stubFetch((url, init) => {
      if (url.endsWith('/chat')) {
        return sse(
          [
            { event: 'open', data: { conversationId: CONV_B } },
            { event: 'text', data: { type: 'text', text: '最初の一文' } },
            { event: 'text', data: { type: 'text', text: '、続きの一文' }, after: chunk2.promise },
            { event: 'done', data: { type: 'done' } },
          ],
          { signal: init?.signal },
        );
      }
      return backgroundForSwitch(url);
    });

    const { router } = renderChat(`/chat/${CONV_A}`);
    await screen.findByText('会話Aの発言');
    await router.navigate(`/chat/${CONV_B}`);
    await screen.findByText('会話Bの発言');

    // B の中で発言し、応答が届き始めるところまでは追従してよい
    // （切り替え直後の「最下部から始まる」＋「送った直後は追従する」の重なり）。
    await send('質問');
    await screen.findByText('最初の一文');

    // ここから B の中で上へ遡る。**切り替えのリセットがここまで効いたままだと
    // （＝ isAtBottomRef が常に true に固定されていると）、この歯が落ちる。**
    setScrollMetrics(scrollContainer(), { scrollTop: 0, scrollHeight: 1000, clientHeight: 200 });
    fireEvent.scroll(scrollContainer());

    const callsBeforeChunk2 = scrollIntoView.mock.calls.length;
    chunk2.open();
    await waitFor(() => {
      expect(within(transcript()).getByText(/続きの一文/)).toBeTruthy();
    });

    // **ここが本題。** 切り替えのリセットが、B の中での遡りの抑止まで
    // 壊していないこと。
    expect(scrollIntoView.mock.calls.length).toBe(callsBeforeChunk2);
  });
});
