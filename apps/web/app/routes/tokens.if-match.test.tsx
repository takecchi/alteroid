// @vitest-environment jsdom
import { cleanup, fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import { createMemoryRouter, RouterProvider } from 'react-router';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import { json, Providers, storeTestBaseUrl } from '~/test-support';

import Tokens from './tokens';

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

const SETTINGS = { rotateOn: 'free_exhausted', cooldownMs: 18_000_000 };
const TOKEN_A = { id: 'tok-a', label: 'a', order: 0, sha256: 'aaaaaaaaaaaa' };

/**
 * 本物のデーモンと同じく、ifMatch が今の版と違えば 409（何も変えない）。
 * `conflicts` 回だけ、送られてきた版と別の版を「いま」として扱う（取り直しから PUT までの間にほかで変わった）。
 */
function stubServer(options: { version?: string; conflicts?: number } = {}) {
  const puts: { tokens: unknown[]; ifMatch?: string }[] = [];
  let gets = 0;
  let conflicts = options.conflicts ?? 0;
  const view = {
    tokens: [TOKEN_A],
    settings: SETTINGS,
    ...(options.version === undefined ? {} : { version: options.version }),
  };
  globalThis.fetch = (async (input: RequestInfo | URL, init?: RequestInit) => {
    const request = input instanceof Request ? input : new Request(input, init);
    const { pathname } = new URL(request.url);
    if (pathname === '/journal') return json({ entries: [] });
    if (pathname !== '/tokens') throw new TypeError(`Failed to fetch: ${request.url}`);
    if (request.method === 'PUT') {
      const body = (await request.json()) as { tokens: unknown[]; ifMatch?: string };
      puts.push(body);
      if (body.ifMatch !== undefined && conflicts > 0) {
        conflicts -= 1;
        return json({ error: '認証トークンのプールが読んだ後に変わっている（変えていない）' }, 409);
      }
      return json(view);
    }
    gets += 1;
    return json(view);
  }) as typeof fetch;
  return { puts, gets: () => gets };
}

function mount() {
  const router = createMemoryRouter([{ path: '/', Component: Tokens }], { initialEntries: ['/'] });
  render(
    <Providers>
      <RouterProvider router={router} />
    </Providers>,
  );
}

const labelInput = () =>
  screen.getByLabelText('ラベル（人間が読む名前。秘密ではない）') as HTMLInputElement;
const valueInput = () =>
  screen.getByLabelText('値（claude setup-token の出力）') as HTMLInputElement;

async function fillAndAdd() {
  await screen.findByText('a');
  fireEvent.change(labelInput(), { target: { value: 'b' } });
  fireEvent.change(valueInput(), { target: { value: 'fake-token-value' } });
  fireEvent.click(screen.getByRole('button', { name: '追加' }));
}

describe('トークンの画面は、押した時点で取り直した版を前提に書く（#4595）', () => {
  it('追加は、取り直した版を ifMatch にして送る', async () => {
    const server = stubServer({ version: 'v1' });
    mount();
    await fillAndAdd();

    await waitFor(() => expect(server.puts).toHaveLength(1));
    expect(server.puts[0]?.ifMatch).toBe('v1');
  });

  it('無効化も、取り直した版を ifMatch にして送る', async () => {
    const server = stubServer({ version: 'v1' });
    mount();
    fireEvent.click(await screen.findByRole('button', { name: 'a を無効化する' }));

    await waitFor(() => expect(server.puts).toHaveLength(1));
    expect(server.puts[0]?.ifMatch).toBe('v1');
  });

  it('409 なら書きかけを消さずに「ほかで変わった」と知らせ、一覧を読み直し、「このまま置き直す」で送り直せる', async () => {
    const server = stubServer({ version: 'v1', conflicts: 1 });
    mount();
    await fillAndAdd();

    const alert = await screen.findByRole('alert');
    expect(
      within(alert).getByText(/トークンの一覧がほかで変わった。何も変えていない/),
    ).toBeTruthy();
    expect(labelInput().value).toBe('b');
    expect(valueInput().value).toBe('fake-token-value');
    const getsAfterConflict = server.gets();
    expect(getsAfterConflict).toBeGreaterThan(1);

    fireEvent.click(within(alert).getByRole('button', { name: 'このまま置き直す' }));
    // 置き直しも取り直してから送る
    await waitFor(() => expect(server.puts).toHaveLength(2));
    expect(server.gets()).toBeGreaterThan(getsAfterConflict);
    await waitFor(() => expect(screen.queryByRole('alert')).toBeNull());
  });

  it('対照: 版を返さない古いデーモンには、今までどおり ifMatch を付けずに送る', async () => {
    const server = stubServer();
    mount();
    await fillAndAdd();

    await waitFor(() => expect(server.puts).toHaveLength(1));
    expect(server.puts[0]).not.toHaveProperty('ifMatch');
  });
});
