// @vitest-environment jsdom
import { cleanup, fireEvent, render, screen, waitFor, within } from '@testing-library/react';
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

const SECRET = 'sk-very-secret-value';

function stateOf(mcpServers: Record<string, unknown>, version: string) {
  return { mcpServers, updatedAt: '2026-09-20T00:00:00.000Z', version };
}

const NEXT = JSON.stringify({
  mcpServers: { notion: { type: 'sse', url: 'https://example.com' } },
});

function updatedOf(version: string) {
  return {
    names: ['notion'],
    updatedAt: '2026-09-24T00:00:00.000Z',
    version,
    sha256: 'b'.repeat(12),
    appliesFrom: 'クローンの次のセッションから',
    runners: [],
  };
}

// 共有の stubFetch を使わない: openapi-fetch は fetch(new Request(...)) の形で呼ぶので init が undefined になり、本文が落ちるため
function stubServer(options: { hold?: boolean } = {}) {
  let stored = stateOf({ github: { command: 'npx' } }, 'v1');
  const puts: { mcpServers: unknown; ifMatch: string | undefined }[] = [];
  const held: (() => void)[] = [];
  globalThis.fetch = (async (input: RequestInfo | URL, init?: RequestInit) => {
    const request = input instanceof Request ? input : new Request(input, init);
    if (!request.url.includes('/mcp-servers')) {
      throw new TypeError(`Failed to fetch: ${request.url}`);
    }
    if (request.method !== 'PUT') return json(stored);
    const body = (await request.json()) as {
      mcpServers: Record<string, unknown>;
      ifMatch?: string;
    };
    puts.push({ mcpServers: body.mcpServers, ifMatch: body.ifMatch });
    if (body.ifMatch !== undefined && body.ifMatch !== stored.version) {
      return json({ error: '読んだ後に変わっています', current: stored }, 409);
    }
    const version = `v${String(puts.length + 1)}`;
    const write = () => {
      stored = stateOf(body.mcpServers, version);
      return json(updatedOf(version));
    };
    if (options.hold === true) {
      return new Promise<Response>((resolve) => {
        held.push(() => {
          resolve(write());
        });
      });
    }
    return write();
  }) as typeof fetch;
  return {
    puts,
    releaseNext: () => {
      const release = held.shift();
      if (release === undefined) throw new Error('待っている PUT が無い');
      release();
    },
    // 読んだ後に別の書き手が書いた状態を作る
    writeElsewhere: (mcpServers: Record<string, unknown>, version: string) => {
      stored = stateOf(mcpServers, version);
    },
  };
}

function mount() {
  const router = createMemoryRouter([{ path: '/mcp-servers', Component: McpServersPage }], {
    initialEntries: ['/mcp-servers'],
  });
  render(
    <Providers>
      <RouterProvider router={router} />
    </Providers>,
  );
}

async function openEdit() {
  fireEvent.click(await screen.findByRole('button', { name: '編集する' }));
  return screen.getByLabelText('MCP サーバの新しい登録') as HTMLTextAreaElement;
}

function save() {
  fireEvent.click(screen.getByRole('button', { name: '保存する' }));
  fireEvent.click(screen.getByRole('button', { name: '本当に保存する' }));
}

describe('MCP 連携の保存は読んだ版を照合する（#3984）', () => {
  it('保存は、編集を開いたときの version を ifMatch に載せる', async () => {
    const server = stubServer();
    mount();
    const editor = await openEdit();
    fireEvent.change(editor, { target: { value: NEXT } });
    save();

    await waitFor(() => expect(server.puts).toHaveLength(1));
    expect(server.puts[0]?.ifMatch).toBe('v1');
  });

  it('409 のとき下書きを残し、伏せたいまの登録を見せ、取り直しでも読んだ版のまま送り、上書きは current.version で送る', async () => {
    const server = stubServer();
    mount();
    const editor = await openEdit();
    server.writeElsewhere(
      {
        github: { command: 'npx', args: [`--token=${SECRET}`], env: { GITHUB_TOKEN: SECRET } },
        linear: { type: 'http', url: `https://mcp.linear.app/mcp?api_key=${SECRET}` },
      },
      'v9',
    );
    fireEvent.change(editor, { target: { value: NEXT } });
    save();

    expect(
      await screen.findByText(/読んだ後に、ほかで書き換えられた。保存していない/),
    ).toBeTruthy();
    const current = screen.getByRole('list', { name: 'いまの登録（値は伏せた）' });
    expect(within(current).getByText('github')).toBeTruthy();
    expect(within(current).getByText('linear')).toBeTruthy();
    expect(document.body.textContent).not.toContain(SECRET);
    expect((screen.getByLabelText('MCP サーバの新しい登録') as HTMLTextAreaElement).value).toBe(
      NEXT,
    );

    // 取り直しで current が v9 に入れ替わっても、もう一度ふつうに保存すれば読んだ版（v1）のまま送る
    await waitFor(() => expect(screen.getByText('2 件')).toBeTruthy());
    save();
    await waitFor(() => expect(server.puts).toHaveLength(2));
    expect(server.puts[1]?.ifMatch).toBe('v1');

    fireEvent.click(await screen.findByRole('button', { name: 'この内容で上書きする' }));
    await waitFor(() => expect(server.puts).toHaveLength(3));
    expect(server.puts[2]).toEqual({ mcpServers: JSON.parse(NEXT).mcpServers, ifMatch: 'v9' });
    expect(await screen.findByText(/MCP 連携の登録を差し替えた/)).toBeTruthy();
    expect(screen.queryByText(/読んだ後に、ほかで書き換えられた/)).toBeNull();
  });

  it('全部外すも、確認を出したときの版を送り、衝突したら外さずに見せ、編集の下書きとは混ぜない', async () => {
    const server = stubServer();
    mount();
    fireEvent.click(await screen.findByRole('button', { name: '登録を全部外す' }));
    server.writeElsewhere({ github: { command: 'npx' }, linear: { command: 'x' } }, 'v9');
    fireEvent.click(screen.getByRole('button', { name: '本当に外す' }));

    expect(await screen.findByText(/読んだ後に、ほかで書き換えられた。外していない/)).toBeTruthy();
    expect(server.puts[0]).toEqual({ mcpServers: {}, ifMatch: 'v1' });
    // 編集を開くと、外す操作の衝突の案内は消える（「全部外す」を下書きの上書きと取り違えない）
    fireEvent.click(await screen.findByRole('button', { name: '編集する' }));
    expect(screen.queryByRole('button', { name: 'それでも全部外す' })).toBeNull();
  });

  it('保存の成功後は応答の version を次の前提にする（打ち足した下書きの保存が偽の衝突にならない）', async () => {
    const server = stubServer({ hold: true });
    mount();
    const editor = await openEdit();
    fireEvent.change(editor, { target: { value: NEXT } });
    save();
    await waitFor(() => expect(server.puts).toHaveLength(1));
    const typedAhead = `${NEXT}\n`;
    fireEvent.change(screen.getByLabelText('MCP サーバの新しい登録'), {
      target: { value: typedAhead },
    });
    server.releaseNext();
    expect(await screen.findByText(/MCP 連携の登録を差し替えた/)).toBeTruthy();

    fireEvent.change(screen.getByLabelText('MCP サーバの新しい登録'), {
      target: { value: `${typedAhead}\n` },
    });
    save();
    await waitFor(() => expect(server.puts).toHaveLength(2));
    expect(server.puts[1]?.ifMatch).toBe('v2');
    server.releaseNext();
    await waitFor(() => expect(screen.queryByText(/読んだ後に、ほかで/)).toBeNull());
  });
});
