// @vitest-environment jsdom
/**
 * `/profile` — 実行環境プロファイル本文を Web UI から読む・直す画面（issue #1122）。
 *
 * **資格の分岐がこの画面の主題である。** `GET`/`PUT /profile` は
 * `requireOperator`——認証が有効な構成では、ブラウザのログインは必ず
 * `kind:'account'` になり、この2本は常に 403 になる（`authenticate` が
 * `kind:'operator'` を付けるのは状態ファイルの token か `ALTEROID_AUTH=off`
 * のときだけ）。だから画面は `useAuth()`（`GET /auth/me` を土台にする、Web が
 * 既に持っていた「自分は誰か」の口）の `operator` で先に分岐する:
 *
 * - **account としてログイン**（`operator: false`）——案内だけを出し、
 *   `GET /profile` そのものを叩かない・編集 UI（textarea／保存）も出さない
 * - **operator**（`ALTEROID_AUTH=off`）——いまの閲覧・編集 UI をそのまま出す
 *   （本文が無ければそう言う・在ればバイト数・sha256・更新時刻を出す・
 *   確認語 `apply` を打つまで `PUT` を叩かない・叩けば1回だけ新しい本文で
 *   叩く・クローン/runner への反映結果を成否を畳まずに出す）
 * - **operator のはずが `GET`/`PUT` が 403 を返した**（判定の食い違い）——
 *   生のエラーを `ErrorNote` には出さず、account と同じ案内へ倒す
 *
 * **共有の `stubFetch` は使えない。** `openapi-fetch` は `fetch(new
 * Request(...))` の形で呼ぶので、素朴な `route(url, init)` だと method も
 * 本文も落ちる（`env-vars.test.tsx` の同じ断り書きと同じ理由）。ここでは
 * `globalThis.fetch` を自分で差し替える。
 */
import { cleanup, fireEvent, render, screen } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import type { Credential } from '~/lib/auth';
import { json, Providers, storeTestBaseUrl, TEST_BASE_URL } from '~/test-support';

import Profile from './profile';

let originalFetch: typeof fetch;

/** `alteroid.credential:<baseUrl>` の形（`use-auth.test.tsx` と同じ）。 */
const CREDENTIAL_KEY = `alteroid.credential:${TEST_BASE_URL}`;

const ACCOUNT_CREDENTIAL: Credential = {
  token: 'alt_account_token',
  account: { id: 'acc-1', displayName: null, email: 'me@example.com' },
  grantedAtClaim: true,
  createdAt: '2026-09-14T00:00:00.000Z',
};

/** 案内文言の中で、CLI の代替手段を名指しする部分（3ケース共通で探す）。 */
const NOTICE_TEXT = 'docker compose exec app alteroid profile edit';

beforeEach(() => {
  originalFetch = globalThis.fetch;
  localStorage.clear();
  storeTestBaseUrl();
});

afterEach(() => {
  cleanup();
  globalThis.fetch = originalFetch;
});

interface StubProfileView {
  script: string;
  updatedAt?: string;
  sha256?: string;
  bytes?: number;
}

interface StubPutOutcome {
  ok: boolean;
  error?: string;
  output?: string;
}

type AuthMode =
  /** `ALTEROID_AUTH=off` 相当。principal は常に operator。 */
  | { kind: 'operator' }
  /** 認証が有効で、account としてログイン済み（operator ではない）。 */
  | { kind: 'account' };

const OPERATOR_HEALTH = {
  ok: true,
  pid: 1,
  operator: true,
  storage: '/tmp/alteroid',
  auth: { enabled: false, providers: [] },
};

const ACCOUNT_HEALTH = {
  ok: true,
  pid: 1,
  operator: false,
  storage: '/tmp/alteroid',
  auth: { enabled: true, providers: [{ id: 'google', label: 'Google', kind: 'oauth2' }] },
};

/**
 * **状態を持つ** `/profile` の stub。`PUT` を受けたら以降の `GET`（再検証も
 * 含む）がその状態を返す——`env-vars.test.tsx` の `stubCrudScreen` と同じ形。
 *
 * `/health` と `/auth/me` も併せて答える——`Profile` は `useAuth()` で先に
 * `operator` かどうかを見るようになったので、これらを答えないと `checking`
 * のまま止まる。**既定は `auth: { kind: 'operator' }`。** 既存の編集系の歯が
 * 「operator なら今までどおり」であることを固定するためのものなので、明示
 * しない限りそちら側にしておく——account 側を試す歯だけが明示的に
 * `{ auth: { kind: 'account' } }` を渡す。
 */
function stubProfileScreen(
  initial: StubProfileView,
  options: {
    auth?: AuthMode;
    getStatus?: number;
    putStatus?: number;
    putErrorBody?: { error: string; detail: string };
    cloneOutcome?: StubPutOutcome;
    runnerOutcomes?: (StubPutOutcome & { runnerId: string })[];
  } = {},
) {
  let current = initial;
  const puts: { script: string }[] = [];
  const calls: string[] = [];
  const {
    auth = { kind: 'operator' },
    getStatus = 200,
    putStatus,
    putErrorBody,
    cloneOutcome,
    runnerOutcomes = [],
  } = options;

  if (auth.kind === 'account') {
    localStorage.setItem(CREDENTIAL_KEY, JSON.stringify(ACCOUNT_CREDENTIAL));
  }

  globalThis.fetch = (async (input: RequestInfo | URL, init?: RequestInit) => {
    const request = input instanceof Request ? input : null;
    const url = request?.url ?? (typeof input === 'string' ? input : String(input));
    const method = request?.method ?? init?.method ?? 'GET';
    calls.push(url);

    if (url.includes('/health')) {
      return json(auth.kind === 'operator' ? OPERATOR_HEALTH : ACCOUNT_HEALTH);
    }
    if (url.includes('/auth/me')) {
      return json(
        auth.kind === 'operator'
          ? { kind: 'operator' }
          : { kind: 'account', account: ACCOUNT_CREDENTIAL.account, granted: true },
      );
    }

    if (!url.includes('/profile')) {
      return Promise.reject(new TypeError(`Failed to fetch: ${url}`));
    }
    if (method === 'GET') {
      if (getStatus !== 200) return json({ error: '実行環境の持ち主だけが操作できる' }, getStatus);
      return json(current);
    }
    if (method === 'PUT') {
      const body = (request !== null ? await request.json() : JSON.parse(String(init?.body))) as {
        script: string;
      };
      puts.push(body);
      if (putStatus !== undefined && putStatus !== 200) {
        return json(putErrorBody ?? { error: '保存できなかった', detail: '' }, putStatus);
      }
      current = {
        script: body.script,
        updatedAt: '2026-09-24T00:00:00.000Z',
        sha256: 'f'.repeat(12),
        bytes: body.script.length,
      };
      return json({
        updatedAt: current.updatedAt,
        sha256: current.sha256,
        bytes: current.bytes,
        clone: cloneOutcome ?? { ok: true },
        runners: runnerOutcomes,
      });
    }
    return json(current);
  }) as typeof fetch;

  return { puts, calls };
}

async function waitForLoaded(): Promise<void> {
  await screen.findByRole('heading', { name: 'いまの状態' });
}

async function waitForNotice(): Promise<void> {
  await screen.findByText(new RegExp(NOTICE_TEXT.replace(/\s/g, '\\s')));
}

function textareaValue(): string {
  return (screen.getByLabelText('プロファイル本文') as HTMLTextAreaElement).value;
}

describe('/profile 画面 — operator ではない（account としてログイン）', () => {
  it('【歯a】案内を出し、GET /profile を叩かず、編集 UI（textarea・保存）も出さない', async () => {
    const { calls } = stubProfileScreen(
      { script: 'export TZ=Asia/Tokyo' },
      { auth: { kind: 'account' } },
    );

    render(
      <Providers>
        <Profile />
      </Providers>,
    );
    await waitForNotice();

    expect(screen.queryByLabelText('プロファイル本文')).toBeNull();
    expect(screen.queryByRole('button', { name: '保存する' })).toBeNull();
    expect(screen.queryByRole('heading', { name: 'いまの状態' })).toBeNull();
    // `/auth/me` は叩くが `/profile` は一度も叩かない。
    expect(calls.some((url) => url.includes('/auth/me'))).toBe(true);
    expect(calls.some((url) => url.includes('/profile'))).toBe(false);
  });
});

describe('/profile 画面 — operator（ALTEROID_AUTH=off）', () => {
  it('【歯b】いまの閲覧・編集 UI をそのまま出す', async () => {
    stubProfileScreen({
      script: 'export TZ=Asia/Tokyo',
      updatedAt: '2026-09-14T00:00:00.000Z',
      sha256: 'a'.repeat(12),
      bytes: 21,
    });

    render(
      <Providers>
        <Profile />
      </Providers>,
    );
    await waitForLoaded();

    expect(textareaValue()).toBe('export TZ=Asia/Tokyo');
    expect(screen.getByRole('button', { name: '変更なし' })).toBeTruthy();
    expect(screen.queryByText(NOTICE_TEXT)).toBeNull();
  });

  it('本文が空なら「置かれていません」と言う', async () => {
    stubProfileScreen({ script: '' });

    render(
      <Providers>
        <Profile />
      </Providers>,
    );
    await waitForLoaded();

    expect(await screen.findByText('置かれていません。')).toBeTruthy();
  });

  it('本文が在ればバイト数・sha256・更新時刻を出す', async () => {
    stubProfileScreen({
      script: 'export TZ=Asia/Tokyo',
      updatedAt: '2026-09-14T00:00:00.000Z',
      sha256: 'a'.repeat(12),
      bytes: 21,
    });

    render(
      <Providers>
        <Profile />
      </Providers>,
    );
    await waitForLoaded();

    expect(await screen.findByText(/sha256 a{12}/)).toBeTruthy();
    expect(textareaValue()).toBe('export TZ=Asia/Tokyo');
  });
});

describe('/profile 画面 — operator 扱いでも 403 が返った（判定の食い違い）', () => {
  it('【歯c】GET /profile の 403 は ErrorNote ではなく案内を出す（編集 UI も隠す）', async () => {
    stubProfileScreen({ script: '' }, { getStatus: 403 });

    render(
      <Providers>
        <Profile />
      </Providers>,
    );
    await waitForNotice();

    expect(screen.queryByText('実行環境の持ち主だけが操作できる')).toBeNull();
    expect(screen.queryByLabelText('プロファイル本文')).toBeNull();
  });
});

describe('/profile 画面 — 編集と確認', () => {
  async function openDialogWithDraft(draft: string): Promise<void> {
    fireEvent.change(screen.getByLabelText('プロファイル本文'), { target: { value: draft } });
    const label = draft.trim().length === 0 ? 'プロファイルを外す' : '保存する';
    fireEvent.click(screen.getByRole('button', { name: label }));
    await screen.findByPlaceholderText('apply');
  }

  it('【歯1】確認語（apply）を打つまで PUT /profile を叩かない', async () => {
    const { puts } = stubProfileScreen({ script: '' });
    render(
      <Providers>
        <Profile />
      </Providers>,
    );
    await waitForLoaded();

    await openDialogWithDraft('export TZ=Asia/Tokyo');
    fireEvent.change(screen.getByPlaceholderText('apply'), { target: { value: 'appl' } });
    const confirmButton = screen.getByRole('button', {
      name: '本当に反映する',
    }) as HTMLButtonElement;
    expect(confirmButton.disabled).toBe(true);

    fireEvent.click(confirmButton);
    await new Promise((resolve) => setTimeout(resolve, 0));
    expect(puts).toEqual([]);
  });

  it('【歯2】確認語が一致すると押せて、PUT /profile を1回、新しい本文で叩く', async () => {
    const { puts } = stubProfileScreen(
      { script: '' },
      { cloneOutcome: { ok: true }, runnerOutcomes: [{ runnerId: 'runner-primary', ok: true }] },
    );
    render(
      <Providers>
        <Profile />
      </Providers>,
    );
    await waitForLoaded();

    await openDialogWithDraft('export TZ=Asia/Tokyo');
    fireEvent.change(screen.getByPlaceholderText('apply'), { target: { value: 'apply' } });
    const confirmButton = screen.getByRole('button', {
      name: '本当に反映する',
    }) as HTMLButtonElement;
    expect(confirmButton.disabled).toBe(false);
    fireEvent.click(confirmButton);

    await screen.findByText('反映しました。');
    expect(puts).toEqual([{ script: 'export TZ=Asia/Tokyo' }]);
  });

  it('本文を空にすると確認文言が「外す」向きになる', async () => {
    stubProfileScreen({
      script: 'export TZ=Asia/Tokyo',
      updatedAt: '2026-09-14T00:00:00.000Z',
      sha256: 'a'.repeat(12),
      bytes: 21,
    });
    render(
      <Providers>
        <Profile />
      </Providers>,
    );
    await waitForLoaded();

    await openDialogWithDraft('');
    expect(await screen.findByText('本当にプロファイルを外しますか？')).toBeTruthy();
  });

  it('クローン・runner への反映結果を、成否を畳まずに出す（失敗を小さく出さない）', async () => {
    stubProfileScreen(
      { script: '' },
      {
        cloneOutcome: { ok: true },
        runnerOutcomes: [{ runnerId: 'runner-2', ok: false, error: '読めなかった' }],
      },
    );
    render(
      <Providers>
        <Profile />
      </Providers>,
    );
    await waitForLoaded();

    await openDialogWithDraft('export TZ=Asia/Tokyo');
    fireEvent.change(screen.getByPlaceholderText('apply'), { target: { value: 'apply' } });
    fireEvent.click(screen.getByRole('button', { name: '本当に反映する' }));

    await screen.findByText('反映しました。');
    expect(screen.getByText('クローン')).toBeTruthy();
    expect(screen.getByText('runner-2')).toBeTruthy();
    expect(screen.getByText('読めなかった')).toBeTruthy();
    expect(screen.getAllByText('反映できませんでした').length).toBeGreaterThan(0);
  });

  it('400（保存できなかった理由つき）は error と detail の両方を出す', async () => {
    stubProfileScreen(
      { script: '' },
      {
        putStatus: 400,
        putErrorBody: {
          error: 'プロファイルが読めなかったので保存していない',
          detail: 'line 3: unexpected token',
        },
      },
    );
    render(
      <Providers>
        <Profile />
      </Providers>,
    );
    await waitForLoaded();

    await openDialogWithDraft('export BROKEN=(');
    fireEvent.change(screen.getByPlaceholderText('apply'), { target: { value: 'apply' } });
    fireEvent.click(screen.getByRole('button', { name: '本当に反映する' }));

    expect(await screen.findByText(/line 3: unexpected token/)).toBeTruthy();
  });

  it('【判定の食い違い】PUT /profile が 403 を返したら、案内へ切り替わる', async () => {
    stubProfileScreen({ script: '' }, { putStatus: 403, putErrorBody: undefined });
    render(
      <Providers>
        <Profile />
      </Providers>,
    );
    await waitForLoaded();

    await openDialogWithDraft('export TZ=Asia/Tokyo');
    fireEvent.change(screen.getByPlaceholderText('apply'), { target: { value: 'apply' } });
    fireEvent.click(screen.getByRole('button', { name: '本当に反映する' }));

    await waitForNotice();
    expect(screen.queryByLabelText('プロファイル本文')).toBeNull();
  });
});
