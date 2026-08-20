// @vitest-environment jsdom
/**
 * マネージャーからの追加の疑い（症状Bの調査中に浮上）:
 *
 * `startedHere`（`chat.tsx`）は「この画面で始めた会話なら履歴を重ねない」
 * ための守りだが、**既存の会話を一覧から開いた場合（`startedHere === false`）
 * には効かない**。そのとき `historyLines` は `useConversation(shownId)`
 * （SWR）から来ており、`use-journal-live.ts` は `exchange(with: 'human')` が
 * 届くたびに `conversation` バケットを無効化して再取得させる
 * （`use-journal-live.ts:118-128`）。
 *
 * 一方、送った自分の発言・受け取った返信は `lines`（ローカル state）にも
 * 積まれ続け、**`send()` のどこにも `lines` から取り除く処理が無い**
 * （`chat.tsx` 全体を読んだ限り、`lines` は単調増加する）。
 *
 * `all = [...historyLines, ...lines]`（`chat.tsx` の該当箇所）には重複排除が
 * 無いので、既存の会話を開いて発言したまま `journal/stream` 由来の無効化が
 * 挟まると、同じ発言・同じ返信が2回描かれるはずである — ここではそれを実際に
 * 再現する。**人間の発言**と**クローンの返信**は同じ機構（同じ無効化・同じ
 * `all` の組み立て）で二重になるが、別々の観測なので it を分ける
 * （AGENTS.md「1つの変異で複数の保証を確かめない」）。
 */
import { cleanup, fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import { createMemoryRouter, RouterProvider, useParams } from 'react-router';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import { useJournalLive } from '~/hooks/use-journal-live';
import { json, Providers, sse, stubFetch, storeTestBaseUrl, type Route } from '~/test-support';

import Chat from './chat';

const CONVERSATION_ID = 'conv-1';

const ChatRoute = Chat as unknown as (props: {
  loaderData: { conversationId: string | undefined };
}) => React.ReactElement;

/**
 * `useJournalLive()` を実際に張る（`AuthedShell` が本来やっていること）。
 * `chat.test.tsx` の `Harness` はこれを呼ばない — あちらは `journal/stream`
 * 由来の無効化そのものが起きない前提の試験だからである。ここではその無効化
 * こそが本題なので、同じ木の中で呼ぶ。
 */
function Harness() {
  useJournalLive();
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

const STREAM = [
  { event: 'open', data: { conversationId: CONVERSATION_ID } },
  { event: 'text', data: { type: 'text', text: 'わかった' } },
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
  fireEvent.click(screen.getByRole('button', { name: /送る/ }));
}

const transcript = () => screen.getByRole('list', { name: 'やりとり' });

/**
 * 「既存の会話を一覧から開いて発言し、その最中に journal/stream 由来の
 * 無効化が届く」形を組み立てる。**既存の会話を開いた形**にするため、最初から
 * `/chat/conv-1` で描く（`send()` の `open` 分岐は `stream.id === undefined`
 * のときだけ `startedHere` を立てるが、ここでは最初から
 * `shownId === conversationId` なので立たない＝`startedHere` は初期値
 * `false` のまま動かない）。
 *
 * 呼び出し側は「送信 → 返信が届く → 無効化による再取得を待つ」までを終えた
 * 状態で受け取り、そこから先（何が何回描かれているか）だけを確かめればよい。
 */
async function setUpExistingConversationWithLiveInvalidation(): Promise<{
  stub: ReturnType<typeof stubFetch>;
}> {
  let afterSend = false;

  const route: Route = (url, init) => {
    // `AuthedShell` と同じ経路。ここが本題（`exchange(with:'human')` を
    // 届けて `conversation` バケットを無効化させる）。
    if (url.endsWith('/journal/stream')) {
      return sse(
        [
          { event: 'open', data: { ok: true } },
          {
            event: 'exchange',
            data: {
              type: 'exchange',
              id: 'evt-live-1',
              at: '2026-08-20T00:00:10.000Z',
              with: 'human',
              role: 'inbound',
              text: '追加の発言',
              conversationId: CONVERSATION_ID,
            },
          },
        ],
        // `/chat` 側の送受信（既定 delayMs=5）が確実に終わったあとに届くよう、
        // 大きめの間隔を空ける。
        { keepOpen: true, delayMs: 120, signal: init?.signal },
      );
    }
    if (url.endsWith('/chat')) return sse(STREAM, { signal: init?.signal });
    if (url.includes(`/conversations/${CONVERSATION_ID}`)) {
      return json(
        afterSend
          ? {
              conversationId: CONVERSATION_ID,
              messages: [
                { id: 'm0', at: '2026-08-13T00:00:00Z', role: 'inbound', text: '以前の話' },
                { id: 'm0b', at: '2026-08-13T00:00:01Z', role: 'outbound', text: '以前の返事' },
                // **サーバから見れば正しい**: 人間が送った発言は `#record`
                // （受理した時点）で既に日誌に載っている
                // （`clone.ts` の doc「受理した時点で未読として書き出す」）ので、
                // 再取得すればここに含まれるのは仕様どおりである。
                { id: 'm1', at: '2026-08-20T00:00:05.000Z', role: 'inbound', text: '追加の発言' },
                // クローンの返信も、ターンが終わった時点（`clone.ts` の
                // `#journal({type:'exchange', ...})`）で同じ
                // `with:'human'/role:'outbound'` の exchange として日誌へ載る。
                // 同じ無効化がこちらも巻き込むはず。
                { id: 'm2', at: '2026-08-20T00:00:06.000Z', role: 'outbound', text: 'わかった' },
              ],
            }
          : {
              conversationId: CONVERSATION_ID,
              messages: [
                { id: 'm0', at: '2026-08-13T00:00:00Z', role: 'inbound', text: '以前の話' },
                { id: 'm0b', at: '2026-08-13T00:00:01Z', role: 'outbound', text: '以前の返事' },
              ],
            },
      );
    }
    if (url.includes('/conversations')) return json({ conversations: [], scanned: 0 });
    return undefined;
  };
  const stub = stubFetch(route);
  const detailFetchCount = () =>
    stub.calls.filter((url) => url.includes(`/conversations/${CONVERSATION_ID}`)).length;

  renderChat(`/chat/${CONVERSATION_ID}`);

  // 履歴が読み込まれるまで待つ
  await screen.findByText('以前の話');
  expect(within(transcript()).queryAllByText('追加の発言')).toHaveLength(0);

  await send('追加の発言');
  // 送信直後: ローカルの `lines` に1件だけ乗っている。
  expect(within(transcript()).getAllByText('追加の発言')).toHaveLength(1);

  // クローンの返信（`わかった`）が届くまで待つ（`/chat` の SSE が終わる）。
  await screen.findByText('わかった');

  // これ以降、サーバ側は既に自分の発言・返信を日誌へ載せている体にする
  // （実物と同じ順序: 発言は `post()` の中、返信は result 到着時。どちらも
  // SSE の応答終了より前後どちらでも先に日誌へ載っている）。
  afterSend = true;
  const detailFetchesBefore = detailFetchCount();

  // `journal/stream` の `exchange(with:'human')` が届き、`conversation`
  // バケットが無効化されて再取得されるまで待つ（`use-journal-live.ts` の
  // `case 'exchange': if (entry.with === 'human') { ... }`）。**再取得が
  // 起きたこと自体を先に確かめる** — でないと、無効化がまだ届く前に下の
  // アサーションへ進んでしまい、「たまたま踏まなかった」を「直っている」と
  // 読み違える。
  await waitFor(
    () => {
      expect(detailFetchCount()).toBeGreaterThan(detailFetchesBefore);
    },
    { timeout: 3000 },
  );

  return { stub };
}

describe('既存の会話を開いたまま発言する — 履歴の再取得による二重描画', () => {
  it('人間の発言が2回描かれる（journal/stream 由来の無効化 → historyLines の再取得と、ローカル lines の両方に乗る）', async () => {
    await setUpExistingConversationWithLiveInvalidation();

    // **求める結果（あるべき姿）**: 送った発言は1回しか描かれない。
    // `historyLines`（再取得された履歴）と `lines`（ローカルの送信）の
    // どちらにも「追加の発言」が乗っていて、`all = [...historyLines, ...lines]`
    // に重複排除が無いので、**いまは2回描かれる**（赤で正しい）。
    expect(within(transcript()).getAllByText('追加の発言')).toHaveLength(1);
  });

  it('クローンの返信も2回描かれる（人間の発言だけの偶然ではない）', async () => {
    await setUpExistingConversationWithLiveInvalidation();

    // 同じ機構（同じ無効化・同じ `all` の組み立て）がクローンの返信側も
    // 巻き込むはず。**求める結果（あるべき姿）**は1回だけ描かれること。
    expect(within(transcript()).getAllByText('わかった')).toHaveLength(1);
  });
});
