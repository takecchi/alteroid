// @vitest-environment jsdom
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

function keyView(id: string) {
  return {
    id,
    name: 'CI',
    source: 'ci.main',
    fingerprint: 'abcdef012345',
    createdAt: '2026-09-30T00:00:00.000Z',
    createdBy: '実行環境の持ち主による操作',
    expiresAt: null,
    revokedAt: null,
    lastUsedAt: null,
    limits: { maxBodyBytes: 1_048_576, ratePerMinute: 60 },
  };
}

describe('/integrations 画面 — 発行の二重送信（#4569）', () => {
  it('発行の応答を待つ間に Ctrl+Enter をもう一度押しても、鍵は1本しか発行しない', async () => {
    let posts = 0;
    const releases: (() => void)[] = [];
    globalThis.fetch = (async (input: RequestInfo | URL, init?: RequestInit) => {
      const request = input instanceof Request ? input : new Request(input, init);
      if (!request.url.includes('/integration-keys')) {
        throw new TypeError(`Failed to fetch: ${request.url}`);
      }
      if (request.method === 'POST') {
        posts += 1;
        const id = `k-new-${String(posts)}`;
        await new Promise<void>((resolve) => releases.push(resolve));
        return json({ key: keyView(id), value: `altk_DUMMY${String(posts)}0123456789` });
      }
      return json({ keys: [] });
    }) as typeof fetch;

    render(
      <Providers>
        <TestDataRouter>
          <Integrations />
        </TestDataRouter>
      </Providers>,
    );

    const name = await screen.findByLabelText(/名前/);
    fireEvent.change(name, { target: { value: 'CI' } });
    fireEvent.change(screen.getByLabelText('source'), { target: { value: 'ci.main' } });

    fireEvent.keyDown(name, { key: 'Enter', ctrlKey: true });
    await waitFor(() => expect(posts).toBe(1));
    // 1本目の応答はまだ返っていない（発行中）。ボタンは押せない状態になっている。
    await waitFor(() =>
      expect((screen.getByRole('button', { name: '発行する' }) as HTMLButtonElement).disabled).toBe(
        true,
      ),
    );
    fireEvent.keyDown(name, { key: 'Enter', ctrlKey: true });
    // 2本目が飛ぶなら、次の描画の前に飛んでいる
    await waitFor(() => expect(screen.getByRole('button', { name: '発行する' })).toBeTruthy());
    await Promise.resolve();
    await Promise.resolve();

    expect(posts).toBe(1);
    for (const release of releases) release();

    // 応答が返った後は印が解け、もう一度発行できる（止めっぱなしにしない）
    await waitFor(() =>
      expect((screen.getByRole('button', { name: '発行する' }) as HTMLButtonElement).disabled).toBe(
        false,
      ),
    );
    fireEvent.change(screen.getByLabelText(/名前/), { target: { value: 'CI2' } });
    fireEvent.change(screen.getByLabelText('source'), { target: { value: 'ci.main' } });
    fireEvent.keyDown(screen.getByLabelText(/名前/), { key: 'Enter', ctrlKey: true });
    await waitFor(() => expect(posts).toBe(2));
    for (const release of releases) release();
  });
});
