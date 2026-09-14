// @vitest-environment jsdom
/**
 * 取り下げられた確認を会話のタイムラインへ出す（issue #974）。
 *
 * **直す前の穴**: `historyLines`（`chat.tsx`）の `approvalItems` は質問
 * （`createdAt`）と回答（`answeredAt` + `answer`）の2種類しか行に変換して
 * おらず、#969 で `PendingApproval` に足された `withdrawnAt` / `withdrawnReason`
 * には対応する行が無かった。⟹ 会話には質問だけが現れ、**痕跡なく終わって
 * いた**（人間が `/approvals` を開かない限り「その後どうなったか」が分から
 * ない）。
 *
 * データ取得側（`useConversationApprovals`。`apps/web/app/hooks/queries.ts`）
 * は #969 の時点で既に `pending: 'false'` で引いており、取り下げ済みの行も
 * 手元に来ている——直すのは描画側（`historyLines`）だけである。
 *
 * ここで固定するのは:
 *
 * 1. 取り下げられた確認が、会話のタイムラインに `withdrawnAt` の位置（時刻順）
 *    で出る
 * 2. その行に取り下げの理由（`withdrawnReason`）が出る
 * 3. `withdrawnReason` が欠けている行でも、行自体は出る（「取り下げられた
 *    事実」のほうが主——`withdrawnAt` の doc）
 * 4. 質問の行の本文（SSE `case 'ask_human'` と1文字も違えない文言）は、この
 *    変更でも変わっていない（二重表示の回帰が無いことの間接的な確認）
 */
import { cleanup, render, screen, within } from '@testing-library/react';
import { createMemoryRouter, RouterProvider, useParams } from 'react-router';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import { useJournalLive } from '~/hooks/use-journal-live';
import { json, Providers, stubFetch, storeTestBaseUrl, type Route } from '~/test-support';

import Chat from './chat';

const ChatRoute = Chat as unknown as (props: {
  loaderData: { conversationId: string | undefined };
}) => React.ReactElement;

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

const transcript = () => screen.getByRole('list', { name: 'やりとり' });

const CONVERSATION_ID = 'conv-withdrawn';
/** `chat.ask-human-history.test.tsx` の `QUESTION_LINE` と同じ基準（畳んだ後の形）。 */
const QUESTION_LINE = '確認したいことがある: 本番に出してよいか （承認待ちの画面から答えられる）';

function stubConversationAndApprovals(approval: Record<string, unknown>) {
  const route: Route = (url) => {
    if (url.includes(`/conversations/${CONVERSATION_ID}`)) {
      return json({
        conversationId: CONVERSATION_ID,
        messages: [
          {
            id: 'm1',
            at: '2026-08-20T00:00:00.000Z',
            role: 'inbound',
            text: '進めてよいか確認して',
          },
        ],
        scanned: 1,
        reachedStart: true,
      });
    }
    if (url.includes('/approvals')) {
      expect(url).toContain(`conversationId=${CONVERSATION_ID}`);
      return json({ approvals: [approval] });
    }
    if (url.includes('/conversations')) return json({ conversations: [], scanned: 0 });
    return undefined;
  };
  stubFetch(route);
}

describe('取り下げられた確認が会話のタイムラインに出る（issue #974）', () => {
  it('理由付きで取り下げられた確認は、質問の行の後ろに取り下げの行が出る', async () => {
    stubConversationAndApprovals({
      id: 'ap-1',
      createdAt: '2026-08-20T00:00:05.000Z',
      question: '本番に出してよいか',
      withdrawnAt: '2026-08-20T00:01:00.000Z',
      withdrawnReason: '要件が変わったため確認自体が不要になった',
    });

    renderChat(`/chat/${CONVERSATION_ID}`);

    // 質問の行の本文は SSE の `case 'ask_human'` と1文字も違えない
    // （不変条件。`chat.ask-human-history.test.tsx` と同じ基準）。
    await screen.findByText(QUESTION_LINE);
    expect(
      await screen.findByText(/確認の取り下げ: 要件が変わったため確認自体が不要になった/),
    ).toBeTruthy();

    // 取り下げは質問より後ろに出る（時系列の正しい位置＝ withdrawnAt > createdAt）。
    const items = within(transcript()).getAllByRole('listitem');
    const texts = items.map((item) => item.textContent);
    const questionIndex = texts.findIndex((text) => text?.includes('確認したいことがある'));
    const withdrawnIndex = texts.findIndex((text) => text?.includes('確認の取り下げ'));
    expect(questionIndex).toBeGreaterThanOrEqual(0);
    expect(withdrawnIndex).toBeGreaterThan(questionIndex);

    // 回答の行は出ない（取り下げと回答は排他——`answeredAt` の doc）。
    expect(screen.queryByText(/確認への回答/)).toBeNull();
  });

  it('取り下げの理由が欠けている行でも、取り下げられた事実の行は出る', async () => {
    stubConversationAndApprovals({
      id: 'ap-1',
      createdAt: '2026-08-20T00:00:05.000Z',
      question: '本番に出してよいか',
      withdrawnAt: '2026-08-20T00:01:00.000Z',
      // withdrawnReason を持たない古い行を想定（`withdrawnAt` の doc）。
    });

    renderChat(`/chat/${CONVERSATION_ID}`);

    await screen.findByText(QUESTION_LINE);
    expect(await screen.findByText(/確認の取り下げ: （理由の記録なし）/)).toBeTruthy();
  });
});
