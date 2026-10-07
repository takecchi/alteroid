// @vitest-environment jsdom
import { cleanup, fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import { createMemoryRouter, RouterProvider, useParams } from 'react-router';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import { json, Providers, sse, storeTestBaseUrl, stubFetch } from '~/test-support';

import Chat from './chat';

const CONVERSATION_ID = 'conv-edit-1';

const ChatRoute = Chat as unknown as (props: {
  loaderData: { conversationId: string | undefined };
}) => React.ReactElement;

function Harness() {
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

const transcript = () => screen.getByRole('list', { name: 'やりとり' });

function conversationsListRoute(url: string) {
  if (url.includes('/approvals')) return json({ approvals: [] });
  return url.includes('/conversations') && !url.includes(`/conversations/${CONVERSATION_ID}`)
    ? json({ conversations: [], scanned: 0 })
    : undefined;
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

describe('編集の入口（鉛筆）— 制約C', () => {
  it('人間の発言には出て、クローンの発言には出ない', async () => {
    stubFetch((url) => {
      if (url.includes(`/conversations/${CONVERSATION_ID}`)) {
        return json({
          conversationId: CONVERSATION_ID,
          messages: [
            { id: 'm-human-1', at: '2026-08-20T00:00:00.000Z', role: 'inbound', text: 'やあ' },
            {
              id: 'm-clone-1',
              at: '2026-08-20T00:00:01.000Z',
              role: 'outbound',
              text: 'こんにちは',
            },
          ],
          scanned: 2,
          reachedStart: true,
          supersededCount: 0,
        });
      }
      return conversationsListRoute(url);
    });

    renderChat(`/chat/${CONVERSATION_ID}`);
    await screen.findByText('やあ');
    await screen.findByText('こんにちは');

    const humanRow = within(transcript()).getByText('やあ').closest('li');
    expect(humanRow).not.toBeNull();
    expect(
      within(humanRow as HTMLElement).getByRole('button', { name: '発言を編集' }),
    ).toBeTruthy();

    const cloneRow = within(transcript()).getByText('こんにちは').closest('li');
    expect(cloneRow).not.toBeNull();
    expect(
      within(cloneRow as HTMLElement).queryByRole('button', { name: '発言を編集' }),
    ).toBeNull();
  });

  it('サーバ未確定の楽観行（送信直後）には出ない', async () => {
    stubFetch((url, init) => {
      if (url.endsWith('/chat')) {
        return sse([{ event: 'open', data: { conversationId: CONVERSATION_ID } }], {
          signal: init?.signal,
          keepOpen: true,
        });
      }
      if (url.includes(`/conversations/${CONVERSATION_ID}`)) {
        return json({
          conversationId: CONVERSATION_ID,
          messages: [],
          scanned: 0,
          reachedStart: true,
          supersededCount: 0,
        });
      }
      return conversationsListRoute(url);
    });

    renderChat('/chat');
    const box = await screen.findByPlaceholderText(/クローンに話しかける/);
    fireEvent.change(box, { target: { value: 'たったいま送った' } });
    fireEvent.click(screen.getByRole('button', { name: 'メッセージを送信' }));

    const line = await screen.findByText('たったいま送った');
    const row = line.closest('li');
    expect(row).not.toBeNull();
    expect(within(row as HTMLElement).queryByRole('button', { name: '発言を編集' })).toBeNull();
  });
});

describe('編集して送信する', () => {
  it('確定すると supersedes 付きで POST /chat が呼ばれる', async () => {
    const stub = stubFetch((url, init) => {
      if (url.endsWith('/chat')) {
        return sse(
          [
            { event: 'open', data: { conversationId: CONVERSATION_ID } },
            { event: 'text', data: { type: 'text', text: '了解しました' } },
            { event: 'done', data: { type: 'done' } },
          ],
          { signal: init?.signal },
        );
      }
      if (url.includes(`/conversations/${CONVERSATION_ID}`)) {
        return json({
          conversationId: CONVERSATION_ID,
          messages: [
            { id: 'm1', at: '2026-08-20T00:00:00.000Z', role: 'inbound', text: '元の文' },
            { id: 'm1r', at: '2026-08-20T00:00:01.000Z', role: 'outbound', text: '了解' },
          ],
          scanned: 2,
          reachedStart: true,
          supersededCount: 0,
        });
      }
      return conversationsListRoute(url);
    });

    renderChat(`/chat/${CONVERSATION_ID}`);
    await screen.findByText('元の文');

    const row = within(transcript()).getByText('元の文').closest('li') as HTMLElement;
    fireEvent.click(within(row).getByRole('button', { name: '発言を編集' }));

    const textarea = await screen.findByRole('textbox', { name: '発言を編集する下書き' });
    expect((textarea as HTMLTextAreaElement).value).toBe('元の文');

    fireEvent.change(textarea, { target: { value: '直した文' } });
    fireEvent.keyDown(textarea, { key: 'Enter', metaKey: true });

    await waitFor(() => {
      expect(stub.entries.some((entry) => entry.url.endsWith('/chat'))).toBe(true);
    });
    const call = stub.entries.find((entry) => entry.url.endsWith('/chat'));
    const body = (await call?.request?.clone().json()) as unknown;
    expect(body).toEqual({
      text: '直した文',
      conversationId: CONVERSATION_ID,
      supersedes: 'm1',
      clientMessageId: expect.stringMatching(/^[A-Za-z0-9_-]{1,128}$/),
    });

    // やりとりの中に限って見る: 送信は会話一覧の抜粋にも即座に映り、画面全体で探すと同じ本文に二度当たるため
    expect(await within(transcript()).findByText('直した文')).toBeTruthy();
  });

  it('キャンセル（Escape）で元の表示に戻り、POST /chat は呼ばれない', async () => {
    const stub = stubFetch((url) => {
      if (url.includes(`/conversations/${CONVERSATION_ID}`)) {
        return json({
          conversationId: CONVERSATION_ID,
          messages: [{ id: 'm1', at: '2026-08-20T00:00:00.000Z', role: 'inbound', text: '元の文' }],
          scanned: 1,
          reachedStart: true,
          supersededCount: 0,
        });
      }
      return conversationsListRoute(url);
    });

    renderChat(`/chat/${CONVERSATION_ID}`);
    await screen.findByText('元の文');

    const row = within(transcript()).getByText('元の文').closest('li') as HTMLElement;
    fireEvent.click(within(row).getByRole('button', { name: '発言を編集' }));

    const textarea = await screen.findByRole('textbox', { name: '発言を編集する下書き' });
    fireEvent.change(textarea, { target: { value: '書きかけの文' } });
    fireEvent.keyDown(textarea, { key: 'Escape' });

    expect(screen.queryByRole('textbox', { name: '発言を編集する下書き' })).toBeNull();
    expect(await screen.findByText('元の文')).toBeTruthy();
    expect(stub.entries.some((entry) => entry.url.endsWith('/chat'))).toBe(false);

    fireEvent.click(within(row).getByRole('button', { name: '発言を編集（書きかけあり）' }));
    const secondTextarea = await screen.findByRole('textbox', { name: '発言を編集する下書き' });
    expect((secondTextarea as HTMLTextAreaElement).value).toBe('書きかけの文');
    fireEvent.change(secondTextarea, { target: { value: 'また書きかけ' } });
    fireEvent.click(screen.getByRole('button', { name: 'キャンセル' }));

    expect(screen.queryByRole('textbox', { name: '発言を編集する下書き' })).toBeNull();
    expect(await screen.findByText('元の文')).toBeTruthy();
    expect(stub.entries.some((entry) => entry.url.endsWith('/chat'))).toBe(false);
  });
});

describe('版の切り替え（ChatGPT 風の < N/N >）', () => {
  // サーバの畳み込み規則を Web 側で再現しない: chat.tsx 側は supersedes / supersededBy を束ねるだけのため
  it('前の版へ戻ると、畳まれた発言（旧本文とその応答）が読める', async () => {
    stubFetch((url) => {
      if (url.includes(`/conversations/${CONVERSATION_ID}`)) {
        return json({
          conversationId: CONVERSATION_ID,
          messages: [
            {
              id: 'm1',
              at: '2026-08-20T00:00:00.000Z',
              role: 'inbound',
              text: '元の質問',
              supersededBy: 'm2',
            },
            {
              id: 'm1r',
              at: '2026-08-20T00:00:01.000Z',
              role: 'outbound',
              text: '元の答え',
              supersededBy: 'm2',
            },
            {
              id: 'm2',
              at: '2026-08-20T00:00:02.000Z',
              role: 'inbound',
              text: '直した質問',
              supersedes: 'm1',
            },
            {
              id: 'm2r',
              at: '2026-08-20T00:00:03.000Z',
              role: 'outbound',
              text: '直した答え',
            },
          ],
          scanned: 4,
          reachedStart: true,
          supersededCount: 2,
        });
      }
      return conversationsListRoute(url);
    });

    renderChat(`/chat/${CONVERSATION_ID}`);

    await screen.findByText('直した質問');
    await screen.findByText('直した答え');
    expect(screen.queryByText('元の質問')).toBeNull();
    expect(screen.queryByText('元の答え')).toBeNull();

    await screen.findByText('2/2');

    fireEvent.click(screen.getByRole('button', { name: '前の版へ' }));

    expect(await screen.findByText('1/2')).toBeTruthy();
    expect(await screen.findByText('元の質問')).toBeTruthy();
    expect(await screen.findByText(/元の答え/)).toBeTruthy();
    expect(screen.queryByText('直した質問')).toBeNull();

    fireEvent.click(screen.getByRole('button', { name: '次の版へ' }));

    expect(await screen.findByText('2/2')).toBeTruthy();
    expect(await screen.findByText('直した質問')).toBeTruthy();
    expect(screen.queryByText('元の質問')).toBeNull();
  });
});
