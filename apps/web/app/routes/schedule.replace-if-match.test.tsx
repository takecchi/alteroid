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

const KIND = 'morning';

function entryOf(request: string, updatedAt: string) {
  return {
    kind: KIND,
    description: '毎日 09:00',
    nextAt: '2026-08-21T09:00:00.000Z',
    request,
    spec: { type: 'daily', at: '09:00' },
    createdAt: '2026-08-01T00:00:00.000Z',
    updatedAt,
  };
}

// 共有の stubFetch を使わない: openapi-fetch は fetch(new Request(...)) の形で呼ぶので init が undefined になり、本文が落ちるため
// 一覧は人間が見た版（v1）を返し続ける。デーモンの側では、クローンが既に v2 へ書き換えている。
// 本物のデーモンと同じく、ifMatch を省くと後勝ちで置き換え、版が今と違えば 409 と current を返す
function stubChangedAfterRead() {
  const posts: { request: string; ifMatch: string | null | undefined }[] = [];
  globalThis.fetch = (async (input: RequestInfo | URL, init?: RequestInit) => {
    const request = input instanceof Request ? input : new Request(input, init);
    if (request.method === 'GET') return json({ entries: [entryOf('一覧で見た本文', 'v1')] });
    const body = (await request.json()) as { request: string; ifMatch?: string | null };
    posts.push({ request: body.request, ifMatch: body.ifMatch });
    if (body.ifMatch !== undefined && body.ifMatch !== 'v2') {
      return json(
        { error: '読んだ後に変わった', current: entryOf('クローンが書き換えた本文', 'v2') },
        409,
      );
    }
    return json({ ok: true });
  }) as typeof fetch;
  return posts;
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

describe('一覧に在る名前の予定を新規の欄から置き換えるときも、見た版を送る（#4580）', () => {
  it('一覧で見た版（v1）を前提に置き換え、その後に書き換えられていれば黙って上書きせず確かめ直す', async () => {
    const posts = stubChangedAfterRead();
    mount();
    expect(await screen.findByText('一覧で見た本文')).toBeTruthy();

    fireEvent.change(await screen.findByLabelText(/依頼の名前/), { target: { value: KIND } });
    fireEvent.change(screen.getByLabelText('依頼の本文'), { target: { value: '人間の本文' } });
    fireEvent.click(screen.getByRole('button', { name: '仕込む' }));

    const dialog = await screen.findByRole('alertdialog');
    fireEvent.click(within(dialog).getByRole('button', { name: '置き換える' }));

    await waitFor(() => expect(posts).toHaveLength(1));
    expect(posts[0]).toEqual({ request: '人間の本文', ifMatch: 'v1' });
    // 409 なので置き換えていない。いまの版で確かめ直す
    expect(await screen.findByRole('alertdialog')).toBeTruthy();
    expect(screen.queryByText('置き換えた: morning')).toBeNull();
    expect((screen.getByLabelText('依頼の本文') as HTMLTextAreaElement).value).toBe('人間の本文');
  });
});
