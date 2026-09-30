// @vitest-environment jsdom
/**
 * issue #2266（同じ穴）: 履歴タブの版の一覧・選んだ版の本文は、読めた後の
 * 再検証が失敗しても、読めていた中身を消さない。
 *
 * SWR は再検証が失敗しても前回の `data` を残したまま `error` を立てる。
 * `error` だけで分岐すると、一過性の失敗1回で読めていた版の一覧が
 * `ErrorNote` に差し替わる。失敗は黙って消さず、注記として残す。
 */
import { act, cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { createMemoryRouter, RouterProvider } from 'react-router';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import type { Practice, PracticeVersionSummary } from '@alteroid/logic';
import { json, Providers, stubFetch, storeTestBaseUrl } from '~/test-support';
import type { Route as FetchRoute } from '~/test-support';

import type { Route } from './+types/practice-detail';
import PracticeDetail, { clientLoader } from './practice-detail';

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

function Harness({ slug }: { slug: string }) {
  const loaderData = clientLoader({ params: { slug } } as Route.ClientLoaderArgs);
  return <PracticeDetail {...({ loaderData } as Route.ComponentProps)} />;
}

function mountDetail(slug: string, route: FetchRoute) {
  stubFetch(route);
  const router = createMemoryRouter(
    [{ path: '/practices/:slug', Component: () => <Harness slug={slug} /> }],
    { initialEntries: [`/practices/${slug}`] },
  );
  render(
    <Providers>
      <RouterProvider router={router} />
    </Providers>,
  );
}

const PRACTICE: Practice = {
  slug: 'daily-report',
  kind: '日報',
  title: '日報の書き方',
  createdAt: '2026-08-01T00:00:00.000Z',
  updatedAt: '2026-08-22T00:00:00.000Z',
  chars: 42,
  content: '# 見出し\n\n本文だよ',
};

const VERSIONS: PracticeVersionSummary[] = [
  {
    slug: PRACTICE.slug,
    version: 1,
    kind: '日報',
    title: '旧題',
    at: '2026-08-01T00:00:00.000Z',
    chars: 3,
  },
];

/** 版の一覧（`/versions`）・版1本（`/versions/1`）は、2回目から失敗する。本体は常に成功する。 */
function route(counts: { list: number; detail: number }): FetchRoute {
  return (url) => {
    if (/\/practices\/[^/]+\/versions\/\d+/.exec(url)) {
      counts.detail += 1;
      if (counts.detail >= 2) return json({ error: 'internal' }, 500);
      return json({ version: { ...VERSIONS[0], content: '# 旧本文' } });
    }
    if (url.includes(`/practices/${PRACTICE.slug}/versions`)) {
      counts.list += 1;
      if (counts.list >= 2) return json({ error: 'internal' }, 500);
      return json({ versions: VERSIONS });
    }
    if (url.includes(`/practices/${PRACTICE.slug}`)) return json({ practice: PRACTICE });
    return undefined;
  };
}

describe('履歴タブの再検証の失敗（issue #2266）', () => {
  it('版の一覧を読めた後の再検証が失敗しても、一覧は残り、失敗は alert で知らせる', async () => {
    const counts = { list: 0, detail: 0 };
    mountDetail(PRACTICE.slug, route(counts));

    fireEvent.mouseDown(await screen.findByRole('tab', { name: '履歴' }));
    expect(await screen.findByText('旧題')).toBeTruthy();

    act(() => {
      window.dispatchEvent(new Event('focus'));
    });

    await waitFor(() => expect(screen.getByRole('alert')).toBeTruthy());
    expect(counts.list).toBeGreaterThanOrEqual(2);
    expect(screen.getByText('旧題')).toBeTruthy();
  });

  it('選んだ版の本文を読めた後の再検証が失敗しても、本文は残り、失敗は alert で知らせる', async () => {
    const counts = { list: 0, detail: 0 };
    // 一覧は常に成功させ、版1本だけを2回目から失敗させる。
    const inner = route(counts);
    mountDetail(PRACTICE.slug, (url, init) => {
      if (/\/practices\/[^/]+\/versions$/.exec(url)) return json({ versions: VERSIONS });
      return inner(url, init);
    });

    fireEvent.mouseDown(await screen.findByRole('tab', { name: '履歴' }));
    fireEvent.click(await screen.findByText('旧題'));
    expect(await screen.findByText(/旧本文/)).toBeTruthy();

    act(() => {
      window.dispatchEvent(new Event('focus'));
    });

    await waitFor(() => expect(screen.getByRole('alert')).toBeTruthy());
    expect(counts.detail).toBeGreaterThanOrEqual(2);
    expect(screen.getByText(/旧本文/)).toBeTruthy();
  });
});
