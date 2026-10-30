// @vitest-environment jsdom
import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { createMemoryRouter, RouterProvider, useParams } from 'react-router';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import { useJournalLive } from '@alteroid/swr';
import { json, Providers, sse, storeTestBaseUrl, stubFetch } from '~/test-support';

import Chat from './chat';

const C = 'conv-5859';

const ChatRoute = Chat as unknown as (props: {
  loaderData: { conversationId: string | undefined };
}) => React.ReactElement;

function Harness() {
  useJournalLive();
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

const FAIL_TEXT = 'この発言には返事を作れませんでした。';
const at = (n: number) => `2026-10-06T00:00:0${n}.000Z`;
const Q = { id: 'h1', at: at(0), role: 'inbound', text: 'q' };
const F1 = { id: 'f1', at: at(1), role: 'outbound', text: FAIL_TEXT, turnFailure: 'failed' };

function setUp(chatResponse: (signal: AbortSignal | null | undefined) => Response) {
  let serverHas = false;
  let release: () => void = () => {};
  const released = new Promise<void>((resolve) => {
    release = resolve;
  });
  stubFetch((url, init) => {
    if (url.endsWith('/journal/stream')) {
      return sse(
        [
          { event: 'open', data: { ok: true } },
          {
            event: 'exchange',
            data: {
              type: 'exchange',
              id: 'evt-1',
              at: at(5),
              with: 'human',
              role: 'inbound',
              text: 'q',
              conversationId: C,
            },
            after: released,
          },
        ],
        { keepOpen: true, signal: init?.signal },
      );
    }
    if (url.endsWith('/chat')) return chatResponse(init?.signal);
    if (url.includes('/approvals')) return json({ approvals: [] });
    if (url.includes(`/conversations/${C}`)) {
      const messages = serverHas
        ? [
            Q,
            F1,
            { id: 'h2', at: at(3), role: 'inbound', text: 'q' },
            { id: 'f2', at: at(4), role: 'outbound', text: FAIL_TEXT, turnFailure: 'failed' },
          ]
        : [Q, F1];
      return json({ conversationId: C, messages, scanned: messages.length, reachedStart: true });
    }
    if (url.includes('/conversations')) return json({ conversations: [], scanned: 0 });
    return undefined;
  });
  const router = createMemoryRouter([{ path: '/chat/:conversationId', Component: Harness }], {
    initialEntries: [`/chat/${C}`],
  });
  render(
    <Providers>
      <RouterProvider router={router} />
    </Providers>,
  );
  return {
    serverRecordsFailure: () => {
      serverHas = true;
      release();
    },
  };
}

const retryButtons = () => screen.queryAllByRole('button', { name: 'もう一度送る' });
const historyFailures = () => document.querySelectorAll('[data-turn-failure="failed"]');
// 入力欄の上の帯: 履歴の失敗の行（li）の外にある alert
const composerBands = () =>
  screen
    .queryAllByRole('alert')
    .filter((element) => element.closest('[data-turn-failure]') === null);

describe('履歴に同じ失敗が載ったら、入力欄の上の失敗の帯は畳む（#5859）', () => {
  it('履歴に載る前は帯を出し、載ったら帯が消えて失敗の枠が1つになる（もう一度送るは履歴に残る）', async () => {
    const server = setUp((signal) =>
      sse(
        [
          { event: 'open', data: { conversationId: C } },
          { event: 'error', data: { type: 'error', message: '失敗', kind: 'other' } },
        ],
        { signal },
      ),
    );
    await screen.findByText('q');
    await waitFor(() => expect(retryButtons()).toHaveLength(1));
    fireEvent.click(retryButtons()[0] as HTMLElement);

    await waitFor(() => expect(composerBands()).toHaveLength(1));
    expect(historyFailures()).toHaveLength(1);

    server.serverRecordsFailure();
    await waitFor(() => expect(historyFailures()).toHaveLength(2));
    await waitFor(() => expect(composerBands()).toHaveLength(0));
    expect(retryButtons()).toHaveLength(1);
  });

  it('TurnFailedError でない失敗（送れなかった）は、履歴に失敗の行があっても畳まない', async () => {
    setUp(() => json({ error: 'こわれた' }, 500));
    await screen.findByText('q');
    await waitFor(() => expect(retryButtons()).toHaveLength(1));
    fireEvent.click(retryButtons()[0] as HTMLElement);

    await waitFor(() => expect(composerBands()).toHaveLength(1));
    expect(composerBands()[0]?.textContent).toContain('こわれた');
    expect(historyFailures()).toHaveLength(1);
  });
});
