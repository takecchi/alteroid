// @vitest-environment jsdom
import { act, cleanup, render, screen, waitFor } from '@testing-library/react';
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

function stub(options: {
  found?: { approval: PendingApproval; settledOn: string | null };
  status?: number;
}) {
  const calls: string[] = [];
  globalThis.fetch = (async (input: RequestInfo | URL) => {
    const href = typeof input === 'string' ? input : input instanceof URL ? input.href : input.url;
    const url = new URL(href);
    calls.push(`${url.pathname}${url.search}`);
    if (/^\/approvals\/[^/]+$/.test(url.pathname)) {
      if (options.status !== undefined) return json({ error: 'boom' }, options.status);
      if (options.found === undefined) return json({ error: 'not found' }, 404);
      return json(options.found);
    }
    return Promise.reject(new TypeError(`Failed to fetch: ${href}`));
  }) as typeof fetch;
  return calls;
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
  it('回答済み: デーモンが返した決着の日の詳細へ replace で移る。呼ぶのは1回だけ', async () => {
    const a = approval({ answeredAt: '2026-09-30T05:00:00.000Z', answer: 'はい' });
    const calls = stub({ found: { approval: a, settledOn: '2026-09-30' } });
    const router = renderItem();

    expect((await screen.findByTestId('where')).textContent).toBe(
      '/approvals/answered/2026-09-30/a-1',
    );
    expect(router.state.historyAction).toBe('REPLACE');
    expect(calls).toEqual(['/approvals/a-1']);
  });

  it('デーモンの日が決着の UTC の日と違っても（UTC 15:00 以降は東京で翌日）、デーモンが返した日を採る', async () => {
    const a = approval({ answeredAt: '2026-09-30T20:00:00.000Z', answer: 'はい' });
    stub({ found: { approval: a, settledOn: '2026-10-01' } });
    renderItem();
    expect((await screen.findByTestId('where')).textContent).toBe(
      '/approvals/answered/2026-10-01/a-1',
    );
  });

  it('前の日（西の TZ）でも、デーモンが返した日を採る', async () => {
    const a = approval({ answeredAt: '2026-09-30T03:00:00.000Z' });
    stub({ found: { approval: a, settledOn: '2026-09-29' } });
    renderItem();
    expect((await screen.findByTestId('where')).textContent).toBe(
      '/approvals/answered/2026-09-29/a-1',
    );
  });

  it('取り下げ済み: デーモンが返した日の詳細へ移る', async () => {
    const a = approval({ withdrawnAt: '2026-09-30T05:00:00.000Z', withdrawnReason: 'x' });
    stub({ found: { approval: a, settledOn: '2026-09-30' } });
    renderItem();
    expect((await screen.findByTestId('where')).textContent).toBe(
      '/approvals/answered/2026-09-30/a-1',
    );
  });

  it('id は URL へエンコードして引き、移り先の URL にもエンコードして載せる', async () => {
    const a = approval({ id: 'a/b c', answeredAt: '2026-09-30T05:00:00.000Z' });
    const calls = stub({ found: { approval: a, settledOn: '2026-09-30' } });
    renderItem(encodeURIComponent('a/b c'));
    await screen.findByTestId('where');
    expect(calls).toEqual(['/approvals/a%2Fb%20c']);
  });

  it('未回答は未回答のページへ移る（呼ぶのは1回だけ）', async () => {
    const calls = stub({ found: { approval: approval(), settledOn: null } });
    renderItem();
    expect((await screen.findByTestId('where')).textContent).toBe('/approvals');
    expect(calls).toEqual(['/approvals/a-1']);
  });

  it('404 なら、見つからないと言い、どこへも移らない（回答済みのページへのリンクは出す）', async () => {
    stub({});
    renderItem();
    expect(await screen.findByText(/この承認は見つからなかった/)).toBeTruthy();
    expect(screen.queryByTestId('where')).toBeNull();
    expect(screen.getByRole('link', { name: '回答済みの承認へ' }).getAttribute('href')).toBe(
      '/approvals/answered',
    );
  });

  it('読めなかった（500）ときは、見つからないとは言わず、読み込めなかったと言い、どこへも移らない', async () => {
    stub({ status: 500 });
    renderItem();
    expect(await screen.findByRole('alert')).toBeTruthy();
    expect(screen.queryByText(/見つからなかった/)).toBeNull();
    expect(screen.queryByTestId('where')).toBeNull();
  });

  it('前に「未回答」で開いた承認を、別の経路で答えたあとに開き直すと、残った「未回答」で一覧へ移らず、決着した日の詳細へ移る（#4076）', async () => {
    stub({ found: { approval: approval(), settledOn: null } });
    const router = renderItem();
    expect((await screen.findByTestId('where')).textContent).toBe('/approvals');

    stub({ found: { approval: approval(), settledOn: '2026-09-30' } });
    await act(async () => {
      await router.navigate('/approvals/item/a-1');
    });

    await waitFor(() =>
      expect(screen.getByTestId('where').textContent).toBe('/approvals/answered/2026-09-30/a-1'),
    );
  });
});
