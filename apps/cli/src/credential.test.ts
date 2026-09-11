import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { captureStdout } from './test-support.js';

/**
 * `alteroid credential` — マネージャーへ降ろす環境変数（名前→値の袋）。
 *
 * ここで固定するのは3つである:
 *
 * 1. **値をコマンドライン引数で受けない**（`argv` は他のプロセスから見える）
 * 2. **出力に値が1文字も出ない**（返るのは指紋だけ）
 * 3. **配布の結果を台ごとに出す**（畳んで1つの成否にしない）
 *
 * `token.test.ts` と同じ作法——`fetch` を `method + path` の応答表で差し替える。
 */
/**
 * **`./target.js` は `resolveTarget` だけ差し替える。** `forbiddenKindOf` と
 * `describeAuthFailure` は**本物を使う**——403 の案内を分けているのはこの2つ
 * なので、ここを偽物にすると、この歯が測るのは偽物の分岐になる。
 */
vi.mock('./target.js', async (importOriginal) => ({
  ...(await importOriginal<typeof import('./target.js')>()),
  resolveTarget: () =>
    Promise.resolve({ baseUrl: 'http://127.0.0.1:4517', headers: {}, note: null, remote: false }),
}));

const { credentialListCommand, credentialSetCommand, credentialRemoveCommand } =
  await import('./credential.js');

interface Reply {
  status: number;
  body: unknown;
}

let replies: Map<string, Reply>;
let sent: { url: string; method: string; body: unknown }[];
let originalFetch: typeof fetch;
let dir: string;

function setReply(method: string, path: string, reply: Reply): void {
  replies.set(`${method} ${path}`, reply);
}

function stubFetch(): void {
  globalThis.fetch = ((input: unknown, init?: RequestInit) => {
    const request = input as { url?: string; method?: string };
    const url = typeof input === 'string' ? input : (request.url ?? String(input));
    const method = init?.method ?? request.method ?? 'GET';
    const path = new URL(url).pathname;
    const body =
      typeof init?.body === 'string' && init.body.length > 0
        ? (JSON.parse(init.body) as unknown)
        : undefined;
    sent.push({ url, method, body });
    const reply = replies.get(`${method} ${path}`) ?? { status: 200, body: {} };
    return Promise.resolve(
      new Response(JSON.stringify(reply.body), {
        status: reply.status,
        headers: { 'content-type': 'application/json' },
      }),
    );
  }) as typeof fetch;
}

beforeEach(async () => {
  originalFetch = globalThis.fetch;
  replies = new Map();
  sent = [];
  stubFetch();
  dir = await mkdtemp(join(tmpdir(), 'alteroid-cli-credential-'));
});

afterEach(async () => {
  globalThis.fetch = originalFetch;
  vi.restoreAllMocks();
  await rm(dir, { recursive: true, force: true });
});

const DUMMY = 'CRED-CLI-DUMMY';

describe('alteroid credential list', () => {
  it('空なら、無いことと「器の環境変数だけで走る」ことと置き方を言う', async () => {
    setReply('GET', '/credentials', { status: 200, body: { credentials: [] } });
    const read = captureStdout();

    await credentialListCommand();

    const text = read();
    expect(text).toContain('正本に置かれた環境変数はありません');
    expect(text).toContain('器の環境変数に在るものだけで走ります');
    expect(text).toContain('alteroid credential set <名前> --file <path>');
  });

  it('名前と指紋を並べ、突き合わせ先（runner 側）まで言う', async () => {
    setReply('GET', '/credentials', {
      status: 200,
      body: {
        credentials: [
          { name: 'GH_TOKEN', sha256: 'aaaaaaaaaaaa', updatedAt: '2026-09-01T00:00:00.000Z' },
          {
            name: 'GIT_AUTHOR_NAME',
            sha256: 'bbbbbbbbbbbb',
            updatedAt: '2026-09-02T00:00:00.000Z',
          },
        ],
      },
    });
    const read = captureStdout();

    await credentialListCommand();

    const text = read();
    expect(text).toContain('GH_TOKEN');
    expect(text).toContain('sha256=aaaaaaaaaaaa');
    expect(text).toContain('GIT_AUTHOR_NAME');
    // **「置いた」と「届いた」は別である。** 突き合わせ先を言わないと、人間は
    // 正本に在ることを届いた証拠として読む。
    expect(text).toContain('alteroid runners');
  });
});

describe('alteroid credential set', () => {
  it('値をファイルから読んで PUT する（末尾の改行は落とす）', async () => {
    const path = join(dir, 'value.txt');
    await writeFile(path, `${DUMMY}\n`, 'utf8');
    setReply('PUT', '/credentials', {
      status: 200,
      body: {
        credentials: [{ name: 'NPM_TOKEN', sha256: 'cccccccccccc', updatedAt: 'now' }],
        runners: [{ runnerId: 'runner-1', ok: true }],
      },
    });
    const read = captureStdout();

    await credentialSetCommand('NPM_TOKEN', { file: path });

    // **改行は落ちている。** 落とさないと「見た目は同じなのに指紋が違う」鍵ができる。
    expect(sent).toEqual([
      expect.objectContaining({
        method: 'PUT',
        body: { credentials: [{ name: 'NPM_TOKEN', value: DUMMY }] },
      }),
    ]);
    const text = read();
    expect(text).toContain('NPM_TOKEN を置きました');
    expect(text).toContain('runner-1: 降ろしました');
    // **値は出さない。**
    expect(text).not.toContain(DUMMY);
  });

  it('内側の空白は落とさない（値の一部でありうる）', async () => {
    const path = join(dir, 'value.txt');
    await writeFile(path, 'a b  c\n', 'utf8');
    setReply('PUT', '/credentials', {
      status: 200,
      body: { credentials: [], runners: [] },
    });
    captureStdout();

    await credentialSetCommand('SOME_VALUE', { file: path });

    expect(sent[0]?.body).toEqual({ credentials: [{ name: 'SOME_VALUE', value: 'a b  c' }] });
  });

  it('空の値は置かず、外し方を案内する（空で上書きして資格を消さない）', async () => {
    const path = join(dir, 'empty.txt');
    await writeFile(path, '\n', 'utf8');

    await expect(credentialSetCommand('NPM_TOKEN', { file: path })).rejects.toThrow(
      /alteroid credential remove NPM_TOKEN/,
    );
    expect(sent).toEqual([]);
  });

  it('デーモンが 400 で断ったら、その理由をそのまま出す（名前を疑えるようにする）', async () => {
    const path = join(dir, 'value.txt');
    await writeFile(path, DUMMY, 'utf8');
    setReply('PUT', '/credentials', {
      status: 400,
      body: {
        error:
          'CLAUDE_CODE_OAUTH_TOKEN の正本は認証トークンのプールである（alteroid token add / PUT /tokens）',
      },
    });

    await expect(credentialSetCommand('CLAUDE_CODE_OAUTH_TOKEN', { file: path })).rejects.toThrow(
      /alteroid token add/,
    );
  });

  it('403（実行環境の持ち主でない）なら、どこで打つべきかを言う', async () => {
    const path = join(dir, 'value.txt');
    await writeFile(path, DUMMY, 'utf8');
    setReply('PUT', '/credentials', {
      status: 403,
      // **デーモンが実際に返す文言そのもの**（`forbiddenKindOf` はこの文字列で
      // 分岐する。逐語は `grep -Fn -- '実行環境の持ち主だけが操作できる' apps/cli/src/target.ts`）。
      body: { error: '実行環境の持ち主だけが操作できる' },
    });

    await expect(credentialSetCommand('NPM_TOKEN', { file: path })).rejects.toThrow(
      /docker compose exec app alteroid credential list/,
    );
  });
});

describe('alteroid credential remove', () => {
  it('置かれていなければ PUT せず、器の環境変数の側は消えないことを言う', async () => {
    setReply('GET', '/credentials', { status: 200, body: { credentials: [] } });
    const read = captureStdout();

    await credentialRemoveCommand('NPM_TOKEN');

    expect(sent.map((entry) => entry.method)).toEqual(['GET']);
    const text = read();
    expect(text).toContain('NPM_TOKEN は正本に置かれていません');
    expect(text).toContain('器の環境変数に同じ名前が在れば');
  });

  it('置かれていれば空文字で外す（器の側からも消える）', async () => {
    setReply('GET', '/credentials', {
      status: 200,
      body: { credentials: [{ name: 'NPM_TOKEN', sha256: 'cccccccccccc', updatedAt: 'now' }] },
    });
    setReply('PUT', '/credentials', {
      status: 200,
      body: { credentials: [], runners: [{ runnerId: 'runner-1', ok: true }] },
    });
    const read = captureStdout();

    await credentialRemoveCommand('NPM_TOKEN');

    expect(sent.at(-1)?.body).toEqual({ credentials: [{ name: 'NPM_TOKEN', value: '' }] });
    expect(read()).toContain('NPM_TOKEN を外しました');
  });

  it('降ろせなかった台は、追いつく時機まで言う（黙って成功に見せない）', async () => {
    setReply('GET', '/credentials', {
      status: 200,
      body: { credentials: [{ name: 'NPM_TOKEN', sha256: 'cccccccccccc', updatedAt: 'now' }] },
    });
    setReply('PUT', '/credentials', {
      status: 200,
      body: {
        credentials: [],
        runners: [{ runnerId: 'runner-broken', ok: false, error: 'つながらない' }],
      },
    });
    const read = captureStdout();

    await credentialRemoveCommand('NPM_TOKEN');

    const text = read();
    expect(text).toContain('runner-broken: 降ろせませんでした');
    expect(text).toContain('次に名乗ったときに追いつきます');
    expect(text).toContain('つながらない');
  });
});
