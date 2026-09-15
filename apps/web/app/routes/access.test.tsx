// @vitest-environment jsdom
/**
 * `/access` 画面。ここで固定したいのは:
 *
 * - `GET /access` が返すアカウントが、許可済み・未許可の両方とも一覧に出る
 * - 0件のとき「まだ誰もログインしていません。」の文言が出る（CLI と同じ文言）
 * - 取得に失敗したとき（403 = 許可されていない等）エラーが出る
 * - **読み取り専用であること** — grant / revoke を起こすボタン・フォームが
 *   画面のどこにも無く、`/grant` `/revoke` を含む URL へ一度も fetch しない
 *   （Issue #213。`apps/web/app/routes/access.tsx` の doc）
 */
import { cleanup, render, screen } from '@testing-library/react';
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
      <Access />
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

    expect(screen.getByText(/実行環境の持ち主/)).toBeTruthy();
    // 伝播した許可（誰かのアカウントが grant した）は、id をそのまま出す
    // （`describeGrantedBy` の doc — 名前へ解決しない）。
    expect(screen.getAllByText(/acct-a/).length).toBeGreaterThan(0);
  });
});

/**
 * **読み取り専用であることを歯で固定する。**
 *
 * grant / revoke（書き込み）はこの画面から出さないという判断（Issue #213）を、
 * 「そのうちボタンが足されて気づかれない」形で壊れないようにする——DOM に
 * ボタン・フォームが1つも無いこと、そして `/grant` `/revoke` を含む URL へ
 * 一度も fetch しないことの両方を測る（片方だけだと、見えないボタンが
 * 裏で叩くような作りを見逃す・逆にボタンが無くても別経路で叩く作りを
 * 見逃す、のどちらかが起こりうる）。
 */
describe('/access 画面 — 読み取り専用であること', () => {
  it('grant / revoke を起こすボタン・フォームがどこにも無い', async () => {
    const stub = stubAccess({
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

    // ボタンが1個も無い（button 要素そのものが無い）。
    expect(screen.queryAllByRole('button').length).toBe(0);
    // 入力欄も無い（フォームが無いことの傍証）。
    expect(document.querySelectorAll('input, form, button').length).toBe(0);
    // 取得の1回しか fetch していない（grant / revoke を書き手が足し忘れて
    // 自動実行してしまう形も、この件数で捕まる）。
    expect(stub.calls.length).toBe(1);
  });

  it('grant / revoke の URL へ一度も fetch しない', async () => {
    const stub = stubAccess({
      body: {
        accounts: [account({ id: 'acct-a', granted: true })],
      },
    });

    await renderAccess();

    expect(stub.calls.some((url) => url.includes('/grant'))).toBe(false);
    expect(stub.calls.some((url) => url.includes('/revoke'))).toBe(false);
  });
});
