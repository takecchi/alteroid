// @vitest-environment jsdom
import { cleanup, fireEvent, render, screen } from '@testing-library/react';
import { createMemoryRouter, RouterProvider } from 'react-router';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import { json, Providers, storeTestBaseUrl } from '~/test-support';

import McpServersPage from './mcp-servers';

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

// CLI（mcp-servers）は runner の失敗文を redactError に通して出す。画面は素のまま出していた。
describe('/mcp-servers 画面は、runner への反映の失敗の理由の本文の秘密を伏せる', () => {
  it('runner.error に入った鍵を出さない', async () => {
    globalThis.fetch = (async (input: RequestInfo | URL, init?: RequestInit) => {
      const request = input instanceof Request ? input : null;
      const url = request?.url ?? (typeof input === 'string' ? input : String(input));
      const method = request?.method ?? init?.method ?? 'GET';
      if (!url.includes('/mcp-servers')) {
        return Promise.reject(new TypeError(`Failed to fetch: ${url}`));
      }
      if (method === 'PUT') {
        return json({
          names: ['notion'],
          updatedAt: '2026-09-24T00:00:00.000Z',
          sha256: 'b'.repeat(12),
          appliesFrom: 'クローンの次のセッションから',
          runners: [{ runnerId: 'runner-2', ok: false, error: `push failed: GH_TOKEN=${TOKEN}` }],
        });
      }
      return json({ mcpServers: {}, updatedAt: '2026-09-20T00:00:00.000Z' });
    }) as typeof fetch;

    const router = createMemoryRouter([{ path: '/mcp-servers', Component: McpServersPage }], {
      initialEntries: ['/mcp-servers'],
    });
    render(
      <Providers>
        <RouterProvider router={router} />
      </Providers>,
    );

    fireEvent.click(await screen.findByRole('button', { name: '編集する' }));
    fireEvent.change(screen.getByLabelText('MCP サーバの新しい登録'), {
      target: {
        value: JSON.stringify({
          mcpServers: { notion: { type: 'sse', url: 'https://example.com/sse' } },
        }),
      },
    });
    fireEvent.click(screen.getByRole('button', { name: '保存する' }));
    fireEvent.click(screen.getByRole('button', { name: '本当に保存する' }));

    const report = await screen.findByLabelText('実行環境ごとの反映結果');
    expect(report.textContent).toContain('runner-2: 届かなかった');
    expect(report.textContent).toContain('push failed');
    expect(document.body.textContent).not.toContain(TOKEN);
  });
});
