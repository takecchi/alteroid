// @vitest-environment jsdom
import { cleanup, fireEvent, render, screen } from '@testing-library/react';
import { createMemoryRouter, RouterProvider } from 'react-router';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import { json, Providers, storeTestBaseUrl } from '~/test-support';
import type { Commitment } from '@alteroid/logic';

import Commitments from './commitments';

// 台帳の撤去の段2b: 台帳の画面は読むだけ。書く UI（登録・本文の編集・片付ける・開き直す）は無く、書く HTTP も呼ばない

const AT = new Date(Date.now() - 3 * 24 * 60 * 60 * 1000).toISOString();
const CLOSED_AT = new Date().toISOString();

const OPEN_ROW: Commitment = {
  id: 'open-1',
  origin: 'human',
  at: AT,
  updatedAt: AT,
  body: 'いま積んでいる仕事',
};

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

describe('台帳の画面は読むだけ', () => {
  it('書く入口が1つも無く、読むだけの一覧が出る', async () => {
    const methods: string[] = [];
    globalThis.fetch = (async (input: RequestInfo | URL, init?: RequestInit) => {
      const request = input instanceof Request ? input : new Request(input, init);
      if (!request.url.includes('/commitments'))
        throw new TypeError(`Failed to fetch: ${request.url}`);
      methods.push(request.method);
      return json({
        entries: request.url.includes('includeClosed=true') ? [OPEN_ROW, CLOSED_ROW] : [OPEN_ROW],
        unreadable: [{ id: 'broken-1', reason: '読めない' }],
        trimmedClosed: 0,
      });
    }) as typeof fetch;
    const router = createMemoryRouter([{ path: '/', Component: Commitments }], {
      initialEntries: ['/'],
    });
    render(
      <Providers>
        <RouterProvider router={router} />
      </Providers>,
    );

    expect(await screen.findByText('いま積んでいる仕事')).toBeTruthy();
    fireEvent.click(await screen.findByRole('button', { name: '片付けたものも見る' }));
    expect(await screen.findByText('閉じた仕事')).toBeTruthy();

    const names = screen.getAllByRole('button').map((button) => button.textContent ?? '');
    for (const forbidden of ['積む', '本文を編集', '開き直す', '片付ける', '閉じる']) {
      expect(names.filter((name) => name.includes(forbidden))).toEqual([]);
    }
    expect(screen.queryByText('仕事を登録する')).toBeNull();
    expect(screen.queryAllByRole('textbox')).toEqual([]);
    expect(new Set(methods)).toEqual(new Set(['GET']));
  });
});
