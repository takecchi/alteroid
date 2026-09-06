import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { captureStdout } from './test-support.js';

/**
 * `alteroid profile` — #333。この3つ（index / login / profile）はこれまで
 * テストが1本も無かった。
 *
 * **`fetch` を差し替える。** `profile.ts` は `access.ts` と同じく `hono/client`
 * を使わず素の `fetch` を叩く（`request()`）。ただし `profile.ts` は同じ
 * コマンドの中で `GET /profile` と `GET /runners`（`profileStatusCommand`）や
 * `PUT /profile`（`profileSetCommand` / `profileClearCommand`）のように
 * **複数の経路を打つ**ので、`access.test.ts` の「先入れ先出しで積む」形は
 * 合わない。ここでは `method + path` をキーにした応答表にする。
 *
 * **`node:child_process` の `spawn` も差し替える** — `profileEditCommand` が
 * `$EDITOR` を起こす（`memory.ts` の `openEditor` と同型）。この器に実際の
 * エディタは無いので、即座に `close(0)` を返す形にする。
 */
/**
 * **`./target.js` は `resolveTarget` だけ差し替える。** `forbiddenKindOf` と
 * `describeAuthFailure` は**本物を使う**——403 の案内を分けているのはこの2つ
 * なので、ここを偽物にすると、この歯が測るのは偽物の分岐になり、赤が出ても
 * 出どころが自分のアサーションだと言えなくなる。
 */
vi.mock('./target.js', async (importOriginal) => ({
  ...(await importOriginal<typeof import('./target.js')>()),
  resolveTarget: () =>
    Promise.resolve({ baseUrl: 'http://127.0.0.1:4517', headers: {}, note: null, remote: false }),
}));

vi.mock('node:child_process', () => ({
  spawn: vi.fn(() => ({
    on(event: string, cb: (code: number) => void) {
      // `child.on('error', reject)` は先に登録されるが、ここでは呼ばない
      // （エディタは常に成功する前提のテストだけを置く）。
      if (event === 'close') cb(0);
      return undefined;
    },
  })),
}));

const {
  profileShowCommand,
  profileStatusCommand,
  profileSetCommand,
  profileClearCommand,
  profileEditCommand,
} = await import('./profile.js');

interface Reply {
  status: number;
  body: unknown;
}

let replies: Map<string, Reply>;
let sent: { url: string; method: string }[];
let originalFetch: typeof fetch;

function setReply(method: string, path: string, reply: Reply): void {
  replies.set(`${method} ${path}`, reply);
}

function stubFetch(): void {
  globalThis.fetch = ((input: unknown, init?: RequestInit) => {
    const request = input as { url?: string; method?: string };
    const url = typeof input === 'string' ? input : (request.url ?? String(input));
    const method = init?.method ?? request.method ?? 'GET';
    const path = new URL(url).pathname;
    sent.push({ url, method });
    const reply = replies.get(`${method} ${path}`) ?? { status: 200, body: {} };
    return Promise.resolve(
      new Response(JSON.stringify(reply.body), {
        status: reply.status,
        headers: { 'content-type': 'application/json' },
      }),
    );
  }) as typeof fetch;
}

beforeEach(() => {
  originalFetch = globalThis.fetch;
  replies = new Map();
  sent = [];
  stubFetch();
});

afterEach(() => {
  globalThis.fetch = originalFetch;
  vi.restoreAllMocks();
});

describe('alteroid profile show', () => {
  it('置かれていなければ、無いことと置き方を言う', async () => {
    setReply('GET', '/profile', { status: 200, body: { script: '' } });
    const read = captureStdout();

    await profileShowCommand();

    const text = read();
    expect(text).toContain('プロファイルは置かれていません。');
    expect(text).toContain('置くには: alteroid profile edit');
  });

  it('置かれていれば、本文をそのまま出す（末尾に改行が無ければ1つ足す）', async () => {
    setReply('GET', '/profile', { status: 200, body: { script: 'export FOO=bar' } });
    const read = captureStdout();

    await profileShowCommand();

    expect(read()).toBe('export FOO=bar\n');
  });
});

describe('alteroid profile status', () => {
  it('バイト数・sha256・更新日時と、各 runner の届き具合を並べる', async () => {
    setReply('GET', '/profile', {
      status: 200,
      body: {
        script: 'export FOO=bar',
        bytes: 12,
        sha256: 'abc123',
        updatedAt: '2026-08-01T00:00:00Z',
      },
    });
    setReply('GET', '/runners', {
      status: 200,
      body: {
        runners: [
          {
            label: 'https://runner-a.internal',
            state: 'connected',
            runnerId: 'runner-a',
            profile: { sha256: 'abc123', updatedAt: '2026-08-01T00:00:00Z' },
          },
          {
            label: 'https://runner-b.internal',
            state: 'connecting',
            // runnerId 無し＝繋がるまで分からない状態。宛先（label）で言う。
            profile: undefined,
          },
        ],
      },
    });
    const read = captureStdout();

    await profileStatusCommand();

    const text = read();
    expect(text).toContain('プロファイル: 12 バイト (sha256 abc123 / 更新 2026-08-01T00:00:00Z)');
    expect(text).toContain('  runner-a: sha256 abc123 (2026-08-01T00:00:00Z)');
    expect(text).toContain('  https://runner-b.internal: プロファイル無し（connecting）');
  });
});

describe('alteroid profile set', () => {
  it('ファイルの内容を PUT し、成功・失敗それぞれの反映結果と gh/git の案内を出す', async () => {
    setReply('PUT', '/profile', {
      status: 200,
      body: {
        updatedAt: '2026-08-24T00:00:00Z',
        sha256: 'def456',
        bytes: 15,
        clone: { ok: true, names: ['GH_TOKEN'] },
        runners: [{ runnerId: 'runner-a', ok: false, error: 'timeout', output: 'line1\nline2' }],
      },
    });
    const dir = await mkdtemp(join(tmpdir(), 'alteroid-profile-set-'));
    const path = join(dir, 'profile.sh');
    await writeFile(path, 'export FOO=bar\n', 'utf8');
    const read = captureStdout();

    try {
      await profileSetCommand({ file: path });
    } finally {
      await rm(dir, { recursive: true, force: true });
    }

    const text = read();
    expect(text).toContain('プロファイルを更新しました (sha256 def456)');
    expect(text).toContain('  クローン: 反映しました（GH_TOKEN）');
    expect(text).toContain('  runner-a: 反映できませんでした — timeout');
    expect(text).toContain('    | line1');
    expect(text).toContain('    | line2');
    // 中身が空でないので、走行中の仕事にどこまで届くかの案内も出る。
    expect(text).toContain('これから起こす仕事には即座に効きます');
  });
});

describe('alteroid profile clear', () => {
  it('外した事実だけを言い、gh/git の案内は出さない（中身が空だから）', async () => {
    setReply('PUT', '/profile', {
      status: 200,
      body: { updatedAt: '2026-08-24T00:00:00Z', clone: { ok: true }, runners: [] },
    });
    const read = captureStdout();

    await profileClearCommand();

    const text = read();
    expect(text).toContain('プロファイルを外しました。');
    expect(text).toContain('  クローン: 反映しました\n');
    expect(text).not.toContain('これから起こす仕事には即座に効きます');
  });
});

describe('alteroid profile edit', () => {
  it('$EDITOR で開いても中身を変えなければ「変更はありません」と言って PUT しない', async () => {
    setReply('GET', '/profile', { status: 200, body: { script: 'export FOO=bar\n' } });
    const read = captureStdout();

    await profileEditCommand();

    expect(read()).toBe('変更はありません。\n');
    // PUT を1件も打っていない（変更が無ければ反映もしない）。
    expect(sent.some((s) => s.method === 'PUT')).toBe(false);
  });
});

/**
 * 403 の案内を、**サーバが返した本文で分ける**（`token.test.ts` と同じ形）。
 *
 * **`/profile` は今回 ① へ開けなかった2本である。** 開けなかった側でも、403 の
 * *案内*は正しくなければならない——資格の線と、案内の正しさは別の話である。
 */
describe('403（本文で理由を分ける）', () => {
  /**
   * **この2つの逐語は `apps/daemon/src/app.ts` が返す本文の複製である。**
   * `target.ts` の定数も `apps/daemon` も import しない——対象と同じ値を
   * 参照すると、文言がずれても歯まで一緒にずれて自己整合し、ずれを検出でき
   * なくなる。**値はここへ書き写し、ずれたらこの歯が落ちる形にしてある。**
   */
  const NOT_OPERATOR = { error: '実行環境の持ち主だけが操作できる' };
  const NOT_GRANTED = { error: 'このアカウントには alteroid を使う許可が無い' };

  /** 投げられた文言そのものを取る（どちらの手順が出たかを両側から見るため）。 */
  async function messageOf(run: () => Promise<unknown>): Promise<string> {
    try {
      await run();
    } catch (error) {
      return error instanceof Error ? error.message : String(error);
    }
    throw new Error('403 で拒否されるはずが、成功してしまった');
  }

  it('持ち主でないときは専用の文言を出す', async () => {
    setReply('GET', '/profile', { status: 403, body: NOT_OPERATOR });

    const message = await messageOf(() => profileShowCommand());
    expect(message).toContain('実行環境の持ち主だけです');
    expect(message).toContain('docker compose exec');
    expect(message).not.toContain('access grant');
  });

  it('未 grant のときは access grant を促す（器の中で実行しろ、と言わない）', async () => {
    setReply('GET', '/profile', { status: 403, body: NOT_GRANTED });

    const message = await messageOf(() => profileShowCommand());
    expect(message).toContain('access grant');
    expect(message).not.toContain('docker compose exec');
  });

  it('判別できない本文なら、どちらの手順も出さない', async () => {
    setReply('GET', '/profile', { status: 403, body: {} });

    const message = await messageOf(() => profileShowCommand());
    expect(message).toContain('403');
    expect(message).not.toContain('docker compose exec');
    expect(message).not.toContain('access grant');
  });
});
