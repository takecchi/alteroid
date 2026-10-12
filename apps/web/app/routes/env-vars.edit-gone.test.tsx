// @vitest-environment jsdom
import { act, cleanup, fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import { json, Providers, TestDataRouter, storeTestBaseUrl } from '~/test-support';

import EnvVars from './env-vars';

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

const PLAIN_ROW = {
  name: 'TZ',
  sha256: 'b'.repeat(12),
  updatedAt: '2026-09-14T00:00:00.000Z',
  scope: 'all',
  secret: false,
  value: 'UTC',
};

function stubServer() {
  let rows: unknown[] = [PLAIN_ROW];
  let emptyServed = 0;
  globalThis.fetch = (async (input: RequestInfo | URL, init?: RequestInit) => {
    const request = input instanceof Request ? input : new Request(input, init);
    if (!request.url.includes('/credentials'))
      throw new TypeError(`Failed to fetch: ${request.url}`);
    if (rows.length === 0) emptyServed += 1;
    return json({ credentials: rows });
  }) as typeof fetch;
  return {
    // ほかで（別のタブ・CLI から）消された。取り直しが走り、一覧から行が外れる
    async removeElsewhere() {
      rows = [];
      act(() => {
        window.dispatchEvent(new Event('focus'));
      });
      await waitFor(() => expect(emptyServed).toBeGreaterThan(0));
      await act(async () => {
        await Promise.resolve();
      });
    },
  };
}

function renderScreen() {
  render(
    <Providers>
      <TestDataRouter>
        <EnvVars />
      </TestDataRouter>
    </Providers>,
  );
}

async function openEdit(name: string) {
  const trigger = await screen.findByRole('button', { name: `「${name}」の操作` });
  fireEvent.keyDown(trigger, { key: 'Enter' });
  fireEvent.click(await screen.findByRole('menuitem', { name: '編集' }));
  return screen.findByRole('dialog');
}

describe('環境変数の編集の窓 — 編集の間にほかで消されても、書きかけを黙って消さない（#4589）', () => {
  it('一覧から外れても写しの行で窓を残し、打った値のまま「ほかで消された」と知らせる', async () => {
    const server = stubServer();
    renderScreen();
    const dialog = await openEdit('TZ');
    fireEvent.change(within(dialog).getByLabelText('値'), { target: { value: 'Asia/Tokyo' } });

    await server.removeElsewhere();

    const still = screen.getByRole('dialog');
    expect((within(still).getByLabelText('値') as HTMLInputElement).value).toBe('Asia/Tokyo');
    expect(within(still).getByText(/ほかで消された/)).toBeTruthy();
  });

  it('対照: 編集していなければ、消された行は一覧から外れる', async () => {
    const server = stubServer();
    renderScreen();
    await screen.findByRole('button', { name: '「TZ」の操作' });

    await server.removeElsewhere();

    await waitFor(() => expect(screen.queryByRole('button', { name: '「TZ」の操作' })).toBeNull());
  });
});
