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
  name: 'NPM_TOKEN',
  sha256: 'a'.repeat(12),
  updatedAt: '2026-09-14T00:00:00.000Z',
  scope: 'all',
  secret: true,
};

function stubServer() {
  const puts: unknown[] = [];
  globalThis.fetch = (async (input: RequestInfo | URL, init?: RequestInit) => {
    const request = input instanceof Request ? input : new Request(input, init);
    if (!request.url.includes('/credentials'))
      throw new TypeError(`Failed to fetch: ${request.url}`);
    if (request.method === 'PUT') {
      puts.push(await request.json());
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
  await screen.findByText('NPM_TOKEN');
  fireEvent.change(screen.getByPlaceholderText('TZ'), { target: { value: name } });
  fireEvent.change(screen.getByLabelText('値'), { target: { value } });
}

describe('環境変数の登録 — 同じ名前の既存の変数（#4032）', () => {
  it('同名・同じシークレット扱いなら、送る前に確認を挟み、やめれば送らず入力も残る', async () => {
    const puts = stubServer();
    await fillForm('npm_token', 'new');
    fireEvent.click(screen.getByRole('button', { name: '置く' }));

    const dialog = await screen.findByRole('alertdialog');
    expect(within(dialog).getByText(/前の値は置き換わり/)).toBeTruthy();
    expect(puts).toEqual([]);

    fireEvent.click(within(dialog).getByRole('button', { name: 'やめる' }));
    await waitFor(() => expect(screen.queryByRole('alertdialog')).toBeNull());
    expect(puts).toEqual([]);
    expect((screen.getByLabelText('値') as HTMLInputElement).value).toBe('new');
  });

  it('確かめて進めると送る', async () => {
    const puts = stubServer();
    await fillForm('NPM_TOKEN', 'new');
    fireEvent.click(screen.getByRole('button', { name: '置く' }));

    const dialog = await screen.findByRole('alertdialog');
    fireEvent.click(within(dialog).getByRole('button', { name: '置き換える' }));

    await waitFor(() => expect(puts).toHaveLength(1));
  });

  it('シークレットかどうかが既存と違えば、送らずに一覧の「編集」へ案内する', async () => {
    const puts = stubServer();
    await fillForm('NPM_TOKEN', 'new');
    fireEvent.click(screen.getByRole('checkbox'));
    fireEvent.click(screen.getByRole('button', { name: '置く' }));

    const alert = await screen.findByRole('alert');
    expect(alert.textContent).toContain('「NPM_TOKEN」は既にある');
    expect(alert.textContent).toContain('「編集」');
    expect(screen.queryByRole('alertdialog')).toBeNull();
    expect(puts).toEqual([]);
  });

  it('一覧が読めていないときは、送る前に「確かめられなかった」確認を挟む', async () => {
    const puts: unknown[] = [];
    globalThis.fetch = (async (input: RequestInfo | URL, init?: RequestInit) => {
      const request = input instanceof Request ? input : new Request(input, init);
      if (!request.url.includes('/credentials'))
        throw new TypeError(`Failed to fetch: ${request.url}`);
      if (request.method === 'PUT') {
        puts.push(await request.json());
        return json({ credentials: [ROW], runners: [] });
      }
      return json({ error: 'boom' }, 500);
    }) as typeof fetch;
    render(
      <Providers>
        <TestDataRouter>
          <EnvVars />
        </TestDataRouter>
      </Providers>,
    );
    fireEvent.change(screen.getByPlaceholderText('TZ'), { target: { value: 'NPM_TOKEN' } });
    fireEvent.change(screen.getByLabelText('値'), { target: { value: 'new' } });
    fireEvent.click(screen.getByRole('button', { name: '置く' }));

    const dialog = await screen.findByRole('alertdialog');
    expect(within(dialog).getByText(/既存の変数を確かめられなかった/)).toBeTruthy();
    expect(puts).toEqual([]);

    fireEvent.click(within(dialog).getByRole('button', { name: 'やめる' }));
    await waitFor(() => expect(screen.queryByRole('alertdialog')).toBeNull());
    expect(puts).toEqual([]);

    fireEvent.click(screen.getByRole('button', { name: '置く' }));
    fireEvent.click(
      within(await screen.findByRole('alertdialog')).getByRole('button', { name: '送る' }),
    );
    await waitFor(() => expect(puts).toHaveLength(1));
  });

  it('対照: 新しい名前なら確認なしで送る', async () => {
    const puts = stubServer();
    await fillForm('OTHER', 'v');
    fireEvent.click(screen.getByRole('button', { name: '置く' }));

    await waitFor(() => expect(puts).toHaveLength(1));
    expect(screen.queryByRole('alertdialog')).toBeNull();
  });
});
