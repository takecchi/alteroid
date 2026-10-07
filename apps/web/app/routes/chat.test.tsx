// @vitest-environment jsdom
import { cleanup, fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import { createMemoryRouter, MemoryRouter, RouterProvider, useParams } from 'react-router';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import {
  findShownConversation,
  gate,
  json,
  Providers,
  sse,
  stubFetch,
  storeTestBaseUrl,
  untilOpenSettled,
} from '~/test-support';

import Chat, { ownedBy, retainedBy } from './chat';

const CONVERSATION_ID = 'conv-1';

const ChatRoute = Chat as unknown as (props: {
  loaderData: { conversationId: string | undefined };
}) => React.ReactElement;

function Harness() {
  const params = useParams();
  return <ChatRoute loaderData={{ conversationId: params.conversationId }} />;
}

function renderChat(initial = '/chat') {
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

const STREAM = [
  { event: 'open', data: { conversationId: CONVERSATION_ID } },
  { event: 'thinking', data: { type: 'thinking' } },
  { event: 'text', data: { type: 'text', text: 'こんにちは' } },
  { event: 'text', data: { type: 'text', text: '、元気にやっている' } },
  { event: 'done', data: { type: 'done' } },
];

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
  fireEvent.click(screen.getByRole('button', { name: 'メッセージを送信' }));
}

const transcript = () => screen.getByRole('list', { name: 'やりとり' });
const conversationList = () => screen.getByRole('list', { name: '会話' });

describe('新しい会話', () => {
  it('open で URL が変わっても、受信中のストリームが切れない', async () => {
    const stub = stubFetch((url, init) => {
      if (url.endsWith('/chat')) return sse(STREAM, { signal: init?.signal });
      if (url.includes(`/conversations/${CONVERSATION_ID}`)) {
        return json({
          conversationId: CONVERSATION_ID,
          messages: [
            { id: 'm1', at: '2026-08-20T00:00:00Z', role: 'inbound', text: 'やあ' },
            {
              id: 'm2',
              at: '2026-08-20T00:00:01Z',
              role: 'outbound',
              text: 'こんにちは、元気にやっている。',
            },
          ],
        });
      }
      if (url.includes('/approvals')) return json({ approvals: [] });
      if (url.includes('/conversations')) return json({ conversations: [], scanned: 0 });
      return undefined;
    });

    const { router } = renderChat();
    await send('やあ');

    expect(await screen.findByText(/こんにちは、元気にやっている/)).toBeTruthy();
    // やりとりの中に限って見る: 送信は会話一覧の抜粋にも即座に映り、画面全体で探すと同じ本文に二度当たるため
    expect(within(transcript()).getByText('やあ')).toBeTruthy();

    await waitFor(() => {
      expect(router.state.location.pathname).toBe(`/chat/${CONVERSATION_ID}`);
    });

    await waitFor(() => {
      expect(stub.calls.some((url) => url.includes(`/conversations/${CONVERSATION_ID}`))).toBe(
        true,
      );
    });
    await waitFor(() => {
      expect(within(transcript()).getAllByText('やあ')).toHaveLength(1);
      expect(within(transcript()).getAllByText(/こんにちは、元気にやっている/)).toHaveLength(1);
    });
  });

  it('受信が終わると入力へ戻る（送信中のままにしない）', async () => {
    stubFetch((url, init) => {
      if (url.endsWith('/chat')) return sse(STREAM, { signal: init?.signal });
      if (url.includes('/approvals')) return json({ approvals: [] });
      if (url.includes('/conversations')) return json({ conversations: [], scanned: 0 });
      return undefined;
    });

    renderChat();
    await send('やあ');

    await screen.findByText(/こんにちは、元気にやっている/);
    await waitFor(() => {
      expect(screen.queryByRole('button', { name: /受信をやめる/ })).toBeNull();
    });
    expect(screen.getByRole('button', { name: 'メッセージを送信' })).toBeTruthy();
  });

  it('送ると、会話一覧にその抜粋が即座に現れる', async () => {
    stubFetch((url, init) => {
      if (url.endsWith('/chat')) return sse(STREAM, { signal: init?.signal });
      if (url.includes('/approvals')) return json({ approvals: [] });
      if (url.includes('/conversations')) return json({ conversations: [], scanned: 0 });
      return undefined;
    });

    renderChat();
    await screen.findByText('まだ会話がない。');

    await send('やあ');

    // <ul> が出るのを待つ: 一覧が空のあいだは list ごと描かれず、先に掴もうとすると存在しないため
    await waitFor(() => conversationList());
    expect(within(conversationList()).getByText('やあ')).toBeTruthy();
  });
});

describe('受信をやめる', () => {
  it('進行中の合図が消え、それまでの本文は残る', async () => {
    const textGate = gate();
    const thinkingGate = gate();
    stubFetch((url, init) => {
      if (url.endsWith('/chat')) {
        return sse(
          [
            { event: 'open', data: { conversationId: CONVERSATION_ID } },
            {
              event: 'text',
              data: { type: 'text', text: 'ここまでは届いた' },
              after: textGate.promise,
            },
            { event: 'thinking', data: { type: 'thinking' }, after: thinkingGate.promise },
          ],
          { keepOpen: true, signal: init?.signal },
        );
      }
      if (url.includes('/approvals')) return json({ approvals: [] });
      if (url.includes('/conversations')) return json({ conversations: [], scanned: 0 });
      return undefined;
    });

    const { router } = renderChat();
    await send('やあ');
    await untilOpenSettled(router, CONVERSATION_ID);
    textGate.open();

    // 本文が届くまで待ってから止める: 「考えている…」は送信の瞬間から出ていて、それだけを待つと本文が届く前に止めてしまうため
    await screen.findByText('ここまでは届いた');
    thinkingGate.open();
    expect(await screen.findByText('考えている…')).toBeTruthy();
    fireEvent.click(screen.getByRole('button', { name: /受信をやめる/ }));

    await waitFor(() => {
      expect(screen.queryByText('考えている…')).toBeNull();
    });
    expect(screen.getByRole('button', { name: 'メッセージを送信' })).toBeTruthy();
    expect(screen.getByText('ここまでは届いた')).toBeTruthy();
    expect(within(transcript()).getByText('やあ')).toBeTruthy();
  });

  it('ツール実行中の表示でも同じ', async () => {
    const toolGate = gate();
    stubFetch((url, init) => {
      if (url.endsWith('/chat')) {
        return sse(
          [
            { event: 'open', data: { conversationId: CONVERSATION_ID } },
            {
              event: 'tool',
              data: { type: 'tool', tool: 'manager_start' },
              after: toolGate.promise,
            },
          ],
          { keepOpen: true, signal: init?.signal },
        );
      }
      if (url.includes('/approvals')) return json({ approvals: [] });
      if (url.includes('/conversations')) return json({ conversations: [], scanned: 0 });
      return undefined;
    });

    const { router } = renderChat();
    await send('やあ');

    await untilOpenSettled(router, CONVERSATION_ID);
    toolGate.open();

    expect(await screen.findByText(/manager_start を実行中/)).toBeTruthy();
    fireEvent.click(screen.getByRole('button', { name: /受信をやめる/ }));

    await waitFor(() => {
      expect(screen.queryByText(/manager_start を実行中/)).toBeNull();
    });
    expect(screen.getByRole('button', { name: 'メッセージを送信' })).toBeTruthy();
  });
});

describe('考えている…の合図', () => {
  it('サーバがまだ何も言っていなくても、送った瞬間に出る', async () => {
    stubFetch((url, init) => {
      if (url.endsWith('/chat')) {
        return sse([], { keepOpen: true, signal: init?.signal });
      }
      if (url.includes('/approvals')) return json({ approvals: [] });
      if (url.includes('/conversations')) return json({ conversations: [], scanned: 0 });
      return undefined;
    });

    renderChat();
    await send('やあ');

    expect(await screen.findByText('考えている…')).toBeTruthy();
  });

  it('本文が1文字でも来たら消える（受信はまだ続いている）', async () => {
    const textGate = gate();
    stubFetch((url, init) => {
      if (url.endsWith('/chat')) {
        return sse(
          [
            { event: 'open', data: { conversationId: CONVERSATION_ID } },
            { event: 'text', data: { type: 'text', text: 'こ' }, after: textGate.promise },
          ],
          { keepOpen: true, signal: init?.signal },
        );
      }
      if (url.includes('/approvals')) return json({ approvals: [] });
      if (url.includes('/conversations')) return json({ conversations: [], scanned: 0 });
      return undefined;
    });

    renderChat();
    await send('やあ');

    expect(await screen.findByText('考えている…')).toBeTruthy();
    textGate.open();
    await screen.findByText('こ');
    await waitFor(() => {
      expect(screen.queryByText('考えている…')).toBeNull();
    });
    expect(screen.getByRole('button', { name: /受信をやめる/ })).toBeTruthy();
  });

  it('本文の後にサーバの thinking が来たら、また出る', async () => {
    const textGate = gate();
    const thinkingGate = gate();
    stubFetch((url, init) => {
      if (url.endsWith('/chat')) {
        return sse(
          [
            { event: 'open', data: { conversationId: CONVERSATION_ID } },
            {
              event: 'text',
              data: { type: 'text', text: 'ここまでは届いた' },
              after: textGate.promise,
            },
            { event: 'thinking', data: { type: 'thinking' }, after: thinkingGate.promise },
          ],
          { keepOpen: true, signal: init?.signal },
        );
      }
      if (url.includes('/approvals')) return json({ approvals: [] });
      if (url.includes('/conversations')) return json({ conversations: [], scanned: 0 });
      return undefined;
    });

    const { router } = renderChat();
    await send('やあ');
    await untilOpenSettled(router, CONVERSATION_ID);
    textGate.open();

    await screen.findByText('ここまでは届いた');
    await waitFor(() => {
      expect(screen.queryByText('考えている…')).toBeNull();
    });
    thinkingGate.open();
    expect(await screen.findByText('考えている…')).toBeTruthy();
  });
});

describe('順番待ちの合図（queued）', () => {
  it('queued が来たら「順番を待っている…」へ差し替わる', async () => {
    const queuedGate = gate();
    stubFetch((url, init) => {
      if (url.endsWith('/chat')) {
        return sse(
          [
            { event: 'open', data: { conversationId: CONVERSATION_ID } },
            { event: 'queued', data: { type: 'queued' }, after: queuedGate.promise },
          ],
          { keepOpen: true, signal: init?.signal },
        );
      }
      if (url.includes('/approvals')) return json({ approvals: [] });
      if (url.includes('/conversations')) return json({ conversations: [], scanned: 0 });
      return undefined;
    });

    const { router } = renderChat();
    await send('やあ');
    await untilOpenSettled(router, CONVERSATION_ID);
    queuedGate.open();

    expect(await screen.findByText('順番を待っている…')).toBeTruthy();
  });

  it('順番が来たら「考えている…」へ移る（queued を置き換えるのではなく後に続く）', async () => {
    const queuedGate = gate();
    const thinkingGate = gate();
    stubFetch((url, init) => {
      if (url.endsWith('/chat')) {
        return sse(
          [
            { event: 'open', data: { conversationId: CONVERSATION_ID } },
            { event: 'queued', data: { type: 'queued' }, after: queuedGate.promise },
            { event: 'thinking', data: { type: 'thinking' }, after: thinkingGate.promise },
          ],
          { keepOpen: true, signal: init?.signal },
        );
      }
      if (url.includes('/approvals')) return json({ approvals: [] });
      if (url.includes('/conversations')) return json({ conversations: [], scanned: 0 });
      return undefined;
    });

    const { router } = renderChat();
    await send('やあ');
    await untilOpenSettled(router, CONVERSATION_ID);
    queuedGate.open();
    await screen.findByText('順番を待っている…');
    thinkingGate.open();

    expect(await screen.findByText('考えている…')).toBeTruthy();
    await waitFor(() => {
      expect(screen.queryByText('順番を待っている…')).toBeNull();
    });
  });
});

describe('枠が閉じている合図（usage_limited）', () => {
  it('直後に届く error・受信終了後も画面に残る（transient として消えない）', async () => {
    const limitedGate = gate();
    stubFetch((url, init) => {
      if (url.endsWith('/chat')) {
        return sse(
          [
            { event: 'open', data: { conversationId: CONVERSATION_ID } },
            {
              event: 'usage_limited',
              data: { type: 'usage_limited', message: '枠が閉じている（テスト用の文言）' },
              after: limitedGate.promise,
            },
            {
              event: 'error',
              data: { type: 'error', message: 'いまは投げられない', kind: 'other' },
            },
          ],
          { signal: init?.signal },
        );
      }
      if (url.includes('/approvals')) return json({ approvals: [] });
      if (url.includes('/conversations')) return json({ conversations: [], scanned: 0 });
      return undefined;
    });

    const { router } = renderChat();
    await send('やあ');
    await untilOpenSettled(router, CONVERSATION_ID);
    limitedGate.open();

    expect(await screen.findByText(/枠が閉じている（テスト用の文言）/)).toBeTruthy();
    expect(await screen.findByText(/配り直されて試し直される/)).toBeTruthy();
    expect(await screen.findByText('いまは投げられない')).toBeTruthy();

    await waitFor(() => {
      expect(screen.getByRole('button', { name: 'メッセージを送信' })).toBeTruthy();
    });
    expect(screen.getByText(/枠が閉じている（テスト用の文言）/)).toBeTruthy();
  });
});

describe('会話の切り替え', () => {
  it('navigate と同じ tick で、しかも abort が効かない前の会話のストリームから届いたチャンクは画面に出ない', async () => {
    let releaseStray: () => void = () => {};
    const strayGate = new Promise<void>((resolve) => {
      releaseStray = resolve;
    });
    stubFetch((url) => {
      if (url.endsWith('/chat')) {
        // わざと signal を渡さない: アプリ側の abort() でフレーム送出そのものは止まらない最悪条件を作るため
        return sse(
          [
            { event: 'open', data: { conversationId: CONVERSATION_ID } },
            { event: 'text', data: { type: 'text', text: 'こんにちは' } },
            { event: 'text', data: { type: 'text', text: '追加チャンク' }, after: strayGate },
            { event: 'done', data: { type: 'done' } },
          ],
          { keepOpen: true, delayMs: 0 },
        );
      }
      if (url.includes('/conversations/other')) {
        return json({
          conversationId: 'other',
          messages: [{ id: 'm1', at: '2026-08-13T00:00:00Z', role: 'inbound', text: '別の会話' }],
        });
      }
      if (url.includes('/approvals')) return json({ approvals: [] });
      if (url.includes('/conversations')) return json({ conversations: [], scanned: 0 });
      return undefined;
    });

    const { router } = renderChat();
    await send('やあ');
    await screen.findByText('こんにちは');

    const navPromise = router.navigate('/chat/other');
    releaseStray();
    await navPromise;

    await screen.findByText('別の会話');
    await new Promise((resolve) => setTimeout(resolve, 30));

    expect(screen.queryByText(/追加チャンク/)).toBeNull();
  });

  it('人間が別の会話を選んだら、前の会話の内容を捨てる', async () => {
    stubFetch((url, init) => {
      if (url.endsWith('/chat')) return sse(STREAM, { signal: init?.signal });
      if (url.includes('/conversations/other')) {
        return json({
          conversationId: 'other',
          messages: [{ id: 'm1', at: '2026-08-13T00:00:00Z', role: 'inbound', text: '別の会話' }],
        });
      }
      if (url.includes('/approvals')) return json({ approvals: [] });
      if (url.includes('/conversations')) return json({ conversations: [], scanned: 0 });
      return undefined;
    });

    const { router } = renderChat();
    await send('やあ');
    await screen.findByText(/こんにちは、元気にやっている/);

    await router.navigate('/chat/other');

    expect(await screen.findByText('別の会話')).toBeTruthy();
    // waitFor の timeout を戻さない: 実行環境が他のプロセスと共有され、CI の負荷下で既定の 1000ms を超えうるため
    await waitFor(
      () => {
        expect(screen.queryByText(/こんにちは、元気にやっている/)).toBeNull();
      },
      { timeout: 3000 },
    );
  });
});

describe('前の会話の行の扱い（#437）', () => {
  const 行 = (of: string | undefined, text: string) => ({
    key: `k-${text}`,
    role: 'clone' as const,
    text,
    of,
  });

  it('貼り直しで前の会話の行が戻ってきても、いま見ている会話には出ない', () => {
    const 戻ってきた = [行(CONVERSATION_ID, 'やあ'), 行(CONVERSATION_ID, 'こんにちは追加チャンク')];

    expect(ownedBy(戻ってきた, 'other')).toEqual([]);
    expect(ownedBy(戻ってきた, undefined)).toEqual([]);
    expect(ownedBy(戻ってきた, CONVERSATION_ID)).toHaveLength(2);

    expect(ownedBy([行(undefined, 'まだ持ち主が決まっていない')], CONVERSATION_ID)).toEqual([]);
    expect(ownedBy([行(undefined, 'まだ持ち主が決まっていない')], undefined)).toHaveLength(1);
  });

  it('古い routeId で描き直されても、送った発言も届いた本文も消えない', async () => {
    stubFetch((url, init) => {
      if (url.endsWith('/chat')) return sse(STREAM, { signal: init?.signal });
      if (url.includes(`/conversations/${CONVERSATION_ID}`)) {
        return json({ conversationId: CONVERSATION_ID, messages: [] });
      }
      if (url.includes('/approvals')) return json({ approvals: [] });
      if (url.includes('/conversations')) return json({ conversations: [], scanned: 0 });
      return undefined;
    });

    const 画面 = ({ routeId }: { routeId: string | undefined }) => (
      <Providers>
        <MemoryRouter initialEntries={['/chat']}>
          <ChatRoute loaderData={{ conversationId: routeId }} />
        </MemoryRouter>
      </Providers>
    );
    const Screen = 画面;

    const { rerender } = render(<Screen routeId={CONVERSATION_ID} />);
    await send('やあ');
    await screen.findByText(/こんにちは、元気にやっている/);

    rerender(<Screen routeId={undefined} />);
    rerender(<Screen routeId={CONVERSATION_ID} />);

    expect(within(transcript()).getByText('やあ')).toBeTruthy();
    expect(within(transcript()).getByText(/こんにちは、元気にやっている/)).toBeTruthy();
  });
});

describe('保つ持ち主の上限（retainedBy。issue #446）', () => {
  const 行 = (of: string | undefined, text: string) => ({
    key: `k-${text}`,
    role: 'clone' as const,
    text,
    of,
  });

  it('いま見ている会話・直前の会話・持ち主なし の3つが残る', () => {
    const lines = [
      行('conv-current', '現在の会話の行'),
      行('conv-previous', '直前の会話の行'),
      行(undefined, '持ち主がまだ決まっていない行'),
    ];

    expect(retainedBy(lines, 'conv-current', 'conv-previous')).toHaveLength(3);
  });

  it('それ以外（2つ前・無関係な会話）は落ちる', () => {
    const lines = [
      行('conv-current', '現在の会話の行'),
      行('conv-previous', '直前の会話の行'),
      行(undefined, '持ち主がまだ決まっていない行'),
      行('conv-older', '2つ前の会話の行'),
      行('conv-unrelated', '無関係な会話の行'),
    ];

    expect(retainedBy(lines, 'conv-current', 'conv-previous')).toHaveLength(3);
  });

  it('直前の会話が無い（undefined。会話の切り替えをまだ一度もしていない）ときは、いまと持ち主なしだけが残る', () => {
    const lines = [
      行('conv-current', '現在の会話の行'),
      行(undefined, '持ち主がまだ決まっていない行'),
      行('conv-older', '前に見ていた別の会話の行'),
    ];

    expect(retainedBy(lines, 'conv-current', undefined)).toHaveLength(2);
  });
});

describe('会話を跨いだ手元の行の生死（配線。issue #446）', () => {
  const LOCAL_ONLY_REPLY = 'ローカルAだけの返信（履歴には無い）';

  function stubThreeConversations() {
    return stubFetch((url, init) => {
      if (url.endsWith('/chat')) {
        return sse(
          [
            { event: 'open', data: { conversationId: 'conv-a' } },
            { event: 'text', data: { type: 'text', text: LOCAL_ONLY_REPLY } },
            { event: 'done', data: { type: 'done' } },
          ],
          { signal: init?.signal },
        );
      }
      if (url.includes('/conversations/conv-a')) {
        return json({ conversationId: 'conv-a', messages: [] });
      }
      if (url.includes('/conversations/conv-b')) {
        return json({ conversationId: 'conv-b', messages: [] });
      }
      if (url.includes('/conversations/conv-c')) {
        return json({ conversationId: 'conv-c', messages: [] });
      }
      if (url.includes('/approvals')) return json({ approvals: [] });
      if (url.includes('/conversations')) return json({ conversations: [], scanned: 0 });
      return undefined;
    });
  }

  it('直前の会話（1つ先）までは、履歴に無い手元の行が保たれる', async () => {
    stubThreeConversations();
    const { router } = renderChat('/chat/conv-a');

    await send('やあ');
    expect(await within(transcript()).findByText(LOCAL_ONLY_REPLY)).toBeTruthy();

    // 各 navigate の後にヘッダの会話 id が切り替わるのを待つ: 待たずに連続で navigate すると、途中の会話を経由したことにならないため
    await router.navigate('/chat/conv-b');
    await findShownConversation('conv-b');
    await router.navigate('/chat/conv-a');
    await findShownConversation('conv-a');

    expect(within(transcript()).getByText(LOCAL_ONLY_REPLY)).toBeTruthy();
  });

  it('2つ先まで離れると、履歴に無い手元の行は状態から刈られて消える', async () => {
    stubThreeConversations();
    const { router } = renderChat('/chat/conv-a');

    await send('やあ');
    expect(await within(transcript()).findByText(LOCAL_ONLY_REPLY)).toBeTruthy();

    await router.navigate('/chat/conv-b');
    await findShownConversation('conv-b');
    await router.navigate('/chat/conv-c');
    await findShownConversation('conv-c');
    await router.navigate('/chat/conv-a');
    await findShownConversation('conv-a');

    await waitFor(() => {
      expect(screen.queryByText(LOCAL_ONLY_REPLY)).toBeNull();
    });
  });
});

describe('遡り切れていないことを言う', () => {
  const MESSAGE = { id: 'm1', at: '2026-08-13T00:00:00Z', role: 'inbound', text: '古い発言' };

  function stubDetail(detail: unknown) {
    return stubFetch((url, init) => {
      if (url.endsWith('/chat')) return sse(STREAM, { signal: init?.signal });
      if (url.includes(`/conversations/${CONVERSATION_ID}`)) return json(detail);
      if (url.includes('/approvals')) return json({ approvals: [] });
      if (url.includes('/conversations')) return json({ conversations: [], scanned: 0 });
      return undefined;
    });
  }

  it('窓が先頭に届いていなければ、遡った件数を添えてそう書く', async () => {
    stubDetail({
      conversationId: CONVERSATION_ID,
      messages: [MESSAGE],
      scanned: 2000,
      reachedStart: false,
    });
    renderChat(`/chat/${CONVERSATION_ID}`);

    expect(
      await screen.findByText(/人間との往復を 2000 件遡ったが、先頭には届いていない/),
    ).toBeTruthy();
    expect(screen.getByText('古い発言')).toBeTruthy();
  });

  it('中身が空のときも「無い」とは書かず、判定できないことを書く', async () => {
    stubDetail({
      conversationId: CONVERSATION_ID,
      messages: [],
      scanned: 2000,
      reachedStart: false,
    });
    renderChat(`/chat/${CONVERSATION_ID}`);

    expect(await screen.findByText(/先頭には届いていない/)).toBeTruthy();
  });

  it('窓が先頭に届いていれば、但し書きは出さない', async () => {
    stubDetail({
      conversationId: CONVERSATION_ID,
      messages: [MESSAGE],
      scanned: 3,
      reachedStart: true,
    });
    renderChat(`/chat/${CONVERSATION_ID}`);

    expect(await screen.findByText('古い発言')).toBeTruthy();
    expect(screen.queryByText(/先頭には届いていない/)).toBeNull();
  });
});

describe('会話一覧の断り書き（#418 の裏返し）', () => {
  function stubList(list: unknown) {
    return stubFetch((url, init) => {
      if (url.endsWith('/chat')) return sse(STREAM, { signal: init?.signal });
      if (url.includes(`/conversations/${CONVERSATION_ID}`)) {
        return json({ conversationId: CONVERSATION_ID, messages: [] });
      }
      if (url.includes('/approvals')) return json({ approvals: [] });
      if (url.includes('/conversations')) return json(list);
      return undefined;
    });
  }

  const CONVERSATION = {
    conversationId: 'conv-x',
    startedAt: '2026-08-20T00:00:00Z',
    updatedAt: '2026-08-20T00:00:00Z',
    messages: 1,
    preview: '一覧の1件',
  };

  it('reachedStart が偽なら、先頭に届いていないと書く', async () => {
    stubList({
      conversations: [CONVERSATION],
      scanned: 2000,
      reachedStart: false,
      hiddenByLimit: 0,
    });
    renderChat();

    expect(
      await screen.findByText(/人間との往復を 2000 件遡ったが、先頭には届いていない/),
    ).toBeTruthy();
    expect(screen.queryByText(/…ほか/)).toBeNull();
  });

  it('reachedStart が真なら、先頭に届いていないとは書かない（不在の側）', async () => {
    stubList({
      conversations: [CONVERSATION],
      scanned: 1,
      reachedStart: true,
      hiddenByLimit: 0,
    });
    renderChat();

    await screen.findByText('一覧の1件');
    expect(screen.queryByText(/先頭には届いていない/)).toBeNull();
  });

  it('hiddenByLimit が正なら、省いた件数を書く', async () => {
    stubList({
      conversations: [CONVERSATION],
      scanned: 30,
      reachedStart: true,
      hiddenByLimit: 5,
    });
    renderChat();

    expect(await screen.findByText(/…ほか 5 件は省略/)).toBeTruthy();
    expect(screen.queryByText(/先頭には届いていない/)).toBeNull();
  });

  it('hiddenByLimit が0なら、省いた件数は書かない（不在の側）', async () => {
    stubList({
      conversations: [CONVERSATION],
      scanned: 1,
      reachedStart: true,
      hiddenByLimit: 0,
    });
    renderChat();

    await screen.findByText('一覧の1件');
    expect(screen.queryByText(/…ほか/)).toBeNull();
  });

  it('両方の条件が成り立てば、両方書く', async () => {
    stubList({
      conversations: [CONVERSATION],
      scanned: 2000,
      reachedStart: false,
      hiddenByLimit: 5,
    });
    renderChat();

    expect(
      await screen.findByText(/人間との往復を 2000 件遡ったが、先頭には届いていない/),
    ).toBeTruthy();
    expect(await screen.findByText(/…ほか 5 件は省略/)).toBeTruthy();
  });
});

describe('吹き出しの折り返し（本2）', () => {
  it('人間の吹き出しに break-words が付いている', async () => {
    stubFetch((url, init) => {
      if (url.endsWith('/chat')) return sse(STREAM, { signal: init?.signal });
      if (url.includes('/approvals')) return json({ approvals: [] });
      if (url.includes('/conversations')) return json({ conversations: [], scanned: 0 });
      return undefined;
    });

    renderChat();
    await send('やあ');

    const bubble = within(transcript()).getByText('やあ');
    expect(bubble.className.split(/\s+/)).toContain('break-words');
  });
});

// aria-label 属性そのものを直接見る: jsdom は CSS を評価せず、aria-label を消しても getByRole の name が通ってしまうため
describe('送信ボタンの狭幅対応（本6）', () => {
  it('送信ボタンは記号だけで文字のラベルを持たない（名前は aria-label が担う）', async () => {
    stubFetch((url, init) => {
      if (url.endsWith('/chat')) return sse(STREAM, { signal: init?.signal });
      if (url.includes('/approvals')) return json({ approvals: [] });
      if (url.includes('/conversations')) return json({ conversations: [], scanned: 0 });
      return undefined;
    });

    renderChat();
    const sendButton = await screen.findByRole('button', { name: 'メッセージを送信' });
    expect(sendButton.textContent).toBe('');
  });

  it('送信ボタンは aria-label="メッセージを送信" を明示している（getByRole の名前一致だけでは確かめられない — 属性を直接見る）', async () => {
    stubFetch((url, init) => {
      if (url.endsWith('/chat')) return sse(STREAM, { signal: init?.signal });
      if (url.includes('/approvals')) return json({ approvals: [] });
      if (url.includes('/conversations')) return json({ conversations: [], scanned: 0 });
      return undefined;
    });

    renderChat();
    const sendButton = await screen.findByRole('button', { name: 'メッセージを送信' });
    expect(sendButton.getAttribute('aria-label')).toBe('メッセージを送信');
  });

  it('受信中は「受信をやめる」もアイコンだけで文字のラベルを持たず、aria-label を明示している。かつ送信ボタンは消えず両方とも出ている', async () => {
    stubFetch((url, init) => {
      if (url.endsWith('/chat')) {
        return sse(
          [{ event: 'open', data: { conversationId: CONVERSATION_ID } }],
          // done を送らない: 受信中の状態を保つため
          { keepOpen: true, signal: init?.signal },
        );
      }
      if (url.includes('/approvals')) return json({ approvals: [] });
      if (url.includes('/conversations')) return json({ conversations: [], scanned: 0 });
      return undefined;
    });

    renderChat();
    await send('やあ');

    const stopButton = await screen.findByRole('button', {
      name: '受信をやめる（クローンのターンは止まらない）',
    });
    expect(stopButton.textContent).toBe('');
    expect(stopButton.getAttribute('aria-label')).toBe(
      '受信をやめる（クローンのターンは止まらない）',
    );

    expect(screen.getByRole('button', { name: 'メッセージを送信' })).toBeTruthy();
  });
});

describe('ChatPane の横向き safe-area inset（本4）', () => {
  it('ヘッダ・本文・入力欄の帯が pl / pr の safe-area クラスを持つ（クラス名の存在のみ）', async () => {
    stubFetch((url, init) => {
      if (url.endsWith('/chat')) return sse(STREAM, { signal: init?.signal });
      if (url.includes('/approvals')) return json({ approvals: [] });
      if (url.includes('/conversations')) return json({ conversations: [], scanned: 0 });
      return undefined;
    });

    renderChat();
    await send('やあ');

    const header = screen.getByRole('banner');
    const headerClasses = header.className.split(/\s+/);
    expect(headerClasses).toContain('pl-[calc(1rem+var(--safe-left))]');
    expect(headerClasses).toContain('pr-[calc(1rem+var(--safe-right))]');
    expect(headerClasses).toContain('md:pl-[calc(1.5rem+var(--safe-left))]');
    expect(headerClasses).toContain('md:pr-[calc(1.5rem+var(--safe-right))]');

    const body = screen.getByRole('list', { name: 'やりとり' }).parentElement;
    if (body === null) throw new Error('やりとりの親要素が見つからない');
    const bodyClasses = body.className.split(/\s+/);
    expect(bodyClasses).toContain('pl-[calc(1rem+var(--safe-left))]');
    expect(bodyClasses).toContain('pr-[calc(1rem+var(--safe-right))]');
    expect(bodyClasses).toContain('md:pl-[calc(1.5rem+var(--safe-left))]');
    expect(bodyClasses).toContain('md:pr-[calc(1.5rem+var(--safe-right))]');

    const textbox = screen.getByPlaceholderText(/クローンに話しかける/);
    const footer = textbox.parentElement?.parentElement?.parentElement;
    if (footer === undefined || footer === null) throw new Error('入力欄の帯が見つからない');
    const footerClasses = footer.className.split(/\s+/);
    expect(footerClasses).toContain('pl-[calc(1rem+var(--safe-left))]');
    expect(footerClasses).toContain('pr-[calc(1rem+var(--safe-right))]');
    expect(footerClasses).toContain('md:pl-[calc(1.5rem+var(--safe-left))]');
    expect(footerClasses).toContain('md:pr-[calc(1.5rem+var(--safe-right))]');
    expect(footerClasses).toContain('pb-[calc(0.75rem+var(--safe-bottom))]');
  });
});
