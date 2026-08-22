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
