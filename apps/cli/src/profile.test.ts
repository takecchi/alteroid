import { writeFile } from 'node:fs/promises';
import { join } from 'node:path';

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { makeTempDir } from '../../../vitest.tmpdir.js';

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
  profileListCommand,
  profileRemoveCommand,
} = await import('./profile.js');

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

function stubFetch(): void {
  globalThis.fetch = ((input: unknown, init?: RequestInit) => {
    const request = input as { url?: string; method?: string };
    const url = typeof input === 'string' ? input : (request.url ?? String(input));
    const method = init?.method ?? request.method ?? 'GET';
    const path = new URL(url).pathname;
    sent.push({ url, method, body: init?.body });
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
  // `openEditor` は起こす前にエディタが在るかを見る（#2867）。`spawn` は差し替えて
  // あるので中身は起きないが、在ると見える名前を置く（器に vi が無くても通るように）
  vi.stubEnv('VISUAL', 'sh');
});

afterEach(() => {
  globalThis.fetch = originalFetch;
  vi.restoreAllMocks();
  vi.unstubAllEnvs();
});

/** `GET /profile` の応答の1行（本文つき）。 */
function entryOf(
  name: string,
  script: string,
  scope: 'all' | 'app' | 'runner' = 'all',
  extra: { bytes?: number; sha256?: string; updatedAt?: string } = {},
) {
  return {
    name,
    script,
    scope,
    updatedAt: extra.updatedAt ?? '2026-08-01T00:00:00Z',
    sha256: extra.sha256 ?? 'abc123',
    bytes: extra.bytes ?? Buffer.byteLength(script),
  };
}

/** `GET /profile` の応答（行と、合成後の指紋）。 */
function profileBody(
  entries: ReturnType<typeof entryOf>[],
  composed: { clone?: string; runner?: string } = {},
) {
  return {
    entries,
    clone: composed.clone === undefined ? {} : { sha256: composed.clone, bytes: 10 },
    runner: composed.runner === undefined ? {} : { sha256: composed.runner, bytes: 10 },
    script: entries.map((e) => e.script).join('\n'),
  };
}

describe('alteroid profile show', () => {
  it('置かれていなければ、無いことと置き方を言う', async () => {
    setReply('GET', '/profile', { status: 200, body: profileBody([]) });
    const read = captureStdout();

    await profileShowCommand();

    const text = read();
    expect(text).toContain('プロファイルは置かれていません。');
    expect(text).toContain('置くには: alteroid profile edit');
  });

  it('名前を省くと default の本文を、そのまま出す（末尾に改行が無ければ1つ足す）', async () => {
    setReply('GET', '/profile', {
      status: 200,
      body: profileBody([entryOf('default', 'export FOO=bar'), entryOf('rust', 'export R=1')]),
    });
    const read = captureStdout();

    await profileShowCommand();

    expect(read()).toBe('export FOO=bar\n');
  });

  it('名前を渡すとその行の本文だけを出す（標準出力は本文だけ。パイプで set へ戻せる）', async () => {
    setReply('GET', '/profile', {
      status: 200,
      body: profileBody([entryOf('default', 'export FOO=bar'), entryOf('rust', 'export R=1\n')]),
    });
    const read = captureStdout();

    await profileShowCommand('rust');

    expect(read()).toBe('export R=1\n');
  });

  it('無い名前は、一覧の取り方を案内して落ちる', async () => {
    setReply('GET', '/profile', {
      status: 200,
      body: profileBody([entryOf('default', 'export FOO=bar')]),
    });
    captureStdout();

    await expect(profileShowCommand('nope')).rejects.toThrow('行 nope は無い');
  });

  it('不正な名前は、通信の前に落ちる', async () => {
    captureStdout();

    await expect(profileShowCommand('../etc')).rejects.toThrow('行の名前の形が不正');
    expect(sent).toEqual([]);
  });
});

describe('alteroid profile list', () => {
  it('名前・撒く先・バイト数・更新時刻を並べる。本文は出さない', async () => {
    setReply('GET', '/profile', {
      status: 200,
      body: profileBody([
        entryOf('base', 'export SECRET_BASE=1', 'all', { bytes: 20 }),
        entryOf('rust', 'export SECRET_RUST=1', 'runner', { bytes: 21 }),
      ]),
    });
    const read = captureStdout();

    await profileListCommand();

    const text = read();
    expect(text).toContain('base  all（共通）  20 バイト  更新 2026-08-01T00:00:00Z');
    expect(text).toContain('rust  runner（manager だけ）  21 バイト  更新 2026-08-01T00:00:00Z');
    expect(text).not.toContain('SECRET_');
  });

  it('置かれていなければ、無いことを言う', async () => {
    setReply('GET', '/profile', { status: 200, body: profileBody([]) });
    const read = captureStdout();

    await profileListCommand();

    expect(read()).toContain('プロファイルは置かれていません。');
  });
});

describe('alteroid profile status', () => {
  const runnersBody = (profile: unknown) => ({
    status: 200,
    body: {
      runners: [
        {
          label: 'https://runner-a.internal',
          state: 'connected',
          runnerId: 'runner-a',
          profile,
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

  it('行の一覧・撒く先・合成後の指紋と、各 runner の届き具合（runner 用の合成と一致するか）を並べる', async () => {
    setReply('GET', '/profile', {
      status: 200,
      body: profileBody(
        [
          entryOf('base', 'export FOO=bar', 'all', { bytes: 12, sha256: 'row111' }),
          entryOf('rust', 'export R=1', 'runner', { bytes: 10, sha256: 'row222' }),
        ],
        { clone: 'cloneSha', runner: 'abc123' },
      ),
    });
    setReply(
      'GET',
      '/runners',
      runnersBody({ sha256: 'abc123', updatedAt: '2026-08-01T00:00:00Z' }),
    );
    const read = captureStdout();

    await profileStatusCommand();

    const text = read();
    expect(text).toContain('プロファイル: 2 行');
    expect(text).toContain(
      'base  all（共通）  12 バイト  更新 2026-08-01T00:00:00Z (sha256 row111)',
    );
    expect(text).toContain('rust  runner（manager だけ）  10 バイト');
    expect(text).toContain('クローン用（合成後）: 10 バイト (sha256 cloneSha)');
    expect(text).toContain('runner 用（合成後）: 10 バイト (sha256 abc123)');
    expect(text).toContain(
      '  runner-a: sha256 abc123 (2026-08-01T00:00:00Z)（runner 用の合成と一致）',
    );
    expect(text).toContain('  https://runner-b.internal: プロファイル無し（connecting）');
  });

  it('runner に載っている指紋が runner 用の合成と違えば、食い違うと言う', async () => {
    setReply('GET', '/profile', {
      status: 200,
      body: profileBody([entryOf('base', 'export FOO=bar')], { clone: 'c', runner: 'expected1' }),
    });
    setReply('GET', '/runners', runnersBody({ sha256: 'stale999', updatedAt: 'T' }));
    const read = captureStdout();

    await profileStatusCommand();

    expect(read()).toContain('runner 用の合成 expected1 と食い違う');
  });

  it('runner に掛かる行が0（app だけ）で何も載っていないのは、食い違いではなく正しい状態として出す', async () => {
    setReply('GET', '/profile', {
      status: 200,
      body: profileBody([entryOf('a', 'export A=1', 'app')], { clone: 'c' }),
    });
    setReply('GET', '/runners', runnersBody(undefined));
    const read = captureStdout();

    await profileStatusCommand();

    const text = read();
    expect(text).toContain('app（clone だけ）');
    expect(text).toContain('runner 用（合成後）: 掛かる行なし');
    expect(text).toContain(
      '  runner-a: プロファイル無し（runner に掛かる行が無いので、載っていないのが正しい。connected）',
    );
  });

  it('runner に掛かる行が0なのに runner に載っているなら、外しの降ろしが済んでいないと言う', async () => {
    setReply('GET', '/profile', {
      status: 200,
      body: profileBody([entryOf('a', 'export A=1', 'app')], { clone: 'c' }),
    });
    setReply('GET', '/runners', runnersBody({ sha256: 'old', updatedAt: 'T' }));
    const read = captureStdout();

    await profileStatusCommand();

    expect(read()).toContain('外しの降ろしが済んでいない');
  });

  it('runner に掛かる行が在るのに載っていなければ、今までどおり「プロファイル無し」だけ', async () => {
    setReply('GET', '/profile', {
      status: 200,
      body: profileBody([entryOf('a', 'export A=1', 'runner')], { runner: 'r' }),
    });
    setReply('GET', '/runners', runnersBody(undefined));
    const read = captureStdout();

    await profileStatusCommand();

    const text = read();
    expect(text).toContain('  runner-a: プロファイル無し（connected）\n');
    expect(text).not.toContain('正しい');
  });

  it('置かれていなければ、そう言う', async () => {
    setReply('GET', '/profile', { status: 200, body: profileBody([]) });
    setReply('GET', '/runners', { status: 200, body: { runners: [] } });
    const read = captureStdout();

    await profileStatusCommand();

    expect(read()).toContain('プロファイル: 置かれていません');
  });
});

/** `PUT` / `DELETE /profile/:name` の成功応答。 */
function updateBody(
  entries: { name: string; scope: 'all' | 'app' | 'runner'; sha256?: string }[],
  overrides: Record<string, unknown> = {},
) {
  return {
    updatedAt: '2026-10-03T00:00:00Z',
    entries: entries.map((e) => ({
      name: e.name,
      scope: e.scope,
      updatedAt: '2026-10-03T00:00:00Z',
      sha256: e.sha256 ?? 'def456',
      bytes: 15,
    })),
    composed: { clone: { sha256: 'cc11' }, runner: { sha256: 'rr22' } },
    clone: { ok: true, names: ['GH_TOKEN'] },
    runners: [{ runnerId: 'runner-a', ok: false, error: 'timeout', output: 'line1\nline2' }],
    ...overrides,
  };
}

describe('alteroid profile set', () => {
  it('ファイルの内容で1行を PUT し、成功・失敗それぞれの反映結果と gh/git の案内を出す', async () => {
    setReply('GET', '/profile', { status: 200, body: profileBody([]) });
    setReply('PUT', '/profile/default', {
      status: 200,
      body: updateBody([{ name: 'default', scope: 'all' }]),
    });
    const dir = await makeTempDir('alteroid-profile-set-');
    const path = join(dir, 'profile.sh');
    await writeFile(path, 'export FOO=bar\n', 'utf8');
    const read = captureStdout();

    await profileSetCommand(undefined, { file: path });

    const text = read();
    expect(text).toContain('プロファイルの行 default を更新しました (sha256 def456)');
    expect(text).toContain('  撒く先: all（共通）');
    expect(text).toContain('  合成後の指紋: クローン用 cc11 / runner 用 rr22');
    expect(text).toContain('  クローン: 反映しました（GH_TOKEN）');
    expect(text).toContain('  runner-a: 反映できませんでした — timeout');
    expect(text).toContain('    | line1');
    expect(text).toContain('    | line2');
    expect(text).toContain('これから起こす仕事には即座に効きます');
  });

  it('名前と --scope を PUT /profile/:name へ送る。--scope を省くと scope を送らない', async () => {
    setReply('GET', '/profile', { status: 200, body: profileBody([]) });
    setReply('PUT', '/profile/rust', {
      status: 200,
      body: updateBody([{ name: 'rust', scope: 'runner' }]),
    });
    const dir = await makeTempDir('alteroid-profile-set-');
    const path = join(dir, 'p.sh');
    await writeFile(path, 'export RUST=1\n', 'utf8');
    const read = captureStdout();

    await profileSetCommand('rust', { file: path, scope: 'runner' });
    await profileSetCommand('rust', { file: path });

    const puts = sent.filter((entry) => entry.method === 'PUT');
    expect(puts.map((entry) => new URL(entry.url).pathname)).toEqual([
      '/profile/rust',
      '/profile/rust',
    ]);
    expect(JSON.parse(String(puts[0]?.body))).toEqual({
      script: 'export RUST=1\n',
      scope: 'runner',
    });
    expect(JSON.parse(String(puts[1]?.body))).toEqual({ script: 'export RUST=1\n' });
    expect(read()).toContain('撒く先: runner（manager だけ）');
  });

  it('不正な --scope・名前・空の本文は PUT する前に落ちる', async () => {
    captureStdout();
    const dir = await makeTempDir('alteroid-profile-set-');
    const path = join(dir, 'p.sh');
    await writeFile(path, 'export A=1\n', 'utf8');
    const empty = join(dir, 'empty.sh');
    await writeFile(empty, '  \n', 'utf8');

    await expect(profileSetCommand('a', { file: path, scope: 'everyone' })).rejects.toThrow(
      '--scope は all / app / runner のいずれかである（渡されたのは everyone）',
    );
    await expect(profileSetCommand('bad name', { file: path })).rejects.toThrow(
      '行の名前の形が不正',
    );
    await expect(profileSetCommand('a', { file: empty })).rejects.toThrow(
      '本文が空では行を置けない',
    );
    expect(sent).toEqual([]);
  });
});

describe('alteroid profile rm', () => {
  it('1行を DELETE する。外した事実と反映結果を言う', async () => {
    setReply('GET', '/profile', {
      status: 200,
      body: profileBody([entryOf('rust', 'export R=1\n', 'runner')]),
    });
    setReply('DELETE', '/profile/rust', { status: 200, body: updateBody([]) });
    const read = captureStdout();

    await profileRemoveCommand('rust');

    const text = read();
    expect(text).toContain('プロファイルの行 rust を外しました。');
    expect(text).toContain('  クローン: 反映しました（GH_TOKEN）');
    // 古いデーモンかを見るために先に GET する（旧形式の倒れ先）。
    expect(sent.map((entry) => `${entry.method} ${new URL(entry.url).pathname}`)).toEqual([
      'GET /profile',
      'DELETE /profile/rust',
    ]);
  });

  it('不正な名前は通信の前に落ちる', async () => {
    captureStdout();
    await expect(profileRemoveCommand('../x')).rejects.toThrow('行の名前の形が不正');
    expect(sent).toEqual([]);
  });
});

describe('alteroid profile clear', () => {
  it('全行を外す（旧来の全文置換の口へ空を1回）。gh/git の案内は出さない', async () => {
    setReply('PUT', '/profile', {
      status: 200,
      body: updateBody([], { clone: { ok: true }, runners: [] }),
    });
    const read = captureStdout();

    await profileClearCommand();

    const text = read();
    expect(text).toContain('プロファイルを全部外しました。');
    expect(text).toContain('  クローン: 反映しました\n');
    expect(text).not.toContain('これから起こす仕事には即座に効きます');
    const put = sent.find((entry) => entry.method === 'PUT');
    expect(new URL(put?.url ?? 'http://x/').pathname).toBe('/profile');
    expect(JSON.parse(String(put?.body))).toEqual({ script: '' });
  });
});

describe('alteroid profile edit', () => {
  it('$EDITOR で開いても中身も撒く先も変えなければ「変更はありません」と言って PUT しない', async () => {
    setReply('GET', '/profile', {
      status: 200,
      body: profileBody([entryOf('default', 'export FOO=bar\n')]),
    });
    const read = captureStdout();

    await profileEditCommand();

    expect(read()).toBe('変更はありません。\n');
    // PUT を1件も打っていない（変更が無ければ反映もしない）。
    expect(sent.some((s) => s.method === 'PUT')).toBe(false);
  });

  it('撒く先だけを変えるなら、本文が同じでも PUT する（外れる側が出るので更新である）', async () => {
    setReply('GET', '/profile', {
      status: 200,
      body: profileBody([entryOf('rust', 'export FOO=bar\n', 'all')]),
    });
    setReply('PUT', '/profile/rust', {
      status: 200,
      body: updateBody([{ name: 'rust', scope: 'runner' }]),
    });
    captureStdout();

    await profileEditCommand('rust', { scope: 'runner' });

    const put = sent.find((entry) => entry.method === 'PUT');
    expect(new URL(put?.url ?? 'http://x/').pathname).toBe('/profile/rust');
    expect(JSON.parse(String(put?.body))).toEqual({ script: 'export FOO=bar\n', scope: 'runner' });
  });

  it('撒く先が今と同じで本文も同じなら PUT しない', async () => {
    setReply('GET', '/profile', {
      status: 200,
      body: profileBody([entryOf('rust', 'export FOO=bar\n', 'runner')]),
    });
    const read = captureStdout();

    await profileEditCommand('rust', { scope: 'runner' });

    expect(read()).toBe('変更はありません。\n');
    expect(sent.some((entry) => entry.method === 'PUT')).toBe(false);
  });

  it('不正な --scope・名前は通信の前に落ちる', async () => {
    captureStdout();

    await expect(profileEditCommand('rust', { scope: 'everyone' })).rejects.toThrow('--scope は');
    await expect(profileEditCommand('../x')).rejects.toThrow('行の名前の形が不正');
    expect(sent).toEqual([]);
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
  const NOT_DECLARED_OWNER = {
    error: '実行環境の持ち主として宣言されたアカウントだけが操作できる',
  };

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

  /**
   * **2026-09-24（#1122）に `/profile` の門が `requireOwner` へ移った**ので、
   * 宣言していないアカウントはこの本文で 403 になる。「理由を判別できなかった」に
   * 倒さず、`access owner` を案内する。
   */
  it('宣言していないアカウントのときは access owner を促す', async () => {
    setReply('GET', '/profile', { status: 403, body: NOT_DECLARED_OWNER });

    const message = await messageOf(() => profileShowCommand());
    expect(message).toContain('access owner');
    expect(message).not.toContain('理由を判別でき');
    expect(message).not.toContain('docker compose exec');
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

/**
 * 失敗の応答の `error` / `detail`（issue #2418）。`detail` はデーモンが評価した
 * シェルの stderr で、bash は構文エラーで**入力の行そのもの**を引用する
 * （`export GH_TOKEN=… )` → 「`export GH_TOKEN=…`」）。Error の message は画面に出るので、
 * 伏せてから切る。値はすべて偽物。
 */
describe('失敗の応答（error / detail）を画面に出す前に伏せる', () => {
  const FAKE_GHP = `ghp_${'A1b2C3d4E5'.repeat(4)}`;

  async function failWith(body: unknown): Promise<string> {
    setReply('GET', '/profile', { status: 400, body });
    try {
      await profileShowCommand();
    } catch (error) {
      return error instanceof Error ? error.message : String(error);
    }
    throw new Error('400 で失敗するはずが、成功してしまった');
  }

  it('detail に入力の断片（GH_TOKEN=…・ghp_…・URL の資格・params:）があっても出さない', async () => {
    const message = await failWith({
      error: 'プロファイルが読めなかったので保存していない',
      detail:
        "bash: -c: line 1: `export GH_TOKEN=FAKE_SECRET_VALUE_2418 )'\n" +
        `${FAKE_GHP} postgres://u:FAKE@h/db\nparams: FAKE`,
    });

    expect(message).toContain('プロファイルが読めなかったので保存していない');
    expect(message).toContain('bash: -c: line 1');
    expect(message).not.toContain('FAKE_SECRET_VALUE_2418');
    expect(message).not.toContain(FAKE_GHP);
    expect(message).not.toContain('u:FAKE@');
    expect(message).not.toMatch(/params: FAKE/);
  });

  it('error に値があっても出さない', async () => {
    const message = await failWith({ error: `boom ${FAKE_GHP}` });
    expect(message).toContain('boom');
    expect(message).not.toContain(FAKE_GHP);
  });

  it('長い detail は切る（伏せてから切るので、上限をまたぐトークンの断片も残らない）', async () => {
    const message = await failWith({
      error: '失敗',
      detail: `${'x '.repeat(1000)}${FAKE_GHP}${'あ'.repeat(10_000)}`,
    });
    expect(message.length).toBeLessThan(3000);
    expect(message.endsWith('…')).toBe(true);
    expect(message).not.toContain('ghp_A1b2');
  });

  it('値を含まない普通の error / detail は、今までどおり出る（対照）', async () => {
    expect(await failWith({ error: '形が不正', detail: '形が不正な項目: script' })).toBe(
      '形が不正\n形が不正な項目: script',
    );
    expect(await failWith({ error: 'だけ' })).toBe('だけ');
  });
});

/**
 * **古いデーモン（`entries` 無しの応答）へ新しい CLI が繋がった窓。** デーモンは
 * `release/prod` 経由で1日1回夜に入るので、この窓は必ず生じる。型は新しい形を
 * 約束しているので、**ここが測るのは実行時の倒れ先だけ**（型の側は `typecheck` が守る）。
 * 古いデーモンの `GET /profile` は `{ script, updatedAt?, sha256?, bytes? }` だけを返す。
 */
describe('古いデーモン（旧形式の応答）', () => {
  const OLD = {
    script: 'export OLD_SECRET=1\n',
    updatedAt: '2026-08-01T00:00:00Z',
    sha256: 'old111',
    bytes: 20,
  };

  it('list: 落ちず、default 1行として見せ、デーモンが古い旨を出す', async () => {
    setReply('GET', '/profile', { status: 200, body: OLD });
    const read = captureStdout();

    await profileListCommand();

    const text = read();
    expect(text).toContain('default  all（共通）  20 バイト  更新 2026-08-01T00:00:00Z');
    expect(text).toContain('デーモンが古い');
  });

  it('show: 従来の script をそのまま出す（本文だけ）', async () => {
    setReply('GET', '/profile', { status: 200, body: OLD });
    const read = captureStdout();

    await profileShowCommand();

    expect(read()).toBe('export OLD_SECRET=1\n');
  });

  it('show: 置かれていなければ（script が空）今までどおり「置かれていません」', async () => {
    setReply('GET', '/profile', { status: 200, body: { script: '' } });
    const read = captureStdout();

    await profileShowCommand();

    expect(read()).toContain('プロファイルは置かれていません。');
  });

  it('status: 落ちず、旧形式の指紋を runner と突き合わせる', async () => {
    setReply('GET', '/profile', { status: 200, body: OLD });
    setReply('GET', '/runners', {
      status: 200,
      body: {
        runners: [
          {
            label: 'x',
            state: 'connected',
            runnerId: 'runner-a',
            profile: { sha256: 'old111', updatedAt: 'T' },
          },
        ],
      },
    });
    const read = captureStdout();

    await profileStatusCommand();

    const text = read();
    expect(text).toContain('default  all（共通）');
    expect(text).toContain('デーモンが古い');
    expect(text).toContain('runner-a: sha256 old111 (T)（runner 用の合成と一致）');
    // 旧形式では合成後の指紋は分からないので出さない。
    expect(text).not.toContain('合成後）');
  });

  it('set default は従来の PUT /profile {script} へ倒す（古いデーモンでも通る）', async () => {
    setReply('GET', '/profile', { status: 200, body: OLD });
    setReply('PUT', '/profile', {
      status: 200,
      body: { updatedAt: 'T', sha256: 'new222', bytes: 5, clone: { ok: true }, runners: [] },
    });
    const dir = await makeTempDir('alteroid-profile-legacy-');
    const path = join(dir, 'p.sh');
    await writeFile(path, 'export NEW=1\n', 'utf8');
    const read = captureStdout();

    await profileSetCommand(undefined, { file: path });

    const put = sent.find((entry) => entry.method === 'PUT');
    expect(new URL(put?.url ?? 'http://x/').pathname).toBe('/profile');
    expect(JSON.parse(String(put?.body))).toEqual({ script: 'export NEW=1\n' });
    const text = read();
    expect(text).toContain('sha256 new222');
    expect(text).toContain('デーモンが古い');
  });

  it('default 以外の名前・default 以外の撒く先は、「デーモンが古い」と分かる文言で落ちる（生の 404 にしない）', async () => {
    setReply('GET', '/profile', { status: 200, body: OLD });
    captureStdout();
    const dir = await makeTempDir('alteroid-profile-legacy-');
    const path = join(dir, 'p.sh');
    await writeFile(path, 'export A=1\n', 'utf8');

    await expect(profileSetCommand('rust', { file: path })).rejects.toThrow('デーモンが古い');
    await expect(profileSetCommand(undefined, { file: path, scope: 'runner' })).rejects.toThrow(
      'デーモンが古い',
    );
    await expect(profileRemoveCommand('rust')).rejects.toThrow('デーモンが古い');
    await expect(profileEditCommand('rust')).rejects.toThrow('デーモンが古い');
    expect(sent.some((entry) => entry.method === 'PUT' || entry.method === 'DELETE')).toBe(false);
  });

  it('rm default は空の PUT /profile へ倒す', async () => {
    setReply('GET', '/profile', { status: 200, body: OLD });
    setReply('PUT', '/profile', {
      status: 200,
      body: { updatedAt: 'T', clone: { ok: true }, runners: [] },
    });
    captureStdout();

    await profileRemoveCommand('default');

    const put = sent.find((entry) => entry.method === 'PUT');
    expect(JSON.parse(String(put?.body))).toEqual({ script: '' });
  });
});
