// @vitest-environment jsdom
/**
 * issue #3404: 会話の一覧が 30 件で止まり、31 件目以降へ辿り着けなかった。
 * 「もっと見る」で `limit` を増やして取り直す。続きが無ければボタンを出さない。
 * 続きの取得に失敗しても、一覧は消さず、画面の上のエラーも出さず、一覧の下に小さく言う。
 */
import { cleanup, fireEvent, render, screen, waitFor, within } from '@testing-library/react';
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

function conversations(shown: number, total: number) {
  return {
    conversations: Array.from({ length: shown }, (_, index) => ({
      conversationId: `c${index}`,
      preview: `会話 ${index}`,
      updatedAt: '2026-10-06T00:00:00.000Z',
      messages: 2,
      unreadCount: 0,
    })),
    scanned: total,
    reachedStart: true,
    hiddenByLimit: Math.max(0, total - shown),
  };
}

const MORE = { name: 'もっと見る' } as const;

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

function limitOf(url: string): number {
  return Number(new URL(url).searchParams.get('limit'));
}

describe('会話の一覧の「もっと見る」（issue #3404）', () => {
  it('押すと limit を増やして取り直し、続きが出る。もう続きが無ければボタンは消える', async () => {
    const stub = stubFetch((url) => {
      if (url.includes('/approvals')) return json({ approvals: [] });
      if (url.includes('/conversations')) {
        return json(limitOf(url) >= 60 ? conversations(45, 45) : conversations(30, 45));
      }
      return undefined;
    });

    renderChat();
    const list = await screen.findByRole('list', { name: '会話' });
    expect(within(list).getAllByRole('listitem')).toHaveLength(30);

    fireEvent.click(screen.getByRole('button', MORE));

    await waitFor(() => {
      expect(
        within(screen.getByRole('list', { name: '会話' })).getAllByRole('listitem'),
      ).toHaveLength(45);
    });
    expect(stub.calls.some((url) => url.includes('/conversations') && limitOf(url) === 60)).toBe(
      true,
    );
    expect(screen.queryByRole('button', MORE)).toBeNull();
  });

  it('最初から続きが無ければ、ボタンを出さない', async () => {
    stubFetch((url) => {
      if (url.includes('/approvals')) return json({ approvals: [] });
      if (url.includes('/conversations')) return json(conversations(3, 3));
      return undefined;
    });

    renderChat();
    await screen.findByRole('list', { name: '会話' });
    expect(screen.queryByRole('button', MORE)).toBeNull();
  });

  it('続きの取得に失敗したら、一覧は残し、一覧の下に小さく言う。もう一度押せば取り直せる', async () => {
    let failMore = true;
    stubFetch((url) => {
      if (url.includes('/approvals')) return json({ approvals: [] });
      if (url.includes('/conversations')) {
        if (limitOf(url) >= 60) {
          return failMore ? json({ error: 'internal' }, 500) : json(conversations(40, 40));
        }
        return json(conversations(30, 40));
      }
      return undefined;
    });

    renderChat();
    await screen.findByRole('list', { name: '会話' });
    fireEvent.click(screen.getByRole('button', MORE));

    const note = await screen.findByRole('alert');
    expect(note.textContent).toContain('続きを読めなかった');
    // 一覧は消えず、ボタンも残る。「まだ会話がない。」にもならない。
    expect(
      within(screen.getByRole('list', { name: '会話' })).getAllByRole('listitem'),
    ).toHaveLength(30);
    expect(screen.queryByText('まだ会話がない。')).toBeNull();
    // 画面の上の ErrorNote（別の alert）は出ていない。
    expect(screen.getAllByRole('alert')).toHaveLength(1);

    failMore = false;
    fireEvent.click(screen.getByRole('button', MORE));
    await waitFor(() => {
      expect(
        within(screen.getByRole('list', { name: '会話' })).getAllByRole('listitem'),
      ).toHaveLength(40);
    });
    expect(screen.queryByRole('alert')).toBeNull();
  });
});
