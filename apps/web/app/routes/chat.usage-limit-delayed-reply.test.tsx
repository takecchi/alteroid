// @vitest-environment jsdom
/**
 * 症状B（人間の報告）の**画面側**。
 *
 * > あとリミットきてた場合、あとで良いのでちゃんと返信して欲しい
 *
 * `packages/core` は既に正しい（枠が開いたら保持していた合図を試し直し、返信を
 * 日誌へ載せる。`clone.test.ts` の「症状B」ブロック）。`apps/daemon` も
 * `GET /conversations/:id` にその返信を返す（`conversations-usage-limit.test.ts`）。
 * 残っていたのはこの画面で、**同じタブに居続けるかぎり遅れた返信が出なかった**
 * — この画面で始めた会話は `useConversation(null)` にしていたので、
 * `use-journal-live.ts` の無効化が効く相手が居なかった（購読していないものは
 * 落としても取り直されない）。
 *
 * ここで見るのは「新しい会話をこの画面で始め、枠で待たされ、**画面を触らずに
 * 居続けたまま**遅れた返信が出るか」である。この筋書きは
 * `chat.duplicate-on-invalidate.test.tsx`（既存の会話を開く側）とは別で、
 * あちらは二重描画を、こちらは**そもそも出るか**を見ている。
 */
import { cleanup, fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import { createMemoryRouter, RouterProvider, useParams } from 'react-router';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import { useJournalLive } from '~/hooks/use-journal-live';
import { json, Providers, sse, stubFetch, storeTestBaseUrl, type Route } from '~/test-support';

import Chat from './chat';

const CONVERSATION_ID = 'conv-1';
const LIMIT_MESSAGE =
  "利用上限に当たった。この文言で仕事が止まっている: You've hit your individual spend limit for this account.";
const DELAYED_REPLY = '枠が開いたので、待たせていた分に返す。';

const ChatRoute = Chat as unknown as (props: {
  loaderData: { conversationId: string | undefined };
}) => React.ReactElement;

/** `AuthedShell` と同じく `useJournalLive()` を張った木の中で描く。 */
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
  return render(
    <Providers>
      <RouterProvider router={router} />
    </Providers>,
  );
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

describe('枠（利用上限）で待たされた発言の返信は、同じタブに居続けても後から出る', () => {
  it('この画面で始めた会話でも、遅れて日誌に載った返信が現れる', async () => {
    /**
     * サーバ側で再試行が済んだかどうか。
     *
     * **テストが明示的に倒す。** 実物では「枠が開く」→「保持していた合図が
     * 配り直される」→「返信が日誌へ載る」の順で起きるが、その時刻はこの画面から
     * は見えない。ここで確かめたいのは**載った後に画面が追いつくか**なので、
     * 載る時刻はテストが決める（時計に賭けない）。
     */
    let retried = false;

    const route: Route = (url, init) => {
      if (url.endsWith('/journal/stream')) {
        return sse(
          [
            { event: 'open', data: { ok: true } },
            // 再試行の返信が日誌へ載ったという合図。**これが無効化の出どころ**
            // （`use-journal-live.ts` の `case 'exchange'`）。
            {
              event: 'exchange',
              data: {
                type: 'exchange',
                id: 'evt-retry-reply',
                at: '2026-08-20T00:10:00.000Z',
                with: 'human',
                role: 'outbound',
                text: DELAYED_REPLY,
                conversationId: CONVERSATION_ID,
              },
            },
          ],
          // `/chat` の往復（既定 delayMs=5）が終わってから届かせる。
          { keepOpen: true, delayMs: 150, signal: init?.signal },
        );
      }
      if (url.endsWith('/chat')) {
        // 枠に当たった1回目。**`done` は来ない**（`error` が終端）。
        return sse(
          [
            { event: 'open', data: { conversationId: CONVERSATION_ID } },
            { event: 'usage_limited', data: { type: 'usage_limited', message: LIMIT_MESSAGE } },
            { event: 'error', data: { type: 'error', message: LIMIT_MESSAGE } },
          ],
          { signal: init?.signal },
        );
      }
      if (url.includes(`/conversations/${CONVERSATION_ID}`)) {
        return json({
          conversationId: CONVERSATION_ID,
          messages: [
            // 人間の発言は受理した時点で日誌に載っている（`clone.ts` の `#record`）。
            { id: 'm1', at: '2026-08-20T00:00:00Z', role: 'inbound', text: '待たされる発言' },
            ...(retried
              ? [
                  {
                    id: 'm2',
                    at: '2026-08-20T00:10:00Z',
                    role: 'outbound' as const,
                    text: DELAYED_REPLY,
                  },
                ]
              : []),
          ],
        });
      }
      if (url.includes('/conversations')) return json({ conversations: [], scanned: 0 });
      return undefined;
    };
    stubFetch(route);

    // **新しい会話としてこの画面で始める**（`/chat`。id は `open` で決まる）。
    renderChat('/chat');
    await send('待たされる発言');

    // 枠に当たったことは画面に出ている（`usage_limited` の行）。
    await screen.findByText(new RegExp('利用上限に当たった'));
    // この時点では返信は無い。
    expect(within(transcript()).queryAllByText(DELAYED_REPLY)).toHaveLength(0);

    // ここから先はサーバ側の出来事（枠が開いて再試行が成功した）。
    retried = true;

    // **画面には何も触らない。** 遅れて届いた `exchange` が無効化を起こし、
    // 履歴が取り直されて返信が出る、までを待つ。
    await waitFor(
      () => {
        expect(within(transcript()).getAllByText(DELAYED_REPLY)).toHaveLength(1);
      },
      { timeout: 3000 },
    );

    // 自分の発言は1回だけ（履歴とローカルの両方に載っているが重ねない）。
    expect(within(transcript()).getAllByText('待たされる発言')).toHaveLength(1);
  });
});
