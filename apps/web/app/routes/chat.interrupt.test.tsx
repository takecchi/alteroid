// @vitest-environment jsdom
/**
 * 「いま走っているクローンのターンを止める」ボタン（#1398 c23-1/c30-2）。
 *
 * PR #1474（`0297103`）で `POST /clone/interrupt` と CLI の `alteroid interrupt`
 * が入ったが、Web UI にはこの口が無かった——docs/PRD.md の「入口の等価性」
 * （ある入口でできることが別の入口でできない状態を作らない）に反する状態だった。
 *
 * ここで固定したいのは4つ:
 *
 * 1. ボタンを押すと `POST /clone/interrupt`（本文 `{}`）が実際に飛ぶこと
 * 2. 応答の3値（`interrupted` / `idle` / `unsupported`）を、CLI の
 *    `describeInterruptOutcome`（`apps/cli/src/interrupt.ts`）と同じ文言で
 *    人間に見せること——`describeCloneInterruptOutcome`（`chat.tsx`）の直接の
 *    単体試験と、画面を通した結合試験の両方で見る
 * 3. 呼べなかった失敗（ネットワーク断・403 等）は結果ではなく `ErrorNote` に
 *    出ること——「止めた」と誤読させない
 * 4. **#1548 / #1570**: 会話 A で押した後、応答が返るより先に会話 B へ切り替えたら、
 *    遅れて届いた「止めた」の表示は B の画面に出ないこと。`ChatPane` は
 *    会話を切り替えても作り直されない（`chat.tsx` の doc）ので、この経路は
 *    `handleInterrupt` 自身が「押したときの会話」を覚えていないと守れない。
 *
 *    **#1548 は `shownIdRef.current`（`useEffect` の中でしか進まない ref）を
 *    比べる形で直したが、#1570 はその ref が進む前の窓（会話を切り替えた
 *    render から、`useEffect(() => { shownIdRef.current = shownId; ... },
 *    [shownId])` が走るまでの間）で応答が返ると、判定が誤って「まだ同じ
 *    会話」と読むことを見つけた。** いまは ref にも効果の順序にも依らない
 *    形（`interruptNotice`/`interruptFailure` に押した時点の会話 id を積み、
 *    出すかどうかは描画する時点の `shownId` と突き合わせて決める）に直っている
 *    ので、下の3本はどれも緑になる——**1本目（act で効果を先に流す）・
 *    3本目（act を挟まず、#1570 の Issue 本文の再現をそのまま足したもの）の
 *    どちらでも**同じ理由で緑になることを見る。
 */
import { act, cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { createMemoryRouter, RouterProvider, useParams } from 'react-router';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import { json, Providers, storeTestBaseUrl, stubFetch, type Route } from '~/test-support';

import Chat, { describeCloneInterruptOutcome } from './chat';

const CONVERSATION_ID = 'conv-interrupt-1';
const OTHER_CONVERSATION_ID = 'conv-interrupt-2';

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

async function findInterruptButton() {
  return screen.findByRole('button', { name: 'クローンのターンを止める' });
}

/** 同期版。`waitFor` の中で使う（`interrupting` が畳まれたかを見るため）。 */
function interruptButton() {
  return screen.getByRole('button', { name: 'クローンのターンを止める' });
}

describe('describeCloneInterruptOutcome（CLI と文言を揃える単体試験）', () => {
  it('interrupted', () => {
    expect(describeCloneInterruptOutcome('interrupted')).toBe(
      'いま走っていたクローンのターンを止めた。会話の続きと受信箱はそのまま残る（次の合図で次のターンが始まる）。',
    );
  });

  it('idle', () => {
    expect(describeCloneInterruptOutcome('idle')).toBe(
      '走っているターンは無かった（止めるものが無い）。',
    );
  });

  it('unsupported', () => {
    expect(describeCloneInterruptOutcome('unsupported')).toBe(
      'このデーモンのクローンは、ターンを止める口を持っていない。',
    );
  });
});

describe('「ターンを止める」ボタン', () => {
  it('押すと POST /clone/interrupt を本文 {} で1回だけ叩く', async () => {
    const stub = stubFetch((url) => {
      const conversation = conversationRoutes(url);
      if (conversation !== undefined) return conversation;
      if (url.endsWith('/clone/interrupt')) return json({ outcome: 'interrupted' });
      return undefined;
    });

    renderChat(`/chat/${CONVERSATION_ID}`);
    fireEvent.click(await findInterruptButton());

    await waitFor(() => {
      expect(stub.entries.some((entry) => entry.url.endsWith('/clone/interrupt'))).toBe(true);
    });

    const calls = stub.entries.filter((entry) => entry.url.endsWith('/clone/interrupt'));
    expect(calls).toHaveLength(1);
    const call = calls[0];
    expect(call?.request?.method).toBe('POST');
    const body = (await call?.request?.clone().json()) as unknown;
    expect(body).toEqual({});
  });

  it('interrupted: 止めたこと・セッションと受信箱が残ることを言う', async () => {
    stubFetch((url) => {
      const conversation = conversationRoutes(url);
      if (conversation !== undefined) return conversation;
      if (url.endsWith('/clone/interrupt')) return json({ outcome: 'interrupted' });
      return undefined;
    });

    renderChat(`/chat/${CONVERSATION_ID}`);
    fireEvent.click(await findInterruptButton());

    expect(
      await screen.findByText(
        'いま走っていたクローンのターンを止めた。会話の続きと受信箱はそのまま残る（次の合図で次のターンが始まる）。',
      ),
    ).toBeTruthy();
  });

  it('idle: 止めるものが無かったことを、止めたとは言わずに伝える', async () => {
    stubFetch((url) => {
      const conversation = conversationRoutes(url);
      if (conversation !== undefined) return conversation;
      if (url.endsWith('/clone/interrupt')) return json({ outcome: 'idle' });
      return undefined;
    });

    renderChat(`/chat/${CONVERSATION_ID}`);
    fireEvent.click(await findInterruptButton());

    expect(
      await screen.findByText('走っているターンは無かった（止めるものが無い）。'),
    ).toBeTruthy();
    // 「止めた」側の文言とは混ざらない。
    expect(screen.queryByText(/いま走っていたクローンのターンを止めた/)).toBeNull();
  });

  it('unsupported: この構成では止められないことを伝える', async () => {
    stubFetch((url) => {
      const conversation = conversationRoutes(url);
      if (conversation !== undefined) return conversation;
      if (url.endsWith('/clone/interrupt')) return json({ outcome: 'unsupported' });
      return undefined;
    });

    renderChat(`/chat/${CONVERSATION_ID}`);
    fireEvent.click(await findInterruptButton());

    expect(
      await screen.findByText('このデーモンのクローンは、ターンを止める口を持っていない。'),
    ).toBeTruthy();
  });

  it('呼べなかった失敗（403）は結果ではなく ErrorNote に出る。「止めた」とは言わない', async () => {
    stubFetch((url) => {
      const conversation = conversationRoutes(url);
      if (conversation !== undefined) return conversation;
      if (url.endsWith('/clone/interrupt')) return json({ error: '許可が無い' }, 403);
      return undefined;
    });

    renderChat(`/chat/${CONVERSATION_ID}`);
    fireEvent.click(await findInterruptButton());

    expect(await screen.findByRole('alert')).toBeTruthy();
    expect(screen.getByRole('alert').textContent).toContain('許可が無い');
    // 3値のどの文言も出ていない——失敗を結果と取り違えていない。
    expect(screen.queryByText(/いま走っていたクローンのターンを止めた/)).toBeNull();
    expect(screen.queryByText('走っているターンは無かった（止めるものが無い）。')).toBeNull();
    expect(
      screen.queryByText('このデーモンのクローンは、ターンを止める口を持っていない。'),
    ).toBeNull();
  });
});

/**
 * #1548 / #1570 の再現と固定。
 *
 * `ChatPane` は会話を切り替えても作り直されない（`chat.tsx` の doc）ので、
 * `handleInterrupt` が「押したときの会話」を覚えていないと、応答が遅れて
 * 届いた回だけ別の会話の画面に「止めた」が出る。`/clone/interrupt` の応答を
 * テスト側が明示的に許可するまで返らない形にして（`test-support.tsx` の
 * `Route` の doc が想定する「まだ返事が来ていない要求」）、時計に頼らず
 * 「B へ切り替えた後で応答が届く」という順序を作る。
 *
 * **3本ある理由。** #1548 の直し（`shownIdRef.current` を比べる）は、
 * 「切り替えの render から `useEffect` が走るまでの窓」の中で応答が返ると
 * 判定を誤る（#1570）。その窓を挟むかどうかで2つの経路があるので、両方を
 * 別のテストとして固定する——片方だけを直すと、直っていないほうが緑のまま
 * 隠れる。
 *
 * 1. **`await act(async () => {})` で効果を先に流してから応答を返す**
 *    （窓を挟まない経路）——#1548 の直しだけでも緑になっていた
 * 2. **B の DOM が commit された直後、受動効果が走る前に応答を返す**（窓の中の
 *    経路）。MutationObserver のコールバック（マイクロタスク）で応答を返して窓を
 *    確実に突く。#1570 の本文の再現（`act()` を挟まずに返す形）は、`findBy` が
 *    待つ間に効果まで流れてしまい、この環境では直す前の main でも緑だった。
 *    この形は直す前の main で赤、直した後で緑になることを確かめてある
 * 3. 同じ会話のまま応答が返る対照（切り替えていない）——1・2 のどちらでも
 *    「出るべきときにまで消してしまっていないか」を確かめる
 */
describe('会話を切り替えた後に届いた応答（#1548 / #1570）', () => {
  it('A で押した後 B へ切り替え、効果が走ってから応答が返っても B に出ない（act で効果を先に流す）', async () => {
    let releaseInterrupt: () => void = () => {};
    const interruptReleased = new Promise<void>((resolve) => {
      releaseInterrupt = resolve;
    });
    const route: Route = (url) => {
      const conversation = conversationRoutes(url);
      if (conversation !== undefined) return conversation;
      if (url.endsWith('/clone/interrupt')) {
        return interruptReleased.then(() => json({ outcome: 'interrupted' }));
      }
      return undefined;
    };
    const stub = stubFetch(route);

    const { router } = renderChat(`/chat/${CONVERSATION_ID}`);
    fireEvent.click(await findInterruptButton());

    // interrupt が実際に飛んだ（まだ応答は返っていない）ことを確かめてから切り替える。
    await waitFor(() => {
      expect(stub.entries.some((entry) => entry.url.endsWith('/clone/interrupt'))).toBe(true);
    });

    await router.navigate(`/chat/${OTHER_CONVERSATION_ID}`);
    // B の画面に切り替わったことを確かめる（ヘッダーの会話 id 表示）。
    expect(await screen.findByText(OTHER_CONVERSATION_ID)).toBeTruthy();

    /*
     * 切り替わったこと（DOM のテキスト）は render の commit で分かるが、
     * `shownIdRef.current` を進める受動効果（`chat.tsx` の `useEffect(() => {
     * shownIdRef.current = shownId; ... }, [shownId])`）はその後に走る。
     * ここで応答を返すのが早すぎると、効果がまだ走っていない一瞬を捉えて
     * しまい「直っていないのに緑」になりうる（偽陰性）。`act()` は時計では
     * なく保留中の効果のキューを流すので、これで効果が確実に走った後の
     * 状態にする（`chat.follow-scroll.test.tsx`『`await act(async () => {})`
     * は、時計ではなくキューを流す』と同じ理由）。
     */
    await act(async () => {});

    // ここで、A への interrupt の応答を遅れて返す。
    releaseInterrupt();

    /*
     * 『出ない』は `findBy`/`waitFor` では直接待てない（出る方向にしか
     * 待てない）ので、必ず起きるはずの別の事実――`finally` の
     * `setInterrupting(false)` でボタンの `disabled` が外れること――を待つ。
     * `interruptNotice`/`interruptFailure` への set と `setInterrupting(false)`
     * は、`await interruptClone()` が解決した後の同じ同期区間で済んでいるので、
     * `disabled` が外れた時点では出す/出さないの判断（描画時の `shownId` との
     * 突き合わせ）はもう確定している（React 18 の自動バッチで同じ render に
     * まとまる）。
     */
    await waitFor(() => {
      expect((interruptButton() as HTMLButtonElement).disabled).toBe(false);
    });
    expect(screen.queryByText(/いま走っていたクローンのターンを止めた/)).toBeNull();
  });

  /**
   * #1570 の Issue 本文の再現をそのまま足したもの。
   *
   * 上のテストとの唯一の違いは `await act(async () => {})` が無いこと——
   * つまり「切り替えの render から `useEffect` が走るまでの窓」を **挟んだ
   * まま** 応答を返す。#1548 の直し（`shownIdRef.current` を比べる）は、
   * この窓の中でだけ判定を誤っていた（`shownIdRef.current` は効果の中でしか
   * 進まないため、切り替え後もまだ古い会話 A を指していた）。
   *
   * `main` 258c1b2 ではこのテストだけが赤く、上の（act で効果を先に流す）
   * テストと下の対照は緑のままだった、と Issue 本文に書かれている。
   */
  it('B の画面が commit された直後（効果が走る前）に応答が返っても、B に A の「止めた」が出ない（#1570）', async () => {
    let releaseInterrupt: () => void = () => {};
    const interruptReleased = new Promise<void>((resolve) => {
      releaseInterrupt = resolve;
    });
    const route: Route = (url) => {
      const conversation = conversationRoutes(url);
      if (conversation !== undefined) return conversation;
      if (url.endsWith('/clone/interrupt')) {
        return interruptReleased.then(() => json({ outcome: 'interrupted' }));
      }
      return undefined;
    };
    const stub = stubFetch(route);
    const { router } = renderChat(`/chat/${CONVERSATION_ID}`);
    fireEvent.click(await findInterruptButton());
    await waitFor(() => {
      expect(stub.entries.some((entry) => entry.url.endsWith('/clone/interrupt'))).toBe(true);
    });

    /*
     * 窓を確実に突く。`findBy` や `act()` で待つと、その間に受動効果まで流れてしまい
     * 窓を越える（#1570 の本文の再現が、この環境では直す前の main でも緑だった）。
     * MutationObserver のコールバックはマイクロタスクなので、B の DOM が commit
     * された直後、受動効果（別のタスク）より前に走る。そこで応答を返すと、
     * `interruptClone()` の続きもマイクロタスクの連鎖で同じ窓の中で走る。
     */
    let releasedInWindow = false;
    const observer = new MutationObserver(() => {
      if (releasedInWindow || screen.queryByText(OTHER_CONVERSATION_ID) === null) return;
      releasedInWindow = true;
      observer.disconnect();
      releaseInterrupt();
    });
    observer.observe(document.body, { childList: true, subtree: true, characterData: true });
    await router.navigate(`/chat/${OTHER_CONVERSATION_ID}`);
    expect(await screen.findByText(OTHER_CONVERSATION_ID)).toBeTruthy();
    expect(releasedInWindow).toBe(true);
    await waitFor(() => {
      expect((interruptButton() as HTMLButtonElement).disabled).toBe(false);
    });
    expect(screen.queryByText(/いま走っていたクローンのターンを止めた/)).toBeNull();
  });

  it('同じ会話のまま応答が返れば、今までどおり出る（切り替えていない対照）', async () => {
    let releaseInterrupt: () => void = () => {};
    const interruptReleased = new Promise<void>((resolve) => {
      releaseInterrupt = resolve;
    });
    stubFetch((url) => {
      const conversation = conversationRoutes(url);
      if (conversation !== undefined) return conversation;
      if (url.endsWith('/clone/interrupt')) {
        return interruptReleased.then(() => json({ outcome: 'interrupted' }));
      }
      return undefined;
    });

    renderChat(`/chat/${CONVERSATION_ID}`);
    fireEvent.click(await findInterruptButton());

    releaseInterrupt();

    expect(
      await screen.findByText(
        'いま走っていたクローンのターンを止めた。会話の続きと受信箱はそのまま残る（次の合図で次のターンが始まる）。',
      ),
    ).toBeTruthy();
  });
});
