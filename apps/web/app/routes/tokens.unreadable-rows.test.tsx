// @vitest-environment jsdom
// 読めない行の断り（UnreadableRowsNote）の見た目と消す操作を固定する: 共有の部品へ寄せても文言・構造が変わらないことを押さえるため
import { cleanup, fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import { createMemoryRouter, RouterProvider } from 'react-router';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import { json, Providers, storeTestBaseUrl } from '~/test-support';

import Tokens from './tokens';

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

const SETTINGS = { rotateOn: 'free_exhausted', cooldownMs: 18_000_000 };
const ROWS = {
  count: 4,
  rows: [
    { id: 'tok-bad', label: 'broken-label', reason: '不正な欄: order' },
    { id: 'tok-only', reason: 'ラベルが無い' },
    { label: 'label-only', reason: 'id が無い' },
    { reason: '何も取れない' },
  ],
};

function stubRemove(removeResponse: () => Response) {
  const posts: unknown[] = [];
  globalThis.fetch = (async (input: RequestInfo | URL, init?: RequestInit) => {
    const request = input instanceof Request ? input : null;
    const url = request?.url ?? (typeof input === 'string' ? input : String(input));
    const method = request?.method ?? init?.method ?? 'GET';
    if (url.includes('/journal')) return json({ entries: [] });
    if (url.includes('/tokens/unreadable/remove') && method === 'POST') {
      posts.push(request !== null ? await request.json() : JSON.parse(String(init?.body)));
      return removeResponse();
    }
    if (url.includes('/tokens')) {
      return json({ tokens: [], settings: SETTINGS, rowsUnreadable: ROWS });
    }
    return Promise.reject(new TypeError(`Failed to fetch: ${url}`));
  }) as typeof fetch;
  return posts;
}

function renderTokens() {
  const router = createMemoryRouter([{ path: '/', Component: Tokens }], { initialEntries: ['/'] });
  return render(
    <Providers>
      <RouterProvider router={router} />
    </Providers>,
  );
}

async function findNote(): Promise<HTMLElement> {
  const text = await screen.findByText(/読めないトークンの行が 4 件ある/);
  const note = text.parentElement;
  if (note === null) throw new Error('note not found');
  return note;
}

describe('/tokens 画面 — 読めない行の断りの表示', () => {
  it('見出し・行ごとの表示・末尾の説明が決まった文言と順で出る', async () => {
    stubRemove(() => json({}));
    renderTokens();

    const note = await findNote();
    const paragraphs = note.querySelectorAll(':scope > p');
    expect(paragraphs).toHaveLength(2);
    expect(paragraphs[0]?.textContent).toBe(
      '読めないトークンの行が 4 件ある（消えたのではなく、読めない形で 入っている）。この一覧には載っていない。',
    );
    expect(paragraphs[1]?.textContent).toBe(
      '一覧を書き換える操作（追加・削除・無効化/戻す）は、この行を捨てずに持ち越す。 消すには、行ごとの「この行を消す」を使う。番号が取れない行は、ここでは消せない。',
    );
    const items = [...note.querySelectorAll(':scope > ul > li')].map((li) => li.textContent);
    expect(items).toEqual([
      'tok-bad / broken-label — 不正な欄: order この行を消す',
      'tok-only — ラベルが無い この行を消す',
      'label-only — id が無い',
      '（id もラベルも取れない） — 何も取れない',
    ]);
    expect(note.querySelector('li code')?.textContent).toBe('tok-bad');
    expect(screen.getAllByRole('button', { name: / の行を消す$/ })).toHaveLength(2);
  });

  it('確認ダイアログの表題と説明が決まった文言で出る', async () => {
    stubRemove(() => json({}));
    renderTokens();
    await findNote();

    fireEvent.click(screen.getByRole('button', { name: 'tok-only の行を消す' }));
    const dialog = await screen.findByRole('alertdialog');
    expect(within(dialog).getByText('読めないトークンの行「tok-only」を消しますか')).toBeTruthy();
    expect(
      within(dialog).getByText(
        'この行は消え、元に戻せません。中身はこの画面では読めないので、消したあとに同じものを入れ直すには元の値が要ります。',
      ),
    ).toBeTruthy();
    expect(within(dialog).getByRole('button', { name: '消す' })).toBeTruthy();
    expect(within(dialog).getByRole('button', { name: 'やめる' })).toBeTruthy();
  });

  it('消すのに失敗したら、断りの中にサーバの文言と次にすることを出し、行は残って押し直せる', async () => {
    const posts = stubRemove(() =>
      json(
        { error: '記録（日誌）が書けなかったので、変更していません', code: 'journal_write_failed' },
        500,
      ),
    );
    renderTokens();
    const note = await findNote();

    fireEvent.click(screen.getByRole('button', { name: 'tok-bad の行を消す' }));
    fireEvent.click(
      within(await screen.findByRole('alertdialog')).getByRole('button', { name: '消す' }),
    );

    await waitFor(() => {
      expect(note.textContent).toContain('記録（日誌）が書けなかったので、変更していません');
    });
    expect(note.textContent).toContain('もう一度試すか、記録の置き場所');
    expect(posts).toEqual([{ ids: ['tok-bad'] }]);
    expect(screen.getByRole('button', { name: 'tok-bad の行を消す' })).toHaveProperty(
      'disabled',
      false,
    );
  });
});
