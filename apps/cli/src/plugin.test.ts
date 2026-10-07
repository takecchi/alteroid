import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import type { ConfirmIo } from './confirm.js';
import { captureStdout, pretendTty } from './test-support.js';

/**
 * `alteroid plugin` — plugin を入れる・外す口（list / add / remove）。
 *
 * 固定するのは次の各点:
 *
 * 1. `add` は **プレビュー → 確認 → 確定** の2段。確認を通るまで `POST /plugins` を打たない
 * 2. プレビューは中身と取り元を出し、**hooks を含むことを目立たせる**
 * 3. 非対話では `--yes` が要る。確認でやめたら確定しない
 * 4. `<url>` は https の URL、それ以外は marketplace の名前として送る
 *
 * `fetch` を差し替え、本物の hono client を通す（経路名や method を間違えれば応答表に当たらず赤くなる）。
 */
vi.mock('./target.js', async (importOriginal) => ({
  ...(await importOriginal<typeof import('./target.js')>()),
  resolveTarget: () =>
    Promise.resolve({ baseUrl: 'http://127.0.0.1:4517', headers: {}, note: null, remote: false }),
}));

const { pluginListCommand, pluginAddCommand, pluginRemoveCommand } = await import('./plugin.js');

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

beforeEach(() => {
  originalFetch = globalThis.fetch;
  replies = new Map();
  sent = [];
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
});

afterEach(() => {
  globalThis.fetch = originalFetch;
  vi.restoreAllMocks();
});

const SHA = 'a'.repeat(40);

function summary(overrides: Record<string, unknown> = {}) {
  return {
    name: 'demo',
    description: 'デモの説明',
    source: { kind: 'url', url: 'https://example.invalid/r.git', sha: SHA },
    sha: SHA,
    fileCount: 3,
    totalBytes: 123,
    files: [
      { path: 'skills/a/SKILL.md', size: 50, executable: false },
      { path: 'bin/tool', size: 10, executable: true },
    ],
    counts: { skills: 1, agents: 2, commands: 3 },
    hooks: { present: false, paths: [] },
    modules: { present: false, paths: [] },
    lspServers: { present: false, paths: [] },
    mcp: { present: false, paths: [] },
    executables: { extracted: ['skills/a/run.sh'], notExtracted: ['bin/tool'] },
    shellExecution: { present: false, paths: [] },
    skipped: [],
    extractorDrops: [{ path: 'bin/tool', reason: 'not-allowlisted' }],
    skillExcerpts: [{ path: 'skills/a/SKILL.md', excerpt: '最初の一文です', truncated: false }],
    ...overrides,
  };
}

const PREVIEW = { previewId: 'p'.repeat(32), expiresAt: '2026-10-07T00:10:00.000Z' };

function installed(overrides: Record<string, unknown> = {}) {
  return {
    plugin: {
      name: 'demo',
      source: { kind: 'url', url: 'https://example.invalid/r.git', sha: SHA },
      scope: 'all',
      enableHooks: false,
      enableMcp: false,
      contentSha256: 'c'.repeat(64),
      fileCount: 3,
      totalBytes: 123,
      installedAt: '2026-10-07T00:00:00.000Z',
      installedBy: 'x',
    },
    appliesFrom: '次に開くセッションから',
    runners: [{ runnerId: 'runner-a', ok: true }],
    ...overrides,
  };
}

function io(answer: string | null, isTTY = true): ConfirmIo & { asked: string[] } {
  const asked: string[] = [];
  return {
    isTTY,
    asked,
    write: () => undefined,
    ask: async (question) => {
      asked.push(question);
      return answer ?? '';
    },
  };
}

describe('alteroid plugin list', () => {
  it('名前・scope・フラグ・取り元・SHA を並べる。空なら案内', async () => {
    setReply('GET', '/plugins', { status: 200, body: { plugins: [] } });
    const read = captureStdout();
    await pluginListCommand();
    expect(read()).toContain('plugin は入っていません');

    setReply('GET', '/plugins', {
      status: 200,
      body: {
        plugins: [
          {
            ...installed().plugin,
            scope: 'runner',
            enableHooks: true,
          },
        ],
      },
    });
    const read2 = captureStdout();
    await pluginListCommand();
    const text = read2();
    expect(text).toContain('demo');
    expect(text).toContain('runner');
    expect(text).toContain(SHA.slice(0, 12));
    expect(text).toContain('https://example.invalid/r.git');
    expect(text).toMatch(/hooks/);
  });
});

describe('alteroid plugin add', () => {
  it('URL: プレビューを出し、確認の後に確定する。送る本文を固定する', async () => {
    setReply('POST', '/plugins/preview', { status: 200, body: { ...PREVIEW, summary: summary() } });
    setReply('POST', '/plugins', { status: 200, body: installed() });
    const read = captureStdout();
    const confirm = io('yes');

    await pluginAddCommand(
      'https://example.invalid/r.git',
      { path: 'plugins/demo', sha: SHA, scope: 'runner', enableMcp: true },
      confirm,
    );

    expect(sent.map((s) => `${s.method} ${s.path}`)).toEqual([
      'POST /plugins/preview',
      'GET /plugins',
      'POST /plugins',
    ]);
    expect(sent[0]?.body).toEqual({
      kind: 'url',
      url: 'https://example.invalid/r.git',
      path: 'plugins/demo',
      sha: SHA,
    });
    expect(sent[2]?.body).toEqual({
      previewId: PREVIEW.previewId,
      scope: 'runner',
      enableHooks: false,
      enableMcp: true,
    });
    const text = read();
    expect(text).toContain('demo');
    expect(text).toContain('デモの説明');
    expect(text).toContain(SHA);
    expect(text).toContain('https://example.invalid/r.git');
    expect(text).toContain('最初の一文です');
    expect(text).toContain('bin/tool');
    expect(confirm.asked).toHaveLength(1);
    expect(text).toContain('runner-a');
    expect(text).toContain('次に開くセッションから');
  });

  it('同名の plugin が入っているときは、置き換え（前の SHA → 新しい SHA）を見せる', async () => {
    const OLD = 'b'.repeat(40);
    setReply('GET', '/plugins', {
      status: 200,
      body: {
        plugins: [
          {
            ...installed().plugin,
            source: { kind: 'url', url: 'https://example.invalid/r.git', sha: OLD },
          },
        ],
      },
    });
    setReply('POST', '/plugins/preview', { status: 200, body: { ...PREVIEW, summary: summary() } });
    setReply('POST', '/plugins', { status: 200, body: installed() });
    const read = captureStdout();
    const confirm = io('yes');

    await pluginAddCommand('https://example.invalid/r.git', {}, confirm);

    expect(read()).toContain(`置き換えます（SHA ${OLD} → ${SHA}）`);
  });

  it('同名が入っていなければ、置き換えとは言わない', async () => {
    setReply('GET', '/plugins', { status: 200, body: { plugins: [] } });
    setReply('POST', '/plugins/preview', { status: 200, body: { ...PREVIEW, summary: summary() } });
    setReply('POST', '/plugins', { status: 200, body: installed() });
    const read = captureStdout();
    const confirm = io('yes');

    await pluginAddCommand('https://example.invalid/r.git', {}, confirm);

    expect(read()).not.toContain('置き換え');
  });

  it('marketplace 名は kind=marketplace で送る。--path / --sha は添えられない', async () => {
    setReply('POST', '/plugins/preview', { status: 200, body: { ...PREVIEW, summary: summary() } });
    setReply('POST', '/plugins', { status: 200, body: installed() });
    captureStdout();
    await pluginAddCommand('demo', { yes: true });
    expect(sent[0]?.body).toEqual({ kind: 'marketplace', plugin: 'demo' });
    expect(sent[2]?.body).toEqual({
      previewId: PREVIEW.previewId,
      scope: 'all',
      enableHooks: false,
      enableMcp: false,
    });

    sent = [];
    await expect(pluginAddCommand('demo', { sha: SHA, yes: true })).rejects.toThrow(/marketplace/);
    await expect(pluginAddCommand('demo', { path: 'x', yes: true })).rejects.toThrow(/marketplace/);
    expect(sent).toEqual([]);
  });

  it('SHA でない --sha はブランチ・タグ名として ref で送る必要があるので --ref を使わせる', async () => {
    setReply('POST', '/plugins/preview', { status: 200, body: { ...PREVIEW, summary: summary() } });
    setReply('POST', '/plugins', { status: 200, body: installed() });
    captureStdout();
    await expect(
      pluginAddCommand('https://example.invalid/r.git', { sha: 'main', yes: true }),
    ).rejects.toThrow(/--ref/);
    expect(sent).toEqual([]);

    await pluginAddCommand('https://example.invalid/r.git', { ref: 'v1', yes: true });
    expect(sent[0]?.body).toEqual({ kind: 'url', url: 'https://example.invalid/r.git', ref: 'v1' });
  });

  it('hooks を含むなら、プレビューで目立たせる（展開されないことも言う）', async () => {
    setReply('POST', '/plugins/preview', {
      status: 200,
      body: {
        ...PREVIEW,
        summary: summary({ hooks: { present: true, paths: ['hooks/hooks.json'] } }),
      },
    });
    const read = captureStdout();
    await expect(pluginAddCommand('https://example.invalid/r.git', {}, io('no'))).rejects.toThrow();
    const text = read();
    expect(text).toContain('hooks');
    expect(text).toContain('hooks/hooks.json');
    expect(text).toMatch(/!!|警告/);
    expect(text).toContain('展開');
  });

  it('実行ファイルは、展開されるものとされないものを分けて出す', async () => {
    setReply('POST', '/plugins/preview', { status: 200, body: { ...PREVIEW, summary: summary() } });
    const read = captureStdout();
    await expect(pluginAddCommand('https://example.invalid/r.git', {}, io('no'))).rejects.toThrow();
    const text = read();
    expect(text).toMatch(/実行ファイル（展開される）: skills\/a\/run\.sh/);
    expect(text).toMatch(/実行ファイル（展開されない）: bin\/tool/);
  });

  it('skills / commands の本文にシェル実行の記法があれば、警告を出す', async () => {
    setReply('POST', '/plugins/preview', {
      status: 200,
      body: {
        ...PREVIEW,
        summary: summary({ shellExecution: { present: true, paths: ['commands/c.md'] } }),
      },
    });
    const read = captureStdout();
    await expect(pluginAddCommand('https://example.invalid/r.git', {}, io('no'))).rejects.toThrow();
    const text = read();
    expect(text).toMatch(/!!|警告/);
    expect(text).toContain('commands/c.md');
    expect(text).toContain('!`');
  });

  it('確認でやめたら確定しない。非対話で --yes が無ければ確定しない', async () => {
    setReply('POST', '/plugins/preview', { status: 200, body: { ...PREVIEW, summary: summary() } });
    captureStdout();
    await expect(pluginAddCommand('https://example.invalid/r.git', {}, io('n'))).rejects.toThrow();
    await expect(
      pluginAddCommand('https://example.invalid/r.git', {}, io(null, false)),
    ).rejects.toThrow(/--yes/);
    expect(sent.filter((s) => s.method === 'POST' && s.path === '/plugins')).toEqual([]);
  });

  it('不正な --scope は何も打たずに断る', async () => {
    captureStdout();
    await expect(
      pluginAddCommand('https://example.invalid/r.git', { scope: 'x', yes: true }),
    ).rejects.toThrow(/scope/);
    expect(sent).toEqual([]);
  });

  it('プレビューの失敗・409・403 を文言にして投げる', async () => {
    captureStdout();
    setReply('POST', '/plugins/preview', { status: 400, body: { error: '取れなかった理由' } });
    await expect(pluginAddCommand('https://example.invalid/r.git', { yes: true })).rejects.toThrow(
      '取れなかった理由',
    );

    setReply('POST', '/plugins/preview', { status: 200, body: { ...PREVIEW, summary: summary() } });
    setReply('POST', '/plugins', { status: 409, body: { error: '名前が衝突' } });
    await expect(pluginAddCommand('https://example.invalid/r.git', { yes: true })).rejects.toThrow(
      '名前が衝突',
    );

    setReply('POST', '/plugins/preview', {
      status: 403,
      body: { error: 'このアカウントには alteroid を使う許可が無い' },
    });
    await expect(pluginAddCommand('https://example.invalid/r.git', { yes: true })).rejects.toThrow(
      /access grant/,
    );
  });

  it('配布に失敗した runner があれば警告し、非 0 で終える（保存は済んでいる）', async () => {
    setReply('POST', '/plugins/preview', { status: 200, body: { ...PREVIEW, summary: summary() } });
    setReply('POST', '/plugins', {
      status: 200,
      body: installed({ runners: [{ runnerId: 'runner-b', ok: false, error: 'down' }] }),
    });
    const read = captureStdout();
    await expect(pluginAddCommand('https://example.invalid/r.git', { yes: true })).rejects.toThrow(
      /runner/,
    );
    expect(read()).toContain('runner-b');
  });
});

describe('alteroid plugin remove', () => {
  it('DELETE /plugins/<name> を打ち、結果を出す', async () => {
    setReply('DELETE', '/plugins/demo', {
      status: 200,
      body: { name: 'demo', appliesFrom: 'いつか', runners: [{ runnerId: 'runner-a', ok: true }] },
    });
    const read = captureStdout();
    await pluginRemoveCommand('demo');
    expect(sent).toEqual([{ method: 'DELETE', path: '/plugins/demo', body: undefined }]);
    expect(read()).toContain('demo');
    expect(read()).toContain('runner-a');
  });

  it('無ければ 404 の文言を投げる', async () => {
    setReply('DELETE', '/plugins/nope', { status: 404, body: { error: '入っていない' } });
    captureStdout();
    await expect(pluginRemoveCommand('nope')).rejects.toThrow('入っていない');
  });
});

describe('非対話', () => {
  it('pretendTty(false) でも --yes があれば通る', async () => {
    const restore = pretendTty(false);
    try {
      setReply('POST', '/plugins/preview', {
        status: 200,
        body: { ...PREVIEW, summary: summary() },
      });
      setReply('POST', '/plugins', { status: 200, body: installed() });
      captureStdout();
      await pluginAddCommand('https://example.invalid/r.git', { yes: true });
      expect(sent.at(-1)?.path).toBe('/plugins');
    } finally {
      restore();
    }
  });
});
