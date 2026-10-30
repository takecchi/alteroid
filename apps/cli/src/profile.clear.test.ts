import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { captureStdout } from './test-support.js';

/** `alteroid profile clear` の今の振る舞い（出力・消える行）を、口の選び方に依らず縛る（#5881）。 */
vi.mock('./target.js', async (importOriginal) => ({
  ...(await importOriginal<typeof import('./target.js')>()),
  resolveTarget: () =>
    Promise.resolve({ baseUrl: 'http://127.0.0.1:4517', headers: {}, note: null, remote: false }),
}));

const { profileClearCommand } = await import('./profile.js');

interface Row {
  name: string;
  scope: 'all' | 'app' | 'runner';
  script: string;
}

let rows: Row[];
let runnerOk: boolean;
let originalFetch: typeof fetch;

function entriesView() {
  return rows
    .map((row) => ({
      name: row.name,
      script: row.script,
      scope: row.scope,
      updatedAt: '2026-10-03T00:00:00Z',
      sha256: 'abc123',
      bytes: Buffer.byteLength(row.script),
      version: `v-${row.name}`,
    }))
    .sort((a, b) => (a.name < b.name ? -1 : 1));
}

function updateView() {
  return {
    updatedAt: '2026-10-03T00:00:00Z',
    entries: entriesView().map((row) => ({ ...row, script: undefined })),
    composed: { clone: {}, runner: {} },
    clone: { ok: true },
    runners: [
      runnerOk
        ? { runnerId: 'runner-a', ok: true }
        : { runnerId: 'runner-a', ok: false, error: 'push failed' },
    ],
  };
}

function json(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { 'content-type': 'application/json' },
  });
}

/** 行を持つ偽のデーモン。`DELETE /profile/:name` で行が消える。それ以外の口は 500 を返す。 */
beforeEach(() => {
  rows = [];
  runnerOk = true;
  originalFetch = globalThis.fetch;
  globalThis.fetch = ((input: unknown, init?: RequestInit) => {
    const request = input as { url?: string; method?: string };
    const url = new URL(typeof input === 'string' ? input : (request.url ?? String(input)));
    const method = init?.method ?? request.method ?? 'GET';
    if (method === 'GET' && url.pathname === '/profile') {
      return Promise.resolve(json({ entries: entriesView(), clone: {}, runner: {}, script: '' }));
    }
    const named = /^\/profile\/([^/]+)$/.exec(url.pathname);
    if (method === 'DELETE' && named !== null) {
      const name = decodeURIComponent(named[1] ?? '');
      if (!rows.some((row) => row.name === name))
        return Promise.resolve(json({ error: 'no' }, 404));
      rows = rows.filter((row) => row.name !== name);
      return Promise.resolve(json(updateView()));
    }
    return Promise.resolve(json({ error: `unexpected ${method} ${url.pathname}` }, 500));
  }) as typeof fetch;
});

afterEach(() => {
  globalThis.fetch = originalFetch;
  vi.restoreAllMocks();
});

describe('alteroid profile clear の振る舞い', () => {
  it('全部の行が消え、見出しと反映結果を出す。gh/git の案内は出さない', async () => {
    rows = [
      { name: 'default', scope: 'all', script: 'export A=1\n' },
      { name: 'rust', scope: 'runner', script: 'export R=1\n' },
      { name: 'zz', scope: 'app', script: 'export Z=1\n' },
    ];
    const read = captureStdout();

    await profileClearCommand({ yes: true });

    expect(rows).toEqual([]);
    const text = read();
    expect(text).toContain('プロファイルを全部外しました。\n');
    expect(text).toContain('  クローン: 反映しました\n');
    expect(text).toContain('  runner-a: 反映しました\n');
    expect(text).not.toContain('警告');
    expect(text).not.toContain('これから起こす仕事には即座に効きます');
  });

  it('行が1つも無くても、見出しを出して正常に終わる', async () => {
    const read = captureStdout();

    await profileClearCommand({ yes: true });

    expect(rows).toEqual([]);
    expect(read()).toContain('プロファイルを全部外しました。\n');
  });

  it('runner への反映が失敗したら、警告の見出しと失敗の台を出して例外にする。行は消えている', async () => {
    rows = [
      { name: 'default', scope: 'all', script: 'export A=1\n' },
      { name: 'rust', scope: 'runner', script: 'export R=1\n' },
    ];
    runnerOk = false;
    const read = captureStdout();

    await expect(profileClearCommand({ yes: true })).rejects.toThrow('一部失敗');

    expect(rows).toEqual([]);
    const text = read();
    expect(text).toContain(
      '警告: プロファイルを全部外しましたが、一部の runner へ反映できていません。\n',
    );
    expect(text).toContain('  runner-a: 反映できませんでした — push failed\n');
  });
});
