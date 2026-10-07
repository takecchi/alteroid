// @vitest-environment jsdom
/**
 * 会話の承認カードの回答が 409（他の入口で回答済み・取り下げ済み）で断られたら、その会話の承認を
 * 取り直し、カードを実際の状態へ変える。状態が変わったカードに、前の送信の失敗を出し続けない（#3827）。
 */
import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { createMemoryRouter, RouterProvider, useParams } from 'react-router';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import { json, Providers, stubFetch, storeTestBaseUrl, type Route } from '~/test-support';

import Chat from './chat';

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

const ID = 'conv-conflict';
const QUESTION = '本番に出してよいか';
const PENDING = {
  id: 'ap-1',
  createdAt: '2026-08-20T00:00:05.000Z',
  updatedAt: '2026-08-20T00:00:05.000Z',
  question: QUESTION,
};

function setup(settled: Record<string, unknown>) {
  let approvals: Record<string, unknown>[] = [PENDING];
  const route: Route = (url) => {
    if (url.includes('/approvals/ap-1/answer')) {
      // 他の入口が先に決着させた体にして、409 で断る。
      approvals = [settled];
      return json({ error: 'すでに決着している承認です' }, 409);
    }
    if (url.includes(`/conversations/${ID}`)) {
      return json({ conversationId: ID, messages: [], scanned: 0, reachedStart: true });
    }
    if (url.includes('/conversations')) return json({ conversations: [], scanned: 0 });
    if (url.includes('/approvals')) return json({ approvals });
    return undefined;
  };
  stubFetch(route);
}

async function answer() {
  const router = createMemoryRouter(
    [
      { path: '/chat', Component: Harness },
      { path: '/chat/:conversationId', Component: Harness },
    ],
    { initialEntries: [`/chat/${ID}`] },
  );
  render(
    <Providers>
      <RouterProvider router={router} />
    </Providers>,
  );
  await screen.findByText(QUESTION);
  fireEvent.click(await screen.findByRole('button', { name: '許可' }));
}

describe('承認の回答が 409 で断られたとき（#3827）', () => {
  it('回答済みだったら、カードが回答済みになり、失敗は出し続けない', async () => {
    setup({
      ...PENDING,
      answeredAt: '2026-08-20T00:01:00.000Z',
      updatedAt: '2026-08-20T00:01:00.000Z',
      answer: 'CLI から答えた',
    });
    await answer();

    await screen.findByText('CLI から答えた');
    await waitFor(() => expect(screen.queryByRole('button', { name: '許可' })).toBeNull());
    expect(screen.queryByRole('alert')).toBeNull();
  });

  it('取り下げ済みだったら、カードが取り下げ済みになり、失敗は出し続けない', async () => {
    setup({
      ...PENDING,
      withdrawnAt: '2026-08-20T00:01:00.000Z',
      updatedAt: '2026-08-20T00:01:00.000Z',
      withdrawnReason: '要件が変わった',
    });
    await answer();

    await screen.findByText('要件が変わった');
    await waitFor(() => expect(screen.queryByRole('button', { name: '許可' })).toBeNull());
    expect(screen.queryByRole('alert')).toBeNull();
  });
});
