// @vitest-environment jsdom
/**
 * 連携の鍵の発行の応答を待つ間に打ち足した文字を、成功のあとも残す（issue #3891）。
 * 応答を返す時期は Promise を手で解決して操る（実時間の待ちは書かない）。
 */
import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import { json, Providers, TestDataRouter, storeTestBaseUrl } from '~/test-support';

import Integrations from './integrations';

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
  key: {
    id: 'k-new',
    name: 'CI',
    source: 'ci',
    fingerprint: 'abcdef012345',
    createdAt: '2026-09-30T00:00:00.000Z',
    createdBy: '実行環境の持ち主による操作',
    expiresAt: null,
    revokedAt: null,
    lastUsedAt: null,
    limits: { maxBodyBytes: 1_048_576, ratePerMinute: 60 },
  },
  value: 'altk_SECRETVALUE0123456789',
};

function stubServer() {
  const posts: unknown[] = [];
  const pending: (() => void)[] = [];
  globalThis.fetch = (async (input: RequestInfo | URL, init?: RequestInit) => {
    const request = input instanceof Request ? input : new Request(input, init);
    if (!request.url.includes('/integration-keys'))
      throw new TypeError(`Failed to fetch: ${request.url}`);
    if (request.method === 'POST') {
      posts.push(await request.json());
      return new Promise<Response>((resolve) => {
        pending.push(() => resolve(json(ISSUED)));
      });
    }
    return json({ keys: [] });
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

const FAR_FUTURE = '2099-01-01T00:00';

async function startIssuing(server: ReturnType<typeof stubServer>) {
  render(
    <Providers>
      <TestDataRouter>
        <Integrations />
      </TestDataRouter>
    </Providers>,
  );
  await screen.findByText('連携の鍵はまだ無い。');
  fill('名前（見分けるための呼び名）', 'CI');
  fill('source', 'ci');
  fill(/期限/, FAR_FUTURE);
  fill('本文の上限（バイト）', '100');
  fill('1分あたりの回数', '10');
  fireEvent.click(screen.getByRole('button', { name: '発行する' }));
  await waitFor(() => expect(server.posts).toHaveLength(1));
}

function fill(label: string | RegExp, value: string) {
  fireEvent.change(screen.getByLabelText(label), { target: { value } });
}

function valueOf(label: string | RegExp): string {
  return (screen.getByLabelText(label) as HTMLInputElement).value;
}

describe('連携の鍵の発行中に打ち足した文字', () => {
  it('名前・source は打ち足しだけが残り、書き換えた期限・数値はそのまま残る', async () => {
    const server = stubServer();
    await startIssuing(server);

    fill('名前（見分けるための呼び名）', 'CI 本番');
    fill('source', 'ci.main');
    fill(/期限/, '2099-02-02T00:00');
    fill('本文の上限（バイト）', '1000');
    // 1分あたりの回数は触らない（送った値のまま = 空に戻る）
    server.releaseNextPost();

    await waitFor(() => expect(valueOf('1分あたりの回数')).toBe(''));
    expect(valueOf('名前（見分けるための呼び名）')).toBe('本番');
    expect(valueOf('source')).toBe('.main');
    expect(valueOf(/期限/)).toBe('2099-02-02T00:00');
    expect(valueOf('本文の上限（バイト）')).toBe('1000');
  });

  it('打ち足さなかったときは、これまでどおり全部空にする', async () => {
    const server = stubServer();
    await startIssuing(server);
    server.releaseNextPost();

    await waitFor(() => expect(valueOf('1分あたりの回数')).toBe(''));
    expect(valueOf('名前（見分けるための呼び名）')).toBe('');
    expect(valueOf('source')).toBe('');
    expect(valueOf(/期限/)).toBe('');
    expect(valueOf('本文の上限（バイト）')).toBe('');
  });
});
