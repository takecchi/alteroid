// @vitest-environment jsdom
import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { createMemoryRouter, RouterProvider } from 'react-router';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { json, Providers, storeTestBaseUrl } from '~/test-support';

import Commitments from './commitments';

let originalFetch: typeof fetch;

beforeEach(() => {
  originalFetch = globalThis.fetch;
  localStorage.clear();
  storeTestBaseUrl();
});

afterEach(() => {
  vi.useRealTimers();
  cleanup();
  globalThis.fetch = originalFetch;
});

function stubServer(closeResponse: () => Response) {
  const closes: { url: string; body: unknown }[] = [];
  globalThis.fetch = (async (input: RequestInfo | URL, init?: RequestInit) => {
    const request = input instanceof Request ? input : new Request(input, init);
    if (!request.url.includes('/commitments'))
      throw new TypeError(`Failed to fetch: ${request.url}`);
    if (request.method === 'POST') {
      closes.push({ url: request.url, body: await request.json() });
      return closeResponse();
    }
    const unreadable = [{ id: 'c-bad', reason: '型が合わない' }, { reason: 'id が取れない' }];
    // 「片付けたものも見る」では、閉じた読めない行も混ざって返る（閉じたかは公開されない）。
    if (request.url.includes('includeClosed=true'))
      unreadable.push({ id: 'c-closed', reason: '型が合わない' });
    return json({ entries: [], unreadable });
  }) as typeof fetch;
  return closes;
}

function renderPage() {
  const router = createMemoryRouter([{ path: '/', Component: Commitments }], {
    initialEntries: ['/'],
  });
  render(
    <Providers>
      <RouterProvider router={router} />
    </Providers>,
  );
}

const REASON_LABEL = '「c-bad」を片付けた理由';

describe('読めない行を閉じる入口', () => {
  it('id のある読めない行に、理由を書いて閉じられる。閉じても本文は出ないと断る', async () => {
    const closes = stubServer(() => json({ ok: true }));
    renderPage();

    await screen.findByText(/読めない行が 2 件ある/);
    expect(screen.getByText(/閉じても中身は読めないままなので/)).toBeTruthy();
    fireEvent.change(screen.getByLabelText(REASON_LABEL), { target: { value: '手で直した' } });
    fireEvent.click(screen.getByRole('button', { name: '「c-bad」が片付いた' }));

    await waitFor(() => expect(closes).toHaveLength(1));
    expect(closes[0]?.url).toContain('/commitments/c-bad/close');
    expect(closes[0]?.body).toEqual({ reason: '手で直した' });
  });

  it('理由が空（空白だけ）なら送れない', async () => {
    const closes = stubServer(() => json({ ok: true }));
    renderPage();

    await screen.findByText(/読めない行が 2 件ある/);
    const button = screen.getByRole<HTMLButtonElement>('button', { name: '「c-bad」が片付いた' });
    expect(button.disabled).toBe(true);
    const field = screen.getByLabelText(REASON_LABEL);
    fireEvent.change(field, { target: { value: '   ' } });
    expect(button.disabled).toBe(true);
    vi.useFakeTimers();
    fireEvent.keyDown(field, { key: 'Enter', metaKey: true });
    await vi.advanceTimersByTimeAsync(20);
    expect(closes).toHaveLength(0);
  });

  it('閉じるのが失敗（409）しても、理由の書きかけは残り、失敗が出る', async () => {
    const closes = stubServer(() =>
      json({ error: 'c-bad は既に片付けてある（読めない形で入っているため）' }, 409),
    );
    renderPage();

    await screen.findByText(/読めない行が 2 件ある/);
    fireEvent.change(screen.getByLabelText(REASON_LABEL), { target: { value: '手で直した' } });
    fireEvent.click(screen.getByRole('button', { name: '「c-bad」が片付いた' }));

    await waitFor(() => expect(closes).toHaveLength(1));
    expect(await screen.findByText(/既に片付けてある/)).toBeTruthy();
    expect((screen.getByLabelText(REASON_LABEL) as HTMLInputElement).value).toBe('手で直した');
  });

  it('id の無い行には入口を出さない（件数だけ言う）', async () => {
    stubServer(() => json({ ok: true }));
    renderPage();

    await screen.findByText(/読めない行が 2 件ある/);
    expect(screen.getAllByRole('textbox')).toHaveLength(2);
    expect(screen.getAllByRole('button', { name: /が片付いた$/ })).toHaveLength(1);
  });

  it('「片付けたものも見る」で混ざる、未了の一覧に無い読めない行には入口を出さない', async () => {
    stubServer(() => json({ ok: true }));
    renderPage();

    await screen.findByText(/読めない行が 2 件ある/);
    fireEvent.click(screen.getByRole('button', { name: '片付けたものも見る' }));

    await screen.findByText(/読めない行が 3 件ある/);
    expect(screen.getByText(/c-closed/)).toBeTruthy();
    expect(screen.getByLabelText(REASON_LABEL)).toBeTruthy();
    expect(screen.queryByLabelText('「c-closed」を片付けた理由')).toBeNull();
  });
});
