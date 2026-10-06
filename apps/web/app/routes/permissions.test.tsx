// @vitest-environment jsdom
/**
 * `/permissions` 画面（Issue #863）。ここで固定したいのは:
 *
 * - `GET /permission-grants` が返す許可のうち、**既定では有効なものだけ**出る
 *   （取り消し済みは隠れる。CLI の既定と同じ）
 * - 「取り消し済みも見る」を押すと、取り消し済みも出る
 * - 0件のとき、初期表示と「取り消し済みも見る」を押した後のどちらでも文言が出る
 * - 規則の広さの段階が出る（`describePermissionRuleBreadth` を通す）
 * - 取得に失敗したときエラーが出る
 * - **取り消し（`revoke`）は確認の一手を挟むまで叩かない**
 * - 取り消し済みの行には取り消しボタンが無い
 */
import { cleanup, fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import { MemoryRouter } from 'react-router';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { json, Providers, stubFetch, storeTestBaseUrl } from '~/test-support';

import Permissions from './permissions';

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

function grant(overrides: Record<string, unknown> = {}) {
  return {
    id: 'grant-a',
    rule: 'Bash(gh pr merge:*)',
    allows: ['gh pr merge 1'],
    denies: ['gh pr merge; rm -rf /'],
    approvalId: 'approval-a',
    answer: '許可します',
    grantedAt: '2026-09-01T00:00:00.000Z',
    route: { principalKind: 'account', accountId: 'acct-a' },
    ...overrides,
  };
}

function stubGrants(options: { status?: number; body?: unknown }) {
  const { status = 200, body = { grants: [] } } = options;
  return stubFetch((url) => {
    if (/\/permission-grants\/[^/]+\/revoke$/.test(url)) return json({ ok: true }, 200);
    if (url.includes('/permission-grants')) return json(body, status);
    return undefined;
  });
}

async function renderPermissions(): Promise<void> {
  render(
    <Providers>
      <MemoryRouter>
        <Permissions />
      </MemoryRouter>
    </Providers>,
  );
  await screen.findByText('許可', { selector: 'h2' });
}

async function waitForCall(calls: readonly string[], pattern: RegExp): Promise<void> {
  for (let i = 0; i < 50; i += 1) {
    if (calls.some((url) => pattern.test(url))) return;
    await new Promise((resolve) => setTimeout(resolve, 10));
  }
  throw new Error(`${String(pattern)} が呼ばれなかった: ${calls.join(', ')}`);
}

describe('/permissions 画面 — 一覧（既定は有効なものだけ）', () => {
  it('有効な許可が出る', async () => {
    stubGrants({ body: { grants: [grant()] } });

    await renderPermissions();

    expect(screen.getByText('Bash(gh pr merge:*)')).toBeTruthy();
    expect(screen.getByText('grant-a')).toBeTruthy();
    expect(screen.getByText('有効')).toBeTruthy();
    expect(screen.getByRole('button', { name: 'Bash(gh pr merge:*) を取り消す' })).toBeTruthy();
  });

  it('取り消し済みは既定では隠れる', async () => {
    stubGrants({
      body: {
        grants: [
          grant({ id: 'grant-active', rule: 'Bash(gh pr view:*)' }),
          grant({
            id: 'grant-revoked',
            rule: 'Bash(gh release edit:*)',
            revokedAt: '2026-09-05T00:00:00.000Z',
          }),
        ],
      },
    });

    await renderPermissions();

    expect(screen.getByText('Bash(gh pr view:*)')).toBeTruthy();
    expect(screen.queryByText('Bash(gh release edit:*)')).toBeNull();
  });

  it('「取り消し済みも見る」を押すと取り消し済みも出る', async () => {
    stubGrants({
      body: {
        grants: [
          grant({ id: 'grant-active', rule: 'Bash(gh pr view:*)' }),
          grant({
            id: 'grant-revoked',
            rule: 'Bash(gh release edit:*)',
            revokedAt: '2026-09-05T00:00:00.000Z',
          }),
        ],
      },
    });

    await renderPermissions();
    fireEvent.click(screen.getByText('取り消し済みも見る'));

    expect(screen.getByText('Bash(gh release edit:*)')).toBeTruthy();
    expect(screen.getByText('取り消し済み')).toBeTruthy();
  });

  it('0件（既定ビュー、取り消し済みも無い）なら文言を出す', async () => {
    stubGrants({ body: { grants: [] } });

    await renderPermissions();

    expect(screen.getByText('有効な許可はありません。')).toBeTruthy();
  });

  it('有効なものは0件だが取り消し済みはあるとき、案内文を出す', async () => {
    stubGrants({
      body: { grants: [grant({ id: 'grant-revoked', revokedAt: '2026-09-05T00:00:00.000Z' })] },
    });

    await renderPermissions();

    expect(
      screen.getByText(
        '有効な許可はありません（「取り消し済みも見る」を押すと取り消し済みも含めて見られます）。',
      ),
    ).toBeTruthy();
  });

  it('全件ビューで0件なら「許可はまだ1件もありません。」と出す', async () => {
    stubGrants({ body: { grants: [] } });

    await renderPermissions();
    fireEvent.click(screen.getByText('取り消し済みも見る'));

    expect(screen.getByText('許可はまだ1件もありません。')).toBeTruthy();
  });

  it('取得に失敗したらエラーを出す', async () => {
    stubGrants({ status: 403, body: { error: 'not granted' } });

    await renderPermissions();

    expect(screen.getByRole('alert')).toBeTruthy();
  });
});

describe('/permissions 画面 — 広さの段階', () => {
  it('完全一致・前方一致(狭い/中間/広い)・不正規則がそれぞれの文言で出る', async () => {
    stubGrants({
      body: {
        grants: [
          grant({ id: 'g-exact', rule: 'Bash(gh pr view 1)' }),
          grant({ id: 'g-narrow', rule: 'Bash(gh release edit:*)' }),
          grant({ id: 'g-medium', rule: 'Bash(gh release:*)' }),
          grant({ id: 'g-broad', rule: 'Bash(gh:*)' }),
          grant({ id: 'g-invalid', rule: 'not-a-rule' }),
        ],
      },
    });

    await renderPermissions();

    expect(screen.getByText('完全一致（最も狭い。この文字列にしか一致しない）')).toBeTruthy();
    expect(screen.getByText('前方一致・狭い（固定 3 語まで一致）')).toBeTruthy();
    expect(screen.getByText('前方一致・中間（固定 2 語まで一致）')).toBeTruthy();
    expect(
      screen.getByText('前方一致・広い（固定 1 語のみ——この語で始まるコマンドなら何でも通る）'),
    ).toBeTruthy();
    expect(screen.getByText('⚠️ 規則が不正（照合されない。壊れている可能性がある）')).toBeTruthy();
  });
});

describe('/permissions 画面 — 取り消し', () => {
  it('初期表示だけでは revoke の URL へ一度も fetch しない', async () => {
    const stub = stubGrants({ body: { grants: [grant()] } });

    await renderPermissions();

    expect(stub.calls.some((url) => /\/permission-grants\/[^/]+\/revoke$/.test(url))).toBe(false);
  });

  it('有効な許可の取り消しは、確認の一手を挟むまで叩かない', async () => {
    const stub = stubGrants({ body: { grants: [grant({ id: 'grant-a' })] } });

    await renderPermissions();
    fireEvent.click(screen.getByText('取り消す'));

    // 1回目の押下では叩かない。確認の文言と「本当に取り消す」が出る。
    expect(stub.calls.some((url) => /\/permission-grants\/grant-a\/revoke$/.test(url))).toBe(false);
    expect(screen.getByText(/その場で効く/)).toBeTruthy();

    // やめれば元に戻り、叩かない。
    fireEvent.click(screen.getByText('やめる'));
    expect(screen.getByText('取り消す')).toBeTruthy();
    expect(stub.calls.some((url) => /\/permission-grants\/grant-a\/revoke$/.test(url))).toBe(false);

    // 確認してから叩く。
    fireEvent.click(screen.getByText('取り消す'));
    fireEvent.click(screen.getByText('本当に取り消す'));
    await waitForCall(stub.calls, /\/permission-grants\/grant-a\/revoke$/);
  });

  it('取り消し済みの行には取り消しボタンが無い', async () => {
    stubGrants({
      body: {
        grants: [grant({ id: 'grant-revoked', revokedAt: '2026-09-05T00:00:00.000Z' })],
      },
    });

    await renderPermissions();
    fireEvent.click(screen.getByText('取り消し済みも見る'));

    expect(screen.queryByText('取り消す')).toBeNull();
  });
});

describe('/permissions 画面 — 長く使われていない許可（Issue #1804）', () => {
  // 時計は Date だけ差し替える（タイマーは本物のまま。実時間の待ちは足さない）。
  beforeEach(() => {
    vi.useFakeTimers({ toFake: ['Date'], now: new Date('2026-09-30T00:00:00.000Z') });
  });
  afterEach(() => {
    vi.useRealTimers();
  });

  it('古い許可にだけ印と「N日使われていない」が出る', async () => {
    stubGrants({
      body: {
        grants: [
          grant({
            id: 'grant-old',
            rule: 'Bash(gh pr view:*)',
            lastUsedAt: '2026-08-10T00:00:00.000Z',
          }),
          grant({
            id: 'grant-new',
            rule: 'Bash(gh pr merge:*)',
            lastUsedAt: '2026-09-25T00:00:00.000Z',
          }),
        ],
      },
    });

    await renderPermissions();

    expect(screen.getAllByText(/日使われていない/)).toHaveLength(1);
    expect(screen.getByText(/51 日使われていない（起点: 最終使用/)).toBeTruthy();
  });

  it('一度も使われていない許可は付与を起点にし、取り消し済みには出ない', async () => {
    stubGrants({
      body: {
        grants: [
          grant({ id: 'grant-unused', grantedAt: '2026-08-01T00:00:00.000Z' }),
          grant({
            id: 'grant-revoked',
            grantedAt: '2026-01-01T00:00:00.000Z',
            revokedAt: '2026-09-05T00:00:00.000Z',
          }),
        ],
      },
    });

    await renderPermissions();
    fireEvent.click(screen.getByText('取り消し済みも見る'));

    expect(screen.getAllByText(/日使われていない/)).toHaveLength(1);
    expect(screen.getByText(/60 日使われていない（起点: 付与/)).toBeTruthy();
  });
});

describe('/permissions 画面 — 読めない行（issue #2536）', () => {
  it('読めない行が無ければ、その断りは出ない（鍵ごと無い）', async () => {
    stubGrants({ body: { grants: [grant()] } });

    await renderPermissions();

    expect(screen.queryByText(/読めない許可の行/)).toBeNull();
    expect(screen.queryByRole('button', { name: 'この行を消す' })).toBeNull();
  });

  it('読めない行しか無いとき、「許可は無い」と言わず、件数と id・不正な欄名を断る。id の無い行にはボタンが無い', async () => {
    stubGrants({
      body: {
        grants: [],
        rowsUnreadable: { count: 2, rows: [{ id: 'grant-bad', reason: '不正な欄: route' }] },
      },
    });

    await renderPermissions();

    expect(await screen.findByText(/読めない許可の行が 2 件ある/)).toBeTruthy();
    expect(screen.getByText('grant-bad')).toBeTruthy();
    expect(screen.getByText(/不正な欄: route/)).toBeTruthy();
    expect(screen.getByText(/id が取れない行が 1 件ある/)).toBeTruthy();
    expect(screen.getByText(/許可が無い、とは言えない/)).toBeTruthy();
    expect(screen.queryByText('有効な許可はありません。')).toBeNull();
    expect(screen.getAllByRole('button', { name: 'この行を消す' })).toHaveLength(1);
  });

  it('読めない行が在っても、読めた許可は今までどおり出る', async () => {
    stubGrants({
      body: {
        grants: [grant()],
        rowsUnreadable: { count: 1, rows: [{ id: 'grant-bad', reason: '不正な欄: route' }] },
      },
    });

    await renderPermissions();

    expect(await screen.findByText(/読めない許可の行が 1 件ある/)).toBeTruthy();
    expect(screen.getByText('Bash(gh pr merge:*)')).toBeTruthy();
  });

  it('「この行を消す」は id を指して POST /permission-grants/unreadable/remove を呼び、再取得で断りが消える', async () => {
    const posts: unknown[] = [];
    let unreadable = true;
    globalThis.fetch = (async (input: RequestInfo | URL, init?: RequestInit) => {
      const request = input instanceof Request ? input : null;
      const url = request?.url ?? (typeof input === 'string' ? input : String(input));
      const method = request?.method ?? init?.method ?? 'GET';
      if (url.includes('/permission-grants/unreadable/remove') && method === 'POST') {
        posts.push(request !== null ? await request.json() : JSON.parse(String(init?.body)));
        unreadable = false;
        return json({ removedIds: ['grant-bad'], count: 1 });
      }
      if (url.includes('/permission-grants')) {
        return json({
          grants: [],
          ...(unreadable
            ? {
                rowsUnreadable: {
                  count: 1,
                  rows: [{ id: 'grant-bad', reason: '不正な欄: route' }],
                },
              }
            : {}),
        });
      }
      return Promise.reject(new TypeError(`Failed to fetch: ${url}`));
    }) as typeof fetch;

    await renderPermissions();
    fireEvent.click(await screen.findByRole('button', { name: 'この行を消す' }));
    // 押しただけでは消さない（#3091。共有部品なので permissions / access で挙動が揃う）。
    const dialog = await screen.findByRole('alertdialog');
    expect(dialog.textContent).toContain('元に戻せません');
    expect(dialog.textContent).toContain('grant-bad');
    expect(posts).toEqual([]);
    fireEvent.click(within(dialog).getByRole('button', { name: 'やめる' }));
    await waitFor(() => expect(screen.queryByRole('alertdialog')).toBeNull());
    expect(posts).toEqual([]);
    fireEvent.click(screen.getByRole('button', { name: 'この行を消す' }));
    fireEvent.click(
      within(await screen.findByRole('alertdialog')).getByRole('button', { name: '消す' }),
    );

    await waitFor(() => {
      expect(posts).toEqual([{ ids: ['grant-bad'] }]);
    });
    await waitFor(() => {
      expect(screen.queryByText(/読めない許可の行が/)).toBeNull();
    });
    expect(await screen.findByText('有効な許可はありません。')).toBeTruthy();
  });
});
