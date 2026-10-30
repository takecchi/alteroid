// @vitest-environment jsdom
/**
 * 設定画面の確認ダイアログ3つ（サーバを止める・セッションを開き直す・リセット）が共有する動き:
 * 失敗しても窓は閉じず入力も残る / 済むと結果と「閉じる」だけになる / 閉じて開き直すと入力・失敗・結果が消える。
 */
import { cleanup, fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import { createMemoryRouter, RouterProvider } from 'react-router';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import { json, Providers, stubFetch, storeTestBaseUrl } from '~/test-support';

import Settings from './settings';

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

const cases = [
  {
    name: 'サーバを止める',
    open: 'alteroid のサーバを止める',
    word: 'stop',
    run: '止める',
    path: '/shutdown',
    ok: () => json({ ok: true }),
    done: /止めました/,
  },
  {
    name: 'セッションを開き直す',
    open: '開き直す',
    word: undefined,
    run: '本当に開き直す',
    path: '/clone/session/reopen',
    ok: () => json({ outcome: 'now' }),
    done: /いまはセッションが無かった/,
  },
  {
    name: 'リセット',
    open: 'リセットする',
    word: 'reset',
    run: '本当に削除する',
    path: '/reset',
    ok: () => json({ cleared: { memory: 3 } }),
    done: /リセットしました/,
  },
];

function renderSettings(path: string, answer: () => Response) {
  const stub = stubFetch((url) => {
    if (url.endsWith(path)) return answer();
    if (url.includes('/runners'))
      return json({ runners: [], daemonRevision: { status: 'unknown' } });
    if (url.includes('/auth/providers')) return json({ providers: [] });
    if (url.includes('/me')) return json({ status: 'open' });
    if (url.includes('/health')) return json({ ok: true });
    return json({});
  });
  const router = createMemoryRouter([{ path: '/', Component: Settings }], {
    initialEntries: ['/'],
  });
  render(
    <Providers>
      <RouterProvider router={router} />
    </Providers>,
  );
  return stub;
}

describe.each(cases)('$name の確認ダイアログ', (c) => {
  async function openDialog() {
    fireEvent.click(await screen.findByRole('button', { name: c.open }));
    const confirm = await screen.findByRole('button', { name: c.run });
    return { dialog: confirm.closest('dialog')!, confirm };
  }

  it('失敗しても窓は開いたまま、理由が出て、入力は残り、押し直せる', async () => {
    const stub = renderSettings(c.path, () => json({ error: '拒まれた' }, 500));
    const { dialog, confirm } = await openDialog();
    if (c.word !== undefined) {
      fireEvent.change(within(dialog).getByPlaceholderText(c.word), { target: { value: c.word } });
    }

    fireEvent.click(confirm);

    expect(await within(dialog).findByRole('alert')).toBeTruthy();
    expect(dialog.hasAttribute('open')).toBe(true);
    expect(within(dialog).queryByRole('button', { name: '閉じる' })).toBeNull();
    if (c.word !== undefined) {
      expect((within(dialog).getByPlaceholderText(c.word) as HTMLInputElement).value).toBe(c.word);
    }
    await waitFor(() => expect((confirm as HTMLButtonElement).disabled).toBe(false));
    fireEvent.click(confirm);
    await waitFor(() => expect(stub.calls.filter((u) => u.endsWith(c.path))).toHaveLength(2));
  });

  it('済むと結果と「閉じる」だけになり、閉じて開き直すと入力・結果が消えて確認からやり直せる', async () => {
    renderSettings(c.path, c.ok);
    const { dialog, confirm } = await openDialog();
    if (c.word !== undefined) {
      fireEvent.change(within(dialog).getByPlaceholderText(c.word), { target: { value: c.word } });
    }

    fireEvent.click(confirm);

    expect(await within(dialog).findByText(c.done)).toBeTruthy();
    expect(within(dialog).queryByRole('button', { name: c.run })).toBeNull();
    expect(within(dialog).queryByRole('button', { name: 'やめる' })).toBeNull();

    fireEvent.click(within(dialog).getByRole('button', { name: '閉じる' }));
    expect(dialog.hasAttribute('open')).toBe(false);

    fireEvent.click(screen.getByRole('button', { name: c.open }));
    expect(dialog.hasAttribute('open')).toBe(true);
    expect(within(dialog).queryByText(c.done)).toBeNull();
    const again = within(dialog).getByRole('button', { name: c.run }) as HTMLButtonElement;
    if (c.word !== undefined) {
      expect((within(dialog).getByPlaceholderText(c.word) as HTMLInputElement).value).toBe('');
      expect(again.disabled).toBe(true);
    } else {
      expect(again.disabled).toBe(false);
    }
  });

  it('失敗の表示も、閉じて開き直すと消える', async () => {
    renderSettings(c.path, () => json({ error: '拒まれた' }, 500));
    const { dialog, confirm } = await openDialog();
    if (c.word !== undefined) {
      fireEvent.change(within(dialog).getByPlaceholderText(c.word), { target: { value: c.word } });
    }
    fireEvent.click(confirm);
    await within(dialog).findByRole('alert');

    fireEvent.click(within(dialog).getByRole('button', { name: 'やめる' }));
    expect(dialog.hasAttribute('open')).toBe(false);
    fireEvent.click(screen.getByRole('button', { name: c.open }));

    expect(within(dialog).queryByRole('alert')).toBeNull();
  });
});
