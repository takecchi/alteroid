// @vitest-environment jsdom
import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { createMemoryRouter, RouterProvider, useParams } from 'react-router';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import { json, Providers, storeTestBaseUrl, stubFetch } from '~/test-support';

import Chat from './chat';

const A = 'conv-conflict-draft';
const PLACEHOLDER = /答える（書いておくと/;
const LEFTOVER = '送らなかった下書きが残っている承認';

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
  sessionStorage.clear();
  storeTestBaseUrl();
});
afterEach(() => {
  cleanup();
  globalThis.fetch = originalFetch;
});

const APPROVAL = {
  id: 'ap-1',
  createdAt: '2026-08-20T00:00:05.000Z',
  updatedAt: '2026-08-20T00:00:05.000Z',
  question: '本番に出してよいか',
};

describe('会話の画面で承認への回答が 409 で断られたとき（#4536）', () => {
  it('書いた答えを黙って消さず、承認の画面と同じく「送らなかった下書き」として残す', async () => {
    let settled = false;
    stubFetch((url) => {
      if (url.includes('/approvals/ap-1/answer')) {
        settled = true;
        return json({ error: 'すでに決着している承認です' }, 409);
      }
      if (url.includes('/approvals')) {
        return json({
          approvals: [
            settled
              ? { ...APPROVAL, answeredAt: '2026-08-20T00:01:00.000Z', answer: 'CLI から答えた' }
              : APPROVAL,
          ],
        });
      }
      if (url.includes(`/conversations/${A}`)) {
        return json({ conversationId: A, messages: [], scanned: 0, reachedStart: true });
      }
      if (url.includes('/conversations')) return json({ conversations: [], scanned: 0 });
      return undefined;
    });
    const router = createMemoryRouter([{ path: '/chat/:conversationId', Component: Harness }], {
      initialEntries: [`/chat/${A}`],
    });
    render(
      <Providers>
        <RouterProvider router={router} />
      </Providers>,
    );
    const field = (await screen.findByPlaceholderText(PLACEHOLDER)) as HTMLTextAreaElement;
    fireEvent.change(field, { target: { value: '丁寧に書いた長い回答' } });
    fireEvent.click(screen.getByRole('button', { name: '回答する' }));
    await screen.findByText('CLI から答えた');
    const list = await screen.findByRole('list', { name: LEFTOVER });
    expect(list.textContent).toContain('丁寧に書いた長い回答');
    // 言い分け: 自分の答えが通った場合ではなく、409 で断られた場合の文言で出す
    await waitFor(() => expect(list.textContent).toContain('409'));
  });
});
