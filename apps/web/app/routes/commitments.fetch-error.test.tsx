// @vitest-environment jsdom
import { act, cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { createMemoryRouter, RouterProvider } from 'react-router';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import { json, Providers, storeTestBaseUrl } from '~/test-support';

import Commitments from './commitments';

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

function stubCommitments(respond: (url: string) => Response | Promise<Response>): void {
  globalThis.fetch = (async (input: RequestInfo | URL) => {
    const url = typeof input === 'string' ? input : input instanceof URL ? input.href : input.url;
    if (new URL(url).pathname === '/commitments') return respond(url);
    return Promise.reject(new TypeError(`Failed to fetch: ${url}`));
  }) as typeof fetch;
}

function renderPage() {
  render(
    <Providers>
      <RouterProvider router={createMemoryRouter([{ path: '/', Component: Commitments }])} />
    </Providers>,
  );
}

const OPEN_EMPTY = /未了の仕事はない。/;
const CLOSED_EMPTY = /完了した仕事の記録はまだない。/;

describe('引き受けた仕事の一覧の取得に失敗したとき（issue #2320）', () => {
  it('サーバの失敗（500）: エラーは出し、「終わっていない仕事はない」は出さない', async () => {
    stubCommitments(() => json({ error: 'internal' }, 500));
    renderPage();

    expect(await screen.findByRole('alert')).toBeTruthy();
    expect(screen.queryByText(OPEN_EMPTY)).toBeNull();
  });

  it('片付けたものも見る状態でも、「完了した仕事の記録はまだない」は出さない', async () => {
    stubCommitments(() => json({ error: 'internal' }, 500));
    renderPage();
    expect(await screen.findByRole('alert')).toBeTruthy();

    fireEvent.click(screen.getByRole('button', { name: '片付けたものも見る' }));

    await waitFor(() => expect(screen.getByRole('button', { name: '未了だけ' })).toBeTruthy());
    expect(await screen.findByRole('alert')).toBeTruthy();
    expect(screen.queryByText(OPEN_EMPTY)).toBeNull();
    expect(screen.queryByText(CLOSED_EMPTY)).toBeNull();
  });

  it('通信の失敗: エラーは出し、0件の文言は出さない', async () => {
    stubCommitments(() => Promise.reject(new TypeError('Failed to fetch')));
    renderPage();
    expect(await screen.findByRole('alert')).toBeTruthy();

    fireEvent.click(screen.getByRole('button', { name: '片付けたものも見る' }));

    await waitFor(() => expect(screen.getByRole('button', { name: '未了だけ' })).toBeTruthy());
    expect(await screen.findByRole('alert')).toBeTruthy();
    expect(screen.queryByText(OPEN_EMPTY)).toBeNull();
    expect(screen.queryByText(CLOSED_EMPTY)).toBeNull();
  });

  it('本当に0件なら、いままでどおり0件の文言を言う', async () => {
    stubCommitments(() => json({ entries: [] }));
    renderPage();

    expect(await screen.findByText(OPEN_EMPTY)).toBeTruthy();
    expect(screen.queryByRole('alert')).toBeNull();

    fireEvent.click(screen.getByRole('button', { name: '片付けたものも見る' }));

    expect(await screen.findByText(CLOSED_EMPTY)).toBeTruthy();
    expect(screen.queryByRole('alert')).toBeNull();
  });

  it('再検証の失敗で一覧が読めたまま残っているときは、一覧を隠さない（失敗は注記で知らせる）', async () => {
    let calls = 0;
    stubCommitments(() => {
      calls += 1;
      if (calls === 1) {
        const at = '2026-08-19T10:00:00.000Z';
        return json({
          entries: [{ id: 'cmt-1', origin: 'human', body: '誤りを直す', at, updatedAt: at }],
        });
      }
      return json({ error: 'internal' }, 500);
    });
    renderPage();

    expect(await screen.findByText('誤りを直す')).toBeTruthy();
    expect(screen.queryByRole('alert')).toBeNull();

    act(() => {
      window.dispatchEvent(new Event('focus'));
    });

    await waitFor(() => expect(screen.getByRole('alert')).toBeTruthy());
    expect(calls).toBeGreaterThanOrEqual(2);
    expect(screen.getByText('誤りを直す')).toBeTruthy();
  });
});
