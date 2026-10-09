import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import type { ConfirmIo } from './confirm.js';
import { captureStdout, pretendTty } from './test-support.js';

/**
 * `./target.js` は `resolveTarget` だけ差し替える。`forbiddenKindOf` と `describeAuthFailure` は本物を使う。
 * `remote` は歯ごとに変える: 遠隔のデーモンでも持ち主用の文言が出ることを測るため。
 */
const targetState = vi.hoisted(() => ({ remote: false }));

vi.mock('./target.js', async (importOriginal) => ({
  ...(await importOriginal<typeof import('./target.js')>()),
  resolveTarget: () =>
    Promise.resolve({
      baseUrl: 'http://127.0.0.1:4517',
      headers: {},
      note: null,
      remote: targetState.remote,
    }),
}));

const {
  accessListCommand,
  accessOwnerCommand,
  accessRemoveUnreadableCommand,
  accessRevokeCommand,
} = await import('./access.js');

interface Sent {
  url: string;
  method: string;
  body?: unknown;
}

let sent: Sent[] = [];
let originalFetch: typeof fetch;
let replies: { status: number; body: unknown }[] = [];

function stubFetch(): void {
  globalThis.fetch = ((input: unknown, init?: RequestInit) => {
    const request = input as { url?: string; method?: string };
    const url = typeof input === 'string' ? input : (request.url ?? String(input));
    sent.push({ url, method: init?.method ?? request.method ?? 'GET', body: init?.body });
    const reply = replies.shift() ?? { status: 200, body: {} };
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
  sent = [];
  replies = [];
  stubFetch();
});

afterEach(() => {
  globalThis.fetch = originalFetch;
  vi.restoreAllMocks();
});

describe('alteroid access list', () => {
  it('作成（createdAt）を出す', async () => {
    const read = captureStdout();
    replies.push({
      status: 200,
      body: {
        accounts: [
          {
            id: 'acc-1',
            displayName: 'たけっち',
            email: 'takecchi@example.com',
            createdAt: '2026-08-01T00:00:00.000Z',
            lastLoginAt: '2026-08-20T09:00:00.000Z',
            grantedAt: '2026-08-01T00:05:00.000Z',
            grantedBy: 'operator',
            granted: true,
            ownerDeclaredAt: null,
            identities: [
              { provider: 'github', email: null, lastLoginAt: '2026-08-20T09:00:00.000Z' },
            ],
          },
        ],
      },
    });

    await accessListCommand();

    expect(sent).toHaveLength(1);
    expect(sent[0]?.url).toBe('http://127.0.0.1:4517/access');
    const text = read();
    expect(text).toContain('acc-1');
    expect(text).toContain('作成: 2026-08-01T00:00:00.000Z');
    expect(text).toContain('最終ログイン: 2026-08-20T09:00:00.000Z');
    expect(text).toContain('許可した日時: 2026-08-01T00:05:00.000Z');
  });

  it('作成の横に経過（（N分前）の形）を添える。ISO は消えない', async () => {
    const read = captureStdout();
    replies.push({
      status: 200,
      body: {
        accounts: [
          {
            id: 'acc-1',
            displayName: 'たけっち',
            email: 'takecchi@example.com',
            createdAt: '2026-08-01T00:00:00.000Z',
            lastLoginAt: null,
            grantedAt: null,
            grantedBy: null,
            granted: true,
            ownerDeclaredAt: null,
            identities: [],
          },
        ],
      },
    });

    await accessListCommand(new Date('2026-08-02T00:00:00.000Z').getTime());

    const text = read();
    expect(text).toContain('作成: 2026-08-01T00:00:00.000Z（1日前）');
  });

  it('作成が読めない時刻のとき「不明前」と出さない', async () => {
    const read = captureStdout();
    replies.push({
      status: 200,
      body: {
        accounts: [
          {
            id: 'acc-1',
            displayName: 'たけっち',
            email: 'takecchi@example.com',
            createdAt: 'not-a-real-timestamp',
            lastLoginAt: null,
            grantedAt: null,
            grantedBy: null,
            granted: true,
            ownerDeclaredAt: null,
            identities: [],
          },
        ],
      },
    });

    await accessListCommand(new Date('2026-08-02T00:00:00.000Z').getTime());

    const text = read();
    expect(text).not.toContain('不明前');
    expect(text).toContain('作成: not-a-real-timestamp（経過不明）');
  });

  it('誰が許可したかを、許可した日時の後ろに添える', async () => {
    const read = captureStdout();
    const account = (id: string, grantedBy: string | null) => ({
      id,
      displayName: null,
      email: `${id}@example.com`,
      createdAt: '2026-09-01T00:00:00.000Z',
      lastLoginAt: null,
      grantedAt: '2026-09-03T00:00:00.000Z',
      grantedBy,
      granted: true,
      ownerDeclaredAt: null,
      identities: [],
    });
    replies.push({
      status: 200,
      body: {
        accounts: [
          account('acc-by-operator', 'operator'),
          account('acc-by-account', 'acc-by-operator'),
          account('acc-by-unknown', null),
        ],
      },
    });

    await accessListCommand();

    const text = read();
    expect(text).toContain('許可した日時: 2026-09-03T00:00:00.000Z（実行環境の持ち主）');
    expect(text).toContain('許可した日時: 2026-09-03T00:00:00.000Z（acc-by-operator）');
    expect(text).toContain('許可した日時: 2026-09-03T00:00:00.000Z（不明）');
  });

  it('まだ誰もいなければ、そう言う', async () => {
    const read = captureStdout();
    replies.push({ status: 200, body: { accounts: [] } });

    await accessListCommand();

    expect(read()).toContain('まだ誰もログインしていません');
  });

  // 未宣言と宣言済みの両方を1回で確かめる: 片方だけだと「常に出る／常に出ない」の両方の壊れ方を見逃す。
  it('宣言済みかどうかの印を出す（[owner] と実行環境の持ち主として宣言の日時）', async () => {
    const read = captureStdout();
    replies.push({
      status: 200,
      body: {
        accounts: [
          {
            id: 'acc-owner',
            displayName: null,
            email: 'owner@example.com',
            createdAt: '2026-09-01T00:00:00.000Z',
            lastLoginAt: null,
            grantedAt: '2026-09-01T00:00:00.000Z',
            grantedBy: 'operator',
            granted: true,
            ownerDeclaredAt: '2026-09-18T00:00:00.000Z',
            identities: [],
          },
          {
            id: 'acc-not-owner',
            displayName: null,
            email: 'plain@example.com',
            createdAt: '2026-09-02T00:00:00.000Z',
            lastLoginAt: null,
            grantedAt: '2026-09-02T00:00:00.000Z',
            grantedBy: 'operator',
            granted: true,
            ownerDeclaredAt: null,
            identities: [],
          },
        ],
      },
    });

    await accessListCommand();

    const text = read();
    expect(text).toContain('[許可][owner] owner@example.com');
    expect(text).toContain('実行環境の持ち主として宣言: 2026-09-18T00:00:00.000Z');
    expect(text).toContain('[許可] plain@example.com');
    expect(text).not.toContain('[許可][owner] plain@example.com');
    expect(text).toContain('実行環境の持ち主として宣言: （未宣言）');
  });
});

describe('alteroid access owner', () => {
  it('宣言する: POST /access/:id/owner を叩く', async () => {
    const read = captureStdout();
    replies.push({
      status: 200,
      body: {
        account: {
          id: 'acc-1',
          displayName: null,
          email: 'owner@example.com',
          createdAt: '2026-09-01T00:00:00.000Z',
          lastLoginAt: null,
          grantedAt: '2026-09-01T00:00:00.000Z',
          grantedBy: 'operator',
          granted: true,
          ownerDeclaredAt: '2026-09-18T00:00:00.000Z',
          identities: [],
        },
      },
    });

    await accessOwnerCommand('acc-1');

    expect(sent).toEqual([{ url: 'http://127.0.0.1:4517/access/acc-1/owner', method: 'POST' }]);
    const text = read();
    expect(text).toContain('実行環境の持ち主として宣言しました: owner@example.com');
    expect(text).toContain('宣言を記録しただけです。資格の判断には使っていません');
    expect(text).not.toContain('通ります');
  });

  it('--revoke: POST /access/:id/owner/revoke を叩く', async () => {
    const read = captureStdout();
    replies.push({
      status: 200,
      body: {
        account: {
          id: 'acc-1',
          displayName: null,
          email: 'owner@example.com',
          createdAt: '2026-09-01T00:00:00.000Z',
          lastLoginAt: null,
          grantedAt: '2026-09-01T00:00:00.000Z',
          grantedBy: 'operator',
          granted: true,
          ownerDeclaredAt: null,
          identities: [],
        },
      },
    });

    await accessOwnerCommand('acc-1', { revoke: true });

    expect(sent).toEqual([
      { url: 'http://127.0.0.1:4517/access/acc-1/owner/revoke', method: 'POST' },
    ]);
    const text = read();
    expect(text).toContain('実行環境の持ち主としての宣言を取り消しました: owner@example.com');
    expect(text).toContain('宣言の記録を取り消しただけです。資格の判断には使っていません');
    expect(text).not.toContain('通らなくなります');
  });

  it('accountId は URL エンコードする', async () => {
    captureStdout();
    replies.push({
      status: 200,
      body: {
        account: {
          id: 'acc/weird',
          displayName: null,
          email: null,
          createdAt: '2026-09-01T00:00:00.000Z',
          lastLoginAt: null,
          grantedAt: '2026-09-01T00:00:00.000Z',
          grantedBy: 'operator',
          granted: true,
          ownerDeclaredAt: '2026-09-18T00:00:00.000Z',
          identities: [],
        },
      },
    });

    await accessOwnerCommand('acc/weird');

    expect(sent[0]?.url).toBe('http://127.0.0.1:4517/access/acc%2Fweird/owner');
  });

  it('未許可のアカウントは 409 —— サーバの文言をそのまま出す', async () => {
    replies.push({
      status: 409,
      body: { error: 'このアカウントはまだ許可されていない（先に access grant が要る）' },
    });

    await expect(accessOwnerCommand('acc-1')).rejects.toThrow(
      /このアカウントはまだ許可されていない/,
    );
  });

  it('本文に理由の無い 409 は、競合したことと理由が返らなかったことだけを言う', async () => {
    replies.push({ status: 409, body: {} });

    await expect(accessOwnerCommand('acc-1')).rejects.toThrow(
      '/access/acc-1/owner が競合しました (409)。デーモンから理由が返りませんでした',
    );
  });

  it('404・409・認証以外の失敗は、状態コードだけでなくデーモンの理由も出す', async () => {
    replies.push({
      status: 500,
      body: { error: 'アカウント台帳の書き込みが失敗した（テスト用）' },
    });

    await expect(accessOwnerCommand('acc-1')).rejects.toThrow(
      /が失敗しました \(500\): アカウント台帳の書き込みが失敗した（テスト用）/,
    );
  });

  it('該当するアカウントが無ければ 404', async () => {
    replies.push({ status: 404, body: { error: 'not found' } });

    await expect(accessOwnerCommand('missing')).rejects.toThrow(/該当するアカウントがありません/);
  });

  it('403（実行環境の持ち主でない）なら、器の中で実行しろと案内する', async () => {
    replies.push({
      status: 403,
      body: { error: '実行環境の持ち主だけが操作できる' },
    });

    await expect(accessOwnerCommand('acc-1')).rejects.toThrow(/docker compose exec/);
  });
});

describe('403（本文で理由を分ける）', () => {
  /**
   * `apps/daemon/src/app.ts` が返す本文の複製。`target.ts` の定数も import しない:
   * 対象と同じ値を参照すると、文言がずれても歯まで一緒にずれて検出できなくなる。
   */
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

  it('持ち主でないときは、器の中で実行しろと案内する', async () => {
    replies.push({ status: 403, body: NOT_OPERATOR });

    const message = await messageOf(() => accessListCommand());
    expect(message).toContain('docker compose exec');
    expect(message).not.toContain('access grant');
  });

  it('⭐ 遠隔のデーモンでも、持ち主でないなら同じ案内を出す（remote で場合分けしない）', async () => {
    targetState.remote = true;
    replies.push({ status: 403, body: NOT_OPERATOR });

    const message = await messageOf(() => accessListCommand());
    expect(message).toContain('docker compose exec');
    expect(message).not.toContain('access grant');
  });

  it('未 grant のときは access grant を促す', async () => {
    replies.push({ status: 403, body: NOT_GRANTED });

    const message = await messageOf(() => accessListCommand());
    expect(message).toContain('access grant');
    expect(message).not.toContain('docker compose exec');
  });

  it('判別できない本文なら、どちらの手順も出さない', async () => {
    replies.push({ status: 403, body: { error: 'なにか別の理由' } });

    const message = await messageOf(() => accessListCommand());
    expect(message).toContain('403');
    expect(message).not.toContain('docker compose exec');
    expect(message).not.toContain('access grant');
  });
});

describe('alteroid access remove-unreadable（issue #2440）', () => {
  it('id を POST /access/unreadable/remove へ送り、消した id と件数を言う。値は出ない', async () => {
    replies.push({ status: 200, body: { removedIds: ['row-1', 'row-2'], count: 2 } });
    const read = captureStdout();

    await accessRemoveUnreadableCommand(['row-1', 'row-2'], { yes: true });

    expect(sent).toHaveLength(1);
    expect(sent[0]?.url).toBe('http://127.0.0.1:4517/access/unreadable/remove');
    expect(sent[0]?.method).toBe('POST');
    expect(JSON.parse(String(sent[0]?.body))).toEqual({ ids: ['row-1', 'row-2'] });
    const text = read();
    expect(text).toContain('読めないアカウントの行を 2 行消し');
    expect(text).toContain('row-1, row-2');
  });

  it('404（指した id が読めない行に無い）は、何も消していないと言って投げる。指した文字列は映さない', async () => {
    replies.push({ status: 404, body: { error: 'x' } });

    const error = await accessRemoveUnreadableCommand(['FAKE_SECRET_VALUE_2440'], {
      yes: true,
    }).catch((e: unknown) => e);

    expect(error).toBeInstanceOf(Error);
    expect((error as Error).message).toContain('何も消していません');
    expect((error as Error).message).toContain('id が取れない行はこの口では消せません');
    expect((error as Error).message).not.toContain('FAKE_SECRET_VALUE_2440');
  });

  it('500 はデーモンの理由を載せて投げる', async () => {
    replies.push({ status: 500, body: { error: '保存できなかった（テスト用）' } });

    await expect(accessRemoveUnreadableCommand(['row-1'], { yes: true })).rejects.toThrow(/500/);
  });
});

describe('alteroid access list — 読めない行（issue #2536）', () => {
  it('読めない行が無ければ、読めない行の断りを出さない', async () => {
    replies.push({ status: 200, body: { accounts: [] } });
    const read = captureStdout();

    await accessListCommand();

    const text = read();
    expect(text).not.toContain('読めない');
    expect(text).not.toContain('remove-unreadable');
    expect(text).toContain('まだ誰もログインしていません。');
  });

  it('件数と id・不正な欄名を出し、remove-unreadable へ導く。id の無い行は手で直すと言う', async () => {
    replies.push({
      status: 200,
      body: {
        accounts: [],
        rowsUnreadable: {
          count: 2,
          rows: [{ id: 'acct-bad', reason: '不正な欄: displayName' }],
        },
      },
    });
    const read = captureStdout();

    await accessListCommand();

    const text = read();
    expect(text).toContain('読めないアカウントの行が 2 件ある');
    expect(text).toContain('id=acct-bad  不正な欄: displayName');
    expect(text).toContain('alteroid access remove-unreadable <id>');
    expect(text).toContain('id が取れない行が 1 件');
    expect(text).toContain('auth.json');
    expect(text).not.toContain('まだ誰もログインしていません。');
    expect(text).toContain('誰もログインしていない、とは言えない');
  });
});

describe('alteroid access revoke（#3141）', () => {
  it('--yes なら先に GET /access で在るかを読み、POST /access/:id/revoke を叩く。トークンが通らなくなると言う', async () => {
    replies.push({ status: 200, body: { accounts: [{ id: 'acc-1' }] } });
    replies.push({ status: 200, body: { account: { id: 'acc-1', email: 'a@example.com' } } });
    const read = captureStdout();

    await accessRevokeCommand('acc-1', { yes: true });

    expect(sent.map((entry) => `${entry.method} ${new URL(entry.url).pathname}`)).toEqual([
      'GET /access',
      'POST /access/acc-1/revoke',
    ]);
    expect(read()).toContain('許可を取り消しました: a@example.com');
  });

  it('端末でなく --yes も無ければ、取り消さずに断る（許可は残る。要求は一覧の GET だけ）', async () => {
    replies.push({ status: 200, body: { accounts: [{ id: 'acc-1' }] } });
    const restore = pretendTty(false);
    try {
      await expect(accessRevokeCommand('acc-1')).rejects.toThrow('--yes');
    } finally {
      restore();
    }
    expect(sent.map((entry) => `${entry.method} ${new URL(entry.url).pathname}`)).toEqual([
      'GET /access',
    ]);
  });
});

describe('alteroid access revoke は、確認の前に在るかを確かめる（#3838）', () => {
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
  const requests = () => sent.map((entry) => `${entry.method} ${new URL(entry.url).pathname}`);

  it('無いアカウントは、確認を出さずに失敗する。要求は一覧の GET だけ（再現）', async () => {
    replies.push({ status: 200, body: { accounts: [{ id: 'acc-1' }] } });
    const { io, asked, written } = fakeIo({ isTTY: true, answer: 'yes' });

    await expect(accessRevokeCommand('no-such-acc', {}, io)).rejects.toThrow(
      '該当するアカウントがありません',
    );

    expect(asked).toEqual([]);
    expect(written).toEqual([]);
    expect(requests()).toEqual(['GET /access']);
  });

  it('無いアカウントは、端末でなく --yes も無くても「該当するアカウントがありません」で失敗する（--yes の案内に化けない）', async () => {
    replies.push({ status: 200, body: { accounts: [] } });
    const { io } = fakeIo({ isTTY: false });

    const error = await accessRevokeCommand('no-such-acc', {}, io).catch((e: unknown) => e);

    expect(String(error)).toContain('該当するアカウントがありません');
    expect(String(error)).not.toContain('--yes');
    expect(requests()).toEqual(['GET /access']);
  });

  it('在るアカウントは、従来どおり 確認 → POST', async () => {
    captureStdout();
    replies.push({ status: 200, body: { accounts: [{ id: 'acc-1' }] } });
    replies.push({ status: 200, body: { account: { id: 'acc-1', email: 'a@example.com' } } });
    const { io, asked, written } = fakeIo({ isTTY: true, answer: 'yes' });

    await accessRevokeCommand('acc-1', {}, io);

    expect(written.join('')).toContain('アカウント acc-1 の許可を取り消します');
    expect(asked).toHaveLength(1);
    expect(requests()).toEqual(['GET /access', 'POST /access/acc-1/revoke']);
  });

  it('在るアカウントでも、確認に yes と答えなければ POST は打たない', async () => {
    replies.push({ status: 200, body: { accounts: [{ id: 'acc-1' }] } });
    const { io } = fakeIo({ isTTY: true, answer: 'no' });

    await expect(accessRevokeCommand('acc-1', {}, io)).rejects.toThrow();

    expect(requests()).toEqual(['GET /access']);
  });

  it('読めない行にある id は「無い」と言わず、確認へ進み、POST の 409 の案内を伝える', async () => {
    replies.push({
      status: 200,
      body: {
        accounts: [],
        rowsUnreadable: { count: 1, rows: [{ id: 'row-bad', reason: 'email' }] },
      },
    });
    replies.push({ status: 409, body: { error: 'アカウント row-bad は読めない形で入っている' } });
    const { io, asked } = fakeIo({ isTTY: true, answer: 'yes' });

    const error = await accessRevokeCommand('row-bad', {}, io).catch((e: unknown) => e);

    expect(asked).toHaveLength(1);
    expect(String(error)).toContain('読めない形で入っている');
    expect(String(error)).not.toContain('該当するアカウントがありません');
    expect(requests()).toEqual(['GET /access', 'POST /access/row-bad/revoke']);
  });
});

describe('alteroid access remove-unreadable の確認（#3141）', () => {
  it('端末でなく --yes も無ければ、HTTP に出ずに断る（消えていない）', async () => {
    const restore = pretendTty(false);
    try {
      await expect(accessRemoveUnreadableCommand(['row-1'])).rejects.toThrow('--yes');
    } finally {
      restore();
    }
    expect(sent.length).toBe(0);
  });
});
