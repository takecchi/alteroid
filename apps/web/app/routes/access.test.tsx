// @vitest-environment jsdom
/**
 * `/access` 画面。ここで固定したいのは:
 *
 * - `GET /access` が返すアカウントが、許可済み・未許可の両方とも一覧に出る
 * - 0件のとき「まだ誰もログインしていません。」の文言が出る（CLI と同じ文言）
 * - 取得に失敗したとき（403 = 許可されていない等）エラーが出る
 * - **`grant` / `revoke`（許可の付与・取り消し）を画面から起こせる。取り消しは確認の
 *   一手を挟むまで叩かない**（Issue #213。2026-09-24 に「出さない」から反転した。
 *   `apps/web/app/routes/access.tsx` の doc）
 * - **宣言済みかどうかの印が出る**（issue #1198）
 * - **実行環境の持ち主としての宣言・取り消しのボタンは在り、押すと
 *   `POST /access/:id/owner` `.../owner/revoke` を叩く。** Web UI からは
 *   `requireOperator` を構造的に満たせないので必ず 403 になり、そのとき
 *   アカウント id 入りの端末コマンドを案内する
 */
import { cleanup, fireEvent, render, screen } from '@testing-library/react';
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

    // **括弧付きの完全な形で見る。** 素の `/実行環境の持ち主/` は issue #1198 で
    // 足した「実行環境の持ち主として宣言」という別の dt 見出しにも当たって
    // しまい、複数要素ヒットで壊れる——ここは `grantedAt` の `dd` が持つ
    // 「（実行環境の持ち主）」という括弧付きの形だけを狙う。
    expect(screen.getByText(/（実行環境の持ち主）/)).toBeTruthy();
    // 伝播した許可（誰かのアカウントが grant した）は、id をそのまま出す
    // （`describeGrantedBy` の doc — 名前へ解決しない）。
    expect(screen.getAllByText(/acct-a/).length).toBeGreaterThan(0);
  });
});

/**
 * **宣言済みかどうかの印（issue #1198）。**
 */
describe('/access 画面 — owner 宣言の印', () => {
  it('未宣言なら「owner 未宣言」と出す', async () => {
    stubAccess({ body: { accounts: [account({ ownerDeclaredAt: null })] } });

    await renderAccess();

    expect(screen.getByText('owner 未宣言')).toBeTruthy();
    expect(screen.getByText('（未宣言）')).toBeTruthy();
  });

  it('宣言済みなら「owner 宣言済み」と日時を出す', async () => {
    stubAccess({
      body: { accounts: [account({ ownerDeclaredAt: '2026-09-18T00:00:00.000Z' })] },
    });

    await renderAccess();

    expect(screen.getByText('owner 宣言済み')).toBeTruthy();
  });
});

/**
 * **`grant` / `revoke`（許可の付与・取り消し）を画面から起こせる**（Issue #213）。
 *
 * ⚠️ **2026-09-24 に反転した歯である。** それまでここは「grant / revoke は出さない」
 * （ボタンもフォームも無く、`/grant` `/revoke` へ一度も fetch しない）を固定していた。
 * #213 を「欠落」と判定して画面に足したので、期待を反転した（理由は
 * `routes/access.tsx` の「grant / revoke を足した経緯」）。**弱めてはいない** —— 旧い歯が
 * 測っていた「初期表示だけでは grant / revoke を叩かない」はそのまま残し、そこに
 * 「押せば叩く」「取り消しは確認を挟むまで叩かない」を足している。
 */
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

    // **`/access/:id/owner/revoke` は `/revoke` を部分文字列に含む**ので、owner 系を除く。
    const nonOwnerUrls = stub.calls.filter((url) => !url.includes('/owner'));
    expect(nonOwnerUrls.some((url) => /\/access\/[^/]+\/grant$/.test(url))).toBe(false);
    expect(nonOwnerUrls.some((url) => /\/access\/[^/]+\/revoke$/.test(url))).toBe(false);
  });

  it('未許可のアカウントは「許可する」を押すと POST /access/:id/grant を叩く', async () => {
    const stub = stubAccessAndGrant([
      account({ id: 'acct-b', grantedAt: null, grantedBy: null, granted: false }),
    ]);

    await renderAccess();
    fireEvent.click(screen.getByText('許可する'));

    await waitForCall(stub.calls, /\/access\/acct-b\/grant$/);
  });

  it('許可済みのアカウントの取り消しは、確認の一手を挟むまで叩かない', async () => {
    const stub = stubAccessAndGrant([account({ id: 'acct-a', granted: true })]);

    await renderAccess();
    fireEvent.click(screen.getByText('許可を取り消す'));

    // 1回目の押下では叩かない。確認の文言と「本当に取り消す」が出る。
    expect(stub.calls.some((url) => /\/access\/acct-a\/revoke$/.test(url))).toBe(false);
    expect(screen.getByText(/その場では戻せない/)).toBeTruthy();

    // やめれば元に戻り、叩かない。
    fireEvent.click(screen.getByText('やめる'));
    expect(screen.getByText('許可を取り消す')).toBeTruthy();
    expect(stub.calls.some((url) => /\/access\/acct-a\/revoke$/.test(url))).toBe(false);

    // 確認してから叩く。
    fireEvent.click(screen.getByText('許可を取り消す'));
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

/**
 * **実行環境の持ち主としての宣言・取り消し（issue #1198）。**
 *
 * Web UI から叩くと `requireOperator` を構造的に満たせないので必ず 403 になる
 * ——ここでは「叩く URL が正しいこと」と「403 のときアカウント id 入りの
 * 端末コマンドを案内すること」を固定する（`OwnerDeclarationControl` の doc）。
 */
describe('/access 画面 — 実行環境の持ち主としての宣言', () => {
  function stubAccessAndOwner(options: {
    accounts: unknown[];
    ownerStatus?: number;
    ownerBody?: unknown;
  }) {
    const { accounts, ownerStatus = 403, ownerBody } = options;
    const body = ownerBody ?? { error: '実行環境の持ち主だけが操作できる' };
    return stubFetch((url) => {
      if (url.includes('/owner')) return json(body, ownerStatus);
      if (url.includes('/access')) return json({ accounts }, 200);
      return undefined;
    });
  }

  it('未宣言のアカウントには「実行環境の持ち主として宣言する」ボタンが出る', async () => {
    stubAccessAndOwner({ accounts: [account({ id: 'acct-a', ownerDeclaredAt: null })] });

    await renderAccess();

    expect(screen.getByText('実行環境の持ち主として宣言する')).toBeTruthy();
  });

  it('宣言済みのアカウントには「実行環境の持ち主としての宣言を取り消す」ボタンが出る', async () => {
    stubAccessAndOwner({
      accounts: [account({ id: 'acct-a', ownerDeclaredAt: '2026-09-18T00:00:00.000Z' })],
    });

    await renderAccess();

    expect(screen.getByText('実行環境の持ち主としての宣言を取り消す')).toBeTruthy();
  });

  it('宣言するボタンを押すと POST /access/:id/owner を叩き、403 でアカウント id 入りの案内を出す', async () => {
    const stub = stubAccessAndOwner({
      accounts: [account({ id: 'acct-a', ownerDeclaredAt: null })],
    });

    await renderAccess();
    fireEvent.click(screen.getByText('実行環境の持ち主として宣言する'));

    await screen.findByRole('alert');
    const entry = stub.entries.find((e) => e.url === 'http://daemon.test/access/acct-a/owner');
    expect(entry?.request?.method).toBe('POST');
    expect(screen.getByText('alteroid access owner acct-a')).toBeTruthy();
  });

  it('取り消すボタンを押すと POST /access/:id/owner/revoke を叩き、403 で --revoke 付きの案内を出す', async () => {
    const stub = stubAccessAndOwner({
      accounts: [account({ id: 'acct-a', ownerDeclaredAt: '2026-09-18T00:00:00.000Z' })],
    });

    await renderAccess();
    fireEvent.click(screen.getByText('実行環境の持ち主としての宣言を取り消す'));

    await screen.findByRole('alert');
    const entry = stub.entries.find(
      (e) => e.url === 'http://daemon.test/access/acct-a/owner/revoke',
    );
    expect(entry?.request?.method).toBe('POST');
    expect(screen.getByText('alteroid access owner acct-a --revoke')).toBeTruthy();
  });

  /**
   * **404（該当するアカウントが無い）では、この案内を出さない。** `isNotOperator`
   * は 403 だけを見る——判別できない/別の理由の失敗にまで当てずっぽうで
   * 端末コマンドを出すと嘘の案内になる（`apps/cli/src/target.ts` の
   * `ForbiddenKind` と同じ考え方）。
   */
  it('403 以外（404）では、端末コマンドの案内を出さない', async () => {
    stubAccessAndOwner({
      accounts: [account({ id: 'acct-a', ownerDeclaredAt: null })],
      ownerStatus: 404,
      ownerBody: { error: 'not found' },
    });

    await renderAccess();
    fireEvent.click(screen.getByText('実行環境の持ち主として宣言する'));

    await screen.findByRole('alert');
    expect(screen.queryByText('alteroid access owner acct-a')).toBeNull();
  });
});
