// @vitest-environment jsdom
/**
 * Issue #3566。失敗したターンの「もう一度送る」は、元の発言の添付も付けて送る
 * （付けないと、返信は添付を読まないまま返る）。上げ直さず、元の添付の id を渡す
 * （編集の添付の引き継ぎ #3399 と同じ道具）。
 */
import { cleanup, fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import { createMemoryRouter, RouterProvider } from 'react-router';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import { json, Providers, sse, storeTestBaseUrl, stubFetch } from '~/test-support';

import Chat from './chat';

const ID = 'conv-3566';

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

function setup(human: Record<string, unknown>) {
  const stub = stubFetch((url, init) => {
    if (url.endsWith('/chat')) {
      return sse(
        [
          { event: 'open', data: { conversationId: ID } },
          { event: 'done', data: { type: 'done' } },
        ],
        { signal: init?.signal },
      );
    }
    if (url.includes('/approvals')) return json({ approvals: [] });
    if (url.includes(`/conversations/${ID}`)) {
      return json({
        conversationId: ID,
        messages: [
          { id: 'h1', at: '2026-10-06T00:00:00.000Z', role: 'inbound', ...human },
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
  return stub;
}

async function retryAndGetBody(stub: ReturnType<typeof setup>) {
  const list = await screen.findByRole('list', { name: 'やりとり' });
  const failure = await waitFor(() => {
    const el = list.querySelector('[data-turn-failure="failed"]');
    if (el === null) throw new Error('まだ出ていない');
    return el as HTMLElement;
  });
  fireEvent.click(within(failure).getByRole('button', { name: 'もう一度送る' }));
  await waitFor(() => expect(stub.entries.some((e) => e.url.endsWith('/chat'))).toBe(true));
  const call = stub.entries.find((e) => e.url.endsWith('/chat'));
  return (await call?.request?.clone().json()) as Record<string, unknown>;
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

describe('失敗したターンの「もう一度送る」と添付（#3566）', () => {
  it('元の発言の添付の id を付けて送り、上げ直さない', async () => {
    const stub = setup({ text: 'この表を見て', attachments: [CSV] });
    const body = await retryAndGetBody(stub);
    expect(body).toMatchObject({
      text: 'この表を見て',
      conversationId: ID,
      attachments: ['att-1'],
    });
    expect(stub.entries.some((e) => e.url.includes('/attachments?'))).toBe(false);
  });

  it('添付だけで本文が空の発言でも、添付つきで送り直せる', async () => {
    const stub = setup({ text: '', attachments: [CSV] });
    const body = await retryAndGetBody(stub);
    expect(body.attachments).toEqual(['att-1']);
  });

  it('陰性対照: 添付の無い発言は、今までどおり本文だけで送る', async () => {
    const stub = setup({ text: '添付なしの発言' });
    const body = await retryAndGetBody(stub);
    expect(body.text).toBe('添付なしの発言');
    expect(body.attachments ?? []).toEqual([]);
  });
});
