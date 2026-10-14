// @vitest-environment jsdom
import { cleanup, fireEvent, render, screen, waitFor, within } from '@testing-library/react';
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

const ROW = {
  name: 'GH_TOKEN',
  sha256: 'a'.repeat(12),
  updatedAt: '2026-09-14T00:00:00.000Z',
  scope: 'runner',
  secret: true,
};

function stubServer() {
  const puts: { credentials: { scope?: string }[] }[] = [];
  globalThis.fetch = (async (input: RequestInfo | URL, init?: RequestInit) => {
    const request = input instanceof Request ? input : new Request(input, init);
    if (!request.url.includes('/credentials'))
      throw new TypeError(`Failed to fetch: ${request.url}`);
    if (request.method === 'PUT') {
      puts.push((await request.json()) as { credentials: { scope?: string }[] });
      return json({ credentials: [ROW], runners: [] });
    }
    return json({ credentials: [ROW] });
  }) as typeof fetch;
  return puts;
}

async function fillForm(name: string, value: string) {
  render(
    <Providers>
      <TestDataRouter>
        <EnvVars />
      </TestDataRouter>
    </Providers>,
  );
  await screen.findByText('GH_TOKEN');
  fireEvent.change(screen.getByPlaceholderText('TZ'), { target: { value: name } });
  fireEvent.change(screen.getByLabelText('値'), { target: { value } });
}

function scopeSelect() {
  return screen.getByLabelText('渡す先') as HTMLSelectElement;
}

describe('環境変数の登録 — 同名の上書きで渡す先を保つ（#4819）', () => {
  it('(a) 渡す先を触らずに上書きすると、既存の渡す先（runner）のまま送る', async () => {
    const puts = stubServer();
    await fillForm('GH_TOKEN', 'new');
    expect(scopeSelect().value).toBe('runner');
    fireEvent.click(screen.getByRole('button', { name: '置く' }));

    const dialog = await screen.findByRole('alertdialog');
    expect(within(dialog).queryByText(/渡す先も/)).toBeNull();
    fireEvent.click(within(dialog).getByRole('button', { name: '置き換える' }));

    await waitFor(() => expect(puts).toHaveLength(1));
    expect(puts[0]?.credentials[0]?.scope).toBe('runner');
  });

  it('(b) 渡す先を「共通」に選び直すと、確認で変わる旨を言い、all で送る', async () => {
    const puts = stubServer();
    await fillForm('GH_TOKEN', 'new');
    fireEvent.change(scopeSelect(), { target: { value: 'all' } });
    fireEvent.click(screen.getByRole('button', { name: '置く' }));

    const dialog = await screen.findByRole('alertdialog');
    expect(
      within(dialog).getByText(/渡す先も『マネージャーだけ』から『共通』に変わる/),
    ).toBeTruthy();
    fireEvent.click(within(dialog).getByRole('button', { name: '置き換える' }));

    await waitFor(() => expect(puts).toHaveLength(1));
    expect(puts[0]?.credentials[0]?.scope).toBe('all');
  });

  it('(c) 対照: 新しい名前なら既定の all で送る', async () => {
    const puts = stubServer();
    await fillForm('OTHER', 'v');
    expect(scopeSelect().value).toBe('all');
    fireEvent.click(screen.getByRole('button', { name: '置く' }));

    await waitFor(() => expect(puts).toHaveLength(1));
    expect(puts[0]?.credentials[0]?.scope).toBe('all');
    expect(screen.queryByRole('alertdialog')).toBeNull();
  });
});
