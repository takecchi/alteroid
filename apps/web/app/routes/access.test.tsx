// @vitest-environment jsdom
import { cleanup, fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import { MemoryRouter } from 'react-router';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import { json, Providers, stubFetch, storeTestBaseUrl } from '~/test-support';

import Access from './access';

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

function account(overrides: Record<string, unknown> = {}) {
  return {
    id: 'acct-a',
    displayName: null,
    email: 'granted@example.com',
    createdAt: '2026-08-01T00:00:00.000Z',
    lastLoginAt: '2026-09-10T00:00:00.000Z',
    grantedAt: '2026-08-02T00:00:00.000Z',
    grantedBy: 'operator',
    granted: true,
    ownerDeclaredAt: null,
    identities: [
      {
        provider: 'google',
        subject: 'sub-a',
        email: 'granted@example.com',
        emailVerified: true,
        lastLoginAt: '2026-09-10T00:00:00.000Z',
      },
    ],
    ...overrides,
  };
}

function stubAccess(options: { status?: number; body?: unknown }) {
  const { status = 200, body = { accounts: [] } } = options;
  return stubFetch((url) => {
    if (url.includes('/access')) return json(body, status);
    return undefined;
  });
}

async function renderAccess(): Promise<void> {
  render(
    <Providers>
      <MemoryRouter>
        <Access />
      </MemoryRouter>
    </Providers>,
  );
  await screen.findByText('アカウント');
}

describe('/access 画面 — 一覧', () => {
  it('許可済みのアカウントが出る', async () => {
    stubAccess({ body: { accounts: [account()] } });

    await renderAccess();

    expect(screen.getByText('granted@example.com')).toBeTruthy();
    expect(screen.getByText('許可')).toBeTruthy();
    expect(screen.getByText('acct-a')).toBeTruthy();
  });

  it('未許可のアカウントは「未許可」の札で出る', async () => {
    stubAccess({
      body: {
        accounts: [
          account({
            id: 'acct-b',
            email: 'pending@example.com',
            grantedAt: null,
            grantedBy: null,
            granted: false,
          }),
        ],
      },
    });

    await renderAccess();

    expect(screen.getByText('pending@example.com')).toBeTruthy();
    expect(screen.getByText('未許可')).toBeTruthy();
  });

  it('許可済み・未許可が混在してもどちらも出る', async () => {
    stubAccess({
      body: {
        accounts: [
          account({ id: 'acct-a', email: 'granted@example.com', granted: true }),
          account({
            id: 'acct-b',
            email: 'pending@example.com',
            grantedAt: null,
            grantedBy: null,
            granted: false,
          }),
        ],
      },
    });

    await renderAccess();

    expect(screen.getByText('granted@example.com')).toBeTruthy();
    expect(screen.getByText('pending@example.com')).toBeTruthy();
  });

  it('0件なら「まだ誰もログインしていません。」の文言を出す（CLI と同じ）', async () => {
    stubAccess({ body: { accounts: [] } });

    await renderAccess();

    expect(screen.getByText('まだ誰もログインしていません。')).toBeTruthy();
  });

  it('取得に失敗したらエラーを出す', async () => {
    stubAccess({ status: 403, body: { error: 'not granted' } });

    await renderAccess();

    expect(screen.getByRole('alert')).toBeTruthy();
  });

  it('取得が失敗したら「もう一度試す」が出て、押すと取り直して一覧が出る（#3420）', async () => {
    let failing = true;
    stubFetch((url) => {
      if (url.includes('/access')) {
        return failing
          ? json({ error: 'boom' }, 500)
          : json({ accounts: [account({ email: 'retry@example.com' })] });
      }
      return undefined;
    });

    await renderAccess();

    const alert = await screen.findByRole('alert');
    expect(alert.textContent).toContain('アクセス許可の一覧を読み込めませんでした');
    failing = false;
    fireEvent.click(within(alert).getByRole('button', { name: 'もう一度試す' }));

    await waitFor(() => expect(screen.getAllByText('retry@example.com').length).toBeGreaterThan(0));
    expect(screen.queryByRole('alert')).toBeNull();
  });

  it('grantedBy が operator なら「実行環境の持ち主」と出す。伝播した許可はアカウント id をそのまま出す', async () => {
    stubAccess({
      body: {
        accounts: [
          account({ id: 'acct-a', email: 'by-operator@example.com', grantedBy: 'operator' }),
          account({
            id: 'acct-b',
            email: 'by-account@example.com',
            grantedBy: 'acct-a',
          }),
        ],
      },
    });

    await renderAccess();

    expect(screen.getByText(/（実行環境の持ち主）/)).toBeTruthy();
    expect(screen.getAllByText(/acct-a/).length).toBeGreaterThan(0);
  });
});

describe('/access 画面 — 持ち主の宣言は画面に出さない', () => {
  it('宣言済み・未宣言のどちらのアカウントにも、宣言のバッジ・行が出ない', async () => {
    stubAccess({
      body: {
        accounts: [
          account({ id: 'acct-a', ownerDeclaredAt: null }),
          account({ id: 'acct-b', ownerDeclaredAt: '2026-09-18T00:00:00.000Z' }),
        ],
      },
    });

    await renderAccess();

    expect(screen.getByText('acct-a')).toBeTruthy();
    expect(screen.queryByText(/宣言/)).toBeNull();
    expect(document.body.textContent).not.toContain('持ち主として');
  });

  it('宣言する・取り消すボタンが出ず、宣言の口（/owner）を叩かない', async () => {
    const stub = stubFetch((url) =>
      url.includes('/access') ? json({ accounts: [account()] }) : undefined,
    );

    await renderAccess();

    expect(screen.queryByRole('button', { name: /宣言/ })).toBeNull();
    expect(stub.calls.some((url) => url.includes('/owner'))).toBe(false);
  });

  it('説明文は、ここで許可したアカウントがすべての設定を変えられると言う', async () => {
    stubAccess({ body: { accounts: [account()] } });

    await renderAccess();

    expect(
      screen.getByText(
        /ここで許可したアカウントは、どれも環境変数・実行環境プロファイル・MCP 連携などすべての設定を変えられる/,
      ),
    ).toBeTruthy();
  });
});

describe('/access 画面 — grant / revoke', () => {
  function stubAccessAndGrant(accounts: unknown[]) {
    return stubFetch((url) => {
      if (/\/access\/[^/]+\/(grant|revoke)$/.test(url)) return json({ ok: true }, 200);
      if (url.includes('/access')) return json({ accounts }, 200);
      return undefined;
    });
  }

  it('初期表示だけでは grant / revoke の URL へ一度も fetch しない', async () => {
    const stub = stubAccessAndGrant([account({ id: 'acct-a', granted: true })]);

    await renderAccess();

    // owner 系を除く: `/access/:id/owner/revoke` は `/revoke` を部分文字列に含むため
    const nonOwnerUrls = stub.calls.filter((url) => !url.includes('/owner'));
    expect(nonOwnerUrls.some((url) => /\/access\/[^/]+\/grant$/.test(url))).toBe(false);
    expect(nonOwnerUrls.some((url) => /\/access\/[^/]+\/revoke$/.test(url))).toBe(false);
  });

  it('未許可のアカウントは「許可する」を押すと POST /access/:id/grant を叩く', async () => {
    const stub = stubAccessAndGrant([
      account({ id: 'acct-b', grantedAt: null, grantedBy: null, granted: false }),
    ]);

    await renderAccess();
    expect(screen.getByRole('button', { name: 'granted@example.com を許可する' })).toBeTruthy();
    fireEvent.click(screen.getByText('許可する'));

    await waitForCall(stub.calls, /\/access\/acct-b\/grant$/);
  });

  it('許可済みのアカウントの取り消しは、確認の一手を挟むまで叩かない', async () => {
    const stub = stubAccessAndGrant([account({ id: 'acct-a', granted: true })]);

    await renderAccess();
    expect(
      screen.getByRole('button', { name: 'granted@example.com の許可を取り消す' }),
    ).toBeTruthy();
    fireEvent.click(screen.getByText('許可を取り消す'));

    expect(stub.calls.some((url) => /\/access\/acct-a\/revoke$/.test(url))).toBe(false);
    const warning = screen.getByText(/取り消された本人は、自分では許可を戻せない/);
    expect(warning.textContent).toMatch(/許可を持つ別のアカウントか実行環境の持ち主/);
    expect(warning.textContent).toMatch(/「許可する」で戻せる/);
    expect(screen.queryByText(/その場では戻せない/)).toBeNull();

    fireEvent.click(screen.getByText('やめる'));
    expect(screen.getByText('許可を取り消す')).toBeTruthy();
    expect(stub.calls.some((url) => /\/access\/acct-a\/revoke$/.test(url))).toBe(false);

    fireEvent.click(screen.getByText('許可を取り消す'));
    expect(
      screen.getByRole('button', { name: 'granted@example.com の許可を本当に取り消す' }),
    ).toBeTruthy();
    fireEvent.click(screen.getByText('本当に取り消す'));
    await waitForCall(stub.calls, /\/access\/acct-a\/revoke$/);
  });
});

async function waitForCall(calls: readonly string[], pattern: RegExp): Promise<void> {
  for (let i = 0; i < 50; i += 1) {
    if (calls.some((url) => pattern.test(url))) return;
    await new Promise((resolve) => setTimeout(resolve, 10));
  }
  throw new Error(`${String(pattern)} が呼ばれなかった: ${calls.join(', ')}`);
}

describe('/access 画面 — 読めない行（issue #2536）', () => {
  it('読めない行が無ければ、その断りは出ない（鍵ごと無い）', async () => {
    stubAccess({ body: { accounts: [account()] } });

    await renderAccess();

    expect(screen.queryByText(/読めないアカウントの行/)).toBeNull();
    expect(screen.queryByRole('button', { name: 'acct-bad の行を消す' })).toBeNull();
  });

  it('読めない行しか無いとき、「誰もログインしていない」と言わず、件数と id・不正な欄名を断る。id の無い行にはボタンが無い', async () => {
    stubAccess({
      body: {
        accounts: [],
        rowsUnreadable: { count: 2, rows: [{ id: 'acct-bad', reason: '不正な欄: displayName' }] },
      },
    });

    await renderAccess();

    expect(await screen.findByText(/読めないアカウントの行が 2 件ある/)).toBeTruthy();
    expect(screen.getByText('acct-bad')).toBeTruthy();
    expect(screen.getByText(/不正な欄: displayName/)).toBeTruthy();
    expect(screen.getByText(/id が取れない行が 1 件ある/)).toBeTruthy();
    expect(screen.getByText(/誰もログインしていない、とは言えない/)).toBeTruthy();
    expect(screen.queryByText('まだ誰もログインしていません。')).toBeNull();
    expect(screen.getAllByRole('button', { name: 'acct-bad の行を消す' })).toHaveLength(1);
  });

  it('行ごとに「<id> の行を消す」の名前で引ける（読み上げで同じ名前が並ばない。#3299）', async () => {
    stubAccess({
      body: {
        accounts: [],
        rowsUnreadable: {
          count: 2,
          rows: [
            { id: 'acct-bad', reason: '不正な欄: displayName' },
            { id: 'acct-bad-2', reason: '不正な欄: email' },
          ],
        },
      },
    });

    await renderAccess();

    expect(await screen.findByRole('button', { name: 'acct-bad の行を消す' })).toBeTruthy();
    expect(screen.getByRole('button', { name: 'acct-bad-2 の行を消す' })).toBeTruthy();
    expect(screen.queryByRole('button', { name: 'この行を消す' })).toBeNull();
  });

  it('「この行を消す」は id を指して POST /access/unreadable/remove を呼び、再取得で断りが消える', async () => {
    const posts: unknown[] = [];
    let unreadable = true;
    globalThis.fetch = (async (input: RequestInfo | URL, init?: RequestInit) => {
      const request = input instanceof Request ? input : null;
      const url = request?.url ?? (typeof input === 'string' ? input : String(input));
      const method = request?.method ?? init?.method ?? 'GET';
      if (url.includes('/access/unreadable/remove') && method === 'POST') {
        posts.push(request !== null ? await request.json() : JSON.parse(String(init?.body)));
        unreadable = false;
        return json({ removedIds: ['acct-bad'], count: 1 });
      }
      if (url.includes('/access')) {
        return json({
          accounts: [],
          ...(unreadable
            ? {
                rowsUnreadable: {
                  count: 1,
                  rows: [{ id: 'acct-bad', reason: '不正な欄: displayName' }],
                },
              }
            : {}),
        });
      }
      return Promise.reject(new TypeError(`Failed to fetch: ${url}`));
    }) as typeof fetch;

    await renderAccess();
    fireEvent.click(await screen.findByRole('button', { name: 'acct-bad の行を消す' }));
    const dialog = await screen.findByRole('alertdialog');
    expect(dialog.textContent).toContain('元に戻せません');
    expect(dialog.textContent).toContain('acct-bad');
    expect(posts).toEqual([]);
    fireEvent.click(within(dialog).getByRole('button', { name: 'やめる' }));
    await waitFor(() => expect(screen.queryByRole('alertdialog')).toBeNull());
    expect(posts).toEqual([]);
    fireEvent.click(screen.getByRole('button', { name: 'acct-bad の行を消す' }));
    fireEvent.click(
      within(await screen.findByRole('alertdialog')).getByRole('button', { name: '消す' }),
    );

    await waitFor(() => {
      expect(posts).toEqual([{ ids: ['acct-bad'] }]);
    });
    await waitFor(() => {
      expect(screen.queryByText(/読めないアカウントの行が/)).toBeNull();
    });
    expect(await screen.findByText('まだ誰もログインしていません。')).toBeTruthy();
  });
});
