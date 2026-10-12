// @vitest-environment jsdom
import { cleanup, fireEvent, render, screen } from '@testing-library/react';
import { createMemoryRouter, Link, RouterProvider } from 'react-router';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import type { Practice, PracticeVersionSummary } from '@alteroid/logic';
import { json, Providers, storeTestBaseUrl } from '~/test-support';

import type { Route } from './+types/practice-detail';
import PracticeDetail, { clientLoader } from './practice-detail';

const KEY = `ghp_${'a1B2c3D4e5'.repeat(4)}`;

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
  return (
    <>
      <Link to="/practices">やり方</Link>
      <PracticeDetail {...({ loaderData } as Route.ComponentProps)} />
    </>
  );
}

const V1 = 'a'.repeat(64);
const V2 = 'b'.repeat(64);

const PRACTICE: Practice = {
  slug: 'daily-report',
  kind: '日報',
  title: '日報の書き方',
  createdAt: '2026-08-01T00:00:00.000Z',
  updatedAt: '2026-08-22T00:00:00.000Z',
  chars: 42,
  content: '# 見出し\n\n本文だよ',
};

const CLONE: Practice = {
  ...PRACTICE,
  title: `クローンの題 GH_TOKEN=${KEY} 題の終わり`,
  content: `クローンが書いた本文 GH_TOKEN=${KEY} 以上`,
  updatedAt: '2026-08-22T02:00:00.000Z',
};

const VERSIONS: PracticeVersionSummary[] = [
  {
    slug: PRACTICE.slug,
    version: 1,
    kind: '日報',
    title: `旧題 GH_TOKEN=${KEY} 旧題の終わり`,
    at: '2026-08-01T00:00:00.000Z',
    chars: 3,
  },
];

function mount(respond: (request: Request) => Response | undefined) {
  globalThis.fetch = (async (input: RequestInfo | URL, init?: RequestInit) => {
    const request = input instanceof Request ? input : new Request(input, init);
    const versionMatch = /\/practices\/[^/]+\/versions\/(\d+)/.exec(request.url);
    if (versionMatch) {
      const summary = VERSIONS.find((v) => v.version === Number(versionMatch[1]));
      return summary === undefined
        ? json({ error: 'not found' }, 404)
        : json({ version: { ...summary, content: '# 旧本文' } });
    }
    if (request.url.includes('/versions')) return json({ versions: VERSIONS });
    if (!request.url.includes('/practices/daily-report')) {
      return Promise.reject(new TypeError(`Failed to fetch: ${request.url}`));
    }
    return respond(request) ?? json({ practice: PRACTICE, version: V1 });
  }) as typeof fetch;
  const router = createMemoryRouter(
    [
      { path: '/practices/:slug', Component: () => <Harness slug="daily-report" /> },
      { path: '/practices', Component: () => null },
    ],
    { initialEntries: ['/practices/daily-report'] },
  );
  render(
    <Providers>
      <RouterProvider router={router} />
    </Providers>,
  );
}

describe('/practices/:slug — 題と本文の表示は鍵を伏せる', () => {
  it('保存の 409 で見せる題と本文に鍵が出ず、地の文は残る。編集欄の下書きは生のまま', async () => {
    mount((request) =>
      request.method === 'PUT'
        ? json(
            {
              error: 'やり方が読んだ後に変わっています（書き換えていません）',
              current: { practice: CLONE, version: V2 },
            },
            409,
          )
        : undefined,
    );

    fireEvent.mouseDown(await screen.findByRole('tab', { name: '編集' }));
    fireEvent.change(await screen.findByLabelText('本文'), { target: { value: '人間の書きかけ' } });
    fireEvent.click(screen.getByRole('button', { name: '保存する' }));

    const alert = await screen.findByRole('alert');
    expect(alert.textContent).toContain('クローンの題');
    expect(alert.textContent).toContain('題の終わり');
    expect(alert.textContent).toContain('クローンが書いた本文');
    expect(alert.textContent).toContain('以上');
    expect(alert.textContent).not.toContain(KEY);
    expect((screen.getByLabelText('本文') as HTMLTextAreaElement).value).toBe('人間の書きかけ');
  });

  it('削除の 409 で見せる題と本文に鍵が出ず、地の文は残る', async () => {
    mount((request) =>
      request.method === 'DELETE'
        ? json(
            {
              error: 'やり方が読んだ後に変わっています（消していません）',
              current: { practice: CLONE, version: V2 },
            },
            409,
          )
        : undefined,
    );

    await screen.findByRole('heading', { name: 'daily-report' });
    fireEvent.click(await screen.findByRole('button', { name: '削除' }));
    fireEvent.click(await screen.findByRole('button', { name: '削除する' }));

    const alert = await screen.findByRole('alert');
    expect(alert.textContent).toContain('クローンの題');
    expect(alert.textContent).toContain('題の終わり');
    expect(alert.textContent).toContain('クローンが書いた本文');
    expect(alert.textContent).toContain('以上');
    expect(alert.textContent).not.toContain(KEY);
  });

  it('プレビューの題に鍵が出ず、地の文は残る', async () => {
    mount(() => undefined);

    fireEvent.mouseDown(await screen.findByRole('tab', { name: '編集' }));
    fireEvent.change(await screen.findByLabelText('題'), {
      target: { value: `書きかけの題 GH_TOKEN=${KEY} 題の終わり` },
    });
    fireEvent.mouseDown(screen.getByRole('tab', { name: 'プレビュー' }));

    const title = await screen.findByText(/書きかけの題/);
    expect(title.textContent).toContain('題の終わり');
    expect(title.textContent).not.toContain(KEY);
  });

  it('版の履歴の一覧と、選んだ版の題に鍵が出ず、地の文は残る', async () => {
    mount(() => undefined);

    fireEvent.mouseDown(await screen.findByRole('tab', { name: '履歴' }));
    const listed = await screen.findByText(/旧題/);
    expect(listed.textContent).toContain('旧題の終わり');
    expect(listed.textContent).not.toContain(KEY);

    fireEvent.click(listed);
    await screen.findByText(/旧本文/);
    const heads = screen.getAllByText(/旧題/);
    expect(heads.length).toBeGreaterThanOrEqual(2);
    for (const head of heads) {
      expect(head.textContent).toContain('旧題の終わり');
      expect(head.textContent).not.toContain(KEY);
    }
  });
});
