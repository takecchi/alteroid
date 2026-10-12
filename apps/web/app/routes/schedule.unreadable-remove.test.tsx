// @vitest-environment jsdom
import { cleanup, fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import { createMemoryRouter, RouterProvider } from 'react-router';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import { json, Providers, storeTestBaseUrl } from '~/test-support';

import { fixHomeClock, renderHome } from './dashboard-test-helpers';
import Schedule from './schedule';

fixHomeClock();

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

interface Unreadable {
  kind?: string;
  reason: string;
}

// 共有の stubFetch を使わない: openapi-fetch は fetch(new Request(...)) の形で呼ぶので init が undefined になり、method を落とすため
// DELETE が通った後の一覧は、その kind の読めない行を返さない: 本物のデーモンの形（行が消えるので一覧から消える）
function stubSchedule(unreadableAtStart: Unreadable[], opts: { deleteStatus?: number } = {}) {
  let unreadable = [...unreadableAtStart];
  const requests: { method: string; path: string }[] = [];
  globalThis.fetch = (async (input: RequestInfo | URL, init?: RequestInit) => {
    const request = input instanceof Request ? input : new Request(input, init);
    const path = new URL(request.url).pathname;
    requests.push({ method: request.method, path });
    if (request.method === 'DELETE') {
      if (opts.deleteStatus !== undefined && opts.deleteStatus !== 200) {
        return json({ error: '外せなかった' }, opts.deleteStatus);
      }
      const kind = decodeURIComponent(path.split('/').pop() ?? '');
      unreadable = unreadable.filter((row) => row.kind !== kind);
      return json({ ok: true });
    }
    if (path.endsWith('/schedule')) {
      return json({ entries: [], ...(unreadable.length > 0 ? { unreadable } : {}) });
    }
    return json({});
  }) as typeof fetch;
  return requests;
}

function mount() {
  const router = createMemoryRouter([{ path: '/', Component: Schedule }], {
    initialEntries: ['/'],
  });
  render(
    <Providers>
      <RouterProvider router={router} />
    </Providers>,
  );
}

const BROKEN = { kind: 'broken-1', reason: '不正な欄: spec' };

describe('/schedule 画面: 読めない継続中の依頼を画面から外せる（#4561）', () => {
  it('kind が取れる読めない依頼ごとに「外す」ボタンが出る', async () => {
    stubSchedule([BROKEN, { kind: 'broken-2', reason: '不正な欄: request' }]);
    mount();

    expect(
      await screen.findByRole('button', { name: '読めない依頼 broken-1 を外す' }),
    ).toBeTruthy();
    expect(screen.getByRole('button', { name: '読めない依頼 broken-2 を外す' })).toBeTruthy();
  });

  it('押して確認すると DELETE /schedule/<kind> が出て、一覧から消え、注記とボタンも消える', async () => {
    const requests = stubSchedule([BROKEN]);
    mount();

    fireEvent.click(await screen.findByRole('button', { name: '読めない依頼 broken-1 を外す' }));
    const dialog = await screen.findByRole('alertdialog');
    expect(
      within(dialog).getByText(
        '読めない形で入っている依頼「broken-1」を外しますか。中身は読めないまま消え、元に戻せません。',
      ),
    ).toBeTruthy();
    // 確認の前は何も送らない
    expect(requests.filter((r) => r.method === 'DELETE')).toEqual([]);

    fireEvent.click(within(dialog).getByRole('button', { name: '外す' }));

    await waitFor(() =>
      expect(requests.filter((r) => r.method === 'DELETE')).toEqual([
        { method: 'DELETE', path: '/schedule/broken-1' },
      ]),
    );
    await waitFor(() => expect(screen.queryByText(/読めない継続中の依頼/)).toBeNull());
    expect(screen.queryByRole('button', { name: '読めない依頼 broken-1 を外す' })).toBeNull();
  });

  it('確認でやめれば DELETE は出ない', async () => {
    const requests = stubSchedule([BROKEN]);
    mount();

    fireEvent.click(await screen.findByRole('button', { name: '読めない依頼 broken-1 を外す' }));
    const dialog = await screen.findByRole('alertdialog');
    fireEvent.click(within(dialog).getByRole('button', { name: 'やめる' }));

    await waitFor(() => expect(screen.queryByRole('alertdialog')).toBeNull());
    expect(requests.filter((r) => r.method === 'DELETE')).toEqual([]);
    expect(screen.getByText(/読めない継続中の依頼が 1 件ある/)).toBeTruthy();
  });

  it('外せなかったら失敗を画面へ出し、注記とボタンは残る', async () => {
    stubSchedule([BROKEN], { deleteStatus: 500 });
    mount();

    fireEvent.click(await screen.findByRole('button', { name: '読めない依頼 broken-1 を外す' }));
    const dialog = await screen.findByRole('alertdialog');
    fireEvent.click(within(dialog).getByRole('button', { name: '外す' }));

    expect(await screen.findByText(/外せなかった/)).toBeTruthy();
    expect(screen.getByRole('button', { name: '読めない依頼 broken-1 を外す' })).toBeTruthy();
    expect(screen.getByText(/読めない継続中の依頼が 1 件ある/)).toBeTruthy();
  });

  it('kind が取れない読めない行には「外す」ボタンを出さない（注記は出る）', async () => {
    stubSchedule([{ reason: '不正な行' }]);
    mount();

    expect(await screen.findByText(/読めない継続中の依頼が 1 件ある/)).toBeTruthy();
    expect(screen.queryByRole('button', { name: /読めない依頼 .* を外す/ })).toBeNull();
  });
});

describe('ホームのタイル: 読めない継続中の依頼の注記に操作は出ない', () => {
  it('注記は出るが、外すボタンは出ない', async () => {
    renderHome({ schedule: { entries: [], unreadable: [BROKEN] } });

    expect(await screen.findByText(/読めない継続中の依頼が 1 件ある/)).toBeTruthy();
    expect(screen.queryByRole('button', { name: /を外す/ })).toBeNull();
  });
});
