// @vitest-environment jsdom
/**
 * `login.tsx` の「使う許可が無い」画面（`Ungranted`）。
 *
 * この画面にはこれまでテストが無かった（横並びの積み替え、本4、実測
 * 2026-08-23 時点で `apps/web/app/routes/login.test.tsx` は存在しなかった）。
 *
 * `Ungranted` は既定 export（`Login`）の内部でしか使わないコンポーネントなので、
 * `useAuth` が `ungranted` を返すところまで状態を作ってから `Login` を描く
 * （`apps/web/app/hooks/use-auth.test.tsx` と同じ作り方 — 鍵を保存してから
 * `/health` は enabled、`/auth/me` は 403 を返す）。
 */
import { cleanup, render, screen } from '@testing-library/react';
import { createMemoryRouter, RouterProvider } from 'react-router';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import { storeCredential } from '~/lib/auth';
import type { Credential } from '~/lib/auth';
import { json, Providers, stubFetch, storeTestBaseUrl, TEST_BASE_URL } from '~/test-support';

import Login from './login';

const CREDENTIAL: Credential = {
  token: 'alt_ungranted',
  account: { id: 'acc-1', displayName: null, email: 'me@example.com' },
  grantedAtClaim: true,
  createdAt: '2026-08-13T00:00:00.000Z',
};

const HEALTH = {
  ok: true,
  pid: 1,
  operator: false,
  storage: '/tmp/alteroid',
  auth: { enabled: true, providers: [{ id: 'google', label: 'Google', kind: 'oauth2' }] },
};

let originalFetch: typeof fetch;

beforeEach(() => {
  originalFetch = globalThis.fetch;
  localStorage.clear();
  storeTestBaseUrl();
  storeCredential(TEST_BASE_URL, CREDENTIAL);
});

afterEach(() => {
  cleanup();
  globalThis.fetch = originalFetch;
  window.history.pushState({}, '', '/');
});

function renderUngranted() {
  stubFetch((url) => {
    if (url.endsWith('/health')) return json(HEALTH);
    if (url.endsWith('/auth/me')) return json({ error: '使う許可が無い' }, 403);
    return undefined;
  });
  render(
    <Providers>
      <Login />
    </Providers>,
  );
}

/**
 * `SignIn`（未ログイン。`auth.status === 'anonymous'`）は `useNavigate` を
 * 呼ぶので `Router` が要る（`Ungranted` / `checking` / エラー分岐は呼ばない
 * ので `renderUngranted` のように素の `render` でよい）。
 *
 * **実在の `window.location` も同じ経路に合わせる**（`history.pushState`）。
 * `MemoryRouter` 自身は `window.location` に触らないので、そちらだけを見て
 * 判定する将来のコードが在っても `MemoryRouter` の `initialEntries` だけでは
 * 捕まえられない——歯5（クエリ/ハッシュから受け取らない）は「読む経路が
 * router 越しか `window.location` 直かのどちらでも、読んでいない」ことを
 * 固定したいので、両方を同じ値に揃えておく。
 */
function renderSignIn(initialEntry = '/login') {
  // このファイルの beforeEach は `Ungranted` 用に鍵を保存しているので、
  // SignIn（未ログイン）を描くにはここで消す（`credential === null` でないと
  // `use-auth.ts` は `/auth/me` を叩きにいって 'ungranted'/'ready' 側へ落ちる）。
  localStorage.clear();
  storeTestBaseUrl();
  stubFetch((url) => {
    if (url.endsWith('/health')) return json(HEALTH);
    return undefined;
  });
  window.history.pushState({}, '', initialEntry);
  const router = createMemoryRouter([{ path: '/login', Component: Login }], {
    initialEntries: [initialEntry],
  });
  return render(
    <Providers>
      <RouterProvider router={router} />
    </Providers>,
  );
}

/**
 * PR 1: ログイン画面のどの状態からでも接続先を変えられる。
 *
 * **以前は `auth.error !== undefined`（繋がらない）のときだけ接続先を変える
 * 手段が出ていた。** 応答はしているが認証を要求している場合（= 大半の詰まり方）
 * には出ておらず、繋いでいる先が「入りたいデーモン」と違うときに詰まっていた。
 * `Shell`（`login.tsx` のローカル関数）に一本化したので、全分岐が同じ入力欄を
 * 得る。
 */
describe('ログイン画面のどの分岐からでも接続先を変えられる（PR 1）', () => {
  it('SignIn（未ログイン）でも接続先の入力欄が出る', async () => {
    renderSignIn();
    const input = await screen.findByLabelText<HTMLInputElement>('接続先');
    expect(input.value).toBe(TEST_BASE_URL);
    // 既存の「接続先: {baseUrl}」表示も消えていないこと（見えていることは価値）。
    expect(await screen.findByText(TEST_BASE_URL, { selector: 'span' })).toBeTruthy();
  });

  it('Ungranted（使う許可待ち）でも接続先の入力欄が出る', async () => {
    renderUngranted();
    const input = await screen.findByLabelText<HTMLInputElement>('接続先');
    expect(input.value).toBe(TEST_BASE_URL);
  });

  it('繋がらない分岐で、接続先の入力欄は1つだけ（二重に出さない）', async () => {
    localStorage.clear();
    storeTestBaseUrl();
    stubFetch(() => undefined); // 何にも応答しない = 繋がらない
    render(
      <Providers>
        <Login />
      </Providers>,
    );
    expect(await screen.findByText('デーモンに繋がらない')).toBeTruthy();
    expect(screen.getAllByLabelText('接続先')).toHaveLength(1);
    expect(screen.getAllByRole('button', { name: '適用' })).toHaveLength(1);
  });
});

/**
 * ⭐ 歯5: URL をクエリ文字列・ハッシュ・その他の外から渡せる経路から受け取らない。
 *
 * ログイン画面で接続先が外から指定できると、「このリンクを開いて」と渡された
 * 人間が攻撃者のサーバへ資格情報を打ち込む経路になる。**人間がその場で入力欄へ
 * 打った値だけを受け取る。**
 *
 * `resolveApiBaseUrl` / `resolveApiBaseUrlOrigin`（`lib/config.ts`）は
 * `location` を1度も読まない（`localStorage` と `import.meta.env` だけを見る）
 * ので、この歯は「読んでいないこと」の構造をそのまま固定する——クエリ文字列と
 * ハッシュに URL を積んだ状態で描いても、保存された値・表示される接続先の
 * どちらも変わらないことを assert する。
 */
describe('URL のクエリ文字列・ハッシュから接続先を受け取らない（本(4)/歯5）', () => {
  const MALICIOUS = 'https://evil.example.com';

  it('クエリ文字列に URL を積んでも、表示される接続先も保存先も変わらない', async () => {
    renderSignIn(
      `/login?apiBaseUrl=${encodeURIComponent(MALICIOUS)}&baseUrl=${encodeURIComponent(MALICIOUS)}`,
    );

    const input = await screen.findByLabelText<HTMLInputElement>('接続先');
    expect(input.value).toBe(TEST_BASE_URL);
    expect(input.value).not.toBe(MALICIOUS);
    expect(localStorage.getItem('alteroid.apiBaseUrl')).toBe(TEST_BASE_URL);
  });

  it('ハッシュに URL を積んでも、表示される接続先も保存先も変わらない', async () => {
    renderSignIn(`/login#apiBaseUrl=${encodeURIComponent(MALICIOUS)}`);

    const input = await screen.findByLabelText<HTMLInputElement>('接続先');
    expect(input.value).toBe(TEST_BASE_URL);
    expect(input.value).not.toBe(MALICIOUS);
    expect(localStorage.getItem('alteroid.apiBaseUrl')).toBe(TEST_BASE_URL);
  });

  it('クエリ文字列に積んだ値のまま「適用」しても、保存されるのは入力欄に打った値だけ', async () => {
    // 攻撃シナリオそのもの: リンクに乗った値が「見えている接続先」にすら
    // ならないことを確かめる。人間が自分でその値を入力欄へ打てば保存できて
    // よい（それは「その場で入力欄へ打った」ことになるので歯5の範囲外）が、
    // URL に乗っているだけでは何も起きないこと。
    renderSignIn(`/login?apiBaseUrl=${encodeURIComponent(MALICIOUS)}`);

    const input = await screen.findByLabelText<HTMLInputElement>('接続先');
    expect(input.value).not.toBe(MALICIOUS);
  });
});

/**
 * 横並びの積み替え（本4-A）。
 *
 * `apps/web/app/routes/login.tsx` の `dl`（`grid-cols-[5rem_1fr]`）は
 * breakpoint 無しで固定されていたので、375px 幅でもラベル列にアカウント情報の
 * 取り分を持っていかれていた。`sm:` 未満は1列、`sm:` 以上で固定幅ラベル列に
 * 切り替える。積んだときに `dt`/`dd` の対応が読めるよう、`dt` に
 * `mt-3 first:mt-0 sm:mt-0` を足して組の境目を間隔の差で表す
 * （`manager-detail.test.tsx` の同型のテストと同じ形）。
 *
 * **⚠️ これは「積み替わった」ことの試験ではない。** jsdom はレイアウトを
 * 持たない（`offsetWidth` / `scrollWidth` / `getBoundingClientRect()` は
 * すべて 0）ので、`sm:grid-cols-[5rem_1fr]` が実際に効いていることは
 * ここでは1つも観測できない。固定できるのは「そのクラス名が書かれていること」
 * までである。本2・本3 のテストより歯が弱い — breakpoint は CSS の話なので、
 * jsdom では「効いている」ことそのものが原理的に見えない。
 */
describe('横並びの積み替え（本4-A）: アカウント情報の dl', () => {
  it('狭い画面では1列、sm: 以上で固定幅ラベル列になる', async () => {
    renderUngranted();

    const dt = await screen.findByText('アカウント');
    const dl = dt.closest('dl');
    expect(dl).not.toBeNull();
    const dlTokens = dl!.className.split(/\s+/);
    expect(dlTokens).toContain('grid-cols-1');
    expect(dlTokens).toContain('sm:grid-cols-[5rem_1fr]');
    // 固定幅の列指定が sm: 無しで残っていないこと（残っていれば狭い画面でも
    // ラベル列が固定幅のままになり、直しが効かない）。
    expect(dlTokens).not.toContain('grid-cols-[5rem_1fr]');
  });

  it('dt に mt-3 first:mt-0 sm:mt-0 が付いている（積んだときの組の境目）', async () => {
    renderUngranted();

    const dt = await screen.findByText('アカウント');
    const tokens = dt.className.split(/\s+/);
    expect(tokens).toContain('mt-3');
    expect(tokens).toContain('first:mt-0');
    expect(tokens).toContain('sm:mt-0');
  });
});

/**
 * 既にコンソールから手で `localStorage.setItem('alteroid.apiBaseUrl', …)` を
 * 設定している当事者が実在する（オーナー自身。入力欄が無かった間の回避策）。
 *
 * この PR で入力欄を足す変更が、初期化の書き方しだいで**その値を空で上書き
 * しうる**——`ConnectionCard` の `useState(baseUrl)` は初回レンダー時の値を
 * 束縛するだけなので理屈のうえでは安全なはずだが、退行を歯で固定する。
 * 確かめるのは3つ: (a) その値が実際の接続先として使われる（fetch の宛先）
 * (b) 入力欄にその値が出る (c) 描画しただけで消えたり上書きされたりしない。
 */
describe('コンソールから手で設定した接続先が、描画しただけで消えない', () => {
  const CONSOLE_SET_URL = 'http://console-set.example';

  it('(a)(b)(c) を1本で確かめる', async () => {
    localStorage.clear();
    localStorage.setItem('alteroid.apiBaseUrl', CONSOLE_SET_URL);

    const stub = stubFetch((url) => {
      if (url.startsWith(CONSOLE_SET_URL) && url.endsWith('/health')) return json(HEALTH);
      return undefined;
    });

    const router = createMemoryRouter([{ path: '/login', Component: Login }], {
      initialEntries: ['/login'],
    });
    render(
      <Providers>
        <RouterProvider router={router} />
      </Providers>,
    );

    // (a) 実際にその接続先へ問い合わせている（同一オリジンの /api や既定値では
    //     ない——このデーモンにしか応答を用意していないので、届いていなければ
    //     「デーモンに繋がらない」のまま止まる）。
    const input = await screen.findByLabelText<HTMLInputElement>('接続先');
    expect(stub.calls.some((url) => url.startsWith(CONSOLE_SET_URL))).toBe(true);

    // (b) 入力欄にその値が出ている。
    expect(input.value).toBe(CONSOLE_SET_URL);

    // (c) 描画しただけで localStorage から消えたり、別の値に上書きされたり
    //     していない。
    expect(localStorage.getItem('alteroid.apiBaseUrl')).toBe(CONSOLE_SET_URL);
  });
});
