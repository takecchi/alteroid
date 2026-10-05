// @vitest-environment jsdom
/**
 * Issue #1618: 入力欄の下書き（送っていない文章）は会話ごとに分かれていない。
 *
 * `apps/web/app/routes/chat.tsx` の `const [draft, setDraft] = useState('');`
 * は `ChatPane` の中に1つしかない。`ChatPane` は会話を切り替えても作り直さない
 * （`key` を付けない設計。`chat.tsx` の `Chat` 内のコメント参照）ため、`draft`
 * はこの画面が生きている限り1つのまま——会話 A で書きかけの下書きを送らずに
 * 会話 B へ切り替えると、A の下書きがそのまま B の入力欄に出る（漏れ）。B で
 * 書き換えてから A へ戻ると、A のもともとの下書きは失われ、B で書いた文字列が
 * A の入力欄に出る（取りこぼし）。
 *
 * **あるべき形（マネージャーの判断、Issue の (a)）**: 下書きを会話ごとに持ち、
 * 戻ったら戻す。鍵は会話の id（URL の `routeId`）——新しい会話（id が無い）も
 * `undefined` という1つの鍵として持つ。送った会話の下書きは、送った時点で
 * その会話の分だけ空にする（他の会話の下書きに触れない）。再読み込みを跨いだ
 * 保存（`localStorage` 等）はこの Issue の範囲外——このテストも保存はメモリの
 * 中だけであることを前提にしている。
 *
 * 直す前のこのファイルの前身は
 * `zz-repro-draft-leaks-across-conversations.test.tsx`（漏れ・取りこぼしの
 * 2本）。ここではそれを正式なテストとして起こし、以下を追加する:
 * - 送ったら、その会話の下書きだけが空になり、別の会話の下書きは残る
 * - 新しい会話 → 既存の会話 → 新しい会話 で、新しい会話の下書きが戻る
 *
 * Issue #2453 で1本足した: 新しい会話で送った文章が、次に新しい会話を開いた
 * ときに下書きとして戻らない。
 */
import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { createMemoryRouter, RouterProvider, useParams } from 'react-router';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import {
  findShownConversation,
  json,
  Providers,
  sse,
  storeTestBaseUrl,
  stubFetch,
  type Route,
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

/**
 * `/approvals` はこの試験の対象ではない——だが issue #2210 以降、`chat.tsx` が
 * `conversationApprovals.error` を見て `ErrorNote` を出すようになったので、
 * 未ハンドルのまま（＝`Failed to fetch` で失敗）にすると無関係な `alert` が
 * 増える。ここでは素直に0件で成功させる。
 */
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

    // 送らずに B へ切り替える。
    await router.navigate(`/chat/${CONVERSATION_B}`);
    expect(await findShownConversation(CONVERSATION_B)).toBeTruthy();

    const boxAfterSwitch = await draftBox();
    // あるべき形: B の入力欄は空（A の下書きが漏れていない）。
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
    // あるべき形: A へ戻ったら A の下書き「Aの下書き」が復元される。
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

    // A に下書きを残したまま、送らずに B へ切り替える。
    const boxInA = await draftBox();
    fireEvent.change(boxInA, { target: { value: 'Aの下書き（送らない）' } });
    await router.navigate(`/chat/${CONVERSATION_B}`);
    expect(await findShownConversation(CONVERSATION_B)).toBeTruthy();

    // B で書いて実際に送る。
    const boxInB = await draftBox();
    fireEvent.change(boxInB, { target: { value: 'Bから送る発言' } });
    fireEvent.click(screen.getByRole('button', { name: /送る/ }));

    // 送信の時点で B の入力欄は空になる（他の会話の下書きには触れない）。
    expect((await draftBox()).value).toBe('');
    // クローンの返信が届くまで待って、ストリームを綺麗に終わらせる。
    await screen.findByText('わかった');
    expect((await draftBox()).value).toBe('');

    // A へ戻ると、A の下書きは B の送信に影響されずそのまま残っている。
    await router.navigate(`/chat/${CONVERSATION_A}`);
    expect(await findShownConversation(CONVERSATION_A)).toBeTruthy();
    expect((await draftBox()).value).toBe('Aの下書き（送らない）');
  });

  it('新しい会話 → 既存の会話 → 新しい会話 で、新しい会話の下書きが戻る', async () => {
    const route: Route = (url) => conversationRoutes(url);
    stubFetch(route);

    const { router } = renderChat('/chat');

    // 新しい会話（URL に id が無い＝鍵は undefined）で書きかける。
    const boxNew = await draftBox();
    fireEvent.change(boxNew, { target: { value: '新しい会話の下書き' } });

    // 既存の会話 A へ切り替える。
    await router.navigate(`/chat/${CONVERSATION_A}`);
    expect(await findShownConversation(CONVERSATION_A)).toBeTruthy();
    expect((await draftBox()).value).toBe('');

    // 新しい会話へ戻る。
    await router.navigate('/chat');
    // `findByText(CONVERSATION_...)` に相当する「新しい会話に戻った」の確認——
    // ヘッダー（`ChatHeader`（`packages/ui/src/components/features/chat/chat-header.tsx`）の `{conversationId ?? '新しい会話'}`）が新しい会話では
    // 常にこの文字列を出すので、それを待つ。**入力欄（`draftBox()`）は会話を
    // 切り替えても同じ DOM ノードのまま残る（`key` を付けない設計）ため、
    // `findByPlaceholderText` は「既に存在する」の一致で即座に解決してしまい、
    // 切り替え時の同期リセット（`drafts`/`draft` の入れ替え）がまだコミットされて
    // いない瞬間を捉えてしまうことがあった（フレーク。#1618 の直後に観測）。
    // ヘッダーの文字列はこの時点まで存在しなかった／別の文字列だったものが
    // 実際に変わる（`CONVERSATION_A` → `新しい会話`）ので、これを待てば
    // 同じ render で一緒にコミットされる `draft` の入れ替えも終わっている
    // ことが保証される——`waitFor` のタイムアウトを延ばしたり `draftBox()` 側の
    // アサーションを緩めたりするのではなく、待つ対象を「既に居る要素」から
    // 「これから変わる、切り替えの完了そのものを示す要素」へ差し替える直し。
    expect(await screen.findByText('新しい会話')).toBeTruthy();
    expect((await draftBox()).value).toBe('新しい会話の下書き');
  });

  /*
   * Issue #2453: 新しい会話で送った文章が、次に新しい会話を開くと下書きとして
   * 復活していた。
   *
   * 鍵 `undefined` にしまった下書きは、戻ってきて `draft` へ読み出しても
   * Map に残ったままだった。新しい会話で送ると `setDraft('')` の後に `open`
   * で `shownId` が確定した id へ替わるので、次に離れるときの鍵はその id に
   * なり、鍵 `undefined` の古い値は空で上書きされない。直しは、入ってくる
   * 会話の鍵を読んだら Map から消すこと（読み出した値は `draft` が持つ）。
   */
  it('新しい会話で送る → 別の会話 → 新しい会話 で、送った文章が下書きとして戻らない（#2453）', async () => {
    const CONVERSATION_NEW = 'conv-draft-new';
    const STREAM_NEW = [
      { event: 'open', data: { conversationId: CONVERSATION_NEW } },
      { event: 'text', data: { type: 'text', text: '受け取った' } },
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

    // 新しい会話で書きかけ、送らずに A へ移る（鍵 undefined にしまわれる）。
    fireEvent.change(await draftBox(), { target: { value: '新しい会話から送る発言' } });
    await router.navigate(`/chat/${CONVERSATION_A}`);
    expect(await findShownConversation(CONVERSATION_A)).toBeTruthy();
    expect((await draftBox()).value).toBe('');

    // 新しい会話へ戻ると下書きが戻る（直前の歯と同じ前提）。
    await router.navigate('/chat');
    expect(await screen.findByText('新しい会話')).toBeTruthy();
    expect((await draftBox()).value).toBe('新しい会話から送る発言');

    // それを送る。`open` で id が確定し、URL が `/chat/<新しい id>` へ追いつく。
    fireEvent.click(screen.getByRole('button', { name: /送る/ }));
    expect((await draftBox()).value).toBe('');
    await screen.findByText('受け取った');
    await waitFor(() => {
      expect(router.state.location.pathname).toBe(`/chat/${CONVERSATION_NEW}`);
    });
    expect((await draftBox()).value).toBe('');

    // 別の会話へ移ってから、もう一度「新しい会話」を開く。
    await router.navigate(`/chat/${CONVERSATION_A}`);
    expect(await findShownConversation(CONVERSATION_A)).toBeTruthy();
    await router.navigate('/chat');
    expect(await screen.findByText('新しい会話')).toBeTruthy();
    // あるべき形: 送った文章は下書きとして戻らない。
    expect((await draftBox()).value).toBe('');
  });
});
