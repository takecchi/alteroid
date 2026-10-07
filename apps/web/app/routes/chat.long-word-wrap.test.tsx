// @vitest-environment jsdom
import { File as NodeFile } from 'node:buffer';

import { cleanup, fireEvent, render, screen } from '@testing-library/react';
import { createMemoryRouter, RouterProvider, useParams } from 'react-router';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import { json, Providers, storeTestBaseUrl, stubFetch } from '~/test-support';

import Chat from './chat';

const ID = 'conv-3401';
const LONG = `${'a'.repeat(120)}.txt`;

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
  URL.createObjectURL = () => 'blob:fake';
  URL.revokeObjectURL = () => undefined;
});
afterEach(() => {
  cleanup();
  globalThis.fetch = originalFetch;
});

function renderChat(messages: unknown[] = []) {
  stubFetch((url) => {
    if (url.includes('/attachments/')) return new Response('gone', { status: 404 });
    if (url.includes('/approvals')) return json({ approvals: [] });
    if (url.includes(`/conversations/${ID}`)) {
      return json({
        conversationId: ID,
        messages,
        scanned: messages.length,
        reachedStart: true,
        supersededCount: 0,
      });
    }
    if (url.includes('/conversations')) return json({ conversations: [], scanned: 0 });
    return undefined;
  });
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
}

const classes = (element: Element) => (element.getAttribute('class') ?? '').split(/\s+/);

describe('長い一語が入る欄は折り返す（#3401）', () => {
  it('添付を断った案内（ファイル名を含む）は break-words を持つ', async () => {
    renderChat();
    const input = document.querySelector('input[type=file]') as HTMLInputElement;
    await screen.findByPlaceholderText(/クローンに話しかける/);
    const empty = new NodeFile([], LONG, { type: 'text/plain' }) as unknown as File;
    Object.defineProperty(input, 'files', { value: [empty], configurable: true });
    fireEvent.change(input);
    const notice = await screen.findByText(new RegExp(LONG));
    expect(classes(notice)).toContain('break-words');
  });

  it('画像の取り出し失敗（ファイル名を含む）は break-words と min-w-0 を持つ', async () => {
    renderChat([
      {
        id: 'm1',
        at: '2026-08-20T00:00:00.000Z',
        role: 'inbound',
        text: '見て',
        attachments: [
          { id: 'att-1', name: `${'b'.repeat(120)}.png`, mediaType: 'image/png', size: 3 },
        ],
      },
    ]);
    const alert = await screen.findByText(/取り出せない/);
    expect(classes(alert)).toEqual(expect.arrayContaining(['break-words', 'min-w-0']));
    const list = alert.closest('ul') as HTMLElement;
    expect(classes(list)).toContain('min-w-0');
  });

  it('編集前の版の後ろの往復は break-words を持つ', async () => {
    renderChat([
      { id: 'm1', at: '2026-08-20T00:00:00.000Z', role: 'inbound', text: '元', supersededBy: 'm2' },
      {
        id: 'm1r',
        at: '2026-08-20T00:00:01.000Z',
        role: 'outbound',
        text: `https://example.com/${'c'.repeat(160)}`,
        supersededBy: 'm2',
      },
      {
        id: 'm2',
        at: '2026-08-20T00:00:02.000Z',
        role: 'inbound',
        text: '直した',
        supersedes: 'm1',
      },
    ]);
    await screen.findByText('直した');
    fireEvent.click(screen.getByRole('button', { name: '前の版へ' }));
    const panel = (await screen.findByText(/example\.com/)).closest('div') as HTMLElement;
    expect(classes(panel)).toContain('break-words');
  });
});
