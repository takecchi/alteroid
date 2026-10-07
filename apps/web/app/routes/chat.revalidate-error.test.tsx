// @vitest-environment jsdom
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

    const router = createMemoryRouter([{ path: '/chat/:conversationId', Component: Harness }], {
      initialEntries: [`/chat/${CONVERSATION}`],
    });
    render(
      <Providers>
        <RouterProvider router={router} />
      </Providers>,
    );

    expect(await screen.findByText('やあ')).toBeTruthy();
    expect(screen.queryByRole('alert')).toBeNull();

    act(() => {
      window.dispatchEvent(new Event('focus'));
    });

    await waitFor(() => expect(screen.getByRole('alert')).toBeTruthy());
    expect(historyCalls).toBeGreaterThanOrEqual(2);
    expect(screen.getByText('やあ')).toBeTruthy();
  });
});
