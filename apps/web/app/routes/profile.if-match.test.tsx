// @vitest-environment jsdom
import { cleanup, fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import { createMemoryRouter, RouterProvider } from 'react-router';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import { json, Providers, storeTestBaseUrl } from '~/test-support';

import Profile from './profile';

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

interface Row {
  name: string;
  script: string;
  scope: 'all' | 'app' | 'runner';
  version?: string;
}

function summaryOf(row: Row) {
  return {
    name: row.name,
    scope: row.scope,
    updatedAt: '2026-10-01T00:00:00.000Z',
    sha256: 'a'.repeat(12),
    bytes: row.script.length,
    ...(row.version === undefined ? {} : { version: row.version }),
  };
}

/**
 * 本物のデーモンと同じく、ifMatch が今の行の版と違えば 409（何も変えない）と、いまの行（本文抜き）を返す。
 * `rows` を書き換えると「ほかで変わった」を作れる（画面はまだ取り直していない）。
 */
function stubServer(initial: Row[]) {
  const state = { rows: initial };
  const puts: { name: string; body: { script: string; ifMatch?: string | null } }[] = [];
  const deletes: URL[] = [];
  let serial = 0;
  globalThis.fetch = (async (input: RequestInfo | URL, init?: RequestInit) => {
    const request = input instanceof Request ? input : new Request(input, init);
    const url = new URL(request.url);
    if (!url.pathname.startsWith('/profile')) throw new TypeError(`Failed to fetch: ${url.href}`);
    const name = decodeURIComponent(url.pathname.slice('/profile/'.length));
    const current = state.rows.find((row) => row.name === name);
    const conflict = (ifMatch: string | null | undefined) =>
      ifMatch !== undefined &&
      (ifMatch === null ? current !== undefined : current?.version !== ifMatch);
    if (request.method === 'PUT') {
      const body = (await request.json()) as { script: string; ifMatch?: string | null };
      puts.push({ name, body });
      if (conflict(body.ifMatch)) {
        return json(
          {
            error: 'プロファイルの行が読んだ後に変わっている（変えていない）',
            detail: 'x',
            current: current === undefined ? null : summaryOf(current),
          },
          409,
        );
      }
      serial += 1;
      const row: Row = { name, script: body.script, scope: 'all', version: `saved-${serial}` };
      state.rows = [...state.rows.filter((r) => r.name !== name), row];
      return json({
        updatedAt: '2026-10-12T00:00:00.000Z',
        entries: state.rows.map(summaryOf),
        composed: { clone: {}, runner: {} },
        clone: { ok: true },
        runners: [],
      });
    }
    if (request.method === 'DELETE') {
      deletes.push(url);
      const ifMatch = url.searchParams.get('ifMatch') ?? undefined;
      if (conflict(ifMatch)) {
        return json(
          {
            error: 'プロファイルの行が読んだ後に変わっている（変えていない）',
            detail: 'x',
            current: current === undefined ? null : summaryOf(current),
          },
          409,
        );
      }
      state.rows = state.rows.filter((r) => r.name !== name);
      return json({
        updatedAt: '2026-10-12T00:00:00.000Z',
        entries: state.rows.map(summaryOf),
        composed: { clone: {}, runner: {} },
        clone: { ok: true },
        runners: [],
      });
    }
    return json({
      entries: state.rows.map((row) => ({ ...summaryOf(row), script: row.script })),
      clone: {},
      runner: {},
      script: state.rows.map((row) => row.script).join('\n'),
    });
  }) as typeof fetch;
  return { state, puts, deletes };
}

function renderScreen() {
  const router = createMemoryRouter([{ path: '/profile', Component: Profile }], {
    initialEntries: ['/profile'],
  });
  render(
    <Providers>
      <RouterProvider router={router} />
    </Providers>,
  );
}

const body = () => screen.getByLabelText('プロファイルの新しい本文') as HTMLTextAreaElement;

async function editAndSave(name: string, script: string) {
  fireEvent.click(await screen.findByRole('button', { name: `${name} を編集する` }));
  fireEvent.change(body(), { target: { value: script } });
  fireEvent.click(screen.getByRole('button', { name: '保存する' }));
  fireEvent.click(await screen.findByRole('button', { name: '本当に保存する' }));
}

describe('プロフィールの画面は、読んだときの行の版を前提に書く（#4597）', () => {
  it('編集の保存は、開いた時点の版を ifMatch にして送る', async () => {
    const server = stubServer([
      { name: 'rust', script: 'export R=1\n', scope: 'all', version: 'v1' },
    ]);
    renderScreen();
    await editAndSave('rust', 'export R=human\n');

    await waitFor(() => expect(server.puts).toHaveLength(1));
    expect(server.puts[0]?.body.ifMatch).toBe('v1');
  });

  it('開いた後にほかで変わっていた（409）なら、書きかけを残して知らせ、「このまま置き直す」でいまの版を前提に置き直す', async () => {
    const server = stubServer([
      { name: 'rust', script: 'export R=1\n', scope: 'all', version: 'v1' },
    ]);
    renderScreen();
    fireEvent.click(await screen.findByRole('button', { name: 'rust を編集する' }));
    // 開いた後に、クローンが書き換える（画面はまだ取り直していない）
    server.state.rows = [{ name: 'rust', script: 'export R=clone\n', scope: 'all', version: 'v2' }];
    fireEvent.change(body(), { target: { value: 'export R=human\n' } });
    fireEvent.click(screen.getByRole('button', { name: '保存する' }));
    fireEvent.click(await screen.findByRole('button', { name: '本当に保存する' }));

    const alert = await screen.findByRole('alert');
    expect(within(alert).getByText(/行 rust はほかで変わった/)).toBeTruthy();
    expect(body().value).toBe('export R=human\n');
    expect(server.state.rows[0]?.script).toBe('export R=clone\n');

    fireEvent.click(within(alert).getByRole('button', { name: 'このまま置き直す' }));
    await waitFor(() => expect(server.puts).toHaveLength(2));
    expect(server.puts[1]?.body.ifMatch).toBe('v2');
    await waitFor(() => expect(server.state.rows[0]?.script).toBe('export R=human\n'));
  });

  it('409 の「読み直す」は、書きかけを捨てていまの本文で開き直す', async () => {
    const server = stubServer([
      { name: 'rust', script: 'export R=1\n', scope: 'all', version: 'v1' },
    ]);
    renderScreen();
    fireEvent.click(await screen.findByRole('button', { name: 'rust を編集する' }));
    server.state.rows = [{ name: 'rust', script: 'export R=clone\n', scope: 'all', version: 'v2' }];
    fireEvent.change(body(), { target: { value: 'export R=human\n' } });
    fireEvent.click(screen.getByRole('button', { name: '保存する' }));
    fireEvent.click(await screen.findByRole('button', { name: '本当に保存する' }));

    const alert = await screen.findByRole('alert');
    fireEvent.click(within(alert).getByRole('button', { name: '読み直す（書きかけを捨てる）' }));
    await waitFor(() => expect(body().value).toBe('export R=clone\n'));
    expect(server.puts).toHaveLength(1);
  });

  it('行を外すときは、一覧で見た版を ifMatch にして送る', async () => {
    const server = stubServer([
      { name: 'rust', script: 'export R=1\n', scope: 'all', version: 'v1' },
    ]);
    renderScreen();
    fireEvent.click(await screen.findByRole('button', { name: 'rust の行を外す' }));
    fireEvent.click(await screen.findByRole('button', { name: 'rust の行を本当に外す' }));

    await waitFor(() => expect(server.deletes).toHaveLength(1));
    expect(server.deletes[0]?.searchParams.get('ifMatch')).toBe('v1');
  });

  it('対照: 版を返さない古いデーモンには、在る行の ifMatch を付けない（今までどおり後勝ち）', async () => {
    const server = stubServer([{ name: 'rust', script: 'export R=1\n', scope: 'all' }]);
    renderScreen();
    await editAndSave('rust', 'export R=human\n');

    await waitFor(() => expect(server.puts).toHaveLength(1));
    expect(server.puts[0]?.body).not.toHaveProperty('ifMatch');
  });
});
