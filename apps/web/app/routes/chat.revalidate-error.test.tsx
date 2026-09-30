// @vitest-environment jsdom
/**
 * issue #2266: 再検証（revalidate）の失敗1回で、読めていた会話の本文が
 * `ErrorNote` に差し替わらない。
 *
 * SWR は再検証が失敗しても前回取れた `data` を残したまま `error` を立てる。
 * `chat.tsx` の本文の分岐が `history.error` だけを見ていた間は、一過性の失敗
 * 1回で履歴と手元の行が消えた（#2218 の分岐が `data` の有無を見ていなかった）。
 *
 * 固定する性質:
 * (a) 初回は成功し、再検証（フォーカス）が失敗しても、本文は残る
 * (b) そのとき失敗は黙って消さない（`role="alert"` の注記が出る）
 * (c) 初回から失敗しているときは、従来どおり本文の代わりに `ErrorNote`
 *     （`chat.swr-error.test.tsx` の (a) が持つ）
 */
import { act, cleanup, render, screen, waitFor } from '@testing-library/react';
import { createMemoryRouter, RouterProvider, useParams } from 'react-router';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import { json, Providers, storeTestBaseUrl, stubFetch } from '~/test-support';

import Chat from './chat';

const CONVERSATION = 'conv-2266';

const ChatRoute = Chat as unknown as (props: {
  loaderData: { conversationId: string | undefined };
}) => React.ReactElement;

function Harness() {
  const params = useParams();
  return <ChatRoute loaderData={{ conversationId: params.conversationId }} />;
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

describe('再検証の失敗（issue #2266）', () => {
  it('(a)(b) 本文を読めた後の再検証が失敗しても、本文は残り、失敗は alert で知らせる', async () => {
    let historyCalls = 0;
    stubFetch((url) => {
      if (url.includes(`/conversations/${CONVERSATION}`)) {
        historyCalls += 1;
        if (historyCalls === 1) {
          return json({
            conversationId: CONVERSATION,
            messages: [{ id: 'm1', at: '2026-08-20T00:00:00.000Z', role: 'inbound', text: 'やあ' }],
          });
        }
        return json({ error: 'internal' }, 500);
      }
      if (url.includes('/approvals')) return json({ approvals: [] });
      if (url.includes('/conversations')) return json({ conversations: [], scanned: 0 });
      return undefined;
    });

    const router = createMemoryRouter(
      [{ path: '/chat/:conversationId', Component: Harness }],
      { initialEntries: [`/chat/${CONVERSATION}`] },
    );
    render(
      <Providers>
        <RouterProvider router={router} />
      </Providers>,
    );

    expect(await screen.findByText('やあ')).toBeTruthy();
    expect(screen.queryByRole('alert')).toBeNull();

    // 再検証を起こす（SWR は focus で再検証する。足場は throttle 0）。
    act(() => {
      window.dispatchEvent(new Event('focus'));
    });

    // 再検証が実際に走って失敗したこと（＝失敗は黙って消えていない）。
    await waitFor(() => expect(screen.getByRole('alert')).toBeTruthy());
    expect(historyCalls).toBeGreaterThanOrEqual(2);
    // 読めていた本文は消えていない。
    expect(screen.getByText('やあ')).toBeTruthy();
  });
});
