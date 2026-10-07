// @vitest-environment jsdom
/**
 * Issue #3778。期限切れの添付（400 `attachment_missing`）のうち、手元のファイルを持たない
 * 引き継いだ添付（失敗したターンの「もう一度送る」が付けるもの。#3566）は上げ直せない。
 * 今までどおり「外して付け直す」案内を出し、上げ直しは走らない。
 * （手元のファイルを持つ添付が上げ直されるほうは `chat.resend-current-content.test.tsx`。）
 */
import { cleanup, fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import { createMemoryRouter, RouterProvider } from 'react-router';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import { json, Providers, storeTestBaseUrl, stubFetch } from '~/test-support';

import Chat from './chat';

const ID = 'conv-3778';

const ChatRoute = Chat as unknown as (props: {
  loaderData: { conversationId: string | undefined };
}) => React.ReactElement;

const CSV = {
  id: 'att-1',
  name: 'table.csv',
  mediaType: 'text/csv',
  size: 2048,
  sha256: 'a'.repeat(64),
};

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

describe('引き継いだ添付の期限切れ（#3778）', () => {
  it('外して付け直す案内を出し、上げ直さない', async () => {
    const stub = stubFetch((url) => {
      if (url.endsWith('/chat')) {
        return json(
          { error: '添付が見つからない（期限切れの可能性）: att-1', code: 'attachment_missing' },
          400,
        );
      }
      if (url.includes('/approvals')) return json({ approvals: [] });
      if (url.includes(`/conversations/${ID}`)) {
        return json({
          conversationId: ID,
          messages: [
            {
              id: 'h1',
              at: '2026-10-06T00:00:00.000Z',
              role: 'inbound',
              text: 'この表を見て',
              attachments: [CSV],
            },
            {
              id: 'f1',
              at: '2026-10-06T00:00:01.000Z',
              role: 'outbound',
              text: '返せなかった。',
              turnFailure: 'failed',
            },
          ],
          scanned: 2,
          reachedStart: true,
          supersededCount: 0,
        });
      }
      if (url.includes('/conversations')) return json({ conversations: [], scanned: 0 });
      return undefined;
    });
    const router = createMemoryRouter(
      [
        {
          path: '/chat/:conversationId',
          Component: () => <ChatRoute loaderData={{ conversationId: ID }} />,
        },
      ],
      { initialEntries: [`/chat/${ID}`] },
    );
    render(
      <Providers>
        <RouterProvider router={router} />
      </Providers>,
    );
    const list = await screen.findByRole('list', { name: 'やりとり' });
    const failure = await waitFor(() => {
      const el = list.querySelector('[data-turn-failure="failed"]');
      if (el === null) throw new Error('まだ出ていない');
      return el as HTMLElement;
    });
    fireEvent.click(within(failure).getByRole('button', { name: 'もう一度送る' }));

    expect(await screen.findByText(/添付を外して付け直/)).toBeTruthy();
    expect(screen.queryByText(/手元のファイルを上げ直す/)).toBeNull();
    expect(stub.entries.some((e) => e.url.includes('/attachments?'))).toBe(false);
  });
});
