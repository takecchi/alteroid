import { writeFile } from 'node:fs/promises';
import { join } from 'node:path';

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { makeTempDir } from '../../../vitest.tmpdir.js';

import { captureStdout } from './test-support.js';

/**
 * `alteroid token` — Issue #393「PR1 プールの器」。**回さない**——ここで固定する
 * のは器を覗く・並べる・外す口の見た目だけで、検知・切替は無い。
 *
 * `profile.test.ts` と同じ作法——`fetch` を `method + path` の応答表で差し替える。
 * `token.ts` も同じコマンドの中で複数経路（`GET /tokens` → `PUT /tokens`）を
 * 打つので、`access.test.ts` の「先入れ先出しで積む」形は合わない。
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

const {
  tokenListCommand,
  tokenAddCommand,
  tokenRemoveCommand,
  tokenDisableCommand,
  tokenEnableCommand,
  tokenPolicyCommand,
  tokenRemoveUnreadableCommand,
} = await import('./token.js');

interface Reply {
  status: number;
  body: unknown;
}

let replies: Map<string, Reply>;
let sent: { url: string; method: string; body: unknown }[];
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

const EMPTY_SETTINGS = { rotateOn: 'free_exhausted', cooldownMs: 18_000_000 };

describe('alteroid token list', () => {
  it('プールが空なら、無いことと登録の仕方を言う（値の話は一切出ない）', async () => {
    setReply('GET', '/tokens', { status: 200, body: { tokens: [], settings: EMPTY_SETTINGS } });
    const read = captureStdout();

    await tokenListCommand();

    const text = read();
    expect(text).toContain('回す契機: free_exhausted');
    expect(text).toContain('トークンは登録されていません');
    // **黙っていると「記録が残る」と思われる。**
    expect(text).toContain('枠に当たっても記録が残りません');
    expect(text).toContain('alteroid token add --label <名前> --file <path>');
  });

  it('登録済みの行を order 順に並べ、状態（外された・冷却中・失効・最後の拒否）を出す。値は一切出ない', async () => {
    const now = Date.now();
    setReply('GET', '/tokens', {
      status: 200,
      body: {
        tokens: [
          {
            id: 'tok-b',
            label: 'second',
            order: 1,
            sha256: 'bbbbbbbbbbbb',
          },
          {
            id: 'tok-a',
            label: 'first',
            order: 0,
            sha256: 'aaaaaaaaaaaa',
            disabledAt: '2026-08-01T00:00:00.000Z',
            cooldownUntil: now + 60_000,
            lastRejectedAt: '2026-08-02T00:00:00.000Z',
            lastRejectedReason: 'rate_limit exceeded',
            invalidatedAt: '2026-08-03T00:00:00.000Z',
            invalidatedReason: 'account_on_hold',
          },
        ],
        settings: { rotateOn: 'overage_exhausted', cooldownMs: 1_000 },
      },
    });
    const read = captureStdout();

    await tokenListCommand();

    const text = read();
    // 順序は order 昇順（first が先）。先に `first` が在ることを確かめる（無いと `-1 < n` で素通りする）。
    expect(text).toContain('first');
    expect(text.indexOf('first')).toBeLessThan(text.indexOf('second'));
    expect(text).toContain('id=tok-a');
    expect(text).toContain('sha256=aaaaaaaaaaaa');
    expect(text).toContain('外されている');
    expect(text).toContain('失効: account_on_hold');
    expect(text).toContain('冷却中');
    expect(text).toContain('最後の拒否: rate_limit exceeded');
    // **出所を返さないデーモンでは「記録されていない」と言う**（#683）。
    // 黙ると「権威ある値である」と読まれる。
    expect(text).toContain('出所は記録されていない');
    // 値はどこにも出ない（本文にトークン本体を書かないという約束の検算）。
    expect(text).not.toContain('tok-aaa');
  });

  /**
   * **#683**: 冷却の期限の出所を行が覚える。
   *
   * ここはかつて `冷却中（あと約 N 分。resetsAt 由来か既定のフォールバック）` と
   * 書いていた —— **どちらなのかを人間へ聞き返す形の表示である。**
   */
  it('冷却の期限の出所を3値で言い分ける（#683）', async () => {
    const now = Date.now();
    const rows = [
      { source: 'quota_reset', expect: '出所は枠の resetsAt（権威ある値）' },
      { source: 'overage_reset', expect: '出所は課金枠の overageResetsAt' },
      { source: 'default', expect: '出所は設定の既定（ただの推測である）' },
    ] as const;
    for (const row of rows) {
      setReply('GET', '/tokens', {
        status: 200,
        body: {
          tokens: [
            {
              id: 'tok-a',
              label: 'first',
              order: 0,
              sha256: 'aaaaaaaaaaaa',
              cooldownUntil: now + 60_000,
              cooldownSource: row.source,
            },
          ],
          settings: { rotateOn: 'free_exhausted', cooldownMs: 1_000 },
        },
      });
      const read = captureStdout();
      await tokenListCommand();
      expect(read(), row.source).toContain(row.expect);
    }
  });

  it('置いた時刻・最後の更新・回復の見込みを出す。見込みには実測でない旨を同じ行に添える（Issue #393）', async () => {
    setReply('GET', '/tokens', {
      status: 200,
      body: {
        tokens: [
          {
            id: 'tok-a',
            label: 'first',
            order: 0,
            sha256: 'aaaaaaaaaaaa',
            createdAt: '2026-08-01T00:00:00.000Z',
            updatedAt: '2026-08-25T03:00:00.000Z',
            lastRejectedAt: '2026-08-25T03:00:00.000Z',
            lastRejectedReason: "You've hit your org's monthly spend limit",
            recovery: 'time',
          },
        ],
        settings: EMPTY_SETTINGS,
      },
    });

    const read = captureStdout();

    await tokenListCommand();

    const text = read();
    expect(text).toContain('置いた 2026-08-01T00:00:00.000Z');
    expect(text).toContain('最後の更新 2026-08-25T03:00:00.000Z');
    expect(text).toContain('見込み: 時間で戻る');
    // **断りは同じ行に在ること。** 実測（文言・時刻）の隣に置いた判定は、行ごと
    // 実測として読まれる（AGENTS.md「報告の形」）。行を跨いだ断りでは効かない。
    const verdictLine = text.split('\n').find((line) => line.includes('見込み: 時間で戻る'));
    expect(verdictLine).toContain('実測ではない');
  });

  it('置いた時刻が無い行（PR1 の版で置かれた行）では、その行を出さない', async () => {
    setReply('GET', '/tokens', {
      status: 200,
      body: {
        tokens: [{ id: 'tok-a', label: 'first', order: 0, sha256: 'aaaaaaaaaaaa' }],
        settings: EMPTY_SETTINGS,
      },
    });

    const read = captureStdout();

    await tokenListCommand();

    // 取れなかったものを「不明」で埋めない。
    expect(read()).not.toContain('置いた');
  });

  /**
   * issue #2095。回す契機・冷却の設定が読めないとき（`settings` を省いて
   * `settingsUnreadable.reason` を返す）、CLI は落ちずに理由を出す。
   * **既定値（`free_exhausted` 等）で埋めない**——一覧そのものは道連れに
   * ならず、読める分だけ出る。
   */
  it('設定が読めない応答（settingsUnreadable）でも落ちず、理由を出す（一覧は道連れにならない）', async () => {
    const REASON = 'rotateOn が enum の外（テスト用）';
    setReply('GET', '/tokens', {
      status: 200,
      body: {
        tokens: [{ id: 'tok-a', label: 'first', order: 0, sha256: 'aaaaaaaaaaaa' }],
        settingsUnreadable: { reason: REASON },
      },
    });

    const read = captureStdout();

    await tokenListCommand();

    const text = read();
    expect(text).toContain('回転の設定は読めない');
    expect(text).toContain(REASON);
    // 既定値へすり替わっていない。
    expect(text).not.toContain('回す契機:');
    // 一覧（読めている分）は出ている。
    expect(text).toContain('first');
  });

  /**
   * issue #2346。プールの行が読めないとき（`rowsUnreadable`。`settingsUnreadable` の行版）、
   * 読めた行が0件でも「トークンは登録されていません」「自動切替は一切効きません」と断定
   * しない。対照（上の「プールが空なら…」）は、`rowsUnreadable` が無ければ今までどおり言う。
   */
  it('読めない行が在り、読めた行が0件のとき、「登録されていません」「一切効きません」と言わない（#2346）', async () => {
    setReply('GET', '/tokens', {
      status: 200,
      body: {
        tokens: [],
        settings: EMPTY_SETTINGS,
        rowsUnreadable: {
          count: 1,
          rows: [{ id: 'tok-bad', label: 'broken-label', reason: '不正な欄: order' }],
        },
      },
    });
    const read = captureStdout();

    await tokenListCommand();

    const text = read();
    expect(text).toContain('読めないトークンの行が 1 件ある');
    expect(text).toContain('id=tok-bad');
    expect(text).toContain('label=broken-label');
    expect(text).toContain('不正な欄: order');
    expect(text).toContain('消えたのではなく、読めない形で入っている');
    expect(text).toContain('読めたトークンの行は無い');
    // #2354: 書き換えは読めない行を「持ち越す」と言い、「捨てる」とは言わない。消す口を案内する。
    expect(text).toContain('捨てずに持ち越す');
    expect(text).toContain('alteroid token remove-unreadable <id>');
    expect(text).not.toContain('一緒に捨てる');
    expect(text).not.toContain('トークンは登録されていません');
    expect(text).not.toContain('一切効きません');
    expect(text).not.toContain('記録が残りません');
  });

  it('読めない行が在り、読めた行も在るとき、一覧の前に断りを出し、読めた行は今までどおり出る（#2346）', async () => {
    setReply('GET', '/tokens', {
      status: 200,
      body: {
        tokens: [{ id: 'tok-a', label: 'first', order: 0, sha256: 'aaaaaaaaaaaa' }],
        settings: EMPTY_SETTINGS,
        rowsUnreadable: { count: 1, rows: [{ reason: '不正な行' }] },
      },
    });
    const read = captureStdout();

    await tokenListCommand();

    const text = read();
    expect(text).toContain('読めないトークンの行が 1 件ある');
    expect(text).toContain('（id もラベルも取れない）');
    expect(text.indexOf('読めないトークンの行')).toBeLessThan(text.indexOf('first'));
    expect(text).toContain('first');
  });

  it('対照: rowsUnreadable が無ければ、断りは1文字も出ない（#2346）', async () => {
    setReply('GET', '/tokens', {
      status: 200,
      body: {
        tokens: [{ id: 'tok-a', label: 'first', order: 0, sha256: 'aaaaaaaaaaaa' }],
        settings: EMPTY_SETTINGS,
      },
    });
    const read = captureStdout();

    await tokenListCommand();

    expect(read()).not.toContain('読めない');
  });
});

/**
 * issue #2354。全文置換（`PUT /tokens`）は読めない行を持ち越す。`add` / `remove` / `disable` /
 * `enable` の出力は「読めない N 行は持ち越した」と言う（応答の `rowsUnreadable.carriedOver`）。
 * トークンの値（偽の値）はどの出力にも出ない。
 */
describe('読めない行の持ち越しを言う（#2354）', () => {
  const CARRIED = {
    tokens: [{ id: 'tok-a', label: 'a', order: 0, sha256: 'aaaaaaaaaaaa' }],
    settings: EMPTY_SETTINGS,
    rowsUnreadable: {
      count: 2,
      rows: [{ id: 'tok-bad', reason: '不正な欄: order' }, { reason: '不正な行' }],
      carriedOver: true,
    },
  };
  const SECRET = 'fake-secret-value-never-print';

  async function readCurrent(): Promise<void> {
    setReply('GET', '/tokens', {
      status: 200,
      body: {
        tokens: [{ id: 'tok-a', label: 'a', order: 0, sha256: 'aaaaaaaaaaaa' }],
        settings: EMPTY_SETTINGS,
      },
    });
    setReply('PUT', '/tokens', { status: 200, body: CARRIED });
  }

  it('add / remove / disable / enable の出力が「読めない 2 行は、捨てずに持ち越した」と言う', async () => {
    await readCurrent();
    const dir = await makeTempDir('alteroid-token-carried-');
    const path = join(dir, 'token.txt');
    await writeFile(path, `${SECRET}\n`, 'utf8');

    for (const run of [
      () => tokenAddCommand({ label: 'n', file: path }),
      () => tokenRemoveCommand('tok-a'),
      () => tokenDisableCommand('tok-a'),
      () => tokenEnableCommand('tok-a'),
    ]) {
      const read = captureStdout();
      await run();
      const text = read();
      expect(text).toContain('読めないトークンの行 2 行は、捨てずに持ち越した');
      expect(text).toContain('alteroid token remove-unreadable <id>');
      expect(text).not.toContain('捨てる');
      expect(text).not.toContain(SECRET);
    }
  });

  it('対照: 読めない行が無い応答では、持ち越しの文は1文字も出ない', async () => {
    setReply('GET', '/tokens', {
      status: 200,
      body: {
        tokens: [{ id: 'tok-a', label: 'a', order: 0, sha256: 'aaaaaaaaaaaa' }],
        settings: EMPTY_SETTINGS,
      },
    });
    setReply('PUT', '/tokens', { status: 200, body: { tokens: [], settings: EMPTY_SETTINGS } });
    const read = captureStdout();

    await tokenDisableCommand('tok-a');

    expect(read()).not.toContain('持ち越');
  });
});

describe('alteroid token remove-unreadable（#2354）', () => {
  it('id を POST /tokens/unreadable/remove へ送り、消した id と件数を言う。値は出ない', async () => {
    setReply('POST', '/tokens/unreadable/remove', {
      status: 200,
      body: { tokens: [], settings: EMPTY_SETTINGS, removedIds: ['tok-bad'] },
    });
    const read = captureStdout();

    await tokenRemoveUnreadableCommand(['tok-bad']);

    expect(read()).toContain('読めないトークンの行を 1 行消した（id: tok-bad）');
    const post = sent.find((call) => call.method === 'POST');
    expect(post?.body).toEqual({ ids: ['tok-bad'] });
    // 読めない行の取得も、PUT も打たない（全文置換を通さない）。
    expect(sent.some((call) => call.method === 'PUT')).toBe(false);
  });

  it('まだ読めない行が残っていれば、その件数を言う', async () => {
    setReply('POST', '/tokens/unreadable/remove', {
      status: 200,
      body: {
        tokens: [],
        settings: EMPTY_SETTINGS,
        removedIds: ['tok-bad'],
        rowsUnreadable: { count: 1, rows: [{ reason: '不正な行' }] },
      },
    });
    const read = captureStdout();

    await tokenRemoveUnreadableCommand(['tok-bad']);

    expect(read()).toContain('読めない行は、まだ 1 行ある');
  });

  it('消した後の読み直しに失敗した応答（viewUnavailable）: 消したと言い、残りは分からないと言う（#2390）', async () => {
    setReply('POST', '/tokens/unreadable/remove', {
      status: 200,
      body: {
        removedIds: ['tok-bad'],
        viewUnavailable: { reason: '読めない行は消した。消した後のプールを読み直せなかった' },
      },
    });
    const read = captureStdout();

    await tokenRemoveUnreadableCommand(['tok-bad']);

    const text = read();
    expect(text).toContain('読めないトークンの行を 1 行消した（id: tok-bad）');
    expect(text).toContain('読み直せなかった');
    expect(text).toContain('alteroid token list で確かめる');
    expect(text).not.toContain('まだ');
  });

  it('デーモンが断ったら（読めない行に無い id）、その理由で投げる', async () => {
    setReply('POST', '/tokens/unreadable/remove', {
      status: 404,
      body: { error: '指した id のうち 1 件が、読めない行に無い（何も消していない。）' },
    });

    await expect(tokenRemoveUnreadableCommand(['ghost'])).rejects.toThrow('何も消していない');
  });
});

describe('保存した後の読み直しに失敗した応答（viewUnavailable）を言う（#2396）', () => {
  const VIEW_UNAVAILABLE = {
    viewUnavailable: { reason: '保存した。保存後のプールを読み直せなかった' },
  };

  async function runAdd(): Promise<void> {
    const dir = await makeTempDir('alteroid-token-add-view-');
    const path = join(dir, 'token.txt');
    await writeFile(path, 'tok-aaa-secret\n', 'utf8');
    await tokenAddCommand({ label: 'new-one', file: path });
  }

  it.each([
    ['add', runAdd, 'トークン「new-one」を追加しました。'],
    ['remove', () => tokenRemoveCommand('tok-a'), 'トークン（id tok-a）を削除しました。'],
    ['disable', () => tokenDisableCommand('tok-a'), 'トークン（id tok-a）を外しました。'],
    ['enable', () => tokenEnableCommand('tok-a'), 'トークン（id tok-a）を戻しました。'],
  ] as const)(
    'token %s: 保存したと言い、今の姿は読み直せなかったと言う。失敗とは言わず、撃ち直さない',
    async (_name, run, saidSaved) => {
      setReply('GET', '/tokens', {
        status: 200,
        body: {
          tokens: [{ id: 'tok-a', label: 'a', order: 0, sha256: 'aaaaaaaaaaaa' }],
          settings: EMPTY_SETTINGS,
        },
      });
      setReply('PUT', '/tokens', { status: 200, body: VIEW_UNAVAILABLE });
      const read = captureStdout();

      await run();

      const text = read();
      expect(text).toContain(saidSaved);
      expect(text).toContain('保存した。ただし、保存後のプールを読み直せなかった');
      expect(text).toContain('alteroid token list で確かめる');
      expect(text).not.toContain('失敗');
      expect(text).not.toContain('持ち越した');
      expect(sent.filter((call) => call.method === 'PUT')).toHaveLength(1);
    },
  );
});

describe('alteroid token add', () => {
  it('ファイルの内容を value として PUT する。既存の行は value を省略して引き継ぐ', async () => {
    setReply('GET', '/tokens', {
      status: 200,
      body: {
        tokens: [{ id: 'tok-existing', label: 'existing', order: 0, sha256: 'ffffffffffff' }],
        settings: EMPTY_SETTINGS,
      },
    });
    setReply('PUT', '/tokens', {
      status: 200,
      body: {
        tokens: [
          { id: 'tok-existing', label: 'existing', order: 0, sha256: 'ffffffffffff' },
          { id: 'tok-new', label: 'new-one', order: 1, sha256: 'eeeeeeeeeeee' },
        ],
        settings: EMPTY_SETTINGS,
      },
    });

    const dir = await makeTempDir('alteroid-token-add-');
    const path = join(dir, 'token.txt');
    await writeFile(path, 'tok-aaa-secret\n', 'utf8');
    const read = captureStdout();

    await tokenAddCommand({ label: 'new-one', file: path });

    expect(read()).toContain('トークン「new-one」を追加しました。');

    const put = sent.find((call) => call.method === 'PUT' && call.url.endsWith('/tokens'));
    expect(put?.body).toEqual({
      tokens: [
        { id: 'tok-existing', label: 'existing', order: 0 },
        { label: 'new-one', value: 'tok-aaa-secret' },
      ],
    });
  });

  it('値が空（ファイルが空・空白のみ）なら投げる。PUT を打たない', async () => {
    setReply('GET', '/tokens', { status: 200, body: { tokens: [], settings: EMPTY_SETTINGS } });
    const dir = await makeTempDir('alteroid-token-add-empty-');
    const path = join(dir, 'empty.txt');
    await writeFile(path, '   \n', 'utf8');

    await expect(tokenAddCommand({ label: 'x', file: path })).rejects.toThrow('値が空である');

    expect(sent.some((call) => call.method === 'PUT')).toBe(false);
  });
});

describe('alteroid token remove', () => {
  it('id を指定して削除する（PUT からその行が落ちる）', async () => {
    setReply('GET', '/tokens', {
      status: 200,
      body: {
        tokens: [
          { id: 'tok-a', label: 'a', order: 0, sha256: 'aaaaaaaaaaaa' },
          { id: 'tok-b', label: 'b', order: 1, sha256: 'bbbbbbbbbbbb' },
        ],
        settings: EMPTY_SETTINGS,
      },
    });
    setReply('PUT', '/tokens', {
      status: 200,
      body: {
        tokens: [{ id: 'tok-b', label: 'b', order: 1, sha256: 'bbbbbbbbbbbb' }],
        settings: EMPTY_SETTINGS,
      },
    });
    const read = captureStdout();

    await tokenRemoveCommand('tok-a');

    expect(read()).toContain('トークン（id tok-a）を削除しました。');
    const put = sent.find((call) => call.method === 'PUT');
    expect(put?.body).toEqual({ tokens: [{ id: 'tok-b', label: 'b', order: 1 }] });
  });

  it('無い id を指定したら、見つからないと言うだけで PUT は打たない', async () => {
    setReply('GET', '/tokens', { status: 200, body: { tokens: [], settings: EMPTY_SETTINGS } });
    const read = captureStdout();

    await tokenRemoveCommand('ghost');

    expect(read()).toContain('id ghost のトークンは見つかりません。');
    expect(sent.some((call) => call.method === 'PUT')).toBe(false);
  });
});

describe('alteroid token disable / enable', () => {
  it('disable は指定した行にだけ disabled:true を立てて PUT する', async () => {
    setReply('GET', '/tokens', {
      status: 200,
      body: {
        tokens: [
          { id: 'tok-a', label: 'a', order: 0, sha256: 'aaaaaaaaaaaa' },
          { id: 'tok-b', label: 'b', order: 1, sha256: 'bbbbbbbbbbbb' },
        ],
        settings: EMPTY_SETTINGS,
      },
    });
    setReply('PUT', '/tokens', { status: 200, body: { tokens: [], settings: EMPTY_SETTINGS } });
    const read = captureStdout();

    await tokenDisableCommand('tok-a');

    expect(read()).toContain('トークン（id tok-a）を外しました。');
    const put = sent.find((call) => call.method === 'PUT');
    expect(put?.body).toEqual({
      tokens: [
        { id: 'tok-a', label: 'a', order: 0, disabled: true },
        { id: 'tok-b', label: 'b', order: 1 },
      ],
    });
  });

  it('enable は disabled:false を立てて戻す', async () => {
    setReply('GET', '/tokens', {
      status: 200,
      body: {
        tokens: [{ id: 'tok-a', label: 'a', order: 0, sha256: 'aaaaaaaaaaaa' }],
        settings: EMPTY_SETTINGS,
      },
    });
    setReply('PUT', '/tokens', { status: 200, body: { tokens: [], settings: EMPTY_SETTINGS } });
    const read = captureStdout();

    await tokenEnableCommand('tok-a');

    expect(read()).toContain('トークン（id tok-a）を戻しました。');
    const put = sent.find((call) => call.method === 'PUT');
    expect(put?.body).toEqual({ tokens: [{ id: 'tok-a', label: 'a', order: 0, disabled: false }] });
  });
});

describe('alteroid token policy', () => {
  it('引数無しなら、いまの設定を GET から出すだけ（PUT は打たない）', async () => {
    setReply('GET', '/tokens', {
      status: 200,
      body: { tokens: [], settings: { rotateOn: 'off', cooldownMs: 42 } },
    });
    const read = captureStdout();

    await tokenPolicyCommand(undefined, {});

    const text = read();
    expect(text).toContain('回す契機: off');
    expect(text).toContain('42ms');
    expect(sent.some((call) => call.method === 'PUT')).toBe(false);
  });

  it('値を渡すと PUT /tokens/policy へ部分更新として送る', async () => {
    setReply('PUT', '/tokens/policy', {
      status: 200,
      body: { rotateOn: 'overage_exhausted', cooldownMs: 18_000_000 },
    });
    const read = captureStdout();

    await tokenPolicyCommand('overage_exhausted', {});

    expect(read()).toContain('回す契機: overage_exhausted');
    const put = sent.find((call) => call.method === 'PUT' && call.url.endsWith('/tokens/policy'));
    expect(put?.body).toEqual({ rotateOn: 'overage_exhausted' });
  });

  it('token policy の値が3つのどれでもなければ、通信の前に許される値と意味を日本語で言う（rotateOn を出さない）', async () => {
    const error = await tokenPolicyCommand('bogus', {}).catch((e: unknown) => e);
    const text = String(error);
    expect(text).toContain(
      'free_exhausted / overage_exhausted / off のいずれか（渡されたのは bogus）',
    );
    expect(text).toContain('無料枠が尽きたら回す');
    expect(text).not.toContain('rotateOn');
    expect(sent.some((call) => call.method === 'PUT')).toBe(false);
  });

  it('--cooldown-ms も渡せる。0以下や非数は投げる', async () => {
    setReply('PUT', '/tokens/policy', {
      status: 200,
      body: { rotateOn: 'free_exhausted', cooldownMs: 5_000 },
    });
    captureStdout();

    await tokenPolicyCommand(undefined, { cooldownMs: '5000' });
    const put = sent.find((call) => call.method === 'PUT' && call.url.endsWith('/tokens/policy'));
    expect(put?.body).toEqual({ cooldownMs: 5_000 });

    await expect(tokenPolicyCommand(undefined, { cooldownMs: '0' })).rejects.toThrow(
      '--cooldown-ms',
    );
    await expect(tokenPolicyCommand(undefined, { cooldownMs: 'abc' })).rejects.toThrow(
      '--cooldown-ms',
    );
  });

  /**
   * issue #2095。引数無し（見るだけ）のとき、GET /tokens が
   * `settingsUnreadable` を返したら既定値で埋めずに理由を出す。
   */
  it('引数無しで、設定が読めない応答なら落ちずに理由を出す', async () => {
    const REASON = 'cooldownMs が数値でない（テスト用）';
    setReply('GET', '/tokens', {
      status: 200,
      body: { tokens: [], settingsUnreadable: { reason: REASON } },
    });
    const read = captureStdout();

    await tokenPolicyCommand(undefined, {});

    const text = read();
    expect(text).toContain('回転の設定は読めない');
    expect(text).toContain(REASON);
    expect(text).not.toContain('回す契機:');
    expect(sent.some((call) => call.method === 'PUT')).toBe(false);
  });

  /**
   * Web の同じ画面（PR #2120）と揃える——読めないときは「消えたのではなく、
   * 読めない形で入っている」ことと、CLI での直し方を出す。`list` と `policy`
   * （引数無し）は同じ関数から出すので、2つの出力が同じ案内を含むことを測る。
   */
  it('設定が読めないとき、policy（引数無し）と list の両方が「読めない形で入っている」と直し方を出す', async () => {
    const REASON = 'rotateOn が enum の外（テスト用）';
    setReply('GET', '/tokens', {
      status: 200,
      body: { tokens: [], settingsUnreadable: { reason: REASON } },
    });

    const readPolicy = captureStdout();
    await tokenPolicyCommand(undefined, {});
    const policyText = readPolicy();

    const readList = captureStdout();
    await tokenListCommand();
    const listText = readList();

    for (const text of [policyText, listText]) {
      expect(text).toContain('消えたのではなく、読めない形で入っている');
      expect(text).toContain(REASON);
      expect(text).toContain('alteroid token policy');
      expect(text).toContain('--cooldown-ms');
      expect(text).toContain('free_exhausted|overage_exhausted|off');
    }
  });
});

/**
 * 403 の案内を、**サーバが返した本文で分ける**。
 *
 * **元はここに歯が1本だけ在った**——`{ error: 'forbidden' }` という本文で
 * 「実行環境の持ち主だけです」が出ることを見ていた。**その足場はデーモンが実際に
 * 返す本文ではない**（`authenticate` と `requireOperator` は別々の逐語を返す）ので、
 * 「どちらの 403 でも同じ文言を出す」という当時の実装をそのまま仕様として固定して
 * いた。実装が本文で分けるようになったので、足場を実物の2種類へ置き換え、判別
 * できない本文の枝を足した。**元の歯は消していない**——「持ち主でない本文なら
 * 持ち主用の文言」として下の1本目に残っている。
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

  it('持ち主でないときは専用の文言を出す（access grant とは別の資格だと分かる形で）', async () => {
    setReply('GET', '/tokens', { status: 403, body: NOT_OPERATOR });

    const message = await messageOf(() => tokenListCommand());
    expect(message).toContain('実行環境の持ち主だけです');
    expect(message).toContain('docker compose exec');
    // **鳴ってはいけない側。** 持ち主でない人に `access grant` を勧めても直らない。
    expect(message).not.toContain('access grant');
  });

  it('未 grant のときは access grant を促す（器の中で実行しろ、と言わない）', async () => {
    setReply('GET', '/tokens', { status: 403, body: NOT_GRANTED });

    const message = await messageOf(() => tokenListCommand());
    expect(message).toContain('access grant');
    // **鳴ってはいけない側。** ここが今回いちばん直したかった嘘である。
    expect(message).not.toContain('docker compose exec');
  });

  it('判別できない本文なら、どちらの手順も出さない', async () => {
    setReply('GET', '/tokens', { status: 403, body: { error: 'なにか別の理由' } });

    const message = await messageOf(() => tokenListCommand());
    expect(message).toContain('403');
    // **⭐ 設計の芯。** 当てずっぽうで片方を出せば、半分の状況では必ず嘘になる。
    expect(message).not.toContain('docker compose exec');
    expect(message).not.toContain('access grant');
  });
});

/**
 * **⚠️ 2026-09-14 に、器の環境変数（`source: 'env'`）へのフォールバックを完全に
 * 廃止した。** かつてはここに、値を持たない「器の環境変数を指す行」の専用表示
 * （指紋の代わりの名指し・並び順・削除時の「次の起動で戻る」警告）を固定する
 * `describe('環境変数の行', …)` が在ったが、その表示ロジックごと `token.ts` から
 * 削除した（`source` は `'stored'` しか無くなったので、そもそも表示の分岐が
 * 作れない）。**この describe は削除した**——契約が変わったのではなく無くなった
 * ので、緩めて残すのではなく消した。
 *
 * 生き残る不変条件（order 順の並び・冷却/拒否の表示・空プールの案内文・
 * 削除時に余計な警告を出さないこと）は、それぞれ `alteroid token list` /
 * `alteroid token remove` の describe の中で、`'stored'` の行だけを使う形で
 * そのまま測っている。
 */

/**
 * 日誌が書けなかった `PUT /tokens`・`PUT /tokens/policy` の 500（issue #2742 の続き）。
 * 素の `/tokens が失敗しました (500)` ではなく、「変更していない」と次にすることを言う。
 */
describe('日誌が書けなかった 500 の見せ方', () => {
  const JOURNAL_DOWN = {
    status: 500,
    body: {
      error: '記録（日誌）が書けなかったので、変更していません',
      code: 'journal_write_failed',
    },
  };

  it('token add: 「記録（日誌）が書けなかったので、変更していません」と言う', async () => {
    const file = join(await makeTempDir('alteroid-token-'), 'v.txt');
    await writeFile(file, 'dummy-value\n');
    setReply('GET', '/tokens', { status: 200, body: { tokens: [], settings: EMPTY_SETTINGS } });
    setReply('PUT', '/tokens', JOURNAL_DOWN);
    captureStdout();

    const error = await tokenAddCommand({ label: 'x', file }).catch((e: unknown) => e as Error);
    expect(error).toBeInstanceOf(Error);
    expect((error as Error).message).toContain('記録（日誌）が書けなかったので、変更していません');
    expect((error as Error).message).not.toContain('(500)');
  });

  it('token enable / token policy: 同じ言い方', async () => {
    setReply('GET', '/tokens', {
      status: 200,
      body: {
        tokens: [{ id: 'tok-a', label: 'a', order: 0, disabledAt: '2026-01-01T00:00:00.000Z' }],
        settings: EMPTY_SETTINGS,
      },
    });
    setReply('PUT', '/tokens', JOURNAL_DOWN);
    setReply('PUT', '/tokens/policy', JOURNAL_DOWN);
    captureStdout();

    await expect(tokenEnableCommand('tok-a')).rejects.toThrow('変更していません');
    await expect(tokenPolicyCommand('overage_exhausted')).rejects.toThrow('変更していません');
  });

  it('本文の無い 500（日誌の失敗を言えない版）は、変更されたか分からないと言い、確かめ方を出す', async () => {
    setReply('PUT', '/tokens/policy', { status: 500, body: 'Internal Server Error' });
    captureStdout();

    const error = await tokenPolicyCommand('off').catch((e: unknown) => e as Error);
    expect((error as Error).message).toContain('変更されたかどうかは分かりません');
    expect((error as Error).message).toContain('alteroid token list');
    expect((error as Error).message).not.toContain('Internal Server Error');
  });
});
