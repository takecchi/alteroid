// @vitest-environment jsdom
import { act, cleanup, fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import { createMemoryRouter, RouterProvider, useParams } from 'react-router';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import type { ManagerSummary, MemoryDocument, Practice } from '@alteroid/logic';
import { gate, json, Providers, storeTestBaseUrl } from '~/test-support';

import type { Route as ManagerRoute } from './+types/manager-detail';
import type { Route as MemoryRoute } from './+types/memory-detail';
import type { Route as PracticeRoute } from './+types/practice-detail';
import ManagerDetail, { clientLoader as managerLoader } from './manager-detail';
import Managers from './managers';
import MemoryDetail, { clientLoader as memoryLoader } from './memory-detail';
import Memory from './memory';
import PracticeDetail, { clientLoader as practiceLoader } from './practice-detail';
import Practices from './practices';

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

function stubWithGatedDelete(handle: (url: string) => Response | undefined) {
  const delete_ = gate();
  let deleteSeen = false;
  globalThis.fetch = (async (input: RequestInfo | URL, init?: RequestInit) => {
    const request = input instanceof Request ? input : new Request(input, init);
    if (request.method === 'DELETE') {
      deleteSeen = true;
      await delete_.promise;
      return json({ outcome: 'stopped', detail: '止めた。' });
    }
    const response = handle(request.url);
    if (response !== undefined) return response;
    throw new TypeError(`Failed to fetch: ${request.url}`);
  }) as typeof fetch;
  return { release: delete_.open, deleteSeen: () => deleteSeen };
}

function mount(router: ReturnType<typeof createMemoryRouter>) {
  render(
    <Providers>
      <RouterProvider router={router} />
    </Providers>,
  );
  return router;
}

async function settle(router: { state: { location: { pathname: string } } }, pathname: string) {
  // 移らないことを見るので、実時間は待たずマクロタスクを何周か回す。
  await waitFor(() => expect(router.state.location.pathname).toBe(pathname));
  for (let turn = 0; turn < 20; turn += 1) {
    await act(async () => {
      await new Promise((resolve) => setTimeout(resolve, 0));
    });
  }
  expect(router.state.location.pathname).toBe(pathname);
}

function memoryDoc(slug: string): MemoryDocument {
  return {
    slug,
    title: slug,
    updatedAt: '2026-08-22T00:00:00.000Z',
    createdAt: { kind: 'unknown' },
    bytes: 42,
    frontmatter: { kind: 'none' },
    kind: 'fact',
    descriptionFreshness: { kind: 'absent' },
    content: `# ${slug}の本文`,
  };
}

describe('記憶の削除', () => {
  function setup() {
    const docs = [memoryDoc('aaa'), memoryDoc('bbb')];
    const gated = stubWithGatedDelete((url) => {
      const one = /\/memory\/(aaa|bbb)(\?|$)/.exec(url);
      if (one !== null) return json({ document: docs.find((d) => d.slug === one[1]) });
      if (url.includes('/memory')) {
        return json({ documents: docs.map((d) => ({ ...d, content: undefined })) });
      }
      return undefined;
    });
    function DetailRoute() {
      const { slug } = useParams();
      const loaderData = memoryLoader({ params: { slug } } as MemoryRoute.ClientLoaderArgs);
      return <MemoryDetail {...({ loaderData } as MemoryRoute.ComponentProps)} />;
    }
    const router = mount(
      createMemoryRouter(
        [
          {
            path: '/memory',
            Component: Memory,
            children: [{ path: ':slug', Component: DetailRoute }],
          },
        ],
        { initialEntries: ['/memory/aaa'] },
      ),
    );
    return { router, ...gated };
  }

  async function askDelete() {
    const detail = await screen.findByRole('region', { name: '記憶の中身' });
    fireEvent.click(await within(detail).findByRole('button', { name: '削除' }));
    fireEvent.click(await screen.findByRole('button', { name: '削除する' }));
  }

  it('応答待ちに別の記憶へ移ったら、成功しても移った先のまま', async () => {
    const { router, release, deleteSeen } = setup();
    await askDelete();
    await waitFor(() => expect(deleteSeen()).toBe(true));

    await router.navigate('/memory/bbb');
    expect(await screen.findByRole('heading', { level: 1, name: 'bbbの本文' })).toBeTruthy();
    release();

    await settle(router, '/memory/bbb');
  });

  it('移った先の書きかけの離れる前の確認は、古い削除が通っても壊れない', async () => {
    const { router, release, deleteSeen } = setup();
    await askDelete();
    await waitFor(() => expect(deleteSeen()).toBe(true));

    await router.navigate('/memory/bbb');
    await screen.findByRole('heading', { level: 1, name: 'bbbの本文' });
    fireEvent.mouseDown(await screen.findByRole('tab', { name: '編集' }));
    fireEvent.change(await screen.findByLabelText('本文'), { target: { value: '書きかけ' } });
    release();
    await settle(router, '/memory/bbb');

    void router.navigate('/memory');
    expect(await screen.findByRole('button', { name: '破棄して離れる' })).toBeTruthy();
    expect(router.state.location.pathname).toBe('/memory/bbb');
  });

  it('移っていなければ、成功のあと一覧へ移る', async () => {
    const { router, release, deleteSeen } = setup();
    await askDelete();
    await waitFor(() => expect(deleteSeen()).toBe(true));
    release();

    await settle(router, '/memory');
  });
});

describe('やり方の削除', () => {
  function practice(slug: string): Practice {
    return {
      slug,
      kind: 'procedure',
      title: `${slug}の手順`,
      createdAt: '2026-08-01T00:00:00.000Z',
      updatedAt: '2026-08-22T00:00:00.000Z',
      chars: 10,
      content: `# ${slug}の本文`,
    };
  }

  function setup() {
    const all = [practice('aaa'), practice('bbb')];
    const gated = stubWithGatedDelete((url) => {
      if (/\/practices\/[^/?]+\/versions/.test(url)) return json({ versions: [] });
      const one = /\/practices\/(aaa|bbb)(\?|$)/.exec(url);
      if (one !== null) return json({ practice: all.find((d) => d.slug === one[1]) });
      if (url.includes('/practices')) {
        return json({ practices: all.map((d) => ({ ...d, content: undefined })) });
      }
      return undefined;
    });
    function DetailRoute() {
      const { slug } = useParams();
      const loaderData = practiceLoader({ params: { slug } } as PracticeRoute.ClientLoaderArgs);
      return <PracticeDetail {...({ loaderData } as PracticeRoute.ComponentProps)} />;
    }
    const router = mount(
      createMemoryRouter(
        [
          {
            path: '/practices',
            Component: Practices,
            children: [{ path: ':slug', Component: DetailRoute }],
          },
        ],
        { initialEntries: ['/practices/aaa'] },
      ),
    );
    return { router, ...gated };
  }

  async function askDelete() {
    const detail = await screen.findByRole('region', { name: 'やり方の中身' });
    fireEvent.click(await within(detail).findByRole('button', { name: '削除' }));
    fireEvent.click(await screen.findByRole('button', { name: '削除する' }));
  }

  it('応答待ちに別のやり方へ移ったら、成功しても移った先のまま', async () => {
    const { router, release, deleteSeen } = setup();
    await askDelete();
    await waitFor(() => expect(deleteSeen()).toBe(true));

    await router.navigate('/practices/bbb');
    expect(await screen.findByRole('heading', { level: 1, name: 'bbbの本文' })).toBeTruthy();
    release();

    await settle(router, '/practices/bbb');
  });

  it('移っていなければ、成功のあと一覧へ移る', async () => {
    const { router, release, deleteSeen } = setup();
    await askDelete();
    await waitFor(() => expect(deleteSeen()).toBe(true));
    release();

    await settle(router, '/practices');
  });
});

describe('マネージャーの停止', () => {
  const A: ManagerSummary = {
    managerId: 'mgr-a',
    status: 'done',
    live: true,
    cwd: '/work/a',
    request: '一つ目の依頼の要旨',
    startedAt: '2026-08-16T03:00:00.000Z',
    updatedAt: '2026-08-16T03:15:00.000Z',
    waiting: [],
  };
  const B: ManagerSummary = {
    ...A,
    managerId: 'mgr-b',
    cwd: '/work/b',
    request: '二つ目の依頼の要旨',
  };

  function setup() {
    const gated = stubWithGatedDelete((url) => {
      const one = /\/managers\/(mgr-[ab])(\?|$)/.exec(url);
      if (one !== null) return json({ manager: [A, B].find((m) => m.managerId === one[1]) });
      if (url.includes('/managers')) return json({ managers: [A, B] });
      return undefined;
    });
    function DetailRoute() {
      const { id } = useParams();
      const loaderData = managerLoader({ params: { id } } as ManagerRoute.ClientLoaderArgs);
      return <ManagerDetail {...({ loaderData } as ManagerRoute.ComponentProps)} />;
    }
    const router = mount(
      createMemoryRouter(
        [
          {
            path: '/managers',
            Component: Managers,
            children: [{ path: ':id', Component: DetailRoute }],
          },
        ],
        { initialEntries: ['/managers/mgr-a'] },
      ),
    );
    return { router, ...gated };
  }

  async function askStop() {
    const detail = await screen.findByRole('region', { name: 'マネージャーの詳細' });
    fireEvent.click(await within(detail).findByRole('button', { name: '停止する' }));
    const dialog = await screen.findByRole('alertdialog');
    fireEvent.click(within(dialog).getByRole('button', { name: '停止する' }));
  }

  it('応答待ちに別のマネージャーへ移ったら、成功しても移った先のまま', async () => {
    const { router, release, deleteSeen } = setup();
    await askStop();
    await waitFor(() => expect(deleteSeen()).toBe(true));

    await router.navigate('/managers/mgr-b');
    const detail = screen.getByRole('region', { name: 'マネージャーの詳細' });
    // B の詳細が出た（A の詳細にも停止ボタンは在るので、B だけの作業ディレクトリで見分ける）。
    expect(await within(detail).findByText('/work/b')).toBeTruthy();
    release();

    await settle(router, '/managers/mgr-b');
  });

  it('移っていなければ、成功のあと一覧へ移る', async () => {
    const { router, release, deleteSeen } = setup();
    await askStop();
    await waitFor(() => expect(deleteSeen()).toBe(true));
    release();

    await settle(router, '/managers');
  });
});
