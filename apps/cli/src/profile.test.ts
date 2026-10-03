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
    const dir = await makeTempDir('alteroid-profile-set-');
    const path = join(dir, 'profile.sh');
    await writeFile(path, 'export FOO=bar\n', 'utf8');
    const read = captureStdout();

    await profileSetCommand({ file: path });

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
 * 撒く先（scope。2026-10-03）。環境変数（`alteroid credential set --scope`）と同じ3値。
 */
describe('撒く先（--scope）', () => {
  const putBody = () =>
    JSON.parse(String(sent.find((entry) => entry.method === 'PUT')?.body ?? '{}')) as Record<
      string,
      unknown
    >;
  const okReply = {
    status: 200,
    body: {
      updatedAt: '2026-10-03T00:00:00Z',
      sha256: 'def456',
      scope: 'runner',
      clone: { ok: true },
      runners: [],
    },
  };

  async function scriptFile(): Promise<string> {
    const dir = await makeTempDir('alteroid-profile-scope-');
    const path = join(dir, 'profile.sh');
    await writeFile(path, 'export FOO=bar\n', 'utf8');
    return path;
  }

  it('set --scope runner は scope を PUT し、撒く先を表示する', async () => {
    setReply('PUT', '/profile', okReply);
    const read = captureStdout();

    await profileSetCommand({ file: await scriptFile(), scope: 'runner' });

    expect(putBody()).toEqual({ script: 'export FOO=bar\n', scope: 'runner' });
    expect(read()).toContain('撒く先: runner（マネージャー・作業者だけ）');
  });

  it('set で --scope を省くと scope を送らない（デーモンが今の撒く先を保つ）', async () => {
    setReply('PUT', '/profile', okReply);
    captureStdout();

    await profileSetCommand({ file: await scriptFile() });

    expect(putBody()).toEqual({ script: 'export FOO=bar\n' });
  });

  it('不正な --scope は PUT する前に落ちる', async () => {
    captureStdout();

    await expect(
      profileSetCommand({ file: await scriptFile(), scope: 'everyone' }),
    ).rejects.toThrow('--scope は all / app / runner のいずれかである（渡されたのは everyone）');
    expect(sent.some((entry) => entry.method === 'PUT')).toBe(false);
  });

  it('edit --scope は、本文を変えなくても撒く先が変わるなら PUT する', async () => {
    setReply('GET', '/profile', {
      status: 200,
      body: { script: 'export FOO=bar\n', scope: 'all' },
    });
    setReply('PUT', '/profile', okReply);
    captureStdout();

    await profileEditCommand({ scope: 'runner' });

    expect(putBody()).toEqual({ script: 'export FOO=bar\n', scope: 'runner' });
  });

  it('edit --scope が今と同じで本文も同じなら PUT しない', async () => {
    setReply('GET', '/profile', {
      status: 200,
      body: { script: 'export FOO=bar\n', scope: 'runner' },
    });
    const read = captureStdout();

    await profileEditCommand({ scope: 'runner' });

    expect(read()).toBe('変更はありません。\n');
    expect(sent.some((entry) => entry.method === 'PUT')).toBe(false);
  });

  it('show の標準出力は本文だけのまま（パイプで set へ戻す使い方を壊さない）', async () => {
    setReply('GET', '/profile', {
      status: 200,
      body: { script: 'export FOO=bar\n', scope: 'runner' },
    });
    const read = captureStdout();

    await profileShowCommand();

    expect(read()).toBe('export FOO=bar\n');
  });

  describe('status', () => {
    const runnersBody = (profile: unknown) => ({
      status: 200,
      body: {
        runners: [
          { label: 'https://runner-a.internal', state: 'connected', runnerId: 'runner-a', profile },
        ],
      },
    });

    it('撒く先を出す', async () => {
      setReply('GET', '/profile', {
        status: 200,
        body: { script: 'export A=1', bytes: 10, sha256: 'abc', updatedAt: 'T', scope: 'runner' },
      });
      setReply('GET', '/runners', runnersBody({ sha256: 'abc', updatedAt: 'T' }));
      const read = captureStdout();

      await profileStatusCommand();

      expect(read()).toContain('撒く先: runner（マネージャー・作業者だけ）');
    });

    it('scope=app で runner に何も載っていないのは、食い違いではなく正しい状態として出す', async () => {
      setReply('GET', '/profile', {
        status: 200,
        body: { script: 'export A=1', bytes: 10, sha256: 'abc', updatedAt: 'T', scope: 'app' },
      });
      setReply('GET', '/runners', runnersBody(undefined));
      const read = captureStdout();

      await profileStatusCommand();

      expect(read()).toContain(
        '  runner-a: プロファイル無し（撒く先が app なので、載っていないのが正しい。connected）',
      );
    });

    it('scope=app なのに runner に載っているなら、外しの降ろしが済んでいないと言う', async () => {
      setReply('GET', '/profile', {
        status: 200,
        body: { script: 'export A=1', bytes: 10, sha256: 'abc', updatedAt: 'T', scope: 'app' },
      });
      setReply('GET', '/runners', runnersBody({ sha256: 'abc', updatedAt: 'T' }));
      const read = captureStdout();

      await profileStatusCommand();

      expect(read()).toContain('外しの降ろしが済んでいない');
    });

    it('scope=runner / all で runner に載っていなければ、今までどおり「プロファイル無し」だけ', async () => {
      for (const scope of ['runner', 'all']) {
        setReply('GET', '/profile', {
          status: 200,
          body: { script: 'export A=1', bytes: 10, sha256: 'abc', updatedAt: 'T', scope },
        });
        setReply('GET', '/runners', runnersBody(undefined));
        const read = captureStdout();

        await profileStatusCommand();

        const text = read();
        expect(text).toContain('  runner-a: プロファイル無し（connected）\n');
        expect(text).not.toContain('正しい');
      }
    });
  });
});
