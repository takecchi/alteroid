// @vitest-environment jsdom
import { cleanup, fireEvent, render, screen } from '@testing-library/react';
import { createMemoryRouter, RouterProvider, useParams } from 'react-router';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import {
  findShownConversation,
  gate,
  json,
  Providers,
  sse,
  storeTestBaseUrl,
  stubFetch,
  type Route,
  untilOpenSettled,
} from '~/test-support';

import Chat from './chat';

const CONVERSATION_A = 'conv-draft-a';
const CONVERSATION_B = 'conv-draft-b';

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

function conversationRoutes(url: string) {
  if (url.includes(`/conversations/${CONVERSATION_A}`)) {
    return json({ conversationId: CONVERSATION_A, messages: [] });
  }
  if (url.includes(`/conversations/${CONVERSATION_B}`)) {
    return json({ conversationId: CONVERSATION_B, messages: [] });
  }
  if (url.includes('/approvals')) {
    return json({ approvals: [] });
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
  sessionStorage.clear();
  storeTestBaseUrl();
});

afterEach(() => {
  cleanup();
  globalThis.fetch = originalFetch;
});

async function draftBox() {
  return (await screen.findByPlaceholderText(/クローンに話しかける/)) as HTMLTextAreaElement;
}

describe('会話ごとの下書き（#1618）', () => {
  it('A で書きかけの下書きが、送らずに B へ切り替えると B の入力欄に出ない（漏れの再現テストの直し）', async () => {
    const route: Route = (url) => conversationRoutes(url);
    stubFetch(route);

    const { router } = renderChat(`/chat/${CONVERSATION_A}`);

    const box = await draftBox();
    fireEvent.change(box, { target: { value: 'Aだけに送るつもりの内緒の話' } });
    expect(box.value).toBe('Aだけに送るつもりの内緒の話');

    await router.navigate(`/chat/${CONVERSATION_B}`);
    expect(await findShownConversation(CONVERSATION_B)).toBeTruthy();

    const boxAfterSwitch = await draftBox();
    expect(boxAfterSwitch.value).toBe('');
  });

  it('B で書き換えてから A へ戻ると、A のもともとの下書きが戻る（取りこぼしの再現テストの直し）', async () => {
    const route: Route = (url) => conversationRoutes(url);
    stubFetch(route);

    const { router } = renderChat(`/chat/${CONVERSATION_A}`);

    const box = await draftBox();
    fireEvent.change(box, { target: { value: 'Aの下書き' } });

    await router.navigate(`/chat/${CONVERSATION_B}`);
    expect(await findShownConversation(CONVERSATION_B)).toBeTruthy();

    const boxInB = await draftBox();
    fireEvent.change(boxInB, { target: { value: 'Bの下書き' } });

    await router.navigate(`/chat/${CONVERSATION_A}`);
    expect(await findShownConversation(CONVERSATION_A)).toBeTruthy();

    const boxBackInA = await draftBox();
    expect(boxBackInA.value).toBe('Aの下書き');
  });

  it('送ったら、その会話の下書きだけが空になり、別の会話の下書きは残る', async () => {
    const STREAM_B = [
      { event: 'open', data: { conversationId: CONVERSATION_B } },
      { event: 'text', data: { type: 'text', text: 'わかった' } },
      { event: 'done', data: { type: 'done' } },
    ];
    const route: Route = (url, init) => {
      if (url.endsWith('/chat')) return sse(STREAM_B, { signal: init?.signal });
      return conversationRoutes(url);
    };
    stubFetch(route);

    const { router } = renderChat(`/chat/${CONVERSATION_A}`);

    const boxInA = await draftBox();
    fireEvent.change(boxInA, { target: { value: 'Aの下書き（送らない）' } });
    await router.navigate(`/chat/${CONVERSATION_B}`);
    expect(await findShownConversation(CONVERSATION_B)).toBeTruthy();

    const boxInB = await draftBox();
    fireEvent.change(boxInB, { target: { value: 'Bから送る発言' } });
    fireEvent.click(screen.getByRole('button', { name: 'メッセージを送信' }));

    expect((await draftBox()).value).toBe('');
    await screen.findByText('わかった');
    expect((await draftBox()).value).toBe('');

    await router.navigate(`/chat/${CONVERSATION_A}`);
    expect(await findShownConversation(CONVERSATION_A)).toBeTruthy();
    expect((await draftBox()).value).toBe('Aの下書き（送らない）');
  });

  it('新しい会話 → 既存の会話 → 新しい会話 で、新しい会話の下書きが戻る', async () => {
    const route: Route = (url) => conversationRoutes(url);
    stubFetch(route);

    const { router } = renderChat('/chat');

    const boxNew = await draftBox();
    fireEvent.change(boxNew, { target: { value: '新しい会話の下書き' } });

    await router.navigate(`/chat/${CONVERSATION_A}`);
    expect(await findShownConversation(CONVERSATION_A)).toBeTruthy();
    expect((await draftBox()).value).toBe('');

    await router.navigate('/chat');
    // ヘッダーの文字列を待つ: 入力欄は会話を切り替えても同じ DOM ノードのままで、findByPlaceholderText は切り替え時の同期リセットがコミットされる前に解決してしまうため
    expect(await screen.findByText('新しい会話')).toBeTruthy();
    expect((await draftBox()).value).toBe('新しい会話の下書き');
  });

  it('新しい会話で送る → 別の会話 → 新しい会話 で、送った文章が下書きとして戻らない（#2453）', async () => {
    const CONVERSATION_NEW = 'conv-draft-new';
    const reply = gate();
    const STREAM_NEW = [
      { event: 'open', data: { conversationId: CONVERSATION_NEW } },
      { event: 'text', data: { type: 'text', text: '受け取った' }, after: reply.promise },
      { event: 'done', data: { type: 'done' } },
    ];
    const route: Route = (url, init) => {
      if (url.endsWith('/chat')) return sse(STREAM_NEW, { signal: init?.signal });
      if (url.includes(`/conversations/${CONVERSATION_NEW}`)) {
        return json({ conversationId: CONVERSATION_NEW, messages: [] });
      }
      return conversationRoutes(url);
    };
    stubFetch(route);

    const { router } = renderChat('/chat');

    fireEvent.change(await draftBox(), { target: { value: '新しい会話から送る発言' } });
    await router.navigate(`/chat/${CONVERSATION_A}`);
    expect(await findShownConversation(CONVERSATION_A)).toBeTruthy();
    expect((await draftBox()).value).toBe('');

    await router.navigate('/chat');
    expect(await screen.findByText('新しい会話')).toBeTruthy();
    expect((await draftBox()).value).toBe('新しい会話から送る発言');

    fireEvent.click(screen.getByRole('button', { name: 'メッセージを送信' }));
    expect((await draftBox()).value).toBe('');
    await untilOpenSettled(router, CONVERSATION_NEW);
    reply.open();
    await screen.findByText('受け取った');
    expect((await draftBox()).value).toBe('');

    await router.navigate(`/chat/${CONVERSATION_A}`);
    expect(await findShownConversation(CONVERSATION_A)).toBeTruthy();
    await router.navigate('/chat');
    expect(await screen.findByText('新しい会話')).toBeTruthy();
    expect((await draftBox()).value).toBe('');
  });
});
