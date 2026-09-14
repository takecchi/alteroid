// @vitest-environment jsdom
/**
 * `/env-vars` — 環境変数（旧「マネージャーへ降ろす環境変数」）を CLI と同じ
 * 資格で見る・置く・外す画面（2026-09-14 新設）。
 *
 * ここで固定したいのは「secret な行は値を1文字も出さない」「非 secret な行は
 * 値をそのまま出す」「scope バッジが 共通/clone/manager を潰さずに出る」
 * 「置く・外すは既存の `PUT /credentials`（`GET`/`PUT /credentials` と同じ経路）
 * を呼ぶ」の各点。
 */
import { cleanup, fireEvent, render, screen } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import { json, Providers, storeTestBaseUrl } from '~/test-support';

import EnvVars from './env-vars';

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

interface StubEnvVarRow {
  name: string;
  sha256: string;
  updatedAt: string;
  scope: 'all' | 'app' | 'runner';
  secret: boolean;
  value?: string;
  shadowsCloneEnv?: boolean;
}

/**
 * **状態を持つ** `/credentials` の stub。`useSetEnvVar` / `useRemoveEnvVar`
 * （`hooks/mutations.ts`）はどちらも `PUT /credentials` を呼ぶだけなので、PUT を
 * 受けたらその場で一覧を書き換え、以降の GET（再検証も含む）がその状態を返す
 * ようにする。
 *
 * **共有の `stubFetch` は使えない。** `openapi-fetch` は `fetch(new Request(...))`
 * の形で呼ぶので、素朴な `route(url, init)` だと method も本文も落ちる
 * （`tokens.test.tsx` の同じ断り書きと同じ理由）。ここでは `globalThis.fetch`
 * を自分で差し替える。
 */
function stubCrudScreen(initial: StubEnvVarRow[]) {
  let rows = initial;
  const puts: { name: string; value: string; scope?: string; secret?: boolean }[][] = [];

  globalThis.fetch = (async (input: RequestInfo | URL, init?: RequestInit) => {
    const request = input instanceof Request ? input : null;
    const url = request?.url ?? (typeof input === 'string' ? input : String(input));
    const method = request?.method ?? init?.method ?? 'GET';

    if (!url.includes('/credentials')) {
      return Promise.reject(new TypeError(`Failed to fetch: ${url}`));
    }
    if (method === 'PUT') {
      const body = (request !== null ? await request.json() : JSON.parse(String(init?.body))) as {
        credentials: { name: string; value: string; scope?: string; secret?: boolean }[];
      };
      puts.push(body.credentials);
      for (const entry of body.credentials) {
        if (entry.value.length === 0) {
          rows = rows.filter((row) => row.name !== entry.name);
          continue;
        }
        const existing = rows.find((row) => row.name === entry.name);
        const secret = entry.secret ?? existing?.secret ?? true;
        const scope = (entry.scope ?? existing?.scope ?? 'all') as StubEnvVarRow['scope'];
        const updated: StubEnvVarRow = {
          name: entry.name,
          sha256: 'f'.repeat(12),
          updatedAt: '2026-09-14T00:00:00.000Z',
          scope,
          secret,
          ...(secret ? {} : { value: entry.value }),
        };
        rows = [...rows.filter((row) => row.name !== entry.name), updated];
      }
      return json({ credentials: rows });
    }
    return json({ credentials: rows });
  }) as typeof fetch;

  return { puts };
}

async function waitForListLoaded(): Promise<void> {
  await screen.findByRole('heading', { name: '一覧' });
}

describe('/env-vars 画面 — 一覧', () => {
  it('secret な行は値を出さず、指紋だけを出す', async () => {
    stubCrudScreen([
      {
        name: 'GH_TOKEN',
        sha256: 'a'.repeat(12),
        updatedAt: '2026-09-14T00:00:00.000Z',
        scope: 'all',
        secret: true,
      },
    ]);

    render(
      <Providers>
        <EnvVars />
      </Providers>,
    );
    await waitForListLoaded();

    expect(screen.getByText('GH_TOKEN')).toBeTruthy();
    expect(screen.getByText('共通')).toBeTruthy();
    expect(screen.getByText('シークレット')).toBeTruthy();
    expect(screen.getByText(/指紋 sha256=a{12}/)).toBeTruthy();
  });

  it('非 secret な行は値をそのまま出す', async () => {
    stubCrudScreen([
      {
        name: 'TZ',
        sha256: 'b'.repeat(12),
        updatedAt: '2026-09-14T00:00:00.000Z',
        scope: 'app',
        secret: false,
        value: 'Asia/Tokyo',
      },
    ]);

    render(
      <Providers>
        <EnvVars />
      </Providers>,
    );
    await waitForListLoaded();

    expect(screen.getByText('Asia/Tokyo')).toBeTruthy();
    expect(screen.getByText('clone')).toBeTruthy();
    expect(screen.getByText('非シークレット')).toBeTruthy();
  });

  it('runner scope は「manager」と出る', async () => {
    stubCrudScreen([
      {
        name: 'MANAGER_ONLY',
        sha256: 'c'.repeat(12),
        updatedAt: '2026-09-14T00:00:00.000Z',
        scope: 'runner',
        secret: true,
      },
    ]);

    render(
      <Providers>
        <EnvVars />
      </Providers>,
    );
    await waitForListLoaded();

    expect(screen.getByText('manager')).toBeTruthy();
  });

  it('shadowsCloneEnv が立っている行には警告が出る', async () => {
    stubCrudScreen([
      {
        name: 'GH_TOKEN',
        sha256: 'a'.repeat(12),
        updatedAt: '2026-09-14T00:00:00.000Z',
        scope: 'all',
        secret: true,
        shadowsCloneEnv: true,
      },
    ]);

    render(
      <Providers>
        <EnvVars />
      </Providers>,
    );
    await waitForListLoaded();

    expect(await screen.findByText(/優先して配られている/)).toBeTruthy();
  });

  it('1件も無ければ、その旨を言う', async () => {
    stubCrudScreen([]);

    render(
      <Providers>
        <EnvVars />
      </Providers>,
    );
    await waitForListLoaded();

    expect(await screen.findByText('置かれた環境変数がまだ1件も無い。')).toBeTruthy();
  });
});

describe('/env-vars 画面 — 置く・外す', () => {
  it('名前・値・撒く先・シークレット可否を指定して置くと、PUT /credentials が呼ばれ一覧に出る', async () => {
    const { puts } = stubCrudScreen([]);

    render(
      <Providers>
        <EnvVars />
      </Providers>,
    );
    await waitForListLoaded();

    fireEvent.change(screen.getByPlaceholderText('TZ'), { target: { value: 'tz' } });
    fireEvent.change(screen.getByLabelText('値'), { target: { value: 'Asia/Tokyo' } });
    fireEvent.change(screen.getByLabelText('撒く先'), { target: { value: 'app' } });
    fireEvent.click(screen.getByLabelText(/シークレット扱いにする/));
    fireEvent.click(screen.getByRole('button', { name: '置く' }));

    // **名前は大文字化される。**
    expect(await screen.findByText('Asia/Tokyo')).toBeTruthy();
    expect(puts).toEqual([[{ name: 'TZ', value: 'Asia/Tokyo', scope: 'app', secret: false }]]);
  });

  it('外すと、空値の PUT /credentials が呼ばれ一覧から消える', async () => {
    const { puts } = stubCrudScreen([
      {
        name: 'NPM_TOKEN',
        sha256: 'a'.repeat(12),
        updatedAt: '2026-09-14T00:00:00.000Z',
        scope: 'all',
        secret: true,
      },
    ]);

    render(
      <Providers>
        <EnvVars />
      </Providers>,
    );
    await waitForListLoaded();
    expect(await screen.findByText('NPM_TOKEN')).toBeTruthy();

    fireEvent.click(screen.getByRole('button', { name: '外す' }));

    await screen.findByText('置かれた環境変数がまだ1件も無い。');
    expect(puts).toEqual([[{ name: 'NPM_TOKEN', value: '' }]]);
  });
});
