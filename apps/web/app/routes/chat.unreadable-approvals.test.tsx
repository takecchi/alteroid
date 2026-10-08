// @vitest-environment jsdom
import { cleanup, render, screen } from '@testing-library/react';
import { createMemoryRouter, RouterProvider, useParams } from 'react-router';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import { json, Providers, storeTestBaseUrl, stubFetch } from '~/test-support';

import Chat from './chat';

const ChatRoute = Chat as unknown as (props: {
  loaderData: { conversationId: string | undefined };
}) => React.ReactElement;

function Harness() {
  const params = useParams();
  return <ChatRoute loaderData={{ conversationId: params.conversationId }} />;
}

const ID = 'conv-unreadable';

function renderChat() {
  const router = createMemoryRouter([{ path: '/chat/:conversationId', Component: Harness }], {
    initialEntries: [`/chat/${ID}`],
  });
  return render(
    <Providers>
      <RouterProvider router={router} />
    </Providers>,
  );
}

function stubDaemon(unreadable: { id?: string; reason: string }[] | undefined) {
  stubFetch((url) => {
    if (url.includes('/approvals')) {
      return json({ approvals: [], ...(unreadable === undefined ? {} : { unreadable }) });
    }
    if (url.includes(`/conversations/${ID}`)) {
      return json({
        conversationId: ID,
        messages: [{ id: 'm1', at: '2026-08-20T00:00:00.000Z', role: 'inbound', text: '確認して' }],
        scanned: 1,
        reachedStart: true,
      });
    }
    if (url.includes('/conversations')) return json({ conversations: [], scanned: 0 });
    return undefined;
  });
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

describe('会話の画面が、その会話の読めない承認の行を断る（#4018）', () => {
  it('読めない承認の行があれば、件数と id と、承認の画面で確かめられることを言う', async () => {
    stubDaemon([{ id: 'ap-bad', reason: '不正な欄: createdAt' }, { reason: '不正な行' }]);
    renderChat();

    const note = await screen.findByText(/読めない承認待ちが 2 件ある/);
    expect(note.textContent).toContain('id: ap-bad');
    expect(note.textContent).toContain('壊れた行であって、回答済みでも取り下げ済みでもない');
    expect(note.textContent).toContain('承認の画面');
  });

  it('読めない行が無ければ何も言わない', async () => {
    stubDaemon(undefined);
    renderChat();

    await screen.findByText('確認して');
    expect(screen.queryByText(/読めない承認待ち/)).toBeNull();
  });
});
