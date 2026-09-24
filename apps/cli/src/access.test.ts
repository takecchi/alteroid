import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { captureStdout } from './test-support.js';

/**
 * `alteroid access` — 誰が alteroid を使えるかを CLI から見えること。
 *
 * **`fetch` を差し替える。** `access.ts` は `hono/client` を使わず素の `fetch` を
 * 叩く（`request()`）ので、`conversations.test.ts` / `memory.test.ts` と同じ形で
 * `globalThis.fetch` を差し替える。
 */
/**
 * **`./target.js` は `resolveTarget` だけ差し替える。** `forbiddenKindOf` と
 * `describeAuthFailure` は**本物を使う**（`token.test.ts` と同じ理由）。
 *
 * **`remote` は歯ごとに変える。** 遠隔のデーモンでも持ち主用の文言が出ること
 * を測るため（この経路には以前 `!target.remote` という場合分けが在り、遠隔
 * だけ案内が別物になっていた）。
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

const { accessListCommand, accessOwnerCommand } = await import('./access.js');

interface Sent {
  url: string;
  method: string;
}

let sent: Sent[] = [];
let originalFetch: typeof fetch;
let replies: { status: number; body: unknown }[] = [];

function stubFetch(): void {
  globalThis.fetch = ((input: unknown, init?: RequestInit) => {
    const request = input as { url?: string; method?: string };
    const url = typeof input === 'string' ? input : (request.url ?? String(input));
    sent.push({ url, method: init?.method ?? request.method ?? 'GET' });
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
  /**
   * #214: `AccountView.createdAt` は元から型に在り、応答にも元から入っている
   * （`GET /access` の `accountWithIdentitiesSchema`）。ここが出していなかった
   * だけである。
   */
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
    // 既存の欄（最終ログイン・許可した日時）は消えていない。
    expect(text).toContain('最終ログイン: 2026-08-20T09:00:00.000Z');
    expect(text).toContain('許可した日時: 2026-08-01T00:05:00.000Z');
  });

  /**
   * **誰が許可したか（#1398 c7-3）。** 3分岐（`'operator'`・アカウントの id・
   * `null`）を1回で確かめる。文言は Web UI の `describeGrantedBy()` と同じ。
   */
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
    // id は名前へ解決せず、そのまま出す。
    expect(text).toContain('許可した日時: 2026-09-03T00:00:00.000Z（acc-by-operator）');
    expect(text).toContain('許可した日時: 2026-09-03T00:00:00.000Z（不明）');
  });

  it('まだ誰もいなければ、そう言う', async () => {
    const read = captureStdout();
    replies.push({ status: 200, body: { accounts: [] } });

    await accessListCommand();

    expect(read()).toContain('まだ誰もログインしていません');
  });

  /**
   * **宣言済みかどうかの印（issue #1198）。** `granted` とは独立の印なので、
   * 未宣言と宣言済みの両方を1回で確かめる——片方だけだと「常に出る／常に
   * 出ない」の両方の壊れ方を見逃す。
   */
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
    // 未宣言の行には `[owner]` が付かない（`plain@example.com` の直後に `[owner]`
    // が来ないことで確かめる）。
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

  /**
   * **未許可のアカウントを宣言しようとすると 409。** サーバの文言をそのまま
   * 人間へ届ける（`accessGrantCommand` の 409 と同じ作り）。
   */
  it('未許可のアカウントは 409 —— サーバの文言をそのまま出す', async () => {
    replies.push({
      status: 409,
      body: { error: 'このアカウントはまだ許可されていない（先に access grant が要る）' },
    });

    await expect(accessOwnerCommand('acc-1')).rejects.toThrow(
      /このアカウントはまだ許可されていない/,
    );
  });

  it('該当するアカウントが無ければ 404', async () => {
    replies.push({ status: 404, body: { error: 'not found' } });

    await expect(accessOwnerCommand('missing')).rejects.toThrow(/該当するアカウントがありません/);
  });

  /**
   * **`requireOperator`（非伝播）。** 許可されたアカウントのトークンで叩くと
   * 403（`not_operator` の本文）になる——`grant` / `revoke` と同じ分岐を通る
   * ことを確かめる（`accessOwnerCommand` は専用の request 実装を持たない）。
   */
  it('403（実行環境の持ち主でない）なら、器の中で実行しろと案内する', async () => {
    replies.push({
      status: 403,
      body: { error: '実行環境の持ち主だけが操作できる' },
    });

    await expect(accessOwnerCommand('acc-1')).rejects.toThrow(/docker compose exec/);
  });
});

/**
 * 403 の案内を、**サーバが返した本文で分ける**。
 *
 * **ここには以前 `&& !target.remote` という場合分けが在った。** 遠隔のデーモンへ
 * 繋いでいるときは専用の文言に入らず、汎用の「`alteroid access grant <アカウント
 * id>` を実行してください」に落ちていた——**`alteroid access grant` を打った本人に
 * `alteroid access grant` を勧める**形である。下の「遠隔でも」の歯が、その場合分けが
 * 戻らないことを押さえている。
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
    // **鳴ってはいけない側。** これが `!target.remote` の場合分けが返ってきた印である。
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
