// @vitest-environment jsdom
import { cleanup, render, screen, within } from '@testing-library/react';
import { createMemoryRouter, RouterProvider, useParams } from 'react-router';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import { useJournalLive } from '@alteroid/swr';
import { json, Providers, stubFetch, storeTestBaseUrl, type Route } from '~/test-support';

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
const CONVERSATION_ID = 'conv-withdrawn-message';

function stubHistory(messages: Record<string, unknown>[]) {
  const route: Route = (url) => {
    if (url.includes(`/conversations/${CONVERSATION_ID}`)) {
      return json({
        conversationId: CONVERSATION_ID,
        messages,
        scanned: messages.length,
        reachedStart: true,
      });
    }
    if (url.includes('/approvals')) return json({ approvals: [] });
    if (url.includes('/conversations')) return json({ conversations: [], scanned: 0 });
    return undefined;
  };
  stubFetch(route);
}

const inbound = (id: string, text: string, extra: Record<string, unknown> = {}) => ({
  id,
  at: `2026-08-20T00:00:0${id.slice(1)}.000Z`,
  role: 'inbound',
  text,
  clientMessageId: `cm-${id}`,
  ...extra,
});

describe('履歴の読み直し: 取り下げた発言（#3990）', () => {
  it('delivery: withdrawn の発言は普通の吹き出しにせず、畳んだ「（取り下げた発言）」で出す', async () => {
    stubHistory([
      inbound('m1', '届いた発言'),
      inbound('m2', '取り下げた発言', { delivery: 'withdrawn' }),
    ]);

    renderChat(`/chat/${CONVERSATION_ID}`);

    await screen.findByText('届いた発言');
    const items = within(transcript()).getAllByRole('listitem');
    const withdrawn = items.filter((item) => item.hasAttribute('data-withdrawn-message'));
    expect(withdrawn).toHaveLength(1);
    expect(withdrawn[0]?.textContent).toContain('（取り下げた発言）');
    expect(withdrawn[0]?.querySelector('details')?.open).toBe(false);
    // 取り下げた発言には、普通の発言の編集の入口（鉛筆）を出さない。取り下げていない発言の分は出る
    expect(screen.getAllByRole('button', { name: '発言を編集' })).toHaveLength(1);
  });

  it('delivery の無い応答（取り下げていない・古いデーモン）は今までどおり普通の吹き出し', async () => {
    stubHistory([inbound('m1', '一つ目'), inbound('m2', '二つ目')]);

    renderChat(`/chat/${CONVERSATION_ID}`);

    await screen.findByText('一つ目');
    await screen.findByText('二つ目');
    expect(document.querySelector('[data-withdrawn-message]')).toBeNull();
    expect(screen.getAllByRole('button', { name: '発言を編集' })).toHaveLength(2);
  });

  it('ヘッダの「発言 N 件」に、取り下げた発言を数えない（#4357）', async () => {
    stubHistory([
      inbound('m1', '届いた発言'),
      inbound('m2', '取り下げた発言', { delivery: 'withdrawn' }),
    ]);

    renderChat(`/chat/${CONVERSATION_ID}`);

    await screen.findByText('届いた発言');
    expect(await screen.findByText(/発言 1 件$/)).toBeTruthy();
    expect(screen.queryByText(/発言 2 件$/)).toBeNull();
  });
});
