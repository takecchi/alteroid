// @vitest-environment jsdom
/**
 * **やりとりの本文の、種類ごとの描き分け（振る舞い）。**
 *
 * 本文は `ChatMessage` / `ChatMessageList` へ移したが、**移行で変えてよいのは見た目だけ**
 * である。ここで押さえるのは見た目ではなく描き分けの側——人間の本文は素のテキスト
 * （`*` を打ったとおりに見せ、改行を保つ）、クローンの本文だけ Markdown、行ごとに `<li>`。
 * 見た目（吹き出しの色・角丸・余白）は新しいテーマの既定を採っており、ここでは固定しない。
 */
import { cleanup, render, screen, within } from '@testing-library/react';
import { createMemoryRouter, RouterProvider, useParams } from 'react-router';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import { json, Providers, storeTestBaseUrl, stubFetch } from '~/test-support';

import Chat from './chat';

const CONVERSATION_ID = 'conv-dom';

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
  stubFetch((url) => {
    if (url.includes(`/conversations/${CONVERSATION_ID}`)) {
      return json({
        conversationId: CONVERSATION_ID,
        messages: [
          {
            id: 'm-human-1',
            at: '2026-08-20T00:00:00.000Z',
            role: 'inbound',
            text: '*そのまま*\n二行目',
          },
          {
            id: 'm-clone-1',
            at: '2026-08-20T00:00:01.000Z',
            role: 'outbound',
            text: 'これは **太字** です',
          },
        ],
        scanned: 2,
        reachedStart: true,
        supersededCount: 0,
      });
    }
    if (url.includes('/approvals')) return json({ approvals: [] });
    if (url.includes('/conversations')) return json({ conversations: [], scanned: 0 });
    return undefined;
  });
});

afterEach(() => {
  cleanup();
  globalThis.fetch = originalFetch;
});

describe('やりとりの本文の描き分け', () => {
  it('1行が1つの <li>。人間の本文は素のテキスト（改行を保つ）、クローンの本文だけ Markdown', async () => {
    const router = createMemoryRouter([{ path: '/chat/:conversationId', Component: Harness }], {
      initialEntries: [`/chat/${CONVERSATION_ID}`],
    });
    render(
      <Providers>
        <RouterProvider router={router} />
      </Providers>,
    );

    const list = await screen.findByRole('list', { name: 'やりとり' });
    await within(list).findByText('太字');
    expect(within(list).getAllByRole('listitem')).toHaveLength(2);

    const human = within(list).getByText(/そのまま/);
    expect(human.textContent).toBe('*そのまま*\n二行目');
    expect(human.querySelector('em')).toBeNull();
    expect(human.className.split(/\s+/)).toContain('whitespace-pre-wrap');

    const strong = within(list).getByText('太字');
    expect(strong.tagName).toBe('STRONG');
  });
});
