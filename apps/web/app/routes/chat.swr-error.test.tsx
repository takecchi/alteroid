// @vitest-environment jsdom
/**
 * issue #2210: `history`（`GET /conversations/:id`）・`conversationApprovals`
 * （`GET /approvals?conversationId=...`）の失敗を、この画面がどちらも見て
 * いなかった（`chat.tsx` の `.error` の参照が issue を書いた時点で0件
 * ——issue 本文の grep）。
 *
 * PR #2143（`dashboard.tsx`/`practice-detail.tsx`、issue #2138/#2139）と
 * 同じ判断をここでも採る——失敗を最優先し、「新しい会話の案内」や「0件」の
 * 表示と紛れさせない。
 *
 * ここで固定する性質は3つ:
 * (a) `GET /conversations/:id` が失敗すると `ErrorNote`（`role="alert"`）が
 *     出て、新しい会話の案内文言（「目的や価値観を伝えると…」）は出ない
 * (b) その会話の承認待ち（`GET /approvals`）が失敗すると、読めていないことを
 *     示す `ErrorNote` が出る——会話の本文（history）は読めているので、
 *     本文が消えるわけではない
 * (c) 会話を切り替えると、前の会話の失敗（history の失敗）は残らない——
 *     `visibleInterruptFailure`/`visibleEndFailure`（手で持ち回す state）とは
 *     違い、こちらは SWR のキー（`shownId` そのもの）が会話ごとに分かれる
 *     ことで成り立つ。切り替えのたびに消す・引き継ぐコードは要らない——
 *     ここではその前提が壊れていないことを歯にする。
 */
import { cleanup, render, screen } from '@testing-library/react';
import { createMemoryRouter, RouterProvider, useParams } from 'react-router';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import { json, Providers, storeTestBaseUrl, stubFetch } from '~/test-support';

import Chat from './chat';

const CONVERSATION_A = 'conv-2210-a';
const CONVERSATION_B = 'conv-2210-b';

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

const GUIDANCE_TEXT = '目的や価値観を伝えると、クローンはそれを記憶に蒸留して次の判断に使う。';

describe('history.error（issue #2210）', () => {
  it('(a) GET /conversations/:id が失敗すると ErrorNote が出て、新しい会話の案内文言は出ない', async () => {
    stubFetch((url) => {
      if (url.includes(`/conversations/${CONVERSATION_A}`)) {
        return json({ error: 'internal' }, 500);
      }
      if (url.includes('/approvals')) return json({ approvals: [] });
      if (url.includes('/conversations')) return json({ conversations: [], scanned: 0 });
      return undefined;
    });

    renderChat(`/chat/${CONVERSATION_A}`);

    expect(await screen.findByRole('alert')).toBeTruthy();
    // 「行が0件」の案内文言（新しい会話と同じ見た目）には落ちていない。
    expect(screen.queryByText(GUIDANCE_TEXT)).toBeNull();
    // 読み込み中（Spinner）とも見分けが付く——失敗は「まだ読んでいる」ではない。
    expect(screen.queryByText('履歴を読み込み中')).toBeNull();
  });
});

describe('conversationApprovals.error（issue #2210）', () => {
  it('(b) その会話の承認待ちが読めないと、読めていないことを示す ErrorNote が出る（本文は読めている）', async () => {
    stubFetch((url) => {
      if (url.includes(`/conversations/${CONVERSATION_A}`)) {
        return json({
          conversationId: CONVERSATION_A,
          messages: [{ id: 'm1', at: '2026-08-20T00:00:00.000Z', role: 'inbound', text: 'やあ' }],
        });
      }
      if (url.includes('/approvals')) return json({ error: 'internal' }, 500);
      if (url.includes('/conversations')) return json({ conversations: [], scanned: 0 });
      return undefined;
    });

    renderChat(`/chat/${CONVERSATION_A}`);

    // 会話の本文（history）は読めている——承認待ちの失敗が本文まで隠さない。
    expect(await screen.findByText('やあ')).toBeTruthy();
    // それでも承認待ちが読めていないことを示す alert が出る。
    expect(await screen.findByRole('alert')).toBeTruthy();
  });
});

describe('会話を切り替えると前の会話の失敗は残らない（issue #2210）', () => {
  it('(c) history が失敗している A から、成功する B へ切り替えると ErrorNote は消える', async () => {
    stubFetch((url) => {
      if (url.includes(`/conversations/${CONVERSATION_A}`)) {
        return json({ error: 'internal' }, 500);
      }
      if (url.includes(`/conversations/${CONVERSATION_B}`)) {
        return json({
          conversationId: CONVERSATION_B,
          messages: [
            { id: 'm1', at: '2026-08-13T00:00:00.000Z', role: 'inbound', text: '別の会話' },
          ],
        });
      }
      if (url.includes('/approvals')) return json({ approvals: [] });
      if (url.includes('/conversations')) return json({ conversations: [], scanned: 0 });
      return undefined;
    });

    const { router } = renderChat(`/chat/${CONVERSATION_A}`);
    expect(await screen.findByRole('alert')).toBeTruthy();

    await router.navigate(`/chat/${CONVERSATION_B}`);

    expect(await screen.findByText('別の会話')).toBeTruthy();
    expect(screen.queryByRole('alert')).toBeNull();
  });
});
