// @vitest-environment jsdom
import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { createMemoryRouter, RouterProvider, useParams } from 'react-router';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import { json, Providers, storeTestBaseUrl, stubFetch } from '~/test-support';

import Chat from './chat';

const ChatRoute = Chat as unknown as (props: {
  loaderData: { conversationId: string | undefined };
}) => React.ReactElement;

function Harness() {
  const params = useParams();
  return <ChatRoute loaderData={{ conversationId: params.conversationId }} />;
}

function renderChat() {
  const router = createMemoryRouter(
    [
      { path: '/chat', Component: Harness },
      { path: '/chat/:conversationId', Component: Harness },
    ],
    { initialEntries: ['/chat'] },
  );
  return render(
    <Providers>
      <RouterProvider router={router} />
    </Providers>,
  );
}

function page(
  from: number,
  count: number,
  extra: {
    scanned: number;
    reachedStart: boolean;
    nextCursor?: string;
    readStateUnreadable?: string;
    unreadCount?: number;
  },
) {
  return {
    conversations: Array.from({ length: count }, (_, index) => ({
      conversationId: `c${from + index}`,
      preview: `会話 ${from + index}`,
      updatedAt: '2026-10-06T00:00:00.000Z',
      messages: 2,
      unreadCount: extra.unreadCount ?? 0,
    })),
    scanned: extra.scanned,
    reachedStart: extra.reachedStart,
    hiddenByLimit: 0,
    ...(extra.nextCursor === undefined ? {} : { nextCursor: extra.nextCursor }),
    ...(extra.readStateUnreadable === undefined
      ? {}
      : { readStateUnreadable: extra.readStateUnreadable }),
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

function serve(first: () => Response, second?: () => Response) {
  stubFetch((url) => {
    if (url.includes('/approvals')) return json({ approvals: [] });
    if (url.includes('/conversations')) {
      return new URL(url).searchParams.get('cursor') === null ? first() : second?.();
    }
    return undefined;
  });
}

const MORE = { name: 'もっと見る' } as const;

describe('会話の一覧の但し書き（#4021）', () => {
  it('もっと見るで頁を足したあと、最後の頁の値だけを一覧全体の値として言わない', async () => {
    serve(
      () => json(page(0, 3, { scanned: 2000, reachedStart: false, nextCursor: 'k1' })),
      () => json(page(3, 2, { scanned: 40, reachedStart: false, nextCursor: 'k2' })),
    );
    renderChat();
    await screen.findByRole('list', { name: '会話' });
    expect(screen.getByText(/人間との往復を 2000 件遡ったが、先頭には届いていない/)).toBeTruthy();

    fireEvent.click(screen.getByRole('button', MORE));
    await waitFor(() => {
      expect(
        screen.getByText(/人間との往復を 2 頁ぶん遡ったが、先頭には届いていない/),
      ).toBeTruthy();
    });
    expect(screen.queryByText(/人間との往復を 40 件遡った/)).toBeNull();
    expect(screen.getByText(/最後の頁の窓は、人間との往復 40 件を走査/)).toBeTruthy();
  });

  it('既読の記録が読めないときは、一覧にも断りを出し、未読の数が全件であることを言う', async () => {
    serve(() =>
      json(
        page(0, 2, {
          scanned: 10,
          reachedStart: true,
          readStateUnreadable: '既読の記録が壊れている',
          unreadCount: 3,
        }),
      ),
    );
    renderChat();
    await screen.findByRole('list', { name: '会話' });
    const note = await screen.findByText(/既読の記録が読めない/);
    expect(note.textContent).toContain('全部未読として数えた');
  });

  it('既読が読めるなら、断りは出さない', async () => {
    serve(() => json(page(0, 2, { scanned: 10, reachedStart: true })));
    renderChat();
    await screen.findByRole('list', { name: '会話' });
    expect(screen.queryByText(/既読の記録が読めない/)).toBeNull();
  });
});
