// @vitest-environment jsdom
/**
 * 失効した鍵の後始末。
 *
 * 401 は「未ログイン」という**正常な状態**として返しているので、共通の失敗
 * ハンドラには届かない。だからここで捨てないと、認証を確かめる主要な経路だけが
 * 「401 なら鍵を捨てる」という約束から外れ、失効した秘密が保存先に残り続ける。
 *
 * 403 は事情が違う（鍵は有効で、許可が無いだけ）。捨てると、やり直しても解決
 * しないログインへ人を戻すことになるので、**そちらは捨てない**。
 */
import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import { useAuth } from '~/hooks/use-auth';
import { useApiContext } from '~/lib/api';
import { json, Providers, stubFetch, storeTestBaseUrl, TEST_BASE_URL } from '~/test-support';
import type { Credential } from '~/lib/auth';

const CREDENTIAL: Credential = {
  token: 'alt_expired',
  account: { id: 'acc-1', displayName: null, email: 'me@example.com' },
  grantedAtClaim: true,
  createdAt: '2026-08-13T00:00:00.000Z',
};

const CREDENTIAL_KEY = `alteroid.credential:${TEST_BASE_URL}`;

const HEALTH = {
  ok: true,
  pid: 1,
  operator: false,
  storage: '/tmp/alteroid',
  auth: { enabled: true, providers: [{ id: 'google', label: 'Google', kind: 'oauth2' }] },
};

function Probe() {
  const auth = useAuth();
  return <div data-testid="status">{auth.status}</div>;
}

function renderProbe() {
  return render(
    <Providers>
      <Probe />
    </Providers>,
  );
}

let originalFetch: typeof fetch;

beforeEach(() => {
  originalFetch = globalThis.fetch;
  localStorage.clear();
  storeTestBaseUrl();
  localStorage.setItem(CREDENTIAL_KEY, JSON.stringify(CREDENTIAL));
});

afterEach(() => {
  cleanup();
  globalThis.fetch = originalFetch;
});

describe('保存済みの鍵が失効していたとき（/auth/me が 401）', () => {
  it('未ログインへ戻り、鍵を保存先から捨て、以降は資格情報を付けない', async () => {
    const stub = stubFetch((url) => {
      if (url.endsWith('/health')) return json(HEALTH);
      if (url.endsWith('/auth/me')) return json({ error: 'トークンが無効か期限切れ' }, 401);
      return undefined;
    });

    renderProbe();

    // ① 未ログインになる
    await waitFor(() => {
      expect(screen.getByTestId('status').textContent).toBe('anonymous');
    });

    // ② その接続先の鍵が保存先から消えている
    await waitFor(() => {
      expect(localStorage.getItem(CREDENTIAL_KEY)).toBeNull();
    });

    // ③ 捨てたあとに作られたクライアントは資格情報を付けない
    await waitFor(() => {
      const later = stub.entries.filter((entry) => entry.url.endsWith('/health')).at(-1);
      expect(later?.authorization).toBeNull();
    });
    // 最初は付けていた（＝付けない状態が「元々付いていない」ではないこと）
    expect(stub.entries[0]?.authorization).toBe('Bearer alt_expired');

    // 捨てたあとに `/auth/me` を叩き直していない（鍵が無いのだから聞く相手が無い）
    expect(stub.entries.filter((entry) => entry.url.endsWith('/auth/me'))).toHaveLength(1);
  });
});

describe('許可が無いとき（/auth/me が 403）', () => {
  it('鍵は捨てない（やり直しても解決しないログインへ戻さない）', async () => {
    stubFetch((url) => {
      if (url.endsWith('/health')) return json(HEALTH);
      if (url.endsWith('/auth/me')) return json({ error: '使う許可が無い' }, 403);
      return undefined;
    });

    renderProbe();

    await waitFor(() => {
      expect(screen.getByTestId('status').textContent).toBe('ungranted');
    });
    expect(localStorage.getItem(CREDENTIAL_KEY)).not.toBeNull();
  });
});

describe('認証を要求していないデーモン', () => {
  it('鍵の有無に関わらず open になる', async () => {
    stubFetch((url) => {
      if (url.endsWith('/health')) {
        return json({ ...HEALTH, operator: true, auth: { enabled: false, providers: [] } });
      }
      return undefined;
    });

    renderProbe();

    await waitFor(() => {
      expect(screen.getByTestId('status').textContent).toBe('open');
    });
    // 認証を確かめに行く必要が無い
    expect(localStorage.getItem(CREDENTIAL_KEY)).not.toBeNull();
  });
});

describe('接続先を切り替えた後に、古い相手の 401 が届いたとき', () => {
  const OTHER = 'http://other.test';
  const OTHER_KEY = `alteroid.credential:${OTHER}`;
  const OTHER_CREDENTIAL: Credential = {
    token: 'alt_other_valid',
    account: { id: 'acc-2', displayName: null, email: 'other@example.com' },
    grantedAtClaim: true,
    createdAt: '2026-08-13T00:00:00.000Z',
  };

  function Switcher() {
    const auth = useAuth();
    const { baseUrl, setBaseUrl } = useApiContext();
    return (
      <div>
        <div data-testid="status">{auth.status}</div>
        <div data-testid="base">{baseUrl}</div>
        <button type="button" onClick={() => setBaseUrl(OTHER)}>
          切り替える
        </button>
      </div>
    );
  }

  /**
   * **有効な鍵を巻き添えにしない。**
   *
   * 401 は「その接続先の、その鍵は通らない」という事実にすぎない。遅れて届いた
   * ものをそのまま今の状態へ当てはめると、既に切り替えて読み込んだ有効な鍵まで
   * 消え、読み込み直すまで戻れなくなる。
   */
  it('切り替えた先の鍵と認証状態を保つ', async () => {
    localStorage.setItem(OTHER_KEY, JSON.stringify(OTHER_CREDENTIAL));

    let answerOld: ((response: Response) => void) | undefined;
    const oldMe = new Promise<Response>((resolve) => {
      answerOld = resolve;
    });

    const stub = stubFetch((url) => {
      if (url.endsWith('/health')) return json(HEALTH);
      // 切り替え前の相手は、まだ返事をしない
      if (url.startsWith(TEST_BASE_URL) && url.endsWith('/auth/me')) return oldMe;
      if (url.startsWith(OTHER) && url.endsWith('/auth/me')) {
        return json({ kind: 'account', account: OTHER_CREDENTIAL.account, granted: true });
      }
      return undefined;
    });

    render(
      <Providers>
        <Switcher />
      </Providers>,
    );

    // 切り替え前は返事待ち
    await waitFor(() => {
      expect(stub.calls.some((url) => url === `${TEST_BASE_URL}/auth/me`)).toBe(true);
    });

    fireEvent.click(screen.getByRole('button', { name: '切り替える' }));

    await waitFor(() => {
      expect(screen.getByTestId('base').textContent).toBe(OTHER);
      expect(screen.getByTestId('status').textContent).toBe('ready');
    });

    // ここで古い相手が 401 を返す
    answerOld?.(json({ error: 'トークンが無効か期限切れ' }, 401));
    await new Promise((resolve) => setTimeout(resolve, 50));

    // 切り替えた先は無傷
    expect(screen.getByTestId('status').textContent).toBe('ready');
    expect(localStorage.getItem(OTHER_KEY)).not.toBeNull();
    // 古い方の鍵は（実際に無効なので）捨ててよい
    expect(localStorage.getItem(CREDENTIAL_KEY)).toBeNull();

    // 以降も切り替えた先の鍵を提示し続ける
    const last = stub.entries.filter((entry) => entry.url.startsWith(OTHER)).at(-1);
    expect(last?.authorization).toBe(`Bearer ${OTHER_CREDENTIAL.token}`);
  });
});
