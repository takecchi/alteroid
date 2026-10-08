// @vitest-environment jsdom
import { cleanup, fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import { createMemoryRouter, RouterProvider } from 'react-router';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import { json, Providers, storeTestBaseUrl, stubFetch } from '~/test-support';

import Chat from './chat';

const ID = 'conv-4070';

const ChatRoute = Chat as unknown as (props: {
  loaderData: { conversationId: string | undefined };
}) => React.ReactElement;

const attachment = (id: string, name: string) => ({
  id,
  name,
  mediaType: 'text/csv',
  size: 2048,
  sha256: 'a'.repeat(64),
});

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

async function openNote(
  attachments: ReturnType<typeof attachment>[],
  missingIds: string[],
): Promise<HTMLElement> {
  {
    stubFetch((url) => {
      if (url.endsWith('/chat')) {
        return json(
          {
            error: `添付が見つからない（期限切れの可能性）: ${missingIds.join(', ')}`,
            code: 'attachment_missing',
          },
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
              attachments,
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

    return screen.findByText(/添付を外して付け直/);
  }
}

describe('引き継いだ添付の期限切れの案内は、切れた添付を名前で示す（#4070）', () => {
  it('2つのうち1つが切れたとき、その名前だけを出す', async () => {
    const note = await openNote(
      [attachment('att-1', 'alive.csv'), attachment('att-2', 'table.csv')],
      ['att-2'],
    );
    expect(note.textContent).toContain('table.csv');
    expect(note.textContent).not.toContain('alive.csv');
  });

  it('名前が多いときは先頭3件と「ほか N 件」にする', async () => {
    const all = [1, 2, 3, 4, 5].map((n) => attachment(`att-${n}`, `f${n}.csv`));
    const note = await openNote(
      all,
      all.map((a) => a.id),
    );
    expect(note.textContent).toContain('（f1.csv、f2.csv、f3.csv ほか 2 件）');
    expect(note.textContent).not.toContain('f4.csv');
  });
});
