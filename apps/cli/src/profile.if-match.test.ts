import { readFile, writeFile } from 'node:fs/promises';
import { join } from 'node:path';

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { makeTempDir } from '../../../vitest.tmpdir.js';

import { captureStderr, captureStdout } from './test-support.js';

vi.mock('./target.js', async (importOriginal) => ({
  ...(await importOriginal<typeof import('./target.js')>()),
  resolveTarget: () =>
    Promise.resolve({ baseUrl: 'http://127.0.0.1:4517', headers: {}, note: null, remote: false }),
}));

let editWith: ((path: string) => Promise<void>) | undefined;
vi.mock('node:child_process', () => ({
  spawn: vi.fn((_editor: string, args: string[]) => ({
    on(event: string, cb: (code: number | null) => void) {
      if (event === 'close')
        void (editWith?.((args[0] ?? '').replace(/^'(.*)'$/, '$1')) ?? Promise.resolve()).then(() =>
          cb(0),
        );
      return undefined;
    },
  })),
}));

const { profileEditCommand, profileSetCommand, profileRemoveCommand } =
  await import('./profile.js');

interface Reply {
  status: number;
  body: unknown;
}

let replies: Map<string, Reply>;
let sent: { url: string; method: string; body?: unknown }[];
let originalFetch: typeof fetch;

function setReply(method: string, path: string, reply: Reply): void {
  replies.set(`${method} ${path}`, reply);
}

beforeEach(() => {
  originalFetch = globalThis.fetch;
  replies = new Map();
  sent = [];
  editWith = undefined;
  globalThis.fetch = ((input: unknown, init?: RequestInit) => {
    const url = typeof input === 'string' ? input : String(input);
    const method = init?.method ?? 'GET';
    sent.push({ url, method, body: init?.body });
    const reply = replies.get(`${method} ${new URL(url).pathname}`) ?? { status: 200, body: {} };
    return Promise.resolve(
      new Response(JSON.stringify(reply.body), {
        status: reply.status,
        headers: { 'content-type': 'application/json' },
      }),
    );
  }) as typeof fetch;
  vi.stubEnv('VISUAL', 'sh');
});

afterEach(() => {
  globalThis.fetch = originalFetch;
  vi.restoreAllMocks();
  vi.unstubAllEnvs();
});

function profileWith(rows: { name: string; script: string; version?: string }[]) {
  return {
    entries: rows.map((row) => ({
      name: row.name,
      script: row.script,
      scope: 'all',
      updatedAt: '2026-10-01T00:00:00Z',
      sha256: 'abc123',
      bytes: Buffer.byteLength(row.script),
      ...(row.version === undefined ? {} : { version: row.version }),
    })),
    clone: {},
    runner: {},
    script: rows.map((row) => row.script).join('\n'),
  };
}

const UPDATED = {
  updatedAt: '2026-10-12T00:00:00Z',
  entries: [
    {
      name: 'rust',
      scope: 'all',
      updatedAt: '2026-10-12T00:00:00Z',
      sha256: 'def456',
      bytes: 10,
      version: 'v2',
    },
  ],
  composed: { clone: { sha256: 'cc11' }, runner: { sha256: 'rr22' } },
  clone: { ok: true },
  runners: [],
};

const CONFLICT = {
  status: 409,
  body: {
    error: 'プロファイルの行が読んだ後に変わっている（変えていない）',
    detail: 'プロファイルの行 rust は読んだ後に変わっている・作られている（変えていない）',
    current: null,
  },
};

function bodyOf(method: string): Record<string, unknown> | undefined {
  const call = sent.find((entry) => entry.method === method);
  return call?.body === undefined ? undefined : (JSON.parse(String(call.body)) as never);
}

describe('alteroid profile の書き込みは、読んだときの行の版を前提にする（#4592）', () => {
  it('edit は、エディタを開く前に読んだ版を ifMatch にして送る', async () => {
    setReply('GET', '/profile', {
      status: 200,
      body: profileWith([{ name: 'rust', script: 'export R=1\n', version: 'v1' }]),
    });
    setReply('PUT', '/profile/rust', { status: 200, body: UPDATED });
    editWith = async (path) => {
      await writeFile(path, 'export R=2\n');
    };
    captureStdout();

    await profileEditCommand('rust');

    expect(bodyOf('PUT')).toEqual({ script: 'export R=2\n', ifMatch: 'v1' });
  });

  it('edit で読んだ後に変わっていた（409）なら、変えていないと言い、書いた下書きを残す', async () => {
    setReply('GET', '/profile', {
      status: 200,
      body: profileWith([{ name: 'rust', script: 'export R=1\n', version: 'v1' }]),
    });
    setReply('PUT', '/profile/rust', CONFLICT);
    let draft = '';
    editWith = async (path) => {
      draft = path;
      await writeFile(path, 'export R=2\n');
    };
    captureStdout();
    const stderr = captureStderr();

    await expect(profileEditCommand('rust')).rejects.toThrow(
      /ほかで変わっていた（作られた・消された）ので、変えていません。\nalteroid profile show/,
    );
    expect(await readFile(draft, 'utf8')).toBe('export R=2\n');
    expect(stderr()).toContain(draft);
  });

  it('set は、置き換える行の読んだ版を ifMatch にして送る', async () => {
    setReply('GET', '/profile', {
      status: 200,
      body: profileWith([{ name: 'rust', script: 'export R=1\n', version: 'v1' }]),
    });
    setReply('PUT', '/profile/rust', { status: 200, body: UPDATED });
    const dir = await makeTempDir('alteroid-profile-if-match-');
    const path = join(dir, 'p.sh');
    await writeFile(path, 'export R=3\n');
    captureStdout();

    await profileSetCommand('rust', { file: path, yes: true });

    expect(bodyOf('PUT')).toEqual({ script: 'export R=3\n', ifMatch: 'v1' });
  });

  it('remove は、読んだ版をクエリの ifMatch にして送る', async () => {
    setReply('GET', '/profile', {
      status: 200,
      body: profileWith([{ name: 'rust', script: 'export R=1\n', version: 'v1' }]),
    });
    setReply('DELETE', '/profile/rust', { status: 200, body: { ...UPDATED, entries: [] } });
    captureStdout();

    await profileRemoveCommand('rust', { yes: true });

    const call = sent.find((entry) => entry.method === 'DELETE');
    expect(new URL(call?.url ?? 'http://x/').searchParams.get('ifMatch')).toBe('v1');
  });

  it('対照: 版を返さないデーモンには、在る行の ifMatch を付けない（今までどおり後勝ち）', async () => {
    setReply('GET', '/profile', {
      status: 200,
      body: profileWith([{ name: 'rust', script: 'export R=1\n' }]),
    });
    setReply('DELETE', '/profile/rust', { status: 200, body: { ...UPDATED, entries: [] } });
    captureStdout();

    await profileRemoveCommand('rust', { yes: true });

    const call = sent.find((entry) => entry.method === 'DELETE');
    expect(new URL(call?.url ?? 'http://x/').search).toBe('');
  });
});
