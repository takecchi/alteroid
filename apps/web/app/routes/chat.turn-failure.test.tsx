// @vitest-environment jsdom
/**
 * 失敗したターンの見せ方（送信失敗）。
 *
 * - サーバが付けた `turnFailure` の印で、返信とは別の部品（エラーの見た目）で描く
 *   （文面は見ない）
 * - 「もう一度送る」は、いちばん後ろの失敗で、すぐ前が自分の発言のときだけ出し、
 *   押すと同じ発言を既存の送信経路（`POST /chat`）で送り直す
 * - 入力欄の上の帯は、ストリームの失敗を利用者向けの文で言い、生の文は「詳細」に畳む
 */
import { cleanup, fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import { createMemoryRouter, RouterProvider, useParams } from 'react-router';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import { json, Providers, sse, storeTestBaseUrl, stubFetch, type Route } from '~/test-support';

import Chat from './chat';

const CONVERSATION = 'conv-turn-failure';
const FAILURE_TEXT = 'この発言には返せなかった（ターンが失敗した）。失敗の理由は日誌に残してある。';

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
      { path: '/tokens', Component: () => <p>認証トークンの画面</p> },
    ],
    { initialEntries: [initial] },
  );
  return render(
    <Providers>
      <RouterProvider router={router} />
    </Providers>,
  );
}

type Message = {
  id: string;
  at: string;
  role: 'inbound' | 'outbound';
  text: string;
  turnFailure?: 'failed' | 'held';
};

function routes(messages: Message[], onChat?: () => Response): Route {
  return (url) => {
    if (url.includes(`/conversations/${CONVERSATION}`)) {
      return json({
        conversationId: CONVERSATION,
        messages,
        scanned: messages.length,
        reachedStart: true,
      });
    }
    if (url.includes('/approvals')) return json({ approvals: [] });
    if (url.includes('/conversations')) return json({ conversations: [], scanned: 0 });
    if (url.endsWith('/chat') && onChat !== undefined) return onChat();
    return undefined;
  };
}

const HUMAN: Message = {
  id: 'h1',
  at: '2026-10-05T00:00:00.000Z',
  role: 'inbound',
  text: '来週の登壇資料を作って',
};
const FAILED: Message = {
  id: 'f1',
  at: '2026-10-05T00:00:01.000Z',
  role: 'outbound',
  text: FAILURE_TEXT,
  turnFailure: 'failed',
};

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

describe('失敗したターンの行', () => {
  it('印のある行は返信ではなくエラーとして描き、「もう一度送る」で同じ発言を送り直す', async () => {
    const stub = stubFetch(
      routes([HUMAN, FAILED], () =>
        sse([
          { event: 'open', data: { conversationId: CONVERSATION } },
          { event: 'done', data: { type: 'done' } },
        ]),
      ),
    );
    renderChat(`/chat/${CONVERSATION}`);

    const list = await screen.findByRole('list', { name: 'やりとり' });
    const failure = await waitFor(() => {
      const el = list.querySelector('[data-turn-failure="failed"]');
      if (el === null) throw new Error('まだ出ていない');
      return el as HTMLElement;
    });
    expect(within(failure).getByText('この発言には返事を作れませんでした。')).toBeTruthy();

    fireEvent.click(within(failure).getByRole('button', { name: 'もう一度送る' }));
    await waitFor(() =>
      expect(
        stub.entries.some(
          (entry) => entry.url.endsWith('/chat') && entry.request?.method === 'POST',
        ),
      ).toBe(true),
    );
    const call = stub.entries.find((entry) => entry.url.endsWith('/chat'));
    expect(await call?.request?.clone().json()).toMatchObject({
      text: '来週の登壇資料を作って',
      conversationId: CONVERSATION,
    });
  });

  it('文面が同じでも印が無い行は、普通の返答として描く（再送も出さない）', async () => {
    stubFetch(routes([HUMAN, { ...FAILED, turnFailure: undefined }]));
    renderChat(`/chat/${CONVERSATION}`);
    expect(await screen.findByText(FAILURE_TEXT)).toBeTruthy();
    expect(document.querySelector('[data-turn-failure]')).toBeNull();
    expect(screen.queryByRole('button', { name: 'もう一度送る' })).toBeNull();
  });

  it('いちばん後ろの失敗でなければ（後ろに発言が続く）再送は出さない', async () => {
    stubFetch(
      routes([
        HUMAN,
        FAILED,
        { id: 'h2', at: '2026-10-05T00:00:02.000Z', role: 'inbound', text: '続き' },
      ]),
    );
    renderChat(`/chat/${CONVERSATION}`);
    await waitFor(() =>
      expect(document.querySelector('[data-turn-failure="failed"]')).not.toBeNull(),
    );
    expect(screen.queryByRole('button', { name: 'もう一度送る' })).toBeNull();
  });

  it('保持（held）の行は再送を出さない', async () => {
    stubFetch(
      routes([HUMAN, { ...FAILED, text: 'いま利用上限に当たっている。', turnFailure: 'held' }]),
    );
    renderChat(`/chat/${CONVERSATION}`);
    await waitFor(() =>
      expect(document.querySelector('[data-turn-failure="held"]')).not.toBeNull(),
    );
    expect(screen.queryByRole('button', { name: 'もう一度送る' })).toBeNull();
  });
});

describe('入力欄の上の帯', () => {
  it('認証切れは利用者向けの文と認証トークンへの導線を出し、生の文は詳細に畳む', async () => {
    stubFetch(
      routes([], () =>
        sse([
          { event: 'open', data: { conversationId: CONVERSATION } },
          {
            event: 'error',
            data: {
              type: 'error',
              message:
                '結果なしで終了: success（result_is_error） / Not logged in · Please run /login',
            },
          },
        ]),
      ),
    );
    renderChat(`/chat/${CONVERSATION}`);
    const box = await screen.findByPlaceholderText(/クローンに話しかける/);
    fireEvent.change(box, { target: { value: 'こんにちは' } });
    fireEvent.click(screen.getByRole('button', { name: 'メッセージを送信' }));

    expect(
      await screen.findByText(/クローンの認証が通らず、返事を作れませんでした。/),
    ).toBeTruthy();
    expect(
      screen.getByRole('link', { name: '認証トークンの画面を開く' }).getAttribute('href'),
    ).toBe('/tokens');
    const details = screen.getByText('詳細').closest('details');
    expect(details?.open).toBe(false);
    expect(details?.textContent).toContain('result_is_error');
  });
});
