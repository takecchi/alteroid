// @vitest-environment jsdom
/**
 * `/mcp-servers` — 人間の MCP 連携の登録を読む・差し替える画面（#325 段4）。
 *
 * ここで固定したいのは次の各点（`profile.test.tsx` と対になる）:
 *
 * 1. **値は押すまで出さない。** 一覧は名前・種類・宛先・鍵の名前だけで、`env` /
 *    `headers` / `args` の値と URL のクエリは「値を表示する」を押すまで1文字も描かない
 * 2. **保存は2段。**「保存する」だけでは `PUT /mcp-servers` を叩かず、「本当に保存する」
 *    で初めて、編集した登録をそのまま送る。JSON として読めないものは送らない
 * 3. **400 のときは不正な欄の位置（`error`）を出し、前のものが残ると言う**
 * 4. **外すのは空の `mcpServers` の `PUT`**（`alteroid mcp clear` と同じ）
 * 5. **403 は本文で出し分ける。** `requireOwner` の本文のときだけ持ち主の宣言を案内する
 * 6. **保存したら runner ごとの配布結果を出す**（配り損ねを小さく出さない）
 */
import { cleanup, fireEvent, render, screen } from '@testing-library/react';
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

const STORED = {
  mcpServers: {
    github: {
      command: 'npx',
      args: ['-y', '@modelcontextprotocol/server-github', `--token=${SECRET}`],
      env: { GITHUB_TOKEN: SECRET },
    },
    linear: {
      type: 'http',
      url: `https://mcp.linear.app/mcp?api_key=${SECRET}`,
      headers: { Authorization: `Bearer ${SECRET}` },
    },
  },
  updatedAt: '2026-09-20T00:00:00.000Z',
};

const UPDATED = {
  names: ['github', 'notion'],
  updatedAt: '2026-09-24T00:00:00.000Z',
  sha256: 'b'.repeat(12),
  appliesFrom: 'クローンの次のセッションから',
  runners: [
    {
      runnerId: 'runner-1',
      ok: true,
      mcpServers: { names: ['github', 'notion'], sha256: 'b'.repeat(12) },
    },
    { runnerId: 'runner-2', ok: false, error: 'runner に届かなかった' },
  ],
};

type Reply = { status: number; body: unknown };

/**
 * `/mcp-servers` の stub。**共有の `stubFetch` は使えない**（`openapi-fetch` は
 * `fetch(new Request(...))` の形で呼ぶので、method も本文も落ちる。
 * `profile.test.tsx` の同じ断り書きと同じ理由）。
 */
function stubMcp(options: { get?: Reply; put?: Reply } = {}) {
  let stored: unknown = STORED;
  const puts: unknown[] = [];

  globalThis.fetch = (async (input: RequestInfo | URL, init?: RequestInit) => {
    const request = input instanceof Request ? input : null;
    const url = request?.url ?? (typeof input === 'string' ? input : String(input));
    const method = request?.method ?? init?.method ?? 'GET';

    if (!url.includes('/mcp-servers')) {
      return Promise.reject(new TypeError(`Failed to fetch: ${url}`));
    }
    if (method === 'PUT') {
      const body = (request !== null ? await request.json() : JSON.parse(String(init?.body))) as {
        mcpServers: Record<string, unknown>;
      };
      puts.push(body);
      const reply = options.put ?? { status: 200, body: UPDATED };
      if (reply.status === 200) stored = { mcpServers: body.mcpServers };
      return json(reply.body, reply.status);
    }
    const reply = options.get ?? { status: 200, body: stored };
    return json(reply.body, reply.status);
  }) as typeof fetch;

  return { puts };
}

function renderScreen() {
  render(
    <Providers>
      <McpServersPage />
    </Providers>,
  );
}

describe('/mcp-servers 画面 — 読む', () => {
  it('名前・種類・宛先・鍵の名前は出すが、値は「値を表示する」を押すまで出さない', async () => {
    stubMcp();
    renderScreen();

    expect(await screen.findByText('2 件')).toBeTruthy();
    expect(screen.getByText('github')).toBeTruthy();
    expect(screen.getByText('npx')).toBeTruthy();
    expect(screen.getByText('env: GITHUB_TOKEN')).toBeTruthy();
    expect(screen.getByText('args: 3 個（値は伏せた）')).toBeTruthy();
    expect(screen.getByText('https://mcp.linear.app/mcp?***')).toBeTruthy();
    expect(screen.getByText('headers: Authorization')).toBeTruthy();
    expect(document.body.textContent).not.toContain(SECRET);

    fireEvent.click(screen.getByRole('button', { name: '値を表示する' }));
    expect(screen.getByLabelText('登録の本文（値を含む）').textContent).toContain(
      `"GITHUB_TOKEN": "${SECRET}"`,
    );

    fireEvent.click(screen.getByRole('button', { name: '値を隠す' }));
    expect(document.body.textContent).not.toContain(SECRET);
  });

  it('置かれていなければ「置かれていない」と出し、表示・外すボタンを出さない', async () => {
    stubMcp({ get: { status: 200, body: { mcpServers: {} } } });
    renderScreen();

    expect(await screen.findByText('置かれていない')).toBeTruthy();
    expect(screen.queryByRole('button', { name: '値を表示する' })).toBeNull();
    expect(screen.queryByRole('button', { name: '登録を全部外す' })).toBeNull();
    expect(screen.getByRole('button', { name: '編集する' })).toBeTruthy();
  });

  it('requireOwner の 403 なら、持ち主として宣言する手を案内する', async () => {
    stubMcp({
      get: {
        status: 403,
        body: { error: '実行環境の持ち主として宣言されたアカウントだけが操作できる' },
      },
    });
    renderScreen();

    expect(
      await screen.findByText('実行環境の持ち主として宣言されたアカウントだけが操作できる'),
    ).toBeTruthy();
    expect(screen.getByText('alteroid access owner <アカウント id>')).toBeTruthy();
    expect(screen.queryByRole('button', { name: '編集する' })).toBeNull();
  });

  it('本文から理由が判別できない 403 には案内を出さない', async () => {
    stubMcp({
      get: { status: 403, body: { error: 'このアカウントには alteroid を使う許可が無い' } },
    });
    renderScreen();

    expect(await screen.findByText('このアカウントには alteroid を使う許可が無い')).toBeTruthy();
    expect(screen.queryByText('alteroid access owner <アカウント id>')).toBeNull();
  });
});

describe('/mcp-servers 画面 — 差し替える', () => {
  it('「保存する」だけでは PUT を叩かず、「本当に保存する」で編集した登録を送り、runner ごとの結果を出す', async () => {
    const { puts } = stubMcp();
    renderScreen();

    fireEvent.click(await screen.findByRole('button', { name: '編集する' }));
    const editor = screen.getByLabelText<HTMLTextAreaElement>('MCP サーバの新しい登録');
    // 「編集する」を押すと、いまの登録（値を含む本物）が .mcp.json の形で流し込まれる。
    expect(JSON.parse(editor.value)).toEqual({ mcpServers: STORED.mcpServers });

    const next = {
      mcpServers: {
        github: STORED.mcpServers.github,
        notion: { type: 'sse', url: 'https://example.com/sse' },
      },
    };
    fireEvent.change(editor, { target: { value: JSON.stringify(next) } });
    fireEvent.click(screen.getByRole('button', { name: '保存する' }));
    expect(puts).toEqual([]);

    fireEvent.click(screen.getByRole('button', { name: '本当に保存する' }));
    expect(await screen.findByText(/MCP 連携の登録を差し替えた（sha256 b{12}）/)).toBeTruthy();
    expect(puts).toEqual([next]);
    expect(screen.getByText('足した: notion')).toBeTruthy();
    expect(screen.getByText('外した: linear')).toBeTruthy();
    const report = screen.getByLabelText('runner ごとの配布結果');
    expect(report.textContent).toContain(`runner-1: 届いた（sha256 ${'b'.repeat(12)}）`);
    // 届かなかった runner を小さく出さない。
    expect(report.textContent).toContain('runner-2: 届かなかった — runner に届かなかった');
    expect(screen.getByText('いつから効くか: クローンの次のセッションから')).toBeTruthy();
  });

  it('JSON として読めなければ確認へ進まず、送らない', async () => {
    const { puts } = stubMcp();
    renderScreen();

    fireEvent.click(await screen.findByRole('button', { name: '編集する' }));
    fireEvent.change(screen.getByLabelText('MCP サーバの新しい登録'), {
      target: { value: '{ "mcpServers": ' },
    });
    fireEvent.click(screen.getByRole('button', { name: '保存する' }));

    expect(screen.getByRole('alert').textContent).toContain('JSON として読めない（送っていない）');
    expect(screen.queryByRole('button', { name: '本当に保存する' })).toBeNull();
    expect(puts).toEqual([]);
  });

  it('400 なら不正な欄の位置を出し、前のものが残ると言う（確認は畳み、編集中の本文は残す）', async () => {
    const { puts } = stubMcp({
      put: {
        status: 400,
        body: { error: 'MCP サーバの登録の形が不正（保存していない）: mcpServers.x.command' },
      },
    });
    renderScreen();

    fireEvent.click(await screen.findByRole('button', { name: '編集する' }));
    const bad = '{ "mcpServers": { "x": {} } }';
    fireEvent.change(screen.getByLabelText('MCP サーバの新しい登録'), {
      target: { value: bad },
    });
    fireEvent.click(screen.getByRole('button', { name: '保存する' }));
    fireEvent.click(screen.getByRole('button', { name: '本当に保存する' }));

    expect(
      await screen.findByText('MCP サーバの登録の形が不正（保存していない）: mcpServers.x.command'),
    ).toBeTruthy();
    expect(screen.getByText('前の登録がそのまま残っている。')).toBeTruthy();
    expect(puts).toEqual([{ mcpServers: { x: {} } }]);
    expect(screen.getByLabelText<HTMLTextAreaElement>('MCP サーバの新しい登録').value).toBe(bad);
    expect(screen.queryByRole('button', { name: '本当に保存する' })).toBeNull();
    // 400 は持ち主の案内の対象ではない。
    expect(screen.queryByText('alteroid access owner <アカウント id>')).toBeNull();
  });

  it('PUT が requireOwner の 403 なら、持ち主として宣言する手を案内する', async () => {
    stubMcp({
      put: {
        status: 403,
        body: { error: '実行環境の持ち主として宣言されたアカウントだけが操作できる' },
      },
    });
    renderScreen();

    fireEvent.click(await screen.findByRole('button', { name: '編集する' }));
    fireEvent.change(screen.getByLabelText('MCP サーバの新しい登録'), {
      target: { value: '{ "mcpServers": {"a": {"command": "x"}} }' },
    });
    fireEvent.click(screen.getByRole('button', { name: '保存する' }));
    fireEvent.click(screen.getByRole('button', { name: '本当に保存する' }));

    expect(await screen.findByText('alteroid access owner <アカウント id>')).toBeTruthy();
    expect(screen.queryByText('前の登録がそのまま残っている。')).toBeNull();
  });

  it('「登録を全部外す」は確認を挟んでから空の mcpServers を PUT する（alteroid mcp clear と同じ）', async () => {
    const { puts } = stubMcp({
      put: {
        status: 200,
        body: {
          names: [],
          updatedAt: 'x',
          appliesFrom: 'y',
          runners: [{ runnerId: 'runner-1', ok: true }],
        },
      },
    });
    renderScreen();

    fireEvent.click(await screen.findByRole('button', { name: '登録を全部外す' }));
    expect(puts).toEqual([]);
    fireEvent.click(screen.getByRole('button', { name: '本当に外す' }));

    expect(await screen.findByText('MCP 連携の登録を外した。')).toBeTruthy();
    expect(puts).toEqual([{ mcpServers: {} }]);
    expect(screen.getByText('外した: github, linear')).toBeTruthy();
    expect(screen.getByLabelText('runner ごとの配布結果').textContent).toContain(
      'runner-1: 外した',
    );
  });
});
