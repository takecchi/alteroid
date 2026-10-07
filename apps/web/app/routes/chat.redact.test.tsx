// @vitest-environment jsdom
// 伏せ字は描画だけに掛ける（データを書き換えない）: 編集の下書きの初期値は元の本文で、書き換えると再送した本文に伏せ字が入ってしまうため
import { cleanup, fireEvent, render, screen, within } from '@testing-library/react';
import { createMemoryRouter, RouterProvider, useParams } from 'react-router';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import { json, Providers, storeTestBaseUrl, stubFetch } from '~/test-support';

import Chat from './chat';

const CONVERSATION_ID = 'conv-redact-1';
const TOKEN = `ghp_${'A1b2C3d4E5'.repeat(4)}`;
const SHA = '0123456789abcdef0123456789abcdef01234567';

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

describe('会話の本文の伏せ字', () => {
  it('人間・クローンの本文からトークンが消え、40桁の sha は残る。編集の下書きは元の本文のまま', async () => {
    stubFetch((url) => {
      if (url.includes('/approvals')) return json({ approvals: [] });
      if (url.includes(`/conversations/${CONVERSATION_ID}`)) {
        return json({
          conversationId: CONVERSATION_ID,
          messages: [
            {
              id: 'm-human-1',
              at: '2026-08-20T00:00:00.000Z',
              role: 'inbound',
              text: `token は ${TOKEN} commit は ${SHA}`,
            },
            {
              id: 'm-clone-1',
              at: '2026-08-20T00:00:01.000Z',
              role: 'outbound',
              text: `返信 ${TOKEN} / ${SHA}`,
            },
          ],
          scanned: 2,
          reachedStart: true,
          supersededCount: 0,
        });
      }
      return url.includes('/conversations') ? json({ conversations: [], scanned: 0 }) : undefined;
    });

    const router = createMemoryRouter([{ path: '/chat/:conversationId', Component: Harness }], {
      initialEntries: [`/chat/${CONVERSATION_ID}`],
    });
    render(
      <Providers>
        <RouterProvider router={router} />
      </Providers>,
    );

    const list = await screen.findByRole('list', { name: 'やりとり' });
    await screen.findByText(/token は /);
    expect(list.textContent).not.toContain(TOKEN);
    expect(list.textContent).toContain(SHA);

    const row = within(list)
      .getByText(/token は /)
      .closest('li') as HTMLElement;
    fireEvent.click(within(row).getByRole('button', { name: '発言を編集' }));
    const textarea = await screen.findByRole<HTMLTextAreaElement>('textbox', {
      name: '発言を編集する下書き',
    });
    expect(textarea.value).toBe(`token は ${TOKEN} commit は ${SHA}`);
  });
});
