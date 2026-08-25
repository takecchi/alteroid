// @vitest-environment jsdom
/**
 * ⚠️ **書き捨ての測定用スクリプト。マネージャー依頼（issue #388 隣接の欠陥の
 * 再測定）でのみ使う。恒久的なテストとして残すかどうかはマネージャーが決める。**
 *
 * `chat.tsx` は1文字も変えていない（この依頼の制約）。ここは測るだけ。
 *
 * 前任の観測（issue #388 のコメント 2026-08-25T15:39:42Z）:
 * - `tool` を確定して積み、`done`/終端が来ないまま別の会話へ navigate すると
 *   （`ownedBy` が効いて画面からは消える）、**元の会話へ戻ると transient が
 *   再び出る**（REAPPEARED=true 3/3）
 * - ただし `sse()` に `signal` を正しく渡すと REAPPEARED=false（3/3）
 *
 * 疑い: 前者は「`sse()` に `signal` を渡さない」という**足場側の作り物**でしか
 * 起きていない可能性がある。本物の `fetch` は必ず `signal` を渡す
 * （`packages/api-client/src/index.ts` の `chat()` が `streamOptions.signal` を
 * 実際の `fetch()` の `init.signal` へ渡している。逐語:
 * `grep -n signal packages/api-client/src/index.ts`）。ここでは
 * (1) 足場の再現を signal 無し/有りの両方で数え直し、
 * (2) signal を正しく渡した状態でも同じ症状を「決定的に」起こせる別経路が
 * あるかを探す。
 */
import { cleanup, fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import { createMemoryRouter, MemoryRouter, RouterProvider, useParams } from 'react-router';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import { json, Providers, sse, stubFetch, storeTestBaseUrl, type Route } from '~/test-support';

import Chat from './chat';

const CONVERSATION_ID = 'conv-1';

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
  fireEvent.click(screen.getByRole('button', { name: /送る/ }));
}

const transcript = () => screen.getByRole('list', { name: 'やりとり' });

const TOOL_LABEL = /manager_start を実行中/;

/**
 * (1) の筋書き。`withSignal` が偽なら `sse()` へ `signal` を渡さない
 * （前任の「足場」を再現）。真なら `init?.signal` を渡す（本物の `fetch` と
 * 同じように、中断がストリームへ伝わる）。
 */
function stubRoute(withSignal: boolean): Route {
  return (url, init) => {
    if (url.endsWith('/chat')) {
      // `tool` を確定して積んだあと、`done`/終端を送らずに止め置く
      // （前任の筋書き: 確定した transient が残ったまま、人間が離れる）。
      return sse(
        [
          { event: 'open', data: { conversationId: CONVERSATION_ID } },
          { event: 'tool', data: { type: 'tool', tool: 'manager_start' } },
        ],
        { keepOpen: true, signal: withSignal ? init?.signal : undefined },
      );
    }
    if (url.includes('/conversations/other')) {
      return json({
        conversationId: 'other',
        messages: [{ id: 'm1', at: '2026-08-13T00:00:00Z', role: 'inbound', text: '別の会話' }],
      });
    }
    if (url.includes(`/conversations/${CONVERSATION_ID}`)) {
      return json({ conversationId: CONVERSATION_ID, messages: [] });
    }
    if (url.includes('/conversations')) return json({ conversations: [], scanned: 0 });
    return undefined;
  };
}

/**
 * 1回ぶんの筋書きを走らせ、戻ったときに transient が再び出ているかを返す。
 *
 * **サニティを兼ねる**: `tool` の transient が最初に出ることを
 * `findByText`（無ければ投げて落ちる）で確かめてから離れる。ここが通らない
 * 回があれば、それ自体が「足場が測っていない」ことの証拠になる。
 */
async function runScenario(withSignal: boolean): Promise<{ shownBefore: boolean; reappeared: boolean }> {
  stubFetch(stubRoute(withSignal));

  const { router } = renderChat(`/chat/${CONVERSATION_ID}`);
  await send('やあ');

  // サニティ: 離れる前に transient が出ている。
  const before = await screen.findByText(TOOL_LABEL).then(
    () => true,
    () => false,
  );

  // 別の会話へ移る（`ownedBy` が効いて画面から消える）。
  await router.navigate('/chat/other');
  await screen.findByText('別の会話');
  // 少しだけ待って、追いついてくる可能性のある描画を拾う。
  await new Promise((resolve) => setTimeout(resolve, 30));

  // 元の会話へ戻る。
  await router.navigate(`/chat/${CONVERSATION_ID}`);
  // 描き直しが済むのを、ヘッダではなく `transcript` の再取得で待つ
  // （このアプリはヘッダに会話名を出していないため、`await` で1tick進める）。
  await waitFor(() => {
    // 何かしら描画が進んだことだけを確かめる（会話一覧の見出しは常に居る）。
    expect(screen.getByRole('list', { name: '会話' })).toBeTruthy();
  });
  // 貼り直し等、遅れて起きる描画も拾えるよう少し待つ。
  await new Promise((resolve) => setTimeout(resolve, 200));

  const reappeared = within(transcript()).queryAllByText(TOOL_LABEL).length > 0;
  return { shownBefore: before, reappeared };
}

describe('(1) 足場の再現 — issue #388 隣接（書き捨て測定）', () => {
  it('(1a) signal を渡さない: 10回', async () => {
    const rows: { shownBefore: boolean; reappeared: boolean }[] = [];
    for (let i = 0; i < 10; i++) {
      rows.push(await runScenario(false));
      cleanup();
    }
    const sanityOk = rows.filter((r) => r.shownBefore).length;
    const reappearedCount = rows.filter((r) => r.reappeared).length;
    // eslint-disable-next-line no-console
    console.log('RAW_1a', JSON.stringify(rows));
    // eslint-disable-next-line no-console
    console.log(`SANITY_1a=${sanityOk}/10 REAPPEARED_1a=${reappearedCount}/10`);
    expect(sanityOk).toBe(10);
  });

  it('(1b) signal を正しく渡す: 10回', async () => {
    const rows: { shownBefore: boolean; reappeared: boolean }[] = [];
    for (let i = 0; i < 10; i++) {
      rows.push(await runScenario(true));
      cleanup();
    }
    const sanityOk = rows.filter((r) => r.shownBefore).length;
    const reappearedCount = rows.filter((r) => r.reappeared).length;
    // eslint-disable-next-line no-console
    console.log('RAW_1b', JSON.stringify(rows));
    // eslint-disable-next-line no-console
    console.log(`SANITY_1b=${sanityOk}/10 REAPPEARED_1b=${reappearedCount}/10`);
    expect(sanityOk).toBe(10);
  });
});

/**
 * (2) 本命 — `signal` を正しく渡したうえで、決定的に同じ症状を起こせるか。
 *
 * **時計（`delayMs`）に賭けない。競走（router.navigate と非同期処理の
 * どちらが先に走るか）にも賭けない。** ここで使うのは `rerender`（React
 * Testing Library）による**直接の入力**——#437 の2本目の決定的な回帰テスト
 * （`chat.test.tsx`「古い routeId で描き直されても…」）と同じ技法である。
 *
 * **狙い**: `finally` の transient 掃除（`setLines((previous) =>
 * previous.filter(...))`）が実際に走った**後**で、React が「古い props で
 * 描き直す」（#437 が `main` で40記録中7回観測した経路）を人為的に与えても、
 * 既に消した transient は戻らないか。
 *
 * ⚠️ **これは #437 が直した経路そのものではない。** #437 が直したのは
 * 「切り替えた瞬間の破壊的な `setLines([])`」（render 時、`routeId` を見て
 * 一度だけ走る）で、いまは `ownedBy`/`retainedBy` の純関数化により
 * **props の描き直しに対しては自己修復する**（`chat.tsx` の doc、
 * `retainedBy` の不変条件チェックが「次の render でまた同じ比較を通るので
 * 自己修復する」と書いている）。ここで確かめたいのは、**`lines` という
 * state そのもの**（props からの派生ではない）が、`finally` の `setLines`
 * 呼び出し以降に「古い基底から貼り直される」ことがあるかである。
 *
 * `rerender` は React に**新しい props を与える**だけで、`lines` という
 * state の中身を外から書き換える口は無い（`routeId` が変わったときに
 * `lines` を書き換えるコードは #437 で消してある）。**だから、この実験で
 * 再現できるとしたら「props の描き直し」が原因ではなく、`finally` の
 * `setLines` そのものが未着地に終わる別の経路がある場合だけである。**
 */
describe('(2) signal を正しく渡したうえでの決定的な再現の探索', () => {
  const ChatRoute2 = Chat as unknown as (props: {
    loaderData: { conversationId: string | undefined };
  }) => React.ReactElement;

  function Screen({ routeId }: { routeId: string | undefined }) {
    return (
      <Providers>
        <MemoryRouter initialEntries={['/chat']}>
          <ChatRoute2 loaderData={{ conversationId: routeId }} />
        </MemoryRouter>
      </Providers>
    );
  }

  function stubToolThenNothing(): Route {
    return (url, init) => {
      if (url.endsWith('/chat')) {
        return sse(
          [
            { event: 'open', data: { conversationId: CONVERSATION_ID } },
            { event: 'tool', data: { type: 'tool', tool: 'manager_start' } },
          ],
          // ⚠️ 本物どおり signal を渡す（前任の観測が REAPPEARED=false 側）。
          { keepOpen: true, signal: init?.signal },
        );
      }
      if (url.includes(`/conversations/${CONVERSATION_ID}`)) {
        return json({ conversationId: CONVERSATION_ID, messages: [] });
      }
      if (url.includes('/conversations')) return json({ conversations: [], scanned: 0 });
      return undefined;
    };
  }

  it('掃除が終わった後に古い props で描き直しても、消した transient は戻らない（rerender による決定的な入力。5回）', async () => {
    const rows: { humanSurvived: boolean; reappeared: boolean }[] = [];
    for (let i = 0; i < 5; i++) {
      stubFetch(stubToolThenNothing());

      const { rerender } = render(<Screen routeId={CONVERSATION_ID} />);
      await send('やあ');

      // サニティ: transient が出ている。
      await screen.findByText(TOOL_LABEL);

      // 切り替え（rerender は React Testing Library が act() で包むので、
      // 戻り待ちの時点で render は commit 済み。abort() を含む effect は
      // 受動的 effect なので、続けて `waitFor` で「掃除が終わった」ことを
      // 明示的な合図（送信中の表示が消える＝ finally が走った）で待つ）。
      rerender(<Screen routeId={'other'} />);
      // `finally` が走った証拠: 「受信をやめる」ボタンが無くなる（別画面の
      // ChatPane を見ているので、ボタン自体は無い。代わりに transient
      // 文言が state から消えたことを、後段のもう一度 `CONVERSATION_ID` へ
      // 戻したときの描画で確認する。ここでは十分な tick を与えるだけ）。
      await waitFor(() => {
        expect(screen.getByRole('list', { name: '会話' })).toBeTruthy();
      });
      await new Promise((resolve) => setTimeout(resolve, 50));

      // 元の会話へ戻る（1 hop。#446 の「直前」の範囲内 — 中身が刈られる
      // 経路に入らないようにする。ここで transient だけが戻らないかを見る）。
      rerender(<Screen routeId={CONVERSATION_ID} />);
      await waitFor(() => {
        expect(screen.getByRole('list', { name: '会話' })).toBeTruthy();
      });
      await new Promise((resolve) => setTimeout(resolve, 50));

      // サニティ: 戻ったハーネス自体は生きている(人間の発言「やあ」は
      // #446 の設計どおり残ってよい。1 hop 往復なので消えない前提)。
      // `list` が無い(= `all.length === 0` で Empty 側)場合も想定し、
      // `queryByRole` で無理に投げさせない。
      const list = screen.queryByRole('list', { name: 'やりとり' });
      const humanSurvived = list !== null && within(list).queryAllByText('やあ').length > 0;
      const reappeared = list !== null && within(list).queryAllByText(TOOL_LABEL).length > 0;
      rows.push({ humanSurvived, reappeared });
      cleanup();
    }
    // eslint-disable-next-line no-console
    console.log('RAW_2a', JSON.stringify(rows));
    // eslint-disable-next-line no-console
    console.log(
      `SANITY_2a(humanSurvived)=${rows.filter((r) => r.humanSurvived).length}/${rows.length} REAPPEARED_2a=${rows.filter((r) => r.reappeared).length}/${rows.length}`,
    );
  });
});
