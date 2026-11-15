// @vitest-environment jsdom
import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import { json, Providers, TestDataRouter, storeTestBaseUrl } from '~/test-support';

import AccessTokens from './access-tokens';

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

const ISSUED = {
  token: {
    id: 't-new',
    accountId: 'acc-1',
    name: 'CI',
    kind: 'full',
    origin: 'issued',
    issuedBy: 'acc-1',
    fingerprint: 'abcdef012345',
    createdAt: '2026-11-15T00:00:00.000Z',
    expiresAt: null,
    lastUsedAt: null,
    revokedAt: null,
  },
  value: 'alt_SECRETVALUE0123456789',
};

function stubServer() {
  const posts: unknown[] = [];
  const pending: (() => void)[] = [];
  globalThis.fetch = (async (input: RequestInfo | URL, init?: RequestInit) => {
    const request = input instanceof Request ? input : new Request(input, init);
    if (!request.url.includes('/access-tokens'))
      throw new TypeError(`Failed to fetch: ${request.url}`);
    if (request.method === 'POST') {
      posts.push(await request.json());
      return new Promise<Response>((resolve) => {
        pending.push(() => resolve(json(ISSUED)));
      });
    }
    return json({ tokens: [] });
  }) as typeof fetch;
  return {
    posts,
    releaseNextPost: () => {
      const release = pending.shift();
      if (release === undefined) throw new Error('待っている POST が無い');
      release();
    },
  };
}

function fill(label: string | RegExp, value: string) {
  fireEvent.change(screen.getByLabelText(label), { target: { value } });
}

function valueOf(label: string | RegExp): string {
  return (screen.getByLabelText(label) as HTMLInputElement).value;
}

async function startIssuing(server: ReturnType<typeof stubServer>) {
  render(
    <Providers>
      <TestDataRouter>
        <AccessTokens />
      </TestDataRouter>
    </Providers>,
  );
  await screen.findByText('アクセストークンはまだ無い。');
  fill('名前（見分けるための呼び名）', 'CI');
  fireEvent.click(screen.getByRole('radio', { name: /full/ }));
  fireEvent.click(screen.getByRole('button', { name: '発行する' }));
  await waitFor(() => expect(server.posts).toHaveLength(1));
}

describe('アクセストークンの発行中に打ち足した入力', () => {
  it('名前は打ち足しだけが残り、変えた種類はそのまま残る', async () => {
    const server = stubServer();
    await startIssuing(server);

    fill('名前（見分けるための呼び名）', 'CI 本番');
    fireEvent.click(screen.getByRole('radio', { name: /read/ }));
    server.releaseNextPost();

    await waitFor(() => expect(valueOf('名前（見分けるための呼び名）')).toBe('本番'));
    expect(screen.getByRole<HTMLInputElement>('radio', { name: /read/ }).checked).toBe(true);
  });

  it('打ち足さなかったときは、名前を空にし、種類は read へ、期限は 30 日へ戻す', async () => {
    const server = stubServer();
    await startIssuing(server);
    server.releaseNextPost();

    await waitFor(() => expect(valueOf('名前（見分けるための呼び名）')).toBe(''));
    expect(screen.getByRole<HTMLInputElement>('radio', { name: /read/ }).checked).toBe(true);
    expect(screen.getByRole<HTMLInputElement>('radio', { name: /30 日/ }).checked).toBe(true);
  });
});
