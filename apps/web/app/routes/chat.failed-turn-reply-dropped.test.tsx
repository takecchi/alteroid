// @vitest-environment jsdom
import { cleanup, fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import { createMemoryRouter, RouterProvider, useParams } from 'react-router';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import { useJournalLive } from '@alteroid/swr';
import { json, Providers, sse, storeTestBaseUrl, stubFetch } from '~/test-support';

import Chat, { pendingOwnLines, type FailedTurn } from './chat';

const C = 'conv-3705';

describe('pendingOwnLines の失敗の印（#3705）', () => {
  const line = (key: string, role: 'human' | 'clone' | 'system', text: string, group?: string) => ({
    key,
    role,
    text,
    of: C,
    ...(group === undefined ? {} : { replyGroup: group }),
  });
  const note = (kind: 'failed' | 'held') => ({
    ...line(`n-${kind}`, 'clone', '知らせ'),
    turnFailure: kind,
  });
  const turn = (over: Partial<FailedTurn> = {}): ReadonlyMap<string, FailedTurn> =>
    new Map([['g1', { of: C, kind: 'failed', baseline: 0, ...over }]]);
  const lines = [
    line('r1', 'clone', '途中まで', 'g1'),
    line('u1', 'system', '枠が閉じている', 'g1'),
    line('other', 'clone', '別のターン', 'g2'),
  ];

  it('履歴に同じ種類の知らせが現れたら、そのターンの行を落とす（ほかのターンは残す）', () => {
    const pending = pendingOwnLines(lines, C, [note('failed')], turn());
    expect(pending.map((l) => l.key)).toEqual(['other']);
  });

  it('受信中（知らせがまだ履歴に無い）は見せたままにする', () => {
    expect(pendingOwnLines(lines, C, [], turn())).toHaveLength(3);
  });

  it('印を付けた時点で履歴にあった知らせは、このターンのものではない', () => {
    expect(pendingOwnLines(lines, C, [note('failed')], turn({ baseline: 1 }))).toHaveLength(3);
    expect(pendingOwnLines(lines, C, [note('failed')], turn({ baseline: undefined }))).toHaveLength(
      3,
    );
  });

  it('種類が違う知らせは引き取らない。held は held の知らせで引き取る', () => {
    expect(pendingOwnLines(lines, C, [note('held')], turn())).toHaveLength(3);
    expect(
      pendingOwnLines(lines, C, [note('held')], turn({ kind: 'held' })).map((l) => l.key),
    ).toEqual(['other']);
  });

  it('印を付けた複数のターンは、増えた知らせを1つずつ引き取る', () => {
    const two = new Map<string, FailedTurn>([
      ['g1', { of: C, kind: 'failed', baseline: 0 }],
      ['g2', { of: C, kind: 'failed', baseline: 1 }],
    ]);
    const history = [note('failed')];
    expect(pendingOwnLines(lines, C, history, two).map((l) => l.key)).toEqual(['other']);
    expect(pendingOwnLines(lines, C, [...history, note('failed')], two)).toHaveLength(0);
  });
});

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

function setUp(events: unknown[], recorded: 'failed' | 'held' = 'failed') {
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
    if (url.endsWith('/chat')) return sse(events as never, { signal: init?.signal });
    if (url.includes('/approvals')) return json({ approvals: [] });
    if (url.includes(`/conversations/${C}`)) {
      const messages = serverHas
        ? [
            Q,
            F1,
            { id: 'h2', at: at(3), role: 'inbound', text: 'q' },
            { id: 'f2', at: at(4), role: 'outbound', text: FAIL_TEXT, turnFailure: recorded },
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
const transcript = () => screen.getByRole('list', { name: 'やりとり' });

describe('失敗したターンの途中の返信は、履歴の知らせが現れたら落とす（#3705）', () => {
  it('受信中は見せたまま、履歴に知らせが載ったら落とし、「もう一度送る」は出続ける', async () => {
    const server = setUp([
      { event: 'open', data: { conversationId: C } },
      { event: 'text', data: { type: 'text', text: '途中まで' } },
      { event: 'error', data: { type: 'error', message: '失敗' } },
    ]);
    await screen.findByText('q');
    await waitFor(() => expect(retryButtons()).toHaveLength(1));
    fireEvent.click(retryButtons()[0] as HTMLElement);

    expect(await screen.findByText('途中まで')).toBeTruthy();

    server.serverRecordsFailure();
    await waitFor(() => expect(within(transcript()).queryByText('途中まで')).toBeNull());
    await waitFor(() =>
      expect(document.querySelectorAll('[data-turn-failure="failed"]')).toHaveLength(2),
    );
    expect(retryButtons()).toHaveLength(1);
  });

  it('usage_limited の行も、held の知らせが載ったら落とす', async () => {
    const server = setUp(
      [
        { event: 'open', data: { conversationId: C } },
        { event: 'usage_limited', data: { type: 'usage_limited', message: '枠が閉じている' } },
        { event: 'error', data: { type: 'error', message: '失敗' } },
      ],
      'held',
    );
    await screen.findByText('q');
    await waitFor(() => expect(retryButtons()).toHaveLength(1));
    fireEvent.click(retryButtons()[0] as HTMLElement);
    expect(await screen.findByText(/枠が閉じている/)).toBeTruthy();
    server.serverRecordsFailure();
    await waitFor(() => expect(within(transcript()).queryByText(/枠が閉じている/)).toBeNull());
    expect(document.querySelectorAll('[data-turn-failure="held"]')).toHaveLength(1);
  });
});
