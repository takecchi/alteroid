// @vitest-environment jsdom
/**
 * 環境変数の登録の応答を待つ間に打ち足した文字を、成功のあとも残す（issue #3891）。
 * 応答を返す時期は Promise を手で解決して操る（実時間の待ちは書かない）。
 */
import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
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

function stubServer() {
  const puts: unknown[] = [];
  const pending: (() => void)[] = [];
  globalThis.fetch = (async (input: RequestInfo | URL, init?: RequestInit) => {
    const request = input instanceof Request ? input : new Request(input, init);
    if (!request.url.includes('/credentials'))
      throw new TypeError(`Failed to fetch: ${request.url}`);
    if (request.method === 'PUT') {
      puts.push(await request.json());
      return new Promise<Response>((resolve) => {
        pending.push(() => resolve(json({ credentials: [], runners: [] })));
      });
    }
    return json({ credentials: [] });
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

async function startSending(server: ReturnType<typeof stubServer>) {
  render(
    <Providers>
      <TestDataRouter>
        <EnvVars />
      </TestDataRouter>
    </Providers>,
  );
  await screen.findByRole('heading', { name: '一覧' });
  fireEvent.change(screen.getByPlaceholderText('TZ'), { target: { value: 'tz' } });
  fireEvent.change(screen.getByLabelText('値'), { target: { value: 'Asia' } });
  fireEvent.click(screen.getByRole('button', { name: '置く' }));
  await waitFor(() => expect(server.puts).toHaveLength(1));
}

const nameInput = () => screen.getByPlaceholderText('TZ') as HTMLInputElement;
const valueInput = () => screen.getByLabelText('値') as HTMLInputElement;

describe('環境変数の登録中に打ち足した文字', () => {
  it('名前・値に打ち足した分だけが、成功のあとも残る（名前は大文字のまま）', async () => {
    const server = stubServer();
    await startSending(server);

    fireEvent.change(nameInput(), { target: { value: 'TZ_NEXT' } });
    fireEvent.change(valueInput(), { target: { value: 'Asia/Tokyo' } });
    server.releaseNextPut();

    await waitFor(() => expect(nameInput().value).toBe('_NEXT'));
    expect(valueInput().value).toBe('/Tokyo');
  });

  it('書き換えた欄はそのまま残す', async () => {
    const server = stubServer();
    await startSending(server);

    fireEvent.change(nameInput(), { target: { value: 'LANG' } });
    server.releaseNextPut();

    await waitFor(() => expect(valueInput().value).toBe(''));
    expect(nameInput().value).toBe('LANG');
  });

  it('打ち足さなかったときは、これまでどおり空にする', async () => {
    const server = stubServer();
    await startSending(server);
    server.releaseNextPut();

    await waitFor(() => expect(nameInput().value).toBe(''));
    expect(valueInput().value).toBe('');
  });
});
