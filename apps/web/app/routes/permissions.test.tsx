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
import { cleanup, fireEvent, render, screen } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';

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
      <Permissions />
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
