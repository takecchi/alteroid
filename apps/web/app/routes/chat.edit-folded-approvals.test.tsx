// @vitest-environment jsdom
/**
 * #3397。編集で畳まれた枝のあいだに上がった承認カードの扱い。
 *
 * - 決着済み（回答済み・取り下げ済み）のカードは、畳まれた枝の一部として畳む。古い版へ戻すと、
 *   その版の後ろに隠れていたやりとりとして読める
 * - **未回答のカードは、畳まれた枝のあいだに上がったものでも常に出す**（クローンが答えを待っている）
 * - 畳まれた区間の外のカードは、今までどおり出る
 */
import { cleanup, fireEvent, render, screen, within } from '@testing-library/react';
import { createMemoryRouter, RouterProvider } from 'react-router';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import { json, Providers, storeTestBaseUrl, stubFetch } from '~/test-support';

import Chat from './chat';

const CONVERSATION_ID = 'conv-3397';

const ChatRoute = Chat as unknown as (props: {
  loaderData: { conversationId: string | undefined };
}) => React.ReactElement;

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

const approval = (id: string, createdAt: string, extra: Record<string, unknown> = {}) => ({
  id,
  createdAt,
  updatedAt: createdAt,
  question: `質問 ${id}`,
  ...extra,
});

function setup() {
  stubFetch((url) => {
    if (url.includes('/approvals')) {
      return json({
        approvals: [
          // m1 と m1r のあいだ（畳まれた区間の中）
          approval('old-answered', '2026-10-06T00:00:01.000Z', {
            answeredAt: '2026-10-06T00:00:01.500Z',
            answer: 'はい',
          }),
          approval('old-withdrawn', '2026-10-06T00:00:01.200Z', {
            withdrawnAt: '2026-10-06T00:00:01.600Z',
          }),
          approval('old-open', '2026-10-06T00:00:01.400Z'),
          // 編集の後（区間の外）
          approval('new-answered', '2026-10-06T00:00:03.500Z', {
            answeredAt: '2026-10-06T00:00:03.600Z',
            answer: 'いいえ',
          }),
        ],
      });
    }
    if (url.includes(`/conversations/${CONVERSATION_ID}`)) {
      return json({
        conversationId: CONVERSATION_ID,
        messages: [
          {
            id: 'm1',
            at: '2026-10-06T00:00:00.000Z',
            role: 'inbound',
            text: '元の質問',
            supersededBy: 'm2',
          },
          {
            id: 'm1r',
            at: '2026-10-06T00:00:02.000Z',
            role: 'outbound',
            text: '元の答え',
            supersededBy: 'm2',
          },
          {
            id: 'm2',
            at: '2026-10-06T00:00:03.000Z',
            role: 'inbound',
            text: '直した質問',
            supersedes: 'm1',
          },
          { id: 'm2r', at: '2026-10-06T00:00:04.000Z', role: 'outbound', text: '直した答え' },
        ],
        scanned: 4,
        reachedStart: true,
        supersededCount: 2,
      });
    }
    if (url.includes('/conversations')) return json({ conversations: [], scanned: 0 });
    return undefined;
  });
  const router = createMemoryRouter(
    [
      {
        path: '/chat/:conversationId',
        Component: () => <ChatRoute loaderData={{ conversationId: CONVERSATION_ID }} />,
      },
    ],
    { initialEntries: [`/chat/${CONVERSATION_ID}`] },
  );
  render(
    <Providers>
      <RouterProvider router={router} />
    </Providers>,
  );
}

describe('編集で畳まれた枝のあいだの承認（#3397）', () => {
  it('既定の表示: 決着済みで区間の中のものは畳まれ、未回答と区間の外のものは出る', async () => {
    setup();
    await screen.findByText('直した答え');
    const list = screen.getByRole('list', { name: 'やりとり' });
    // 未回答は区間の中でも常に出る。
    expect(within(list).getByText('質問 old-open')).toBeTruthy();
    // 区間の外のカードは今までどおり出る。
    expect(within(list).getByText('質問 new-answered')).toBeTruthy();
    // 区間の中の決着済み（回答済み・取り下げ済み）は畳まれ、編集後の発言の上に孤立して残らない。
    expect(within(list).queryByText('質問 old-answered')).toBeNull();
    expect(within(list).queryByText('質問 old-withdrawn')).toBeNull();
  });

  it('古い版へ戻すと、畳まれた決着済みの確認が、その版の後ろに隠れていたやりとりとして読める', async () => {
    setup();
    await screen.findByText('直した答え');
    fireEvent.click(screen.getByRole('button', { name: '前の版へ' }));
    expect(await screen.findByText('元の質問')).toBeTruthy();
    expect(await screen.findByText(/質問 old-answered（回答: はい）/)).toBeTruthy();
    expect(screen.getByText(/質問 old-withdrawn（取り下げ済み）/)).toBeTruthy();
    // 未回答はカードのまま出続ける（隠れていたやりとりの方には入らない）。
    expect(screen.queryByText(/質問 old-open（/)).toBeNull();
    expect(screen.getAllByText('質問 old-open')).toHaveLength(1);
  });
});
