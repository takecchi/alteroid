import { writeFile } from 'node:fs/promises';
import { join } from 'node:path';

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { makeTempDir } from '../../../vitest.tmpdir.js';

import { captureStdout, pretendTty } from './test-support.js';

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
    expect(text).toContain('first');
    expect(text.indexOf('first')).toBeLessThan(text.indexOf('second'));
    expect(text).toContain('id=tok-a');
    expect(text).toContain('sha256=aaaaaaaaaaaa');
    expect(text).toContain('外されている');
    expect(text).toContain('失効: account_on_hold');
    expect(text).toContain('冷却中');
    expect(text).toContain('最後の拒否: rate_limit exceeded');
    expect(text).toContain('出所は記録されていない');
    expect(text).not.toContain('tok-aaa');
  });

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

    expect(read()).not.toContain('置いた');
  });

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
    expect(text).not.toContain('回す契機:');
    expect(text).toContain('first');
  });

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
      () => tokenRemoveCommand('tok-a', { yes: true }),
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

    await tokenRemoveUnreadableCommand(['tok-bad'], { yes: true });

    expect(read()).toContain('読めないトークンの行を 1 行消した（id: tok-bad）');
    const post = sent.find((call) => call.method === 'POST');
    expect(post?.body).toEqual({ ids: ['tok-bad'] });
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

    await tokenRemoveUnreadableCommand(['tok-bad'], { yes: true });

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

    await tokenRemoveUnreadableCommand(['tok-bad'], { yes: true });

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

    await expect(tokenRemoveUnreadableCommand(['ghost'], { yes: true })).rejects.toThrow(
      '何も消していない',
    );
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
    [
      'remove',
      () => tokenRemoveCommand('tok-a', { yes: true }),
      'トークン（id tok-a）を削除しました。',
    ],
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

    await tokenRemoveCommand('tok-a', { yes: true });

    expect(read()).toContain('トークン（id tok-a）を削除しました。');
    const put = sent.find((call) => call.method === 'PUT');
    expect(put?.body).toEqual({ tokens: [{ id: 'tok-b', label: 'b', order: 1 }] });
  });

  it('無い id を指定したら、見つからないと言うだけで PUT は打たない', async () => {
    setReply('GET', '/tokens', { status: 200, body: { tokens: [], settings: EMPTY_SETTINGS } });

    await expect(tokenRemoveCommand('ghost')).rejects.toThrow(
      'id ghost のトークンは見つかりません（alteroid token list で id を確かめてください）',
    );
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

describe('403（本文で理由を分ける）', () => {
  // `target.ts` の定数も `apps/daemon` も import しない: 対象と同じ値を参照すると、文言がずれても歯まで一緒にずれて、ずれを検出できなくなるため
  const NOT_OPERATOR = { error: '実行環境の持ち主だけが操作できる' };
  const NOT_GRANTED = { error: 'このアカウントには alteroid を使う許可が無い' };

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
    expect(message).not.toContain('access grant');
  });

  it('未 grant のときは access grant を促す（器の中で実行しろ、と言わない）', async () => {
    setReply('GET', '/tokens', { status: 403, body: NOT_GRANTED });

    const message = await messageOf(() => tokenListCommand());
    expect(message).toContain('access grant');
    expect(message).not.toContain('docker compose exec');
  });

  it('判別できない本文なら、どちらの手順も出さない', async () => {
    setReply('GET', '/tokens', { status: 403, body: { error: 'なにか別の理由' } });

    const message = await messageOf(() => tokenListCommand());
    expect(message).toContain('403');
    expect(message).not.toContain('docker compose exec');
    expect(message).not.toContain('access grant');
  });
});

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

describe('alteroid token remove の確認（#3141）', () => {
  it('端末でなく --yes も無ければ、PUT せずに断る（消えていない）', async () => {
    setReply('GET', '/tokens', {
      status: 200,
      body: {
        tokens: [{ id: 'tok-a', label: 'a', order: 0, sha256: 'aaaaaaaaaaaa' }],
        settings: EMPTY_SETTINGS,
      },
    });
    const restore = pretendTty(false);
    try {
      await expect(tokenRemoveCommand('tok-a')).rejects.toThrow('--yes');
    } finally {
      restore();
    }
    expect(sent.some((call) => call.method === 'PUT')).toBe(false);
  });
});

describe('alteroid token remove-unreadable の確認（#3141）', () => {
  it('端末でなく --yes も無ければ、HTTP に出ずに断る（消えていない）', async () => {
    const restore = pretendTty(false);
    try {
      await expect(tokenRemoveUnreadableCommand(['row-1'])).rejects.toThrow('--yes');
    } finally {
      restore();
    }
    expect(sent.length).toBe(0);
  });
});
