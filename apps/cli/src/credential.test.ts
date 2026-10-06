import { writeFile } from 'node:fs/promises';
import { join } from 'node:path';

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { makeTempDir } from '../../../vitest.tmpdir.js';

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
  dir = await makeTempDir('alteroid-cli-credential-');
});

afterEach(async () => {
  globalThis.fetch = originalFetch;
  vi.restoreAllMocks();
});

const DUMMY = 'CRED-CLI-DUMMY';

describe('alteroid credential list', () => {
  /**
   * **⚠️ このテストは 2026-10-06 に期待値を反転した。** 元の題: 「空なら、無いことと
   * 「器の環境変数だけで走る」ことと置き方を言う」（元の期待: 「デーモン（クローン）の環境変数に
   * 在るものだけで走ります」）。**器の環境変数を最後の土台にする経路を撤去した**ので
   * （オーナー決定 2026-10-06）、空の正本のとき、マネージャーへ配られるものは**無い**。
   * 元の文言を出し続けるのは嘘になる。**保証は弱くなっていない**——「空のときの状態を、実際の
   * 挙動のとおりに言う」は同じで、実際の挙動が変わった。
   */
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

  /**
   * **「器の環境変数が正本に勝つ」ことの名指し（#865・#1894。旗 `shadowsCloneEnv`）は撤去した
   * （2026-10-06）。** この節にあった5本（食い違いの名指し・無ければ出ない・scope: app の2本・
   * 混在）は、起こり得ない状態を測っていたので消した（勝つ側を撤去した。3点セットは PR 本文）。
   *
   * **代わりの歯: 古いデーモン（旗を返す版）につないでも、警告を出さない。** CLI とデーモンは
   * 別々に更新されうるので、旗が応答に載ってくる版ずれが実在する。載っていても表示は変えない
   * （消した警告が、古いデーモン相手に蘇らない）。
   */
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
    // **「置いた」と「届いた」は別である。** 突き合わせ先を言わないと、人間は
    // 正本に在ることを届いた証拠として読む。
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
    // シークレットな行は値を出さない（指紋だけ）——`値=` が非シークレットの
    // 1行分しか現れないことで確かめる。
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

    expect(sent[0]?.body).toEqual({ credentials: [{ name: 'SOME_VALUE', value: 'a b  c' }] });
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

    expect(sent[0]?.body).toEqual({
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

    expect(sent[0]?.body).toEqual({ credentials: [{ name: 'NPM_TOKEN', value: DUMMY }] });
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

  /**
   * **issue #1198 でこの経路の門が `requireOperator` から `requireOwner` へ
   * 変わった。** 未宣言（`access grant` は済んでいるが `access owner` をまだ
   * 打っていない）で拒まれたときの案内は、`alteroid access owner <id>` を
   * 打つ形にする——`alteroid access list` で id を見る導線とセットである。
   */
  it('403（未宣言 owner）なら、access owner を打てと言う', async () => {
    const path = join(dir, 'value.txt');
    await writeFile(path, DUMMY, 'utf8');
    setReply('PUT', '/credentials', {
      status: 403,
      // **デーモンが実際に返す文言そのもの**（`forbiddenKindOf` はこの文字列で
      // 分岐する。逐語は `grep -Fn -- '実行環境の持ち主として宣言されたアカウントだけが操作できる' apps/cli/src/target.ts`）。
      body: { error: '実行環境の持ち主として宣言されたアカウントだけが操作できる' },
    });

    const message = await credentialSetCommand('NPM_TOKEN', { file: path }).catch(
      (error: unknown) => (error instanceof Error ? error.message : String(error)),
    );

    expect(message).toContain('alteroid access list');
    expect(message).toContain('alteroid access owner <アカウント id>');
    // **`access grant` は勧めない。** 既に許可されている前提での 403 なので、
    // grant を勧めると人間が同じ操作を打ち直して「また 403」を踏む。
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

  /**
   * **`requireOwner` はこの経路の門であって `requireOperator` ではない。**
   * ⟹ `not_operator` の本文はこの経路からは実際には来ない（`credential.ts` の
   * doc）。それでも `ForbiddenKind` はこの値を持てる型なので、来た場合に
   * 当てずっぽうの案内（旧 `docker compose exec …`）を出さないことを固定する
   * ——「型で塞いだ分岐にも実行時の倒れ先の歯を足す」（AGENTS.md）。
   */
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

    await credentialRemoveCommand('NPM_TOKEN');

    expect(sent.map((entry) => entry.method)).toEqual(['GET']);
    const text = read();
    expect(text).toContain('NPM_TOKEN は正本に置かれていません');
    expect(text).toContain('デーモン（クローン）の環境変数に同じ名前が在れば');
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

    await expect(credentialRemoveCommand('NPM_TOKEN')).rejects.toThrow(
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
