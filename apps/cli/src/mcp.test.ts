import { writeFile } from 'node:fs/promises';
import { join } from 'node:path';

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { makeTempDir } from '../../../vitest.tmpdir.js';

import { captureStdout } from './test-support.js';

/**
 * `alteroid mcp` — 人間の MCP 連携の登録（#325 段4）。
 *
 * ここで固定するのは次の各点:
 *
 * 1. **`list` と素の `show` は値を1文字も出さない**（`env` / `headers` の値・`args`・
 *    URL のクエリ）。`show --reveal` だけが `.mcp.json` にそのまま貼れる形で全部出す
 * 2. **`set` / `clear` は `PUT /mcp-servers` へ `{ mcpServers }` を送り**、足した・外した
 *    名前・指紋・runner ごとの成否を出す（配り損ねを小さく出さない）
 * 3. **403 は本文で出し分ける**（未宣言なら `access owner`、未許可なら `access grant`、
 *    判別できなければ案内しない）
 *
 * **`fetch` を差し替え、本物の hono client（`client.ts` の `createClient`）を通す。**
 * `mcp.ts` は hono client で打つので、経路名（`mcp-servers`）の綴りや method を
 * 間違えればこの応答表に当たらず、既定の空応答になって赤くなる。
 */
/**
 * **`./target.js` は `resolveTarget` だけ差し替える。** `forbiddenKindOf` と
 * `describeAuthFailure` は本物を使う（`credential.test.ts` と同じ理由 —— 403 の
 * 案内を分けているのはこの2つである）。
 */
vi.mock('./target.js', async (importOriginal) => ({
  ...(await importOriginal<typeof import('./target.js')>()),
  resolveTarget: () =>
    Promise.resolve({ baseUrl: 'http://127.0.0.1:4517', headers: {}, note: null, remote: false }),
}));

/**
 * `$EDITOR` の代わり。**起こされたファイルを書き換えてから `close(0)` を返す**
 * —— `editWith` に入れた関数が、エディタで人間が書いた結果になる。
 */
let editWith: ((path: string) => Promise<void>) | undefined;
vi.mock('node:child_process', () => ({
  spawn: vi.fn((_editor: string, args: string[]) => ({
    on(event: string, cb: (code: number) => void) {
      if (event === 'close') {
        const path = args[0] ?? '';
        void (editWith?.(path) ?? Promise.resolve()).then(() => cb(0));
      }
      return undefined;
    },
  })),
}));

const {
  mcpListCommand,
  mcpShowCommand,
  mcpSetCommand,
  mcpEditCommand,
  mcpClearCommand,
  maskUrl,
  parseMcpJson,
} = await import('./mcp.js');

interface Reply {
  status: number;
  body: unknown;
}

let replies: Map<string, Reply>;
let sent: { method: string; path: string; body: unknown }[];
let originalFetch: typeof fetch;

function setReply(method: string, path: string, reply: Reply): void {
  replies.set(`${method} ${path}`, reply);
}

function stubFetch(): void {
  globalThis.fetch = (async (input: unknown, init?: RequestInit) => {
    const request = input instanceof Request ? input : null;
    const url = typeof input === 'string' ? input : (request?.url ?? String(input));
    const method = init?.method ?? request?.method ?? 'GET';
    const path = new URL(url).pathname;
    const raw =
      typeof init?.body === 'string' ? init.body : request !== null ? await request.text() : '';
    sent.push({ method, path, body: raw.length > 0 ? (JSON.parse(raw) as unknown) : undefined });
    const reply = replies.get(`${method} ${path}`) ?? { status: 200, body: {} };
    return new Response(JSON.stringify(reply.body), {
      status: reply.status,
      headers: { 'content-type': 'application/json' },
    });
  }) as typeof fetch;
}

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
  updatedAt: '2026-09-24T00:00:00.000Z',
};

beforeEach(() => {
  originalFetch = globalThis.fetch;
  replies = new Map();
  sent = [];
  editWith = undefined;
  stubFetch();
});

afterEach(() => {
  globalThis.fetch = originalFetch;
  vi.restoreAllMocks();
});

describe('alteroid mcp list', () => {
  it('名前・種類・宛先・鍵の名前だけを出し、値は1文字も出さない', async () => {
    setReply('GET', '/mcp-servers', { status: 200, body: STORED });
    const read = captureStdout();

    await mcpListCommand();

    const text = read();
    expect(text).toContain('MCP サーバの登録: 2 件（更新 2026-09-24T00:00:00.000Z）');
    expect(text).toContain('  github  stdio  npx');
    expect(text).toContain('    args: 3 個（値は伏せた）');
    expect(text).toContain('    env: GITHUB_TOKEN');
    expect(text).toContain('  linear  http  https://mcp.linear.app/mcp?***');
    expect(text).toContain('    headers: Authorization');
    expect(text).not.toContain(SECRET);
    expect(sent).toEqual([{ method: 'GET', path: '/mcp-servers', body: undefined }]);
  });

  it('置かれていなければ、無いことと置き方を言う', async () => {
    setReply('GET', '/mcp-servers', { status: 200, body: { mcpServers: {} } });
    const read = captureStdout();

    await mcpListCommand();

    expect(read()).toBe('MCP サーバの登録はありません。\n置くには: alteroid mcp edit\n');
  });
});

describe('alteroid mcp show', () => {
  it('--reveal が無ければ値を伏せた JSON を出す（鍵の名前は残す）', async () => {
    setReply('GET', '/mcp-servers', { status: 200, body: STORED });
    const read = captureStdout();

    await mcpShowCommand();

    const text = read();
    expect(text).not.toContain(SECRET);
    expect(text).toContain('"GITHUB_TOKEN": "***"');
    expect(text).toContain('"Authorization": "***"');
    expect(text).toContain('"command": "npx"');
    expect(text).toContain('全部見るには: alteroid mcp show --reveal');
  });

  it('--reveal なら .mcp.json にそのまま貼れる形だけを出す（値を含む、余計な行なし）', async () => {
    setReply('GET', '/mcp-servers', { status: 200, body: STORED });
    const read = captureStdout();

    await mcpShowCommand({ reveal: true });

    const text = read();
    expect(JSON.parse(text)).toEqual({ mcpServers: STORED.mcpServers });
  });
});

describe('alteroid mcp set / clear', () => {
  it('ファイルの .mcp.json を PUT し、足した・外した名前と runner ごとの成否を出す', async () => {
    setReply('GET', '/mcp-servers', { status: 200, body: STORED });
    setReply('PUT', '/mcp-servers', {
      status: 200,
      body: {
        names: ['github', 'notion'],
        updatedAt: '2026-09-24T01:00:00.000Z',
        sha256: 'abcdefabcdef',
        appliesFrom: 'クローンの次のセッションから',
        runners: [
          {
            runnerId: 'runner-a',
            ok: true,
            mcpServers: { names: ['github', 'notion'], sha256: 'abcdefabcdef' },
          },
          { runnerId: 'runner-b', ok: false, error: 'ECONNRESET' },
          { runnerId: 'runner-c', ok: false, unsupported: true, error: '404' },
          {
            runnerId: 'runner-d',
            ok: true,
            mcpServers: { names: ['github'], sha256: '000000000000' },
          },
        ],
      },
    });
    const next = {
      mcpServers: {
        github: { command: 'npx', args: ['-y', 'x'] },
        notion: { type: 'sse', url: 'https://example.com/sse' },
      },
    };
    const dir = await makeTempDir('alteroid-cli-mcp-set-');
    const path = join(dir, '.mcp.json');
    await writeFile(path, JSON.stringify(next), 'utf8');
    const read = captureStdout();

    await mcpSetCommand(path);

    const put = sent.find((s) => s.method === 'PUT');
    expect(put?.path).toBe('/mcp-servers');
    expect(put?.body).toEqual(next);
    const text = read();
    expect(text).toContain('MCP サーバの登録を差し替えました (sha256 abcdefabcdef)');
    expect(text).toContain('  足した: notion');
    expect(text).toContain('  外した: linear');
    expect(text).toContain('  置き直した: github');
    expect(text).toContain('  runner-a: 届きました（sha256 abcdefabcdef）');
    expect(text).toContain('  runner-b: 届けられませんでした — ECONNRESET');
    expect(text).toContain('  runner-c: 受け取る口がありません（古い runner） — 404');
    expect(text).toContain(
      '  runner-d: 届きましたが指紋が違います（runner 000000000000 / 保存 abcdefabcdef）',
    );
    expect(text).toContain('いつから効くか: クローンの次のセッションから');
  });

  it('mcpServers の欄が無い JSON は送らずに止める', async () => {
    const dir = await makeTempDir('alteroid-cli-mcp-set-');
    const path = join(dir, 'bad.json');
    await writeFile(path, JSON.stringify({ github: { command: 'npx' } }), 'utf8');

    await expect(mcpSetCommand(path)).rejects.toThrow('"mcpServers"');
    expect(sent.filter((s) => s.method === 'PUT')).toEqual([]);
  });

  it('400 なら error を出し、前の登録が残っていると言う', async () => {
    setReply('GET', '/mcp-servers', { status: 200, body: { mcpServers: {} } });
    setReply('PUT', '/mcp-servers', {
      status: 400,
      body: { error: 'MCP サーバの登録の形が不正（保存していない）: mcpServers.x.command' },
    });
    const dir = await makeTempDir('alteroid-cli-mcp-set-');
    const path = join(dir, '.mcp.json');
    await writeFile(path, JSON.stringify({ mcpServers: { x: {} } }), 'utf8');

    await expect(mcpSetCommand(path)).rejects.toThrow(
      'MCP サーバの登録の形が不正（保存していない）: mcpServers.x.command\n（前の登録がそのまま残っています）',
    );
  });

  it('clear は空の mcpServers を PUT し、外したことと外した名前を言う', async () => {
    setReply('GET', '/mcp-servers', { status: 200, body: STORED });
    setReply('PUT', '/mcp-servers', {
      status: 200,
      body: {
        names: [],
        updatedAt: '2026-09-24T01:00:00.000Z',
        appliesFrom: 'クローンの次のセッションから',
        runners: [{ runnerId: 'runner-a', ok: true }],
      },
    });
    const read = captureStdout();

    await mcpClearCommand();

    expect(sent.find((s) => s.method === 'PUT')?.body).toEqual({ mcpServers: {} });
    const text = read();
    expect(text).toContain('MCP サーバの登録を外しました。');
    expect(text).toContain('  外した: github, linear');
    expect(text).toContain('  runner-a: 外しました');
  });

  it('配った runner が無ければ、無いと言う（黙らない）', async () => {
    setReply('GET', '/mcp-servers', { status: 200, body: { mcpServers: {} } });
    setReply('PUT', '/mcp-servers', {
      status: 200,
      body: { names: [], updatedAt: 'x', appliesFrom: 'y', runners: [] },
    });
    const read = captureStdout();

    await mcpClearCommand();

    expect(read()).toContain('いま配った先はありません');
  });
});

describe('alteroid mcp edit', () => {
  it('いまの登録を JSON で開き、書き換えた内容を PUT する', async () => {
    setReply('GET', '/mcp-servers', { status: 200, body: STORED });
    setReply('PUT', '/mcp-servers', {
      status: 200,
      body: {
        names: ['github'],
        updatedAt: 'x',
        sha256: 'f'.repeat(12),
        appliesFrom: 'y',
        runners: [],
      },
    });
    let opened = '';
    editWith = async (path) => {
      const { readFile } = await import('node:fs/promises');
      opened = await readFile(path, 'utf8');
      await writeFile(path, JSON.stringify({ mcpServers: { github: STORED.mcpServers.github } }));
    };
    const read = captureStdout();

    await mcpEditCommand();

    // 開いたのは値を含む本物（伏せた写しを開くと、保存したときに鍵が *** に化ける）。
    expect(JSON.parse(opened)).toEqual({ mcpServers: STORED.mcpServers });
    expect(sent.find((s) => s.method === 'PUT')?.body).toEqual({
      mcpServers: { github: STORED.mcpServers.github },
    });
    expect(read()).toContain('  外した: linear');
  });

  it('何も変えずに閉じれば PUT しない', async () => {
    setReply('GET', '/mcp-servers', { status: 200, body: STORED });
    const read = captureStdout();

    await mcpEditCommand();

    expect(sent.filter((s) => s.method === 'PUT')).toEqual([]);
    expect(read()).toBe('変更はありません。\n');
  });
});

describe('403 の出し分け', () => {
  it('requireOwner（未宣言）の 403 なら access owner を案内する', async () => {
    setReply('GET', '/mcp-servers', {
      status: 403,
      body: { error: '実行環境の持ち主として宣言されたアカウントだけが操作できる' },
    });

    await expect(mcpListCommand()).rejects.toThrow('alteroid access owner <アカウント id>');
  });

  it('未許可の 403 なら access grant を案内する', async () => {
    setReply('GET', '/mcp-servers', {
      status: 403,
      body: { error: 'このアカウントには alteroid を使う許可が無い' },
    });

    await expect(mcpListCommand()).rejects.toThrow('alteroid access grant <アカウント id>');
  });

  it('本文から判別できない 403 には案内を出さない', async () => {
    setReply('GET', '/mcp-servers', { status: 403, body: { error: '別の理由' } });

    const failure = mcpListCommand();
    await expect(failure).rejects.toThrow('理由を判別できなかったため');
    await expect(failure).rejects.not.toThrow('alteroid access');
  });
});

describe('伏せ方と読み方', () => {
  it('maskUrl はクエリ・フラグメント・認証情報を伏せ、読めない URL は丸ごと伏せる', () => {
    expect(maskUrl('https://example.com/mcp')).toBe('https://example.com/mcp');
    expect(maskUrl('https://example.com/mcp?token=x')).toBe('https://example.com/mcp?***');
    expect(maskUrl('https://u:p@example.com/mcp')).toBe('https://example.com/mcp?***');
    expect(maskUrl('https://example.com/mcp#k')).toBe('https://example.com/mcp?***');
    expect(maskUrl('not a url with secret')).toBe('***');
  });

  it('parseMcpJson は JSON として読めないものを、保存していないと言って止める', () => {
    expect(() => parseMcpJson('{')).toThrow('JSON として読めませんでした（何も保存していません）');
  });
});
