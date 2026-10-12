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

/**
 * 一覧は、人間が見た版（v1）を返す。`changed` を立てると、デーモンの側ではクローンが v2 へ書き換えた状態になる
 * （画面はまだ取り直していない）。本物のデーモンと同じく、ifMatch が今の版と違えば 409 で外さない。
 */
function stubServer(options: { changed?: boolean; withoutVersion?: boolean } = {}) {
  const deletes: { ifMatch?: string }[] = [];
  let current: ReturnType<typeof entryOf> | null = entryOf('一覧で見た本文', 'v1');
  let gets = 0;
  globalThis.fetch = (async (input: RequestInfo | URL, init?: RequestInit) => {
    const request = input instanceof Request ? input : new Request(input, init);
    if (request.method === 'GET') {
      gets += 1;
      return json({ entries: current === null ? [] : [current] });
    }
    if (request.method === 'DELETE') {
      const body = (await request.json()) as { ifMatch?: string };
      deletes.push(body);
      const now = options.changed === true ? entryOf('クローンが直した本文', 'v2') : current;
      if (body.ifMatch !== undefined && now !== null && now.updatedAt !== body.ifMatch) {
        current = now;
        return json(
          { error: '継続中の依頼が見た後に変わっています（外していません）', current: now },
          409,
        );
      }
      current = null;
      return json({ ok: true });
    }
    throw new TypeError(`Failed to fetch: ${request.url}`);
  }) as typeof fetch;
  return { deletes, gets: () => gets };
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

async function removeIt() {
  fireEvent.click(await screen.findByRole('button', { name: `${KIND} を外す` }));
  const dialog = await screen.findByRole('alertdialog');
  fireEvent.click(within(dialog).getByRole('button', { name: '外す' }));
}

describe('予定を外すときは、一覧で見た版を前提にする（#4599）', () => {
  it('一覧で見た版（v1）を ifMatch にして送る', async () => {
    const server = stubServer();
    mount();
    await removeIt();

    await waitFor(() => expect(server.deletes).toHaveLength(1));
    expect(server.deletes[0]).toEqual({ ifMatch: 'v1' });
  });

  it('見た後にほかで書き換えられていれば（409）、外さずに知らせ、一覧を読み直していまの本文を見せる', async () => {
    const server = stubServer({ changed: true });
    mount();
    await screen.findByText('一覧で見た本文');
    const getsBefore = server.gets();
    await removeIt();

    expect(
      await screen.findByText(/この予定はほかで書き換えられたので、外していない/),
    ).toBeTruthy();
    expect(server.gets()).toBeGreaterThan(getsBefore);
    expect(await screen.findByText('クローンが直した本文')).toBeTruthy();
  });
});
