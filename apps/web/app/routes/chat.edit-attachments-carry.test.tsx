// @vitest-environment jsdom
import { cleanup, fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import { createMemoryRouter, RouterProvider } from 'react-router';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { json, Providers, sse, storeTestBaseUrl, stubFetch } from '~/test-support';

import Chat from './chat';

const CONVERSATION_ID = 'conv-3399';

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
  URL.createObjectURL = vi.fn(() => 'blob:fake');
  URL.revokeObjectURL = vi.fn();
});
afterEach(() => {
  cleanup();
  globalThis.fetch = originalFetch;
});

function setup() {
  const stub = stubFetch((url, init) => {
    if (url.endsWith('/chat')) {
      return sse(
        [
          { event: 'open', data: { conversationId: CONVERSATION_ID } },
          { event: 'done', data: { type: 'done' } },
        ],
        { signal: init?.signal },
      );
    }
    if (url.includes('/approvals')) return json({ approvals: [] });
    if (url.includes(`/conversations/${CONVERSATION_ID}`)) {
      return json({
        conversationId: CONVERSATION_ID,
        messages: [
          {
            id: 'm1',
            at: '2026-10-06T00:00:00.000Z',
            role: 'inbound',
            text: 'この表を見て',
            attachments: [CSV],
          },
        ],
        scanned: 1,
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
  return stub;
}

async function startEditing() {
  const transcript = await screen.findByRole('list', { name: 'やりとり' });
  const row = (await within(transcript).findByText('この表を見て')).closest('li') as HTMLElement;
  fireEvent.click(within(row).getByRole('button', { name: '発言を編集' }));
  return screen.findByRole('textbox', { name: '発言を編集する下書き' });
}

async function postedBody(stub: ReturnType<typeof setup>) {
  await waitFor(() => expect(stub.entries.some((e) => e.url.endsWith('/chat'))).toBe(true));
  const call = stub.entries.find((e) => e.url.endsWith('/chat'));
  return (await call?.request?.clone().json()) as Record<string, unknown>;
}

describe('発言の編集で添付を引き継ぐ（#3399）', () => {
  it('編集欄に添付のチップが出て、そのまま確定すると新しい版にも同じ添付 id が付く（上げ直さない）', async () => {
    const stub = setup();
    const textarea = await startEditing();
    expect(screen.getByRole('list', { name: 'この発言の添付' })).toBeTruthy();
    expect(screen.getByText('table.csv')).toBeTruthy();

    fireEvent.change(textarea, { target: { value: 'この表の合計を出して' } });
    fireEvent.keyDown(textarea, { key: 'Enter', metaKey: true });

    expect(await postedBody(stub)).toEqual({
      text: 'この表の合計を出して',
      conversationId: CONVERSATION_ID,
      supersedes: 'm1',
      attachments: ['att-1'],
      clientMessageId: expect.any(String),
    });
    expect(stub.entries.some((e) => e.url.includes('/attachments?'))).toBe(false);
  });

  it('チップの「外す」で外すと、新しい版には添付が付かない', async () => {
    const stub = setup();
    const textarea = await startEditing();
    fireEvent.click(screen.getByRole('button', { name: 'table.csv を外す' }));
    expect(screen.queryByRole('list', { name: 'この発言の添付' })).toBeNull();

    fireEvent.change(textarea, { target: { value: '添付なしで' } });
    fireEvent.keyDown(textarea, { key: 'Enter', metaKey: true });

    const body = await postedBody(stub);
    expect(body.text).toBe('添付なしで');
    expect('attachments' in body).toBe(false);
  });

  it('Enter だけでは確定しない（改行）。添付が残っていれば本文が空でも確定できる', async () => {
    const stub = setup();
    const textarea = await startEditing();
    fireEvent.keyDown(textarea, { key: 'Enter' });
    expect(stub.entries.some((e) => e.url.endsWith('/chat'))).toBe(false);

    fireEvent.change(textarea, { target: { value: '' } });
    expect((screen.getByRole('button', { name: '確定' }) as HTMLButtonElement).disabled).toBe(
      false,
    );
    fireEvent.click(screen.getByRole('button', { name: '確定' }));
    const body = await postedBody(stub);
    expect(body).toMatchObject({ text: '', supersedes: 'm1', attachments: ['att-1'] });
  });
});
