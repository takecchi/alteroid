// @vitest-environment jsdom
/**
 * `ask_human` の質問・回答をチャットの履歴へ織り込む（issue #782 の2）。
 *
 * **直す前の穴**: `ask_human` は SSE の `case 'ask_human'` が `lines`（画面だけの
 * state）へ積むだけで、`escalation`（`packages/core/src/schema.ts`）は
 * `readConversationWindow`（`with: ['human']`）の窓に入らないので、リロードで
 * `lines` が消えると質問ごと消えていた。直したのは読み側の結合だけである
 * （journal / 台帳へは何も書いていない）。
 *
 * ここで固定するのは:
 *
 * 1. 承認の台帳（`GET /approvals?conversationId=...`）から読んだ質問が、リロード後
 *    （＝手元の `lines` を経由しない、`historyLines` だけの状態）でも出る
 * 2. 回答済みの確認は、質問だけでなく回答も出る（不変条件A——回答済みが
 *    「まだ返答が無い」に見えない）
 * 3. 生配信（SSE）で先に出た質問行が、台帳から読んだ分と合流しても二重に
 *    ならない（`pendingOwnLines` の役割＋本文の照合に、質問の文言を
 *    1文字も違えず載せてあることの歯）
 */
import { cleanup, fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import { createMemoryRouter, RouterProvider, useParams } from 'react-router';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import { useJournalLive } from '~/hooks/use-journal-live';
import { json, Providers, sse, stubFetch, storeTestBaseUrl, type Route } from '~/test-support';

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

async function send(text: string) {
  const box = await screen.findByPlaceholderText(/クローンに話しかける/);
  fireEvent.change(box, { target: { value: text } });
  fireEvent.click(screen.getByRole('button', { name: /送る/ }));
}

const CONVERSATION_ID = 'conv-ask-human';
/**
 * **testing-library の既定の正規化に合わせて空白を畳んである。** DOM 上の
 * 実際の文字列は `\n` を1つ挟むが（`chat.tsx` の SSE `case 'ask_human'` /
 * `historyLines` の doc）、`getByText` の既定 `normalizer` は連続する空白
 * （改行を含む）を単一の半角スペースへ畳んでから比較する。畳んだ後の形が
 * ここでの「1文字も違えない」の基準になる。
 */
const QUESTION_LINE = '確認したいことがある: 本番に出してよいか （承認待ちの画面から答えられる）';

describe('リロード後（＝手元の lines を経由しない状態）でも ask_human の質問・回答が消えない', () => {
  it('質問だけの確認は、SSE の文言と1文字も違えない形で historyLines から出る', async () => {
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
        return json({
          approvals: [
            {
              id: 'ap-1',
              createdAt: '2026-08-20T00:00:05.000Z',
              question: '本番に出してよいか',
            },
          ],
        });
      }
      if (url.includes('/conversations')) return json({ conversations: [], scanned: 0 });
      return undefined;
    };
    stubFetch(route);

    renderChat(`/chat/${CONVERSATION_ID}`);

    // 質問（会話の発言より後ろに出る——`at` の時刻順）。
    await screen.findByText(QUESTION_LINE);
    const items = within(transcript()).getAllByRole('listitem');
    const texts = items.map((item) => item.textContent);
    const humanIndex = texts.findIndex((text) => text?.includes('進めてよいか確認して'));
    const questionIndex = texts.findIndex((text) => text?.includes('確認したいことがある'));
    expect(humanIndex).toBeGreaterThanOrEqual(0);
    expect(questionIndex).toBeGreaterThan(humanIndex);
  });

  /**
   * **不変条件A: 質問だけ復元すると、回答済みの確認が永久に未回答に見える。**
   * だから回答も出す。
   */
  it('回答済みの確認は、質問と回答の両方が時刻順に出る', async () => {
    const route: Route = (url) => {
      if (url.includes(`/conversations/${CONVERSATION_ID}`)) {
        return json({
          conversationId: CONVERSATION_ID,
          messages: [],
          scanned: 0,
          reachedStart: true,
        });
      }
      if (url.includes('/approvals')) {
        return json({
          approvals: [
            {
              id: 'ap-1',
              createdAt: '2026-08-20T00:00:05.000Z',
              question: '本番に出してよいか',
              answeredAt: '2026-08-20T00:01:00.000Z',
              answer: 'はい、進めてよい',
            },
          ],
        });
      }
      if (url.includes('/conversations')) return json({ conversations: [], scanned: 0 });
      return undefined;
    };
    stubFetch(route);

    renderChat(`/chat/${CONVERSATION_ID}`);

    await screen.findByText(QUESTION_LINE);
    expect(await screen.findByText(/確認への回答: はい、進めてよい/)).toBeTruthy();

    // 回答は質問より後ろに出る（answeredAt > createdAt）。
    const items = within(transcript()).getAllByRole('listitem');
    const texts = items.map((item) => item.textContent);
    const questionIndex = texts.findIndex((text) => text?.includes('確認したいことがある'));
    const answerIndex = texts.findIndex((text) => text?.includes('確認への回答'));
    expect(questionIndex).toBeGreaterThanOrEqual(0);
    expect(answerIndex).toBeGreaterThan(questionIndex);
  });
});

/**
 * **二重表示（リロード前後で同じ行が2つ出る）を1本の歯で押さえる。**
 *
 * 生配信（SSE の `case 'ask_human'`）でまず質問行が出て、その後に承認の台帳
 * （`escalation` の journal 事象で無効化された `GET /approvals`）が同じ確認を
 * 返す——このとき手元の行（`lines`）と履歴由来の行（`historyLines`）の
 * 役割＋本文が一致して初めて `pendingOwnLines` が重複を刈れる。文言を
 * 1文字でも違えると、この歯が赤くなる。
 */
describe('二重表示を防ぐ（生配信 → 承認の台帳、の順で同じ確認が2回現れても1つのまま）', () => {
  it('SSE の ask_human で出た質問行は、台帳から読んだ分と合流しても1つのまま残る', async () => {
    let approvalRecorded = false;
    let releaseEscalation: () => void = () => {};
    const escalationReleased = new Promise<void>((resolve) => {
      releaseEscalation = resolve;
    });

    const route: Route = (url, init) => {
      if (url.endsWith('/journal/stream')) {
        return sse(
          [
            { event: 'open', data: { ok: true } },
            {
              event: 'escalation',
              data: {
                type: 'escalation',
                id: 'esc-1',
                at: '2026-08-20T00:00:05.000Z',
                question: '本番に出してよいか',
                approvalId: 'ap-1',
              },
              after: escalationReleased,
            },
          ],
          { keepOpen: true, signal: init?.signal },
        );
      }
      if (url.endsWith('/chat')) {
        return sse(
          [
            { event: 'open', data: { conversationId: CONVERSATION_ID } },
            {
              event: 'ask_human',
              data: { type: 'ask_human', approvalId: 'ap-1', question: '本番に出してよいか' },
            },
            { event: 'done', data: { type: 'done' } },
          ],
          { signal: init?.signal },
        );
      }
      if (url.includes(`/conversations/${CONVERSATION_ID}`)) {
        return json({
          conversationId: CONVERSATION_ID,
          messages: [],
          scanned: 0,
          reachedStart: true,
        });
      }
      if (url.includes('/conversations')) return json({ conversations: [], scanned: 0 });
      if (url.includes('/approvals')) {
        return json({
          approvals: approvalRecorded
            ? [
                {
                  id: 'ap-1',
                  createdAt: '2026-08-20T00:00:05.000Z',
                  question: '本番に出してよいか',
                },
              ]
            : [],
        });
      }
      return undefined;
    };
    const stub = stubFetch(route);
    const approvalsFetchCount = () => stub.calls.filter((url) => url.includes('/approvals')).length;

    renderChat(`/chat/${CONVERSATION_ID}`);

    await send('進めてよいか確認して');

    // 生配信でまず1つだけ出る（人間の発言＋質問の2行）。
    await screen.findByText(QUESTION_LINE);
    expect(within(transcript()).getAllByText(QUESTION_LINE)).toHaveLength(1);
    expect(within(transcript()).getAllByRole('listitem')).toHaveLength(2);

    // 承認の台帳が同じ確認を持つようになり、journal の無効化が届く。
    approvalRecorded = true;
    const approvalsFetchesBefore = approvalsFetchCount();
    releaseEscalation();
    await waitFor(() => {
      expect(approvalsFetchCount()).toBeGreaterThan(approvalsFetchesBefore);
    });

    // **合流しても1つのまま。** 台帳由来の行と生配信の行が両方出れば行数が
    // 3つに増える——`getAllByText(QUESTION_LINE)` は完全一致なので、文言が
    // 1文字でもずれた行が紛れ込むと（別の文字列として）カウントに出ないが、
    // `getAllByRole('listitem')` の総数はそれも数えるので、文言のずれによる
    // 二重表示もここで捕まる。
    await waitFor(() => {
      expect(within(transcript()).getAllByText(QUESTION_LINE)).toHaveLength(1);
      expect(within(transcript()).getAllByRole('listitem')).toHaveLength(2);
    });
  });
});
