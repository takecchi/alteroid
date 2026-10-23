// @vitest-environment jsdom
import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { createMemoryRouter, RouterProvider } from 'react-router';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import { json, Providers, storeTestBaseUrl } from '~/test-support';
import type { Commitment } from '@alteroid/logic';

import Commitments from './commitments';

// 閉じた行を否定する口（#5176）。片付いた行にだけ出て、理由なしでは送れず、POST /commitments/{id}/reopen を呼ぶ

const AT = new Date(Date.now() - 3 * 24 * 60 * 60 * 1000).toISOString();
const CLOSED_AT = new Date().toISOString();

const CLOSED_ROW: Commitment = {
  id: 'closed-1',
  origin: 'manager',
  at: AT,
  closedAt: CLOSED_AT,
  closedBy: 'daemon',
  updatedAt: CLOSED_AT,
  body: '閉じた仕事',
  closedReason: '器が自動で閉じた',
};

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

function stubServer(reopenResponse: () => Response) {
  const reopens: { url: string; body: unknown }[] = [];
  globalThis.fetch = (async (input: RequestInfo | URL, init?: RequestInit) => {
    const request = input instanceof Request ? input : new Request(input, init);
    if (!request.url.includes('/commitments'))
      throw new TypeError(`Failed to fetch: ${request.url}`);
    if (request.method === 'POST') {
      reopens.push({ url: request.url, body: await request.json() });
      return reopenResponse();
    }
    return json({
      entries: request.url.includes('includeClosed=true') ? [CLOSED_ROW] : [],
      unreadable: [],
      trimmedClosed: 0,
    });
  }) as typeof fetch;
  return reopens;
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

async function openForm() {
  fireEvent.click(await screen.findByRole('button', { name: '片付けたものも見る' }));
  fireEvent.click(await screen.findByRole('button', { name: '「閉じた仕事」を開き直す' }));
}

describe('閉じた行を開き直す入口', () => {
  it('理由を書いて送ると POST /commitments/{id}/reopen を呼ぶ', async () => {
    const reopens = stubServer(() => json({ ...CLOSED_ROW, closedAt: undefined }));
    renderPage();
    await openForm();

    fireEvent.change(screen.getByLabelText('「閉じた仕事」を開き直す理由'), {
      target: { value: 'まだ終わっていない' },
    });
    fireEvent.click(screen.getByRole('button', { name: '「閉じた仕事」の開き直しを確定' }));

    await waitFor(() => expect(reopens).toHaveLength(1));
    expect(reopens[0]?.url).toContain('/commitments/closed-1/reopen');
    expect(reopens[0]?.body).toEqual({ reason: 'まだ終わっていない' });
  });

  it('理由が空（空白だけ）なら送れない', async () => {
    const reopens = stubServer(() => json({}));
    renderPage();
    await openForm();

    const button = screen.getByRole<HTMLButtonElement>('button', {
      name: '「閉じた仕事」の開き直しを確定',
    });
    expect(button.disabled).toBe(true);
    fireEvent.change(screen.getByLabelText('「閉じた仕事」を開き直す理由'), {
      target: { value: '   ' },
    });
    expect(button.disabled).toBe(true);
    expect(reopens).toHaveLength(0);
  });

  it('断られた（409）ら、理由の書きかけは残り、サーバの本文が出る', async () => {
    const reopens = stubServer(() => json({ error: 'closed-1 は閉じていない' }, 409));
    renderPage();
    await openForm();

    fireEvent.change(screen.getByLabelText('「閉じた仕事」を開き直す理由'), {
      target: { value: 'まだ終わっていない' },
    });
    fireEvent.click(screen.getByRole('button', { name: '「閉じた仕事」の開き直しを確定' }));

    await waitFor(() => expect(reopens).toHaveLength(1));
    expect(await screen.findByText(/閉じていない/)).toBeTruthy();
    expect((screen.getByLabelText('「閉じた仕事」を開き直す理由') as HTMLInputElement).value).toBe(
      'まだ終わっていない',
    );
  });
});
