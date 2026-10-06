// @vitest-environment jsdom
/**
 * 日付なしの入口（`/approvals/item/:approvalId`）。回答済みの詳細の日付はデーモンの `localDate()` で
 * 決まるので、ブラウザは決着の日時の前後1日を `answeredOn` で引き、その承認を返した日を採る。
 */
import { cleanup, render, screen } from '@testing-library/react';
import { createMemoryRouter, RouterProvider, useLocation, useParams } from 'react-router';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import type { PendingApproval } from '@alteroid/logic';
import { json, Providers, storeTestBaseUrl } from '~/test-support';

import ApprovalsItem from './approvals-item';

const Page = ApprovalsItem as unknown as (props: {
  loaderData: { approvalId: string | undefined };
}) => React.ReactElement;

function approval(over: Partial<PendingApproval> = {}): PendingApproval {
  return {
    id: 'a-1',
    createdAt: '2026-09-30T00:00:00.000Z',
    updatedAt: '2026-09-30T00:00:00.000Z',
    question: '本番に出してよいか',
    ...over,
  };
}

/** `days`: デーモンが「その日に決着した」と答える承認。`trace` が無ければ 404。 */
function stub(options: { trace?: PendingApproval; days?: Record<string, PendingApproval[]> }) {
  const asked: string[] = [];
  globalThis.fetch = (async (input: RequestInfo | URL) => {
    const href = typeof input === 'string' ? input : input instanceof URL ? input.href : input.url;
    const url = new URL(href);
    if (/^\/approvals\/[^/]+\/trace$/.test(url.pathname)) {
      if (options.trace === undefined) return json({ error: 'not found' }, 404);
      return json({
        approval: options.trace,
        state: 'paired',
        questionEntry: null,
        answerEntry: null,
        turnStarts: [],
        actions: [],
        actionsOmitted: 0,
        unstampedInTurn: 0,
        scanned: 0,
        truncated: false,
      });
    }
    if (url.pathname === '/approvals') {
      const date = url.searchParams.get('answeredOn') ?? '';
      asked.push(date);
      return json({ approvals: options.days?.[date] ?? [] });
    }
    return Promise.reject(new TypeError(`Failed to fetch: ${href}`));
  }) as typeof fetch;
  return asked;
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

function Where() {
  const location = useLocation();
  return <p data-testid="where">{location.pathname}</p>;
}

function renderItem(id = 'a-1') {
  function Routed() {
    const { approvalId } = useParams();
    return <Page loaderData={{ approvalId }} />;
  }
  const router = createMemoryRouter(
    [
      { path: '/approvals/item/:approvalId', Component: Routed },
      { path: '/approvals', Component: Where },
      { path: '/approvals/answered', Component: Where },
      { path: '/approvals/answered/:date/:approvalId', Component: Where },
    ],
    { initialEntries: [`/approvals/item/${id}`] },
  );
  render(
    <Providers>
      <RouterProvider router={router} />
    </Providers>,
  );
  return router;
}

describe('日付なしの入口', () => {
  it('回答済み: デーモンがその承認を返した日の詳細へ replace で移る', async () => {
    const a = approval({ answeredAt: '2026-09-30T05:00:00.000Z', answer: 'はい' });
    stub({ trace: a, days: { '2026-09-30': [a] } });
    const router = renderItem();

    expect((await screen.findByTestId('where')).textContent).toBe(
      '/approvals/answered/2026-09-30/a-1',
    );
    // replace: 入口を履歴に残さない（戻るで入口に戻って、また移るのを繰り返さない）
    expect(router.state.historyAction).toBe('REPLACE');
  });

  it('デーモンの日が決着の UTC の日と違っても（UTC 15:00 以降は東京で翌日）、デーモンが返した日を採る', async () => {
    const a = approval({ answeredAt: '2026-09-30T20:00:00.000Z', answer: 'はい' });
    stub({ trace: a, days: { '2026-10-01': [a] } });
    renderItem();
    expect((await screen.findByTestId('where')).textContent).toBe(
      '/approvals/answered/2026-10-01/a-1',
    );
  });

  it('前の日（西の TZ）でも見つける', async () => {
    const a = approval({ answeredAt: '2026-09-30T03:00:00.000Z' });
    stub({ trace: a, days: { '2026-09-29': [a] } });
    renderItem();
    expect((await screen.findByTestId('where')).textContent).toBe(
      '/approvals/answered/2026-09-29/a-1',
    );
  });

  it('取り下げ済みは withdrawnAt の日を探す', async () => {
    const a = approval({ withdrawnAt: '2026-09-30T05:00:00.000Z', withdrawnReason: 'x' });
    const asked = stub({ trace: a, days: { '2026-09-30': [a] } });
    renderItem();
    expect((await screen.findByTestId('where')).textContent).toBe(
      '/approvals/answered/2026-09-30/a-1',
    );
    expect(asked).toContain('2026-09-30');
  });

  it('未回答は未回答のページへ移る（日付は引かない）', async () => {
    const asked = stub({ trace: approval() });
    renderItem();
    expect((await screen.findByTestId('where')).textContent).toBe('/approvals');
    expect(asked).toEqual([]);
  });

  it('どの日にも見つからなければ、日を推測せず、特定できなかったと言う', async () => {
    const a = approval({ answeredAt: '2026-09-30T05:00:00.000Z' });
    stub({ trace: a, days: {} });
    renderItem();
    expect(await screen.findByText(/決着した日を特定できなかった/)).toBeTruthy();
    expect(screen.queryByTestId('where')).toBeNull();
    expect(screen.getByRole('link', { name: '回答済みの承認へ' }).getAttribute('href')).toBe(
      '/approvals/answered',
    );
  });

  it('承認が引けなければ（404）、エラーを出し、どこへも移らない', async () => {
    stub({});
    renderItem();
    expect(await screen.findByRole('alert')).toBeTruthy();
    expect(screen.queryByTestId('where')).toBeNull();
  });
});
