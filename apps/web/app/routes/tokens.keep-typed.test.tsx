// @vitest-environment jsdom
/**
 * トークンの追加の応答を待つ間に打ち足した文字を、成功のあとも残す。
 * 応答を返す時期は Promise を手で解決して操る（実時間の待ちは書かない）。
 */
import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
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

function stubServer() {
  const puts: unknown[] = [];
  const pending: (() => void)[] = [];
  const view = { tokens: [], settings: { rotateOn: 'free_exhausted', cooldownMs: 18_000_000 } };
  globalThis.fetch = (async (input: RequestInfo | URL, init?: RequestInit) => {
    const request = input instanceof Request ? input : new Request(input, init);
    const { pathname } = new URL(request.url);
    if (pathname === '/journal') return json({ entries: [] });
    if (pathname !== '/tokens') throw new TypeError(`Failed to fetch: ${request.url}`);
    if (request.method === 'PUT') {
      puts.push(await request.json());
      return new Promise<Response>((resolve) => {
        pending.push(() => resolve(json(view)));
      });
    }
    return json(view);
  }) as typeof fetch;
  return {
    puts,
    releaseNextPut: () => {
      const release = pending.shift();
      if (release === undefined) throw new Error('待っている PUT が無い');
      release();
    },
  };
}

const labelInput = () =>
  screen.getByLabelText('ラベル（人間が読む名前。秘密ではない）') as HTMLInputElement;
const valueInput = () =>
  screen.getByLabelText('値（claude setup-token の出力）') as HTMLInputElement;

async function startSending(server: ReturnType<typeof stubServer>) {
  const router = createMemoryRouter([{ path: '/', Component: Tokens }], {
    initialEntries: ['/'],
  });
  render(
    <Providers>
      <RouterProvider router={router} />
    </Providers>,
  );
  await screen.findByRole('heading', { name: '追加' });
  fireEvent.change(labelInput(), { target: { value: 'tok' } });
  fireEvent.change(valueInput(), { target: { value: 'sk-1' } });
  fireEvent.click(screen.getByRole('button', { name: '追加' }));
  await waitFor(() => expect(server.puts).toHaveLength(1));
}

describe('トークンの追加中に打ち足した文字', () => {
  it('打ち足した分だけが、成功のあとも残る', async () => {
    const server = stubServer();
    await startSending(server);

    fireEvent.change(labelInput(), { target: { value: 'tok-next' } });
    server.releaseNextPut();

    await waitFor(() => expect(labelInput().value).toBe('-next'));
    expect(valueInput().value).toBe('');
  });

  it('打ち足さなかったときは、これまでどおり空にする', async () => {
    const server = stubServer();
    await startSending(server);
    server.releaseNextPut();

    await waitFor(() => expect(labelInput().value).toBe(''));
    expect(valueInput().value).toBe('');
  });
});
