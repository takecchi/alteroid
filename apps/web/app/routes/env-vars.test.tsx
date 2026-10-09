// @vitest-environment jsdom
import { cleanup, fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import { json, Providers, TestDataRouter, storeTestBaseUrl } from '~/test-support';

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
}

// 共有の stubFetch を使わない: openapi-fetch は fetch(new Request(...)) の形で呼ぶので、route(url, init) では method も本文も落ちるため
function stubCrudScreen(
  initial: StubEnvVarRow[],
  runners: { runnerId: string; ok: boolean; error?: string }[] = [],
) {
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
      return json({ credentials: rows, runners });
    }
    return json({ credentials: rows });
  }) as typeof fetch;

  return { puts };
}

async function openMenuItem(name: string, item: '編集' | '削除'): Promise<void> {
  const trigger = await screen.findByRole('button', { name: `「${name}」の操作` });
  fireEvent.keyDown(trigger, { key: 'Enter' });
  fireEvent.click(await screen.findByRole('menuitem', { name: item }));
}

async function waitForListLoaded(): Promise<void> {
  await screen.findByRole('heading', { name: '一覧' });
}

describe('/env-vars 画面 — runner への反映の一部失敗（#3157）', () => {
  const PARTIAL = [
    { runnerId: 'runner-1', ok: true },
    { runnerId: 'runner-2', ok: false, error: 'つながらない' },
  ];

  it('置いたとき、一部の実行環境へ反映できなければ warn の警告を出し、失敗した実行環境と理由を言う', async () => {
    stubCrudScreen([], PARTIAL);
    render(
      <Providers>
        <TestDataRouter>
          <EnvVars />
        </TestDataRouter>
      </Providers>,
    );
    await waitForListLoaded();

    fireEvent.change(screen.getByPlaceholderText('TZ'), { target: { value: 'tz' } });
    fireEvent.change(screen.getByLabelText('値'), { target: { value: 'Asia/Tokyo' } });
    fireEvent.click(screen.getByRole('button', { name: '置く' }));

    const alert = await screen.findByRole('alert');
    expect(alert.textContent).toContain('環境変数を置いたが、1 台の実行環境へ反映できていない');
    expect(alert.textContent).toContain('runner-2');
    expect(alert.textContent).toContain('つながらない');
    expect(alert.className).toContain('text-warn');
  });

  it('全部届いた・実行環境が0台なら警告を出さない', async () => {
    stubCrudScreen([], [{ runnerId: 'runner-1', ok: true }]);
    render(
      <Providers>
        <TestDataRouter>
          <EnvVars />
        </TestDataRouter>
      </Providers>,
    );
    await waitForListLoaded();

    fireEvent.change(screen.getByPlaceholderText('TZ'), { target: { value: 'tz' } });
    fireEvent.change(screen.getByLabelText('値'), { target: { value: 'Asia/Tokyo' } });
    fireEvent.click(screen.getByRole('button', { name: '置く' }));

    await waitFor(() => expect((screen.getByLabelText('値') as HTMLInputElement).value).toBe(''));
    expect(screen.queryByRole('alert')).toBeNull();
  });

  it('削除したとき、一部の実行環境へ反映できなければ警告を出す', async () => {
    stubCrudScreen(
      [
        {
          name: 'TZ',
          sha256: 'f'.repeat(12),
          updatedAt: '2026-09-14T00:00:00.000Z',
          scope: 'all',
          secret: true,
        },
      ],
      PARTIAL,
    );
    render(
      <Providers>
        <TestDataRouter>
          <EnvVars />
        </TestDataRouter>
      </Providers>,
    );
    await waitForListLoaded();

    await openMenuItem('TZ', '削除');
    fireEvent.click(
      within(await screen.findByRole('alertdialog')).getByRole('button', { name: '削除' }),
    );

    const alert = await screen.findByRole('alert');
    expect(alert.textContent).toContain('環境変数を外したが');
  });
});

describe('/env-vars 画面 — 一覧', () => {
  it('secret な行は値を伏せ字にし、実値を DOM に出さない（指紋は title だけ）', async () => {
    stubCrudScreen([
      {
        name: 'GH_TOKEN',
        sha256: 'a'.repeat(12),
        updatedAt: '2026-09-14T00:00:00.000Z',
        scope: 'all',
        secret: true,
        value: 'LEAKED-REAL-VALUE',
      },
    ]);

    render(
      <Providers>
        <TestDataRouter>
          <EnvVars />
        </TestDataRouter>
      </Providers>,
    );
    await waitForListLoaded();

    const row = screen.getByText('GH_TOKEN').closest('[role="listitem"]') as HTMLElement;
    expect(within(row).getByText('共通')).toBeTruthy();
    expect(within(row).getByText('******')).toBeTruthy();
    expect(within(row).getByRole('button', { name: '「GH_TOKEN」の操作' })).toBeTruthy();
    expect(document.body.textContent).not.toContain('LEAKED-REAL-VALUE');
    expect(screen.queryByText('シークレット')).toBeNull();
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
        <TestDataRouter>
          <EnvVars />
        </TestDataRouter>
      </Providers>,
    );
    await waitForListLoaded();

    expect(screen.getByText('Asia/Tokyo')).toBeTruthy();
    const row = screen.getByText('Asia/Tokyo').closest('[role="listitem"]') as HTMLElement;
    expect(within(row).getByText('クローンだけ')).toBeTruthy();
    expect(screen.queryByText('******')).toBeNull();
  });

  it('runner scope は「マネージャーだけ」と出る（タグは行ごとに共通・クローンだけ・マネージャーだけを潰さない）', async () => {
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
        <TestDataRouter>
          <EnvVars />
        </TestDataRouter>
      </Providers>,
    );
    await waitForListLoaded();

    const row = screen.getByText('MANAGER_ONLY').closest('[role="listitem"]') as HTMLElement;
    expect(within(row).getByText('マネージャーだけ')).toBeTruthy();
  });

  it('渡す先の選択肢は、値を変えずに語だけプロファイル画面（profile.tsx）と同じ言い方で出る', async () => {
    stubCrudScreen([]);

    render(
      <Providers>
        <TestDataRouter>
          <EnvVars />
        </TestDataRouter>
      </Providers>,
    );
    await waitForListLoaded();

    const options = within(screen.getByLabelText('渡す先')).getAllByRole('option');
    expect(
      options.map((option) => [(option as HTMLOptionElement).value, option.textContent]),
    ).toEqual([
      ['all', '共通（クローン・マネージャー両方。既定）'],
      ['app', 'クローンだけ'],
      ['runner', 'マネージャーだけ'],
    ]);
    expect(
      screen.getByText(/渡す先は「共通」「クローンだけ」「マネージャーだけ」から選べる/),
    ).toBeTruthy();
    expect(document.body.textContent).not.toMatch(/\bclone\b|\bmanager\b/i);
  });

  it('未知の scope は「未知の渡す先（値）」と出す（プロファイル画面と同じ）', async () => {
    stubCrudScreen([
      {
        name: 'FUTURE',
        sha256: 'd'.repeat(12),
        updatedAt: '2026-09-14T00:00:00.000Z',
        scope: 'future-scope',
        secret: true,
      } as unknown as StubEnvVarRow,
    ]);

    render(
      <Providers>
        <TestDataRouter>
          <EnvVars />
        </TestDataRouter>
      </Providers>,
    );
    await waitForListLoaded();

    expect(screen.getByText('未知の渡す先（future-scope）')).toBeTruthy();
  });

  it('1件も無ければ、その旨を言う', async () => {
    stubCrudScreen([]);

    render(
      <Providers>
        <TestDataRouter>
          <EnvVars />
        </TestDataRouter>
      </Providers>,
    );
    await waitForListLoaded();

    expect(await screen.findByText('置かれた環境変数がまだ1件も無い。')).toBeTruthy();
  });
});

describe('/env-vars 画面 — 置く・編集・削除', () => {
  it('名前・値・渡す先・シークレット可否を指定して置くと、PUT /credentials が呼ばれ一覧に出る', async () => {
    const { puts } = stubCrudScreen([]);

    render(
      <Providers>
        <TestDataRouter>
          <EnvVars />
        </TestDataRouter>
      </Providers>,
    );
    await waitForListLoaded();

    fireEvent.change(screen.getByPlaceholderText('TZ'), { target: { value: 'tz' } });
    fireEvent.change(screen.getByLabelText('値'), { target: { value: 'Asia/Tokyo' } });
    fireEvent.change(screen.getByLabelText('渡す先'), { target: { value: 'app' } });
    fireEvent.click(screen.getByLabelText(/シークレット扱いにする/));
    fireEvent.click(screen.getByRole('button', { name: '置く' }));

    expect(await screen.findByText('Asia/Tokyo')).toBeTruthy();
    expect(puts).toEqual([[{ name: 'TZ', value: 'Asia/Tokyo', scope: 'app', secret: false }]]);
  });

  it('削除すると、空値の PUT /credentials が呼ばれ一覧から消える', async () => {
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
        <TestDataRouter>
          <EnvVars />
        </TestDataRouter>
      </Providers>,
    );
    await waitForListLoaded();
    expect(await screen.findByText('NPM_TOKEN')).toBeTruthy();

    await openMenuItem('NPM_TOKEN', '削除');
    const dialog = await screen.findByRole('alertdialog');
    expect(screen.getByText('環境変数「NPM_TOKEN」を削除しますか')).toBeTruthy();
    expect(puts).toEqual([]);
    fireEvent.click(within(dialog).getByRole('button', { name: 'やめる' }));
    await waitFor(() => expect(screen.queryByRole('alertdialog')).toBeNull());
    expect(puts).toEqual([]);
    expect(screen.getByText('NPM_TOKEN')).toBeTruthy();

    await openMenuItem('NPM_TOKEN', '削除');
    fireEvent.click(
      within(await screen.findByRole('alertdialog')).getByRole('button', { name: '削除' }),
    );

    await screen.findByText('置かれた環境変数がまだ1件も無い。');
    expect(puts).toEqual([[{ name: 'NPM_TOKEN', value: '' }]]);
  });

  it('⋮→編集→値を変えて保存すると、PUT /credentials が {name, value, scope}（secret 無し）で呼ばれる', async () => {
    const { puts } = stubCrudScreen([
      {
        name: 'TZ',
        sha256: 'b'.repeat(12),
        updatedAt: '2026-09-14T00:00:00.000Z',
        scope: 'all',
        secret: false,
        value: 'UTC',
      },
    ]);

    render(
      <Providers>
        <TestDataRouter>
          <EnvVars />
        </TestDataRouter>
      </Providers>,
    );
    await waitForListLoaded();
    await openMenuItem('TZ', '編集');

    const dialog = await screen.findByRole('dialog');
    expect((within(dialog).getByLabelText('名前') as HTMLInputElement).readOnly).toBe(true);
    expect((within(dialog).getByLabelText('値') as HTMLInputElement).value).toBe('UTC');
    fireEvent.change(within(dialog).getByLabelText('値'), { target: { value: 'Asia/Tokyo' } });
    fireEvent.change(within(dialog).getByLabelText('渡す先'), { target: { value: 'runner' } });
    fireEvent.click(within(dialog).getByRole('button', { name: '保存' }));

    expect(await screen.findByText('Asia/Tokyo')).toBeTruthy();
    expect(puts).toEqual([[{ name: 'TZ', value: 'Asia/Tokyo', scope: 'runner' }]]);
    await waitFor(() => expect(screen.queryByRole('dialog')).toBeNull());
  });

  it('secret の編集は空の「新しい値」から始まり、空のままでは保存できない（空は削除の意味になるため）', async () => {
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
        <TestDataRouter>
          <EnvVars />
        </TestDataRouter>
      </Providers>,
    );
    await waitForListLoaded();
    await openMenuItem('NPM_TOKEN', '編集');

    const dialog = await screen.findByRole('dialog');
    const input = within(dialog).getByLabelText('新しい値') as HTMLInputElement;
    expect(input.value).toBe('');
    const save = within(dialog).getByRole('button', { name: '保存' }) as HTMLButtonElement;
    expect(save.disabled).toBe(true);
    fireEvent.click(save);
    expect(puts).toEqual([]);

    fireEvent.change(input, { target: { value: 'new-secret' } });
    expect(save.disabled).toBe(false);
    fireEvent.click(save);
    await waitFor(() =>
      expect(puts).toEqual([[{ name: 'NPM_TOKEN', value: 'new-secret', scope: 'all' }]]),
    );
    expect(await screen.findByText('******')).toBeTruthy();
  });

  it('編集をやめて開き直すと、入力途中の値を持ち越さず、いまの登録内容から始まる', async () => {
    const { puts } = stubCrudScreen([
      {
        name: 'TZ',
        sha256: 'b'.repeat(12),
        updatedAt: '2026-09-14T00:00:00.000Z',
        scope: 'all',
        secret: false,
        value: 'UTC',
      },
    ]);

    render(
      <Providers>
        <TestDataRouter>
          <EnvVars />
        </TestDataRouter>
      </Providers>,
    );
    await waitForListLoaded();

    await openMenuItem('TZ', '編集');
    let dialog = await screen.findByRole('dialog');
    fireEvent.change(within(dialog).getByLabelText('値'), { target: { value: 'half-typed' } });
    fireEvent.change(within(dialog).getByLabelText('渡す先'), { target: { value: 'app' } });
    fireEvent.click(within(dialog).getByRole('button', { name: 'やめる' }));
    // 書きかけがあるので確認が挟まる（#3418）。捨てて閉じてから開き直す
    fireEvent.click(
      within(await screen.findByRole('alertdialog')).getByRole('button', { name: '捨てて閉じる' }),
    );
    await waitFor(() => expect(screen.queryByRole('dialog')).toBeNull());

    await openMenuItem('TZ', '編集');
    dialog = await screen.findByRole('dialog');
    expect((within(dialog).getByLabelText('値') as HTMLInputElement).value).toBe('UTC');
    expect((within(dialog).getByLabelText('渡す先') as HTMLSelectElement).value).toBe('all');
    expect(puts).toEqual([]);
  });
});
