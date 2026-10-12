// @vitest-environment jsdom
import { cleanup, fireEvent, render, screen, within } from '@testing-library/react';
import { createMemoryRouter, RouterProvider } from 'react-router';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { json, Providers, storeTestBaseUrl, stubFetch } from '~/test-support';

import Chat from './chat';

const CONVERSATION_ID = 'conv-version-att';

const ChatRoute = Chat as unknown as (props: {
  loaderData: { conversationId: string | undefined };
}) => React.ReactElement;

const att = (id: string, name: string) => ({
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
  URL.createObjectURL = vi.fn(() => 'blob:fake');
  URL.revokeObjectURL = vi.fn();
});
afterEach(() => {
  cleanup();
  globalThis.fetch = originalFetch;
});

function setup(messages: unknown[]) {
  stubFetch((url) => {
    if (url.includes('/approvals')) return json({ approvals: [] });
    if (url.includes(`/conversations/${CONVERSATION_ID}`)) {
      return json({
        conversationId: CONVERSATION_ID,
        messages,
        scanned: messages.length,
        reachedStart: true,
        supersededCount: 1,
      });
    }
    if (url.includes('/conversations')) return json({ conversations: [], scanned: 0 });
    return undefined;
  });
  const router = createMemoryRouter(
    [
      {
        path: '/chat/:conversationId?',
        Component: () => <ChatRoute loaderData={{ conversationId: CONVERSATION_ID }} />,
      },
    ],
    { initialEntries: [`/chat/${CONVERSATION_ID}`] },
  );
  render(
    <Providers>
      <RouterProvider router={router} />
    </Providers>,
  );
}

describe('編集の版を切り替えたとき、添付も版のものを出す（#4541）', () => {
  it('添付を外して編集した発言の前の版を見ると、その版の添付が出る', async () => {
    setup([
      {
        id: 'm1',
        at: '2026-10-06T00:00:00.000Z',
        role: 'inbound',
        text: '元の質問',
        attachments: [att('att-old', 'old.csv')],
        supersededBy: 'm2',
      },
      {
        id: 'm2',
        at: '2026-10-06T00:00:02.000Z',
        role: 'inbound',
        text: '添付を外した質問',
        supersedes: 'm1',
      },
    ]);
    await screen.findByText('2/2');
    expect(screen.queryByText('old.csv')).toBeNull();
    fireEvent.click(screen.getByRole('button', { name: '前の版へ' }));
    await screen.findByText('元の質問');
    const row = screen.getByText('元の質問').closest('li') as HTMLElement;
    expect(await within(row).findByText('old.csv')).toBeTruthy();
  });

  it('添付を足して編集した発言の前の版を見ると、足した添付は出ない。最新版へ戻すと出る', async () => {
    setup([
      {
        id: 'm1',
        at: '2026-10-06T00:00:00.000Z',
        role: 'inbound',
        text: '元の質問',
        supersededBy: 'm2',
      },
      {
        id: 'm2',
        at: '2026-10-06T00:00:02.000Z',
        role: 'inbound',
        text: '添付を足した質問',
        attachments: [att('att-new', 'new.csv')],
        supersedes: 'm1',
      },
    ]);
    await screen.findByText('2/2');
    expect(await screen.findByText('new.csv')).toBeTruthy();
    fireEvent.click(screen.getByRole('button', { name: '前の版へ' }));
    await screen.findByText('元の質問');
    expect(screen.queryByText('new.csv')).toBeNull();
    fireEvent.click(screen.getByRole('button', { name: '次の版へ' }));
    await screen.findByText('添付を足した質問');
    expect(await screen.findByText('new.csv')).toBeTruthy();
  });
});
