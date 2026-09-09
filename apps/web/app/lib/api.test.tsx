// @vitest-environment jsdom
/**
 * PR 1 の本(4): 保存の後、本当に切り替わるか。
 *
 * `hooks/queries.ts` の SWR キーは接続先を含まない（`useAuth` の `authState`
 * キーだけが例外で `baseUrl` を持つ）。だから `ApiProvider.setBaseUrl` が
 * キャッシュへ何もしなければ、接続先を切り替えた後も**前の接続先で取れた
 * 応答がそのまま表示され続ける** — 次にキーが変わる・フォーカスが戻る・
 * 30秒間隔の再検証が来るまで、画面は「切り替わった」ふりだけをする。
 *
 * `ApiProvider` は接続先が変わった effect で `mutate(() => true)` を呼び、
 * 全キーを引き直す（`lib/api.tsx` の該当コメント）。ここではそれが実際に
 * 効くこと——再読み込み無しで新しい接続先の応答に置き換わること——を、
 * `useHealth`（キーに接続先を含まない代表）で確かめる。
 */
import { cleanup, render, screen, waitFor } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import { useHealth } from '~/hooks/queries';
import { json, Providers, stubFetch, storeTestBaseUrl, TEST_BASE_URL } from '~/test-support';

import { useApiContext } from './api';

const OTHER_BASE_URL = 'http://daemon-2.test';

function health(pid: number, storage: string) {
  return { ok: true, pid, operator: false, storage, auth: { enabled: false, providers: [] } };
}

/** 接続先と、その接続先の `useHealth()` の値を出すだけの部品。 */
function Probe() {
  const { baseUrl, setBaseUrl } = useApiContext();
  const { data } = useHealth();
  return (
    <div>
      <p data-testid="base-url">{baseUrl}</p>
      <p data-testid="pid">{data?.pid ?? 'loading'}</p>
      <button type="button" onClick={() => setBaseUrl(OTHER_BASE_URL)}>
        switch
      </button>
    </div>
  );
}

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

describe('接続先を切り替えたら、キャッシュに残った古い応答を捨てて引き直す（本4）', () => {
  it('health の pid が新しい接続先の値に変わる（読み込み直しは要らない）', async () => {
    const stub = stubFetch((url) => {
      if (url.startsWith(TEST_BASE_URL) && url.includes('/health')) {
        return json(health(1, '/old'));
      }
      if (url.startsWith(OTHER_BASE_URL) && url.includes('/health')) {
        return json(health(2, '/new'));
      }
      return undefined;
    });

    render(
      <Providers>
        <Probe />
      </Providers>,
    );

    await waitFor(() => expect(screen.getByTestId('pid').textContent).toBe('1'));

    screen.getByRole('button', { name: 'switch' }).click();

    await waitFor(() => expect(screen.getByTestId('base-url').textContent).toBe(OTHER_BASE_URL));
    // ここが本体: 前の接続先（pid 1）に留まらず、新しい接続先（pid 2）へ変わること。
    await waitFor(() => expect(screen.getByTestId('pid').textContent).toBe('2'));

    expect(stub.calls.some((url) => url === `${OTHER_BASE_URL}/health`)).toBe(true);
  });
});
