// @vitest-environment jsdom
import { cleanup, fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import { createMemoryRouter, RouterProvider } from 'react-router';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import { json, Providers, storeTestBaseUrl } from '~/test-support';

import Schedule from './schedule';

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

const KIND = 'morning-issues';

const entry = {
  kind: KIND,
  description: '毎日 09:00',
  nextAt: '2026-08-21T09:00:00.000Z',
  request: '元の本文',
  spec: { type: 'daily', at: '09:00' },
  createdAt: '2026-08-01T00:00:00.000Z',
  updatedAt: 'v1',
};

describe('編集中にほかで消された予定の保存（#4555）', () => {
  it('取り直した一覧から消えても、編集の枠・下書き・「ほかで消された」案内を残し、上書きで作り直せる', async () => {
    let deleted = false;
    let gets = 0;
    const posts: { ifMatch?: unknown; request?: unknown }[] = [];
    globalThis.fetch = (async (input: RequestInfo | URL, init?: RequestInit) => {
      // openapi-fetch は Request を渡すので、method は Request の側を見る
      const request = input instanceof Request ? input : new Request(input, init);
      if (request.method === 'GET') {
        gets += 1;
        return json({ entries: deleted ? [] : [entry] });
      }
      const body = (await request.json()) as { ifMatch?: unknown; request?: unknown };
      posts.push(body);
      if (posts.length === 1) {
        // 保存の時点でほかが消している（本物のデーモンは、消えた依頼を一覧に出さない）
        deleted = true;
        return json({ error: '読んだ後に変わった', current: null }, 409);
      }
      // 「自分の内容で上書きする」で作り直す
      deleted = false;
      return json({ ok: true });
    }) as typeof fetch;

    const router = createMemoryRouter([{ path: '/schedule', Component: Schedule }], {
      initialEntries: ['/schedule'],
    });
    render(
      <Providers>
        <RouterProvider router={router} />
      </Providers>,
    );

    fireEvent.click(await screen.findByRole('button', { name: `${KIND} を編集` }));
    const panel = await screen.findByRole('group', { name: `${KIND} を編集` });
    fireEvent.mouseDown(within(panel).getByRole('tab', { name: '編集' }));
    fireEvent.change(await within(panel).findByPlaceholderText(/依頼の本文/), {
      target: { value: '長く書いた下書き' },
    });
    const getsBeforeSave = gets;
    fireEvent.click(within(panel).getByRole('button', { name: '保存する' }));

    // 409 を受けて一覧を取り直し、取り直した一覧には消えた依頼が無い
    await waitFor(() => expect(deleted).toBe(true));
    await waitFor(() => expect(gets).toBeGreaterThan(getsBeforeSave));

    // 編集の枠は残り、書いた下書きも残り、「ほかで消された」と言う
    const kept = await screen.findByRole('group', { name: `${KIND} を編集` });
    expect(within(kept).getByDisplayValue('長く書いた下書き')).toBeTruthy();
    expect(within(kept).getByText(/読んだ後に、ほかで消された/)).toBeTruthy();
    // 消えた依頼の行には、消えた依頼に向かう操作（今すぐ回す・外す）を出さない
    expect(screen.queryByRole('button', { name: `${KIND} を今すぐ回す` })).toBeNull();
    expect(screen.queryByRole('button', { name: `${KIND} を外す` })).toBeNull();

    // 自分の内容で上書きすると、版を問わずに（ifMatch: null）作り直す
    fireEvent.click(within(kept).getByRole('button', { name: '自分の内容で上書きする' }));
    await waitFor(() => expect(posts).toHaveLength(2));
    expect(posts[1]?.ifMatch).toBeNull();
    expect(posts[1]?.request).toBe('長く書いた下書き');
    await waitFor(() => expect(screen.queryByRole('group', { name: `${KIND} を編集` })).toBeNull());
    expect(await screen.findByRole('button', { name: `${KIND} を今すぐ回す` })).toBeTruthy();
  });
});
