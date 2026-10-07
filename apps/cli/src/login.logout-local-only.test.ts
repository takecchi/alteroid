import { chmod, mkdir, readdir, readFile, writeFile } from 'node:fs/promises';
import { join } from 'node:path';

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { makeTempDir } from '../../../vitest.tmpdir.js';

import { captureStdout } from './test-support.js';

vi.mock('./target.js', () => ({
  resolveTarget: vi.fn(() =>
    Promise.resolve({ baseUrl: 'http://127.0.0.1:4517', headers: {}, note: null, remote: true }),
  ),
  describeAuthFailure: () => null,
  isRunnerContainer: vi.fn(() => false),
}));

const { logoutCommand } = await import('./login.js');

let home: string;
let originalHome: string | undefined;
let originalFetch: typeof fetch;
let fetched: string[];
let stderrChunks: string[];
let originalStderrWrite: typeof process.stderr.write;

beforeEach(async () => {
  home = await makeTempDir('alteroid-cli-logout-local-only-test-');
  originalHome = process.env.ALTEROID_HOME;
  process.env.ALTEROID_HOME = home;
  await mkdir(join(home, 'state'), { recursive: true });

  fetched = [];
  originalFetch = globalThis.fetch;
  globalThis.fetch = ((input: unknown) => {
    fetched.push(String(input));
    return Promise.reject(new Error('connect ECONNREFUSED'));
  }) as typeof fetch;

  stderrChunks = [];
  originalStderrWrite = process.stderr.write.bind(process.stderr);
  process.stderr.write = ((chunk: unknown): boolean => {
    stderrChunks.push(String(chunk));
    return true;
  }) as typeof process.stderr.write;
});

afterEach(() => {
  process.stderr.write = originalStderrWrite;
  globalThis.fetch = originalFetch;
  if (originalHome === undefined) delete process.env.ALTEROID_HOME;
  else process.env.ALTEROID_HOME = originalHome;
});

function credentialsPath(): string {
  return join(home, 'state', 'credentials.json');
}

describe('alteroid logout と壊れた資格ファイル（#3819）', () => {
  it('--local-only: 壊れた JSON は退避して空にし、ほかの接続先も空になると言う（サーバへは呼ばない）', async () => {
    const broken = '{"http://127.0.0.1:4517": {"token": "fake-tok';
    await writeFile(credentialsPath(), broken, 'utf8');
    const read = captureStdout();

    await logoutCommand({ localOnly: true });

    const text = read();
    expect(text).toContain('手元のログイン情報だけを消しました');
    expect(text).toContain('壊れていた');
    expect(text).toContain('ほかの接続先のログイン情報も空');
    expect(fetched).toEqual([]);

    const names = await readdir(join(home, 'state'));
    const quarantined = names.filter((name) => name.startsWith('credentials.json.unreadable-'));
    expect(quarantined).toHaveLength(1);
    expect(await readFile(join(home, 'state', quarantined[0] as string), 'utf8')).toBe(broken);
    expect(await readFile(credentialsPath(), 'utf8')).toBe('{}\n');
    expect(text).not.toContain('fake-tok');
    expect(stderrChunks.join('')).not.toContain('fake-tok');
  });

  it('--local-only: 壊れていないファイルなら、これまでどおり自分の接続先だけ消える', async () => {
    await writeFile(
      credentialsPath(),
      JSON.stringify({
        'http://127.0.0.1:4517': { token: 'fake-1', accountId: 'a', label: 'A', createdAt: 'x' },
        'http://other.example': { token: 'fake-2', accountId: 'b', label: 'B', createdAt: 'x' },
      }),
      'utf8',
    );
    const read = captureStdout();

    await logoutCommand({ localOnly: true });

    const text = read();
    expect(text).toContain('手元のログイン情報だけを消しました');
    expect(text).not.toContain('ほかの接続先');
    const left = JSON.parse(await readFile(credentialsPath(), 'utf8')) as Record<string, unknown>;
    expect(Object.keys(left)).toEqual(['http://other.example']);
  });

  it('--local-only: ファイルが無ければ「ログイン情報はありません」と言い、ファイルは作らない', async () => {
    const read = captureStdout();

    await logoutCommand({ localOnly: true });

    expect(read()).toContain('のログイン情報はありません');
    expect(await readdir(join(home, 'state'))).toEqual([]);
  });

  it('--local-only なし: 壊れていれば失敗のまま。「ログインしていない」とは言わず、--local-only を案内する', async () => {
    await writeFile(credentialsPath(), 'not json {{{', 'utf8');
    captureStdout();

    const error = await logoutCommand().then(
      () => null,
      (e: unknown) => e as Error,
    );

    expect(error).not.toBeNull();
    expect((error as Error).message).toContain('壊れていて、JSON として読めません');
    expect((error as Error).message).toContain('ログインしていないのではありません');
    expect((error as Error).message).toContain('alteroid logout --local-only');
    expect(fetched).toEqual([]);
    expect(await readFile(credentialsPath(), 'utf8')).toBe('not json {{{');
  });

  it.skipIf(process.getuid?.() === 0)(
    '--local-only: 権限エラー（EACCES）は、読めない旨の案内で止まり、ファイルは動かさない',
    async () => {
      await writeFile(credentialsPath(), '{}', 'utf8');
      await chmod(credentialsPath(), 0o000);
      captureStdout();
      try {
        await expect(logoutCommand({ localOnly: true })).rejects.toThrow(
          'ログインしていないのではありません',
        );
        const names = await readdir(join(home, 'state'));
        expect(names.filter((n) => n.includes('unreadable'))).toEqual([]);
      } finally {
        await chmod(credentialsPath(), 0o600);
      }
    },
  );
});
