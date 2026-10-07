// @vitest-environment jsdom
import { cleanup, fireEvent, render, screen, within } from '@testing-library/react';
import { createMemoryRouter, RouterProvider, useParams } from 'react-router';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import { json, Providers, storeTestBaseUrl } from '~/test-support';

import ApprovalsAnswered from './approvals-answered';

const ANSWERED = {
  id: 'a-new',
  createdAt: '2026-09-30T00:00:00.000Z',
  updatedAt: '2026-09-30T00:00:00.000Z',
  question: '夜のリリースを待つか',
  answeredAt: '2026-09-30T10:00:00.000Z',
  answer: '待たない',
  answeredVia: { kind: 'operator', auth: 'operator-token' },
  conversationId: 'conv-9',
};

const CONVERSATION = {
  id: 'conv-9',
  messages: [{ id: 'm1', role: 'outbound', text: 'クローンの発言', at: '2026-09-30T09:00:00Z' }],
};

const TRACE = {
  approval: ANSWERED,
  questionEntry: null,
  answerEntry: null,
  turnStarts: [],
  state: 'paired',
  actions: [
    {
      type: 'decision',
      id: 'j-1',
      at: '2026-09-30T11:00:01.000Z',
      decision: 'b に沿って進めた',
      grounds: '人間の答え',
      answeredApprovalId: 'a-new',
    },
  ],
  actionsOmitted: 0,
  unstampedInTurn: 0,
  scanned: 1,
  truncated: false,
};

function stubApi() {
  const state = { conversationFails: false, traceFails: false };
  globalThis.fetch = (async (input: RequestInfo | URL) => {
    const href = typeof input === 'string' ? input : input instanceof URL ? input.href : input.url;
    const url = new URL(href);
    if (url.pathname === '/approvals/answered-dates') {
      return json({ dates: [{ date: '2026-09-30', count: 1 }] });
    }
    if (url.pathname === '/approvals') {
      if (url.searchParams.get('pending') === 'true') return json({ approvals: [] });
      return json({ approvals: [ANSWERED] });
    }
    if (url.pathname === '/approvals/a-new/trace') {
      return state.traceFails ? json({ error: 'internal' }, 500) : json(TRACE);
    }
    if (url.pathname === '/conversations/conv-9') {
      return state.conversationFails ? json({ error: 'internal' }, 500) : json(CONVERSATION);
    }
    return Promise.reject(new TypeError(`Failed to fetch: ${href}`));
  }) as typeof fetch;
  return state;
}

const Page = ApprovalsAnswered as unknown as (props: {
  loaderData: { date: string | undefined; approvalId: string | undefined };
}) => React.ReactElement;

function renderDetail() {
  function Routed() {
    const { date, approvalId } = useParams();
    return <Page loaderData={{ date, approvalId }} />;
  }
  const router = createMemoryRouter(
    [
      { path: '/approvals/answered/:date?/:approvalId?', Component: Routed },
      { path: '/chat/:id', Component: () => null },
    ],
    { initialEntries: ['/approvals/answered/2026-09-30/a-new'] },
  );
  render(
    <Providers>
      <RouterProvider router={router} />
    </Providers>,
  );
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

describe('承認の詳細のパネルの取り直しの失敗', () => {
  it('会話: 一度読めた後に取り直しが失敗しても、会話は残り、注記が出る', async () => {
    const state = stubApi();
    renderDetail();
    await screen.findByText('クローンの発言');

    state.conversationFails = true;
    window.dispatchEvent(new Event('focus'));

    expect(await screen.findByText(/最新の会話を取り直せなかった/)).toBeTruthy();
    expect(screen.getByText('クローンの発言')).toBeTruthy();
  });

  it('会話: 最初から読めないときは、エラーを出す', async () => {
    const state = stubApi();
    state.conversationFails = true;
    renderDetail();

    expect(await screen.findByRole('alert')).toBeTruthy();
    expect(screen.queryByText(/最新の会話を取り直せなかった/)).toBeNull();
  });

  it('trace: 一度読めた後に取り直しが失敗しても、行動は残り、注記が出る', async () => {
    const state = stubApi();
    renderDetail();
    fireEvent.click(await screen.findByRole('button', { name: '答えの後の行動を見る' }));
    await screen.findByText(/b に沿って進めた/);

    state.traceFails = true;
    window.dispatchEvent(new Event('focus'));

    expect(await screen.findByText(/最新の行動を取り直せなかった/)).toBeTruthy();
    expect(screen.getByText(/b に沿って進めた/)).toBeTruthy();
  });

  it('trace: 最初から読めないときは、エラーを出す', async () => {
    const state = stubApi();
    state.traceFails = true;
    renderDetail();
    await screen.findByText('クローンの発言');
    fireEvent.click(screen.getByRole('button', { name: '答えの後の行動を見る' }));

    const alerts = await screen.findAllByRole('alert');
    expect(alerts.length).toBeGreaterThan(0);
    expect(screen.queryByText(/最新の行動を取り直せなかった/)).toBeNull();
    expect(within(document.body).queryByText(/b に沿って進めた/)).toBeNull();
  });
});
