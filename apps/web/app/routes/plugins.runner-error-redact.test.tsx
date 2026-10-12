// @vitest-environment jsdom
import { cleanup, fireEvent, render, screen } from '@testing-library/react';
import { createMemoryRouter, RouterProvider } from 'react-router';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import { json, Providers, storeTestBaseUrl } from '~/test-support';

import PluginsPage from './plugins';

const TOKEN = `ghp_${'a1B2c3D4e5'.repeat(4)}`;

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

const PLUGIN = {
  name: 'demo',
  source: { kind: 'url', url: 'https://example.com/o/demo.git', sha: '1'.repeat(40) },
  scope: 'runner',
  enableHooks: false,
  enableMcp: true,
  contentSha256: 'c'.repeat(64),
  installedAt: '2026-09-20T00:00:00.000Z',
  installedBy: 'owner-account',
  fileCount: 3,
  totalBytes: 120,
};

// CLI の plugin コマンドは runner の失敗文を redactError に通して出す。画面は素のまま出していた。
describe('plugin の実行環境ごとの反映結果は、失敗の理由の本文の秘密を伏せる', () => {
  it('外したときの runner.error に入った鍵を出さない', async () => {
    globalThis.fetch = (async (input: RequestInfo | URL, init?: RequestInit) => {
      const request = input instanceof Request ? input : null;
      const url = new URL(request?.url ?? (typeof input === 'string' ? input : String(input)));
      const method = request?.method ?? init?.method ?? 'GET';
      if (url.pathname.startsWith('/plugins/') && method === 'DELETE') {
        return json({
          name: 'demo',
          appliesFrom: '次のセッションから',
          runners: [{ runnerId: 'runner-2', ok: false, error: `push failed: GH_TOKEN=${TOKEN}` }],
        });
      }
      if (url.pathname === '/plugins' && method === 'GET') return json({ plugins: [PLUGIN] });
      return Promise.reject(new TypeError(`Failed to fetch: ${url.href}`));
    }) as typeof fetch;

    const router = createMemoryRouter([{ path: '/plugins', Component: PluginsPage }], {
      initialEntries: ['/plugins'],
    });
    render(
      <Providers>
        <RouterProvider router={router} />
      </Providers>,
    );
    await screen.findByText('demo');

    fireEvent.click(screen.getByRole('button', { name: 'プラグイン demo を外す' }));
    fireEvent.click(await screen.findByRole('button', { name: '本当に外す' }));

    await screen.findByText(/runner-2/);
    expect(document.body.textContent).not.toContain(TOKEN);
    expect(document.body.textContent).toContain('push failed');
  });
});
