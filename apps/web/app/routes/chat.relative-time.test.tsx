// @vitest-environment jsdom
/**
 * #3596。承認カードの作成時刻・会話一覧の更新時刻の相対の表示（「たった今」「N分前」）は、
 * 再描画のきっかけが無くても分単位で更新される。**実時間を待たない**（偽のタイマー。
 * `waitFor` は偽のタイマーと噛み合わないので、約束の解決は `advanceTimersByTimeAsync(0)` で流す）。
 */
import { act, cleanup, render, screen } from '@testing-library/react';
import { createMemoryRouter, RouterProvider, useParams } from 'react-router';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { ApprovalAnswerCard } from '~/components/approval-answer-card';
import { json, Providers, storeTestBaseUrl, stubFetch } from '~/test-support';

import Chat from './chat';

const START = new Date('2026-10-07T12:00:00.000Z').getTime();

let originalFetch: typeof fetch;
beforeEach(() => {
  originalFetch = globalThis.fetch;
  localStorage.clear();
  storeTestBaseUrl();
  vi.useFakeTimers({ now: START, toFake: ['setInterval', 'clearInterval', 'Date'] });
  Object.defineProperty(document, 'visibilityState', { value: 'visible', configurable: true });
});
afterEach(() => {
  cleanup();
  vi.useRealTimers();
  globalThis.fetch = originalFetch;
});

async function flush() {
  for (let i = 0; i < 20; i += 1) {
    await act(async () => {
      await vi.advanceTimersByTimeAsync(0);
    });
  }
}

const ChatRoute = Chat as unknown as (props: {
  loaderData: { conversationId: string | undefined };
}) => React.ReactElement;

function Harness() {
  const params = useParams();
  return <ChatRoute loaderData={{ conversationId: params.conversationId }} />;
}

describe('相対の時刻は、再描画が無くても分単位で更新される（#3596）', () => {
  it('承認カードの作成時刻', async () => {
    stubFetch(() => undefined);
    const createdAt = new Date(START).toISOString();
    render(
      <Providers>
        <ApprovalAnswerCard
          approval={{ id: 'ap-1', createdAt, updatedAt: createdAt, question: '出してよいか' }}
        />
      </Providers>,
    );
    expect(screen.getByText('(たった今)')).toBeTruthy();
    await act(async () => {
      await vi.advanceTimersByTimeAsync(3 * 60_000);
    });
    expect(screen.getByText('(3分前)')).toBeTruthy();
  });

  it('会話一覧の更新時刻', async () => {
    stubFetch((url) => {
      if (url.includes('/approvals')) return json({ approvals: [] });
      if (url.includes('/conversations')) {
        return json({
          conversations: [
            {
              conversationId: 'conv-1',
              preview: '前の話',
              updatedAt: new Date(START).toISOString(),
              messages: 2,
              unreadCount: 0,
            },
          ],
          scanned: 2,
          reachedStart: true,
          hiddenByLimit: 0,
        });
      }
      return undefined;
    });
    const router = createMemoryRouter([{ path: '/chat/:conversationId?', Component: Harness }], {
      initialEntries: ['/chat'],
    });
    render(
      <Providers>
        <RouterProvider router={router} />
      </Providers>,
    );
    await flush();
    expect(screen.getAllByText('前の話').length).toBeGreaterThan(0);
    expect(screen.getAllByText(/たった今/).length).toBeGreaterThan(0);
    await act(async () => {
      await vi.advanceTimersByTimeAsync(2 * 60_000);
    });
    expect(screen.queryAllByText(/たった今/)).toHaveLength(0);
    expect(screen.getAllByText(/2分前/).length).toBeGreaterThan(0);
  });
});

/**
 * #3828。分の時計の値は最大 60 秒古い。更新した直後の時刻（端末の `Date.now()`・サーバの `updatedAt`）は
 * その値より少し後になるので、「まもなく」「1分後」と出ていた。1分未満先の時刻は「たった今」と出す。
 * 本当に未来の時刻（予定など）は変えない。
 */
describe('更新した直後の時刻は「たった今」と出る（#3828）', () => {
  const at = (secondsAfter: number) => new Date(START + secondsAfter * 1000).toISOString();

  it.each([5, 30, 50, 59])('承認カード: 分の時計より %i 秒後の作成時刻', (seconds) => {
    stubFetch(() => undefined);
    render(
      <Providers>
        <ApprovalAnswerCard
          approval={{
            id: 'ap-1',
            createdAt: at(seconds),
            updatedAt: at(seconds),
            question: '出してよいか',
          }}
        />
      </Providers>,
    );
    expect(screen.getByText('(たった今)')).toBeTruthy();
  });

  it('承認カード: 本当に未来（10分後）の時刻は「10分後」のまま', () => {
    stubFetch(() => undefined);
    render(
      <Providers>
        <ApprovalAnswerCard
          approval={{
            id: 'ap-1',
            createdAt: at(600),
            updatedAt: at(600),
            question: '出してよいか',
          }}
        />
      </Providers>,
    );
    expect(screen.getByText('(10分後)')).toBeTruthy();
  });

  it.each([30, 50])('会話一覧: 分の時計より %i 秒後の更新時刻', async (seconds) => {
    stubFetch((url) => {
      if (url.includes('/approvals')) return json({ approvals: [] });
      if (url.includes('/conversations')) {
        return json({
          conversations: [
            {
              conversationId: 'conv-1',
              preview: '前の話',
              updatedAt: at(seconds),
              messages: 2,
              unreadCount: 0,
            },
          ],
          scanned: 2,
          reachedStart: true,
          hiddenByLimit: 0,
        });
      }
      return undefined;
    });
    const router = createMemoryRouter([{ path: '/chat/:conversationId?', Component: Harness }], {
      initialEntries: ['/chat'],
    });
    render(
      <Providers>
        <RouterProvider router={router} />
      </Providers>,
    );
    await flush();
    expect(screen.getAllByText('前の話').length).toBeGreaterThan(0);
    expect(screen.getAllByText(/たった今/).length).toBeGreaterThan(0);
    expect(screen.queryAllByText(/まもなく|1分後/)).toHaveLength(0);
  });
});
