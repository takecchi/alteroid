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
 * 5. **403 に宣言の案内を出さない。** 本文が何であれ（かつての `requireOwner` の本文でも）、持ち主として宣言する手は案内しない（#2862）
 * 6. **保存したら 実行環境ごとの反映結果を出す**（配り損ねを小さく出さない）
 */
import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { createMemoryRouter, Link, RouterProvider } from 'react-router';
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
function stubMcp(options: { get?: Reply; put?: Reply; putGate?: Promise<void> } = {}) {
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
      // 保存の完了を、テストが好きな時点まで止める（実時間の待ちは使わない）。
      await options.putGate;
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
  // `useBlocker` はデータルーターの中でしか動かない。離れる先のリンクも置く。
  const router = createMemoryRouter(
    [
      {
        path: '/mcp-servers',
        Component: () => (
          <>
            <Link to="/elsewhere">よその画面</Link>
            <McpServersPage />
          </>
        ),
      },
      { path: '/elsewhere', Component: () => <p>よその画面です</p> },
    ],
    { initialEntries: ['/mcp-servers'] },
  );
  render(
    <Providers>
      <RouterProvider router={router} />
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
    expect(screen.getByText('環境変数: GITHUB_TOKEN')).toBeTruthy();
    expect(screen.getByText('引数: 3 個（値は伏せた）')).toBeTruthy();
    expect(screen.getByText('https://mcp.linear.app/mcp?***')).toBeTruthy();
    expect(screen.getByText('ヘッダ: Authorization')).toBeTruthy();
    expect(document.body.textContent).not.toContain(SECRET);

    fireEvent.click(screen.getByRole('button', { name: '値を表示する' }));
    expect(screen.getByLabelText('登録の本文（値を含む）').textContent).toContain(
      `"GITHUB_TOKEN": "${SECRET}"`,
    );

    fireEvent.click(screen.getByRole('button', { name: '値を隠す' }));
    expect(document.body.textContent).not.toContain(SECRET);
  });

  /**
   * 🔴 **password だけの userinfo（`https://:秘密@host`）も、押す前の一覧に出さない**
   * （issue #1622）。`username` だけを見る判定では、`username` が空文字のこの形が
   * 素通りし、秘密が一覧にそのまま出ていた。
   */
  it('password だけの userinfo の宛先も伏せ、押す前の一覧に秘密を出さない', async () => {
    stubMcp({
      get: {
        status: 200,
        body: {
          mcpServers: {
            passwordOnly: { type: 'http', url: `https://:${SECRET}@mcp.example.com/mcp` },
          },
          updatedAt: '2026-09-20T00:00:00.000Z',
        },
      },
    });
    renderScreen();

    expect(await screen.findByText('passwordOnly')).toBeTruthy();
    expect(screen.getByText('https://mcp.example.com/mcp?***')).toBeTruthy();
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

  it('かつての requireOwner の本文の 403 でも、持ち主の宣言は案内しない（#2862）', async () => {
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
    expect(screen.queryByText('alteroid access owner <アカウント id>')).toBeNull();
    expect(screen.queryByText(/持ち主として宣言してください/)).toBeNull();
    expect(screen.queryByRole('button', { name: '編集する' })).toBeNull();
  });

  it('許可の無い 403 にも、持ち主の宣言は案内しない', async () => {
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
    // runner-2 が届いていないので、成功の見出しではなく警告（warn 色）になる（#3157）。
    const heading = await screen.findByText(
      /MCP 連携の登録は保存したが、一部の実行環境へ反映できていない（確認用の値 b{12}）/,
    );
    expect(heading.className).toContain('text-warn');
    expect(screen.queryByText(/MCP 連携の登録を差し替えた/)).toBeNull();
    expect(puts).toEqual([next]);
    expect(screen.getByText('足した: notion')).toBeTruthy();
    expect(screen.getByText('外した: linear')).toBeTruthy();
    const report = screen.getByLabelText('実行環境ごとの反映結果');
    expect(report.textContent).toContain(`runner-1: 届いた（確認用の値 ${'b'.repeat(12)}）`);
    // 届かなかった runner を小さく出さない。
    expect(report.textContent).toContain('runner-2: 届かなかった — runner に届かなかった');
    expect(screen.getByText('いつから効くか: クローンの次のセッションから')).toBeTruthy();
  });

  it('Ctrl + Enter は「保存する」と同じ（確認へ進むだけ）。確認の段では何もせず、確認を飛ばして送らない', async () => {
    const { puts } = stubMcp();
    renderScreen();

    fireEvent.click(await screen.findByRole('button', { name: '編集する' }));
    const editor = screen.getByLabelText<HTMLTextAreaElement>('MCP サーバの新しい登録');
    // 変更が無いあいだは何も起きない（保存ボタンも disabled）。
    fireEvent.keyDown(editor, { key: 'Enter', ctrlKey: true });
    expect(screen.queryByRole('button', { name: '本当に保存する' })).toBeNull();

    const next = { mcpServers: { notion: { type: 'sse', url: 'https://example.com/sse' } } };
    fireEvent.change(editor, { target: { value: JSON.stringify(next) } });
    fireEvent.keyDown(editor, { key: 'Enter' });
    expect(screen.queryByRole('button', { name: '本当に保存する' })).toBeNull();
    fireEvent.keyDown(editor, { key: 'Enter', ctrlKey: true });
    expect(screen.getByRole('button', { name: '本当に保存する' })).toBeTruthy();
    expect(puts).toEqual([]);

    // 確認の段でもう一度押しても、送らない（確認は「本当に保存する」でだけ越える）。
    fireEvent.keyDown(editor, { key: 'Enter', metaKey: true });
    expect(puts).toEqual([]);
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
    expect(screen.queryByText('alteroid access owner <アカウント id>')).toBeNull();
  });

  it('PUT がかつての requireOwner の本文の 403 でも、持ち主の宣言は案内しない', async () => {
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

    expect(
      await screen.findByText('実行環境の持ち主として宣言されたアカウントだけが操作できる'),
    ).toBeTruthy();
    expect(screen.queryByText('alteroid access owner <アカウント id>')).toBeNull();
    expect(screen.queryByText(/持ち主として宣言してください/)).toBeNull();
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
    expect(screen.getByLabelText('実行環境ごとの反映結果').textContent).toContain(
      'runner-1: 外した',
    );
  });
});

/** 書きかけがあるときだけ、閉じる・離れる前に確認する（#3370）。 */
describe('/mcp-servers 画面 — 書きかけを確認なしで捨てない', () => {
  const EDITOR = 'MCP サーバの新しい登録';

  async function startDirty() {
    stubMcp();
    renderScreen();
    fireEvent.click(await screen.findByRole('button', { name: '編集する' }));
    fireEvent.change(screen.getByLabelText(EDITOR), { target: { value: '{ 書きかけ' } });
  }

  it('書きかけのまま「編集を閉じる」を押すと確認が出る。やめれば残り、破棄すると閉じる', async () => {
    await startDirty();
    fireEvent.click(screen.getByRole('button', { name: '編集を閉じる' }));

    expect(await screen.findByRole('alertdialog')).toBeTruthy();
    fireEvent.click(screen.getByRole('button', { name: 'やめる' }));
    await waitFor(() => expect(screen.queryByRole('alertdialog')).toBeNull());
    expect(screen.getByLabelText<HTMLTextAreaElement>(EDITOR).value).toContain('書きかけ');

    fireEvent.click(screen.getByRole('button', { name: '編集を閉じる' }));
    fireEvent.click(await screen.findByRole('button', { name: '破棄して閉じる' }));
    expect(screen.queryByLabelText(EDITOR)).toBeNull();
  });

  it('書きかけが無ければ「編集を閉じる」は確認なしで閉じる', async () => {
    stubMcp();
    renderScreen();
    fireEvent.click(await screen.findByRole('button', { name: '編集する' }));
    fireEvent.click(screen.getByRole('button', { name: '編集を閉じる' }));

    expect(screen.queryByRole('alertdialog')).toBeNull();
    expect(screen.queryByLabelText(EDITOR)).toBeNull();
  });

  it('書きかけのまま画面を離れると確認が出る。破棄すると移動する', async () => {
    await startDirty();
    fireEvent.click(screen.getByRole('link', { name: 'よその画面' }));

    expect(await screen.findByText('保存していない変更があります')).toBeTruthy();
    fireEvent.click(screen.getByRole('button', { name: 'やめる' }));
    await waitFor(() => expect(screen.queryByRole('alertdialog')).toBeNull());
    expect(screen.getByLabelText<HTMLTextAreaElement>(EDITOR).value).toContain('書きかけ');

    fireEvent.click(screen.getByRole('link', { name: 'よその画面' }));
    fireEvent.click(await screen.findByRole('button', { name: '破棄して離れる' }));
    expect(await screen.findByText('よその画面です')).toBeTruthy();
  });

  it('書きかけが無ければ確認なしで離れる', async () => {
    stubMcp();
    renderScreen();
    await screen.findByRole('button', { name: '編集する' });
    fireEvent.click(screen.getByRole('link', { name: 'よその画面' }));

    expect(await screen.findByText('よその画面です')).toBeTruthy();
  });

  it('beforeunload は書きかけのときだけ止める', async () => {
    stubMcp();
    renderScreen();
    fireEvent.click(await screen.findByRole('button', { name: '編集する' }));
    const clean = new Event('beforeunload', { cancelable: true });
    window.dispatchEvent(clean);
    expect(clean.defaultPrevented).toBe(false);

    fireEvent.change(screen.getByLabelText(EDITOR), { target: { value: '{}' } });
    const dirty = new Event('beforeunload', { cancelable: true });
    window.dispatchEvent(dirty);
    expect(dirty.defaultPrevented).toBe(true);
  });
});

describe('保存中の追記は、成功しても消えない', () => {
  it('保存中に編集欄へ打ち足すと、編集欄は閉じず追記が残る', async () => {
    let release: () => void = () => {};
    const putGate = new Promise<void>((resolve) => {
      release = resolve;
    });
    const { puts } = stubMcp({ putGate });
    renderScreen();

    fireEvent.click(await screen.findByRole('button', { name: '編集する' }));
    const editor = screen.getByLabelText<HTMLTextAreaElement>('MCP サーバの新しい登録');
    const next = { mcpServers: { notion: { type: 'sse', url: 'https://example.com/sse' } } };
    fireEvent.change(editor, { target: { value: JSON.stringify(next) } });
    fireEvent.click(screen.getByRole('button', { name: '保存する' }));
    fireEvent.click(screen.getByRole('button', { name: '本当に保存する' }));
    await waitFor(() => expect(puts).toHaveLength(1));

    const appended = JSON.stringify(next) + '\n// 追記';
    fireEvent.change(editor, { target: { value: appended } });
    release();

    // 結果は出るが、編集欄は閉じず、追記が残る。
    await screen.findByText(/MCP 連携の登録/);
    expect(screen.getByLabelText<HTMLTextAreaElement>('MCP サーバの新しい登録').value).toBe(
      appended,
    );
  });
});
