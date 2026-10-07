import { writeFile } from 'node:fs/promises';
import { join } from 'node:path';

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { makeTempDir } from '../../../vitest.tmpdir.js';

import { type ConfirmIo } from './confirm.js';
import { captureStdout, pretendTty } from './test-support.js';

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
  setReply('GET', '/credentials', { status: 200, body: { credentials: [] } });
  dir = await makeTempDir('alteroid-cli-credential-');
});

afterEach(async () => {
  globalThis.fetch = originalFetch;
  vi.restoreAllMocks();
});

const DUMMY = 'CRED-CLI-DUMMY';

describe('alteroid credential list', () => {
  it('空なら、無いことと「配られるものは無い」ことと置き方を言う', async () => {
    setReply('GET', '/credentials', { status: 200, body: { credentials: [] } });
    const read = captureStdout();

    await credentialListCommand();

    const text = read();
    expect(text).toContain('正本に置かれた環境変数はありません');
    expect(text).toContain('マネージャーへ配られる環境変数はありません');
    expect(text).not.toContain('在るものだけで走ります');
    expect(text).toContain('alteroid credential set <名前> --file <path>');
  });

  it('古いデーモンが shadowsCloneEnv を返しても、警告は出ない（旗は撤去済み）', async () => {
    setReply('GET', '/credentials', {
      status: 200,
      body: {
        credentials: [
          {
            name: 'GH_TOKEN',
            sha256: 'cccccccccccc',
            updatedAt: '2026-09-12T00:00:00.000Z',
            scope: 'all',
            secret: true,
            shadowsCloneEnv: true,
          },
        ],
      },
    });
    const read = captureStdout();

    await credentialListCommand();

    const text = read();
    expect(text).toContain('GH_TOKEN');
    expect(text).not.toContain('優先して配られています');
    expect(text).not.toContain('器の環境変数の値');
  });

  it('名前と指紋を並べ、突き合わせ先（runner 側）まで言う', async () => {
    setReply('GET', '/credentials', {
      status: 200,
      body: {
        credentials: [
          {
            name: 'GH_TOKEN',
            sha256: 'aaaaaaaaaaaa',
            updatedAt: '2026-09-01T00:00:00.000Z',
            scope: 'all',
            secret: true,
          },
          {
            name: 'GIT_AUTHOR_NAME',
            sha256: 'bbbbbbbbbbbb',
            updatedAt: '2026-09-02T00:00:00.000Z',
            scope: 'all',
            secret: true,
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
    expect(text).toContain('alteroid runners');
  });

  it('scope・secret を並べ、非シークレットな行は値も出す', async () => {
    setReply('GET', '/credentials', {
      status: 200,
      body: {
        credentials: [
          {
            name: 'GH_TOKEN',
            sha256: 'aaaaaaaaaaaa',
            updatedAt: '2026-09-01T00:00:00.000Z',
            scope: 'runner',
            secret: true,
          },
          {
            name: 'TZ',
            sha256: 'eeeeeeeeeeee',
            updatedAt: '2026-09-14T00:00:00.000Z',
            scope: 'app',
            secret: false,
            value: 'Asia/Tokyo',
          },
        ],
      },
    });
    const read = captureStdout();

    await credentialListCommand();

    const text = read();
    expect(text).toContain('撒く先=runner（manager だけ）');
    expect(text).toContain('指紋 sha256=aaaaaaaaaaaa');
    expect(text).toContain('撒く先=app（clone だけ）');
    expect(text).toContain('非シークレット');
    expect(text).toContain('値=Asia/Tokyo');
    expect(text.match(/ {2}値=/g)).toHaveLength(1);
  });
});

describe('alteroid credential set', () => {
  it('一部の runner へ降ろせなかったら、成功の見出しを出さず警告にして例外にする（#3157）', async () => {
    const path = join(dir, 'value.txt');
    await writeFile(path, DUMMY, 'utf8');
    setReply('PUT', '/credentials', {
      status: 200,
      body: {
        credentials: [{ name: 'NPM_TOKEN', sha256: 'cccccccccccc', updatedAt: 'now' }],
        runners: [
          { runnerId: 'runner-1', ok: true },
          { runnerId: 'runner-2', ok: false, error: 'つながらない' },
        ],
      },
    });
    const read = captureStdout();

    await expect(credentialSetCommand('NPM_TOKEN', { file: path })).rejects.toThrow(
      'runner への反映が一部失敗しました',
    );

    const text = read();
    expect(text).toContain(
      '警告: NPM_TOKEN は正本に置きましたが、一部の runner へ反映できていません',
    );
    expect(text).not.toContain('NPM_TOKEN を置きました');
    expect(text).toContain('runner-1: 降ろしました');
    expect(text).toContain('runner-2: 降ろせませんでした');
  });

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

    expect(sent).toEqual([
      expect.objectContaining({ method: 'GET' }),
      expect.objectContaining({
        method: 'PUT',
        body: { credentials: [{ name: 'NPM_TOKEN', value: DUMMY }] },
      }),
    ]);
    const text = read();
    expect(text).toContain('NPM_TOKEN を置きました');
    expect(text).toContain('runner-1: 降ろしました');
    expect(text).not.toContain(DUMMY);
  });

  it('名前の形が誤りなら、値（空の標準入力でも）より先に、名前の誤りを言う', async () => {
    const error = await credentialSetCommand('lower_case', {
      file: join(dir, 'does-not-exist'),
    }).catch((e: unknown) => e);
    const text = String(error);
    expect(text).toContain('名前 <name> は英大文字で始まり');
    expect(text).toContain('lower_case');
    expect(text).not.toContain('値が空');
    expect(sent).toEqual([]);
  });

  it('-f のファイルが無ければ、素の ENOENT ではなく日本語で言う', async () => {
    const error = await credentialSetCommand('GOOD_NAME', {
      file: join(dir, 'does-not-exist'),
    }).catch((e: unknown) => e);
    expect(String(error)).toContain('--file で指したファイルを読めない');
    expect(String(error)).not.toContain('ENOENT');
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

    expect(sent[1]?.body).toEqual({ credentials: [{ name: 'SOME_VALUE', value: 'a b  c' }] });
  });

  it('--scope --no-secret を渡すと、そのまま本文へ乗る', async () => {
    const path = join(dir, 'tz.txt');
    await writeFile(path, 'Asia/Tokyo', 'utf8');
    setReply('PUT', '/credentials', {
      status: 200,
      body: { credentials: [], runners: [] },
    });
    captureStdout();

    await credentialSetCommand('TZ', { file: path, scope: 'app', secret: false });

    expect(sent[1]?.body).toEqual({
      credentials: [{ name: 'TZ', value: 'Asia/Tokyo', scope: 'app', secret: false }],
    });
  });

  it('scope・secret を省略すると、本文にも欄自体が乗らない（サーバ側の既定・引き継ぎに任せる）', async () => {
    const path = join(dir, 'value.txt');
    await writeFile(path, DUMMY, 'utf8');
    setReply('PUT', '/credentials', {
      status: 200,
      body: { credentials: [], runners: [] },
    });
    captureStdout();

    await credentialSetCommand('NPM_TOKEN', { file: path });

    expect(sent[1]?.body).toEqual({ credentials: [{ name: 'NPM_TOKEN', value: DUMMY }] });
  });

  it('--scope に不正な値を渡すと、サーバへ送らずに断る', async () => {
    const path = join(dir, 'value.txt');
    await writeFile(path, DUMMY, 'utf8');

    await expect(credentialSetCommand('NPM_TOKEN', { file: path, scope: 'bogus' })).rejects.toThrow(
      /--scope/,
    );
    expect(sent).toEqual([]);
  });

  it('空の値は置かず、外し方を案内する（空で上書きして資格を消さない）', async () => {
    const path = join(dir, 'empty.txt');
    await writeFile(path, '\n', 'utf8');

    await expect(credentialSetCommand('NPM_TOKEN', { file: path })).rejects.toThrow(
      /alteroid credential remove NPM_TOKEN/,
    );
    expect(sent.filter((entry) => entry.method !== 'GET')).toEqual([]);
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

  it('403（未宣言 owner）なら、access owner を打てと言う', async () => {
    const path = join(dir, 'value.txt');
    await writeFile(path, DUMMY, 'utf8');
    setReply('PUT', '/credentials', {
      status: 403,
      body: { error: '実行環境の持ち主として宣言されたアカウントだけが操作できる' },
    });

    const message = await credentialSetCommand('NPM_TOKEN', { file: path }).catch(
      (error: unknown) => (error instanceof Error ? error.message : String(error)),
    );

    expect(message).toContain('alteroid access list');
    expect(message).toContain('alteroid access owner <アカウント id>');
    expect(message).not.toContain('access grant <アカウント id>');
  });

  it('403（未 grant）なら、access grant を打てと言う', async () => {
    const path = join(dir, 'value.txt');
    await writeFile(path, DUMMY, 'utf8');
    setReply('PUT', '/credentials', {
      status: 403,
      body: { error: 'このアカウントには alteroid を使う許可が無い' },
    });

    const message = await credentialSetCommand('NPM_TOKEN', { file: path }).catch(
      (error: unknown) => (error instanceof Error ? error.message : String(error)),
    );

    expect(message).toContain('alteroid access grant <アカウント id>');
  });

  it('403（not_operator の本文。この経路では実際には来ないはず）は、案内を出さない', async () => {
    const path = join(dir, 'value.txt');
    await writeFile(path, DUMMY, 'utf8');
    setReply('PUT', '/credentials', {
      status: 403,
      body: { error: '実行環境の持ち主だけが操作できる' },
    });

    const message = await credentialSetCommand('NPM_TOKEN', { file: path }).catch(
      (error: unknown) => (error instanceof Error ? error.message : String(error)),
    );

    expect(message).toContain('理由を判別できなかった');
    expect(message).not.toContain('docker compose exec');
    expect(message).not.toContain('access grant');
    expect(message).not.toContain('access owner');
  });
});

describe('alteroid credential remove', () => {
  it('置かれていなければ PUT せず、器の環境変数の側は消えないことを言う', async () => {
    setReply('GET', '/credentials', { status: 200, body: { credentials: [] } });
    const read = captureStdout();

    const error = await credentialRemoveCommand('NPM_TOKEN', { yes: true }).then(
      () => null,
      (e: unknown) => e as Error,
    );

    expect(sent.map((entry) => entry.method)).toEqual(['GET']);
    expect(error?.message).toContain('NPM_TOKEN は正本に置かれていません');
    expect(error?.message).toContain('デーモン（クローン）の環境変数に同じ名前が在れば');
    expect(read()).toBe('');
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

    await credentialRemoveCommand('NPM_TOKEN', { yes: true });

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

    await expect(credentialRemoveCommand('NPM_TOKEN', { yes: true })).rejects.toThrow(
      'runner への反映が一部失敗しました',
    );

    const text = read();
    expect(text).toContain(
      '警告: NPM_TOKEN は正本から外しましたが、一部の runner へ反映できていません',
    );
    expect(text).not.toContain('NPM_TOKEN を外しました');
    expect(text).toContain('runner-broken: 降ろせませんでした');
    expect(text).toContain('次に名乗ったときに追いつきます');
    expect(text).toContain('つながらない');
  });
});

describe('alteroid credential remove の確認（#3141）', () => {
  it('端末でなく --yes も無ければ、PUT せずに断る（外れていない）', async () => {
    setReply('GET', '/credentials', {
      status: 200,
      body: { credentials: [{ name: 'NPM_TOKEN', sha256: 'cccccccccccc', updatedAt: 'now' }] },
    });
    const restore = pretendTty(false);
    try {
      await expect(credentialRemoveCommand('NPM_TOKEN')).rejects.toThrow('--yes');
    } finally {
      restore();
    }
    expect(sent.some((entry) => entry.method === 'PUT')).toBe(false);
  });
});

describe('alteroid credential set の上書き確認（#3201）', () => {
  const existing = {
    status: 200,
    body: { credentials: [{ name: 'NPM_TOKEN', sha256: 'cccccccccccc', updatedAt: 'now' }] },
  };
  const putOk = {
    status: 200,
    body: { credentials: [], runners: [{ runnerId: 'runner-1', ok: true }] },
  };

  function fakeIo(over: { isTTY: boolean; answer?: string }) {
    const asked: string[] = [];
    const written: string[] = [];
    const io: ConfirmIo = {
      isTTY: over.isTTY,
      write: (text) => {
        written.push(text);
      },
      ask: (question) => {
        asked.push(question);
        return Promise.resolve(over.answer ?? '');
      },
    };
    return { io, asked, written };
  }

  async function valueFile(): Promise<string> {
    const path = join(dir, 'value.txt');
    await writeFile(path, DUMMY, 'utf8');
    return path;
  }

  it('新規作成（無い名前）は確認せずに置く（非対話でも）', async () => {
    const file = await valueFile();
    setReply('PUT', '/credentials', putOk);
    captureStdout();
    const { io, asked } = fakeIo({ isTTY: false });

    await credentialSetCommand('NPM_TOKEN', { file }, io);

    expect(asked).toEqual([]);
    expect(sent.some((entry) => entry.method === 'PUT')).toBe(true);
  });

  it('既に在る名前は、非対話で --yes が無ければ PUT せずに断る（何も変えない）。値は読まない', async () => {
    const file = await valueFile();
    setReply('GET', '/credentials', existing);
    setReply('PUT', '/credentials', putOk);
    captureStdout();
    const { io } = fakeIo({ isTTY: false, answer: 'yes' });

    const error = await credentialSetCommand('NPM_TOKEN', { file }, io).catch((e: unknown) => e);

    expect(String(error)).toContain('--yes');
    expect(String(error)).toContain('NPM_TOKEN');
    expect(String(error)).not.toContain(DUMMY);
    expect(sent.filter((entry) => entry.method !== 'GET')).toEqual([]);
  });

  it('端末で yes と答えれば置き換える。確認の文は名前を言い、値を出さない', async () => {
    const file = await valueFile();
    setReply('GET', '/credentials', existing);
    setReply('PUT', '/credentials', putOk);
    captureStdout();
    const { io, written } = fakeIo({ isTTY: true, answer: 'yes' });

    await credentialSetCommand('NPM_TOKEN', { file }, io);

    expect(written.join('')).toContain('環境変数 NPM_TOKEN を置き換えます');
    expect(written.join('')).not.toContain(DUMMY);
    expect(sent.some((entry) => entry.method === 'PUT')).toBe(true);
  });

  it('端末で yes 以外なら置かない', async () => {
    const file = await valueFile();
    setReply('GET', '/credentials', existing);
    captureStdout();
    const { io } = fakeIo({ isTTY: true, answer: 'no' });

    await expect(credentialSetCommand('NPM_TOKEN', { file }, io)).rejects.toThrow(
      '取り消しました。何も変更していません。',
    );

    expect(sent.some((entry) => entry.method === 'PUT')).toBe(false);
  });

  it('--yes なら聞かずに置き換える（非対話でも）', async () => {
    const file = await valueFile();
    setReply('GET', '/credentials', existing);
    setReply('PUT', '/credentials', putOk);
    captureStdout();
    const { io, asked } = fakeIo({ isTTY: false });

    await credentialSetCommand('NPM_TOKEN', { file, yes: true }, io);

    expect(asked).toEqual([]);
    expect(sent.some((entry) => entry.method === 'PUT')).toBe(true);
  });
});
