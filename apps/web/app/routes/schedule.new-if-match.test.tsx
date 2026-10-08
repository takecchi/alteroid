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
// 一覧は空のまま返し続ける: 画面の一覧が古い（クローンが作った直後）状態を作るため
function stubStaleList(reply: 'conflict' | 'reserved' | 'free') {
  const posts: { request: string; ifMatch: string | null | undefined }[] = [];
  globalThis.fetch = (async (input: RequestInfo | URL, init?: RequestInit) => {
    const request = input instanceof Request ? input : new Request(input, init);
    if (request.method === 'GET') return json({ entries: [] });
    const body = (await request.json()) as { request: string; ifMatch?: string | null };
    posts.push({ request: body.request, ifMatch: body.ifMatch });
    if (reply === 'reserved') return json({ error: 'reserved kind' }, 409);
    if (reply === 'conflict' && body.ifMatch !== 'v7') {
      return json(
        { error: '読んだ後に変わった', current: entryOf('クローンが作った本文', 'v7') },
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

async function fillAndSubmit() {
  fireEvent.change(await screen.findByLabelText(/依頼の名前/), { target: { value: KIND } });
  fireEvent.change(screen.getByLabelText('依頼の本文'), { target: { value: '人間の本文' } });
  fireEvent.click(screen.getByRole('button', { name: '仕込む' }));
}

describe('予定の新規の仕込みは「読んだ時には無かった」を版として送る（#4066）', () => {
  it('一覧に無い名前は ifMatch: null で送る', async () => {
    const posts = stubStaleList('free');
    mount();
    await fillAndSubmit();

    await waitFor(() => expect(posts).toHaveLength(1));
    expect(posts[0]).toEqual({ request: '人間の本文', ifMatch: null });
    expect(await screen.findByText('仕込んだ: morning')).toBeTruthy();
  });

  it('一覧が古く同名が在った（409・current あり）なら、置き換えるか確かめ、やめれば再送しない', async () => {
    const posts = stubStaleList('conflict');
    mount();
    await fillAndSubmit();

    const dialog = await screen.findByRole('alertdialog');
    expect(within(dialog).getByText(/同じ名前の依頼が既に在る/)).toBeTruthy();
    expect(posts).toHaveLength(1);

    fireEvent.click(within(dialog).getByRole('button', { name: 'やめる' }));
    await waitFor(() => expect(screen.queryByRole('alertdialog')).toBeNull());
    expect(posts).toHaveLength(1);
    expect((screen.getByLabelText('依頼の本文') as HTMLTextAreaElement).value).toBe('人間の本文');
  });

  it('確かめて進めると current.updatedAt を版にして送り直し、「置き換えた」と言う', async () => {
    const posts = stubStaleList('conflict');
    mount();
    await fillAndSubmit();

    const dialog = await screen.findByRole('alertdialog');
    fireEvent.click(within(dialog).getByRole('button', { name: '置き換える' }));

    await waitFor(() => expect(posts).toHaveLength(2));
    expect(posts[1]).toEqual({ request: '人間の本文', ifMatch: 'v7' });
    expect(await screen.findByText('置き換えた: morning')).toBeTruthy();
  });

  it('current の無い 409（予約名）は確認を出さず、今までどおりの文言で断る', async () => {
    const posts = stubStaleList('reserved');
    mount();
    await fillAndSubmit();

    expect(
      await screen.findByText(/既定の名前（予約名）なので使えない。別の名前にする/),
    ).toBeTruthy();
    expect(screen.queryByRole('alertdialog')).toBeNull();
    expect(posts).toHaveLength(1);
  });
});
