// @vitest-environment jsdom
import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { createMemoryRouter, RouterProvider } from 'react-router';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import { json, Providers, storeTestBaseUrl } from '~/test-support';

import McpServersPage from './mcp-servers';

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

const UPDATED = {
  names: ['notion'],
  updatedAt: '2026-09-24T00:00:00.000Z',
  sha256: 'b'.repeat(12),
  appliesFrom: 'クローンの次のセッションから',
  runners: [],
};

const NEXT = JSON.stringify({
  mcpServers: { notion: { type: 'sse', url: 'https://example.com/sse' } },
});

function stubServer() {
  let stored: unknown = { mcpServers: {}, updatedAt: '2026-09-20T00:00:00.000Z' };
  const puts: unknown[] = [];
  const pending: (() => void)[] = [];
  globalThis.fetch = (async (input: RequestInfo | URL, init?: RequestInit) => {
    const request = input instanceof Request ? input : new Request(input, init);
    if (!request.url.includes('/mcp-servers'))
      throw new TypeError(`Failed to fetch: ${request.url}`);
    if (request.method === 'PUT') {
      const body = (await request.json()) as { mcpServers: unknown };
      puts.push(body);
      return new Promise<Response>((resolve) => {
        pending.push(() => {
          stored = { mcpServers: body.mcpServers, updatedAt: UPDATED.updatedAt };
          resolve(json(UPDATED));
        });
      });
    }
    return json(stored);
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

async function startSaving(server: ReturnType<typeof stubServer>) {
  const router = createMemoryRouter([{ path: '/mcp-servers', Component: McpServersPage }], {
    initialEntries: ['/mcp-servers'],
  });
  render(
    <Providers>
      <RouterProvider router={router} />
    </Providers>,
  );
  fireEvent.click(await screen.findByRole('button', { name: '編集する' }));
  fireEvent.change(screen.getByLabelText('MCP サーバの新しい登録'), { target: { value: NEXT } });
  fireEvent.click(screen.getByRole('button', { name: '保存する' }));
  fireEvent.click(screen.getByRole('button', { name: '本当に保存する' }));
  await waitFor(() => expect(server.puts).toHaveLength(1));
}

describe('MCP 連携の保存中に打ち足した文字', () => {
  it('保存が成功しても編集欄に残る', async () => {
    const server = stubServer();
    await startSaving(server);

    fireEvent.change(screen.getByLabelText('MCP サーバの新しい登録'), {
      target: { value: `${NEXT}\n// 打ち足し` },
    });
    server.releaseNextPut();

    expect(await screen.findByText(/MCP 連携の登録を差し替えた/)).toBeTruthy();
    expect((screen.getByLabelText('MCP サーバの新しい登録') as HTMLTextAreaElement).value).toBe(
      `${NEXT}\n// 打ち足し`,
    );
  });

  it('打ち足さなかったときは、これまでどおり編集欄を閉じる', async () => {
    const server = stubServer();
    await startSaving(server);
    server.releaseNextPut();

    expect(await screen.findByText(/MCP 連携の登録を差し替えた/)).toBeTruthy();
    expect(screen.queryByLabelText('MCP サーバの新しい登録')).toBeNull();
  });
});
