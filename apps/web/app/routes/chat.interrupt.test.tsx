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
 * 4. **#1548**: 会話 A で押した後、応答が返るより先に会話 B へ切り替えたら、
 *    遅れて届いた「止めた」の表示は B の画面に出ないこと。`ChatPane` は
 *    会話を切り替えても作り直されない（`chat.tsx` の doc）ので、この経路は
 *    `handleInterrupt` 自身が「押したときの会話」を覚えていないと守れない
 *    ——同じファイルの送信経路が `owns()`/`stopped()` で持つのと同じ形の
 *    守りを、応答が遅れて届くこちらの経路にも入れた
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
 * #1548 の再現と固定。
 *
 * `ChatPane` は会話を切り替えても作り直されない（`chat.tsx` の doc）ので、
 * `handleInterrupt` が「押したときの会話」を覚えていないと、応答が遅れて
 * 届いた回だけ別の会話の画面に「止めた」が出る。`/clone/interrupt` の応答を
 * テスト側が明示的に許可するまで返らない形にして（`test-support.tsx` の
 * `Route` の doc が想定する「まだ返事が来ていない要求」）、時計に頼らず
 * 「B へ切り替えた後で応答が届く」という順序を作る。
 */
describe('会話を切り替えた後に届いた応答（#1548）', () => {
  it('A で押した後 B へ切り替えると、遅れて届いた「止めた」の表示は B に出ない', async () => {
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
     * `stillShown()` の判定と `setInterruptMessage` は、`await
     * interruptClone()` が解決した後の同じ同期区間で `finally` の直前に
     * 済んでいるので、`disabled` が外れた時点では出す/出さないの判断は
     * 確定している（React 18 の自動バッチで同じ render にまとまる）。
     */
    await waitFor(() => {
      expect((interruptButton() as HTMLButtonElement).disabled).toBe(false);
    });
    expect(screen.queryByText(/いま走っていたクローンのターンを止めた/)).toBeNull();
  });

  /**
   * #1570 の再現と固定。
   *
   * 直上のテストは `router.navigate` の後に `await act(async () => {})` を
   * 挟んで、`shownIdRef.current` を進める効果を確実に走らせてから応答を
   * 返している——これは「効果が走った後」を確かめるテストであって、
   * 「navigate 直後・効果が走る前」を確かめるテストではない。この窓
   * （render の commit から、`shownIdRef.current` を進める効果が走るまでの
   * 短い間）に応答が返ると、`stillShown()` が比べる `shownIdRef.current` が
   * まだ会話 A のままなので、画面は既に会話 B を出しているのに A の
   * 「止めた」が B の画面に出てしまう。ここでは `await act(async () => {})`
   * を挟まずに、DOM が B を出した直後の tick で応答を返す。
   *
   * **決定的に窓を捉えるため、`MutationObserver` で DOM を張り込む。**
   * `MutationObserver` のコールバックは**マイクロタスク**として走る仕様
   * （DOM 標準。jsdom も同じ）——一方、`shownIdRef.current` を進める受動
   * effect は React の scheduler 経由で**マクロタスク**（jsdom には
   * `MessageChannel` が無いので `setTimeout` にフォールバックする）に乗る。
   * マイクロタスクは常にマクロタスクより先に尽きるので、「B の文言が DOM に
   * 現れた」ことを `MutationObserver` のコールバック（マイクロタスク）で
   * 検知してその場で `releaseInterrupt()` を呼べば、応答の連鎖（fetch の
   * 解決 → `.json()` → `handleInterrupt` の `await` 以降・`stillShown()` の
   * 判定）は全てマイクロタスクで進み、受動 effect（マクロタスク）が走る
   * 前に `stillShown()` へ確実に届く。`act()`/testing-library の
   * `waitFor`（`setInterval` ベース）や `router.navigate` 自体の解決待ちは
   * マクロタスクを挟みうるので使わない——`navigate` は observer を張った
   * **後**に呼ぶだけで、以降は observer 任せにする。
   *
   * **実測（vitest 4.1.11 / jsdom、2026-09-26）**: 直しを戻した
   * （`shownIdRef.current` の更新を abort() と同じ受動的 `useEffect` へ
   * 戻した）状態でこのテストを20回繰り返したところ **20回とも赤**。直した
   * 状態（`useLayoutEffect` 分離）では同じ20回が **20回とも緑**。
   * `MutationObserver` を使わない旧版（`findByText` の後にそのまま
   * `releaseInterrupt()` を呼ぶだけの形）は同じ20回で18回緑・2回赤という
   * 巡り合わせ任せの結果だった——この版はその窓を毎回確実に捉える。
   */
  it('navigate 直後、効果が走る前に応答が返っても、B の画面に A の「止めた」は出ない', async () => {
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

    // `navigate` を呼ぶ前に張る——DOM が B に変わった瞬間（マイクロタスク）を
    // 逃さないため。
    let released = false;
    const observer = new MutationObserver(() => {
      if (released) return;
      if (document.body.textContent?.includes(OTHER_CONVERSATION_ID) !== true) return;
      released = true;
      observer.disconnect();
      // ここはまだ `MutationObserver` のコールバック（マイクロタスク）の
      // 中——受動 effect（マクロタスク）はまだ走っていない。
      releaseInterrupt();
    });
    observer.observe(document.body, { childList: true, subtree: true, characterData: true });

    try {
      await router.navigate(`/chat/${OTHER_CONVERSATION_ID}`);

      await waitFor(() => {
        expect((interruptButton() as HTMLButtonElement).disabled).toBe(false);
      });
      // observer が実際に発火して `releaseInterrupt` を呼んだことの裏取り
      // （発火しないまま `waitFor` が別の経路で通ってしまう心配を潰す）。
      expect(released).toBe(true);
      expect(screen.queryByText(/いま走っていたクローンのターンを止めた/)).toBeNull();
    } finally {
      observer.disconnect();
    }
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
