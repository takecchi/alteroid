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

const { accessListCommand } = await import('./access.js');

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
            granted: true,
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

  it('まだ誰もいなければ、そう言う', async () => {
    const read = captureStdout();
    replies.push({ status: 200, body: { accounts: [] } });

    await accessListCommand();

    expect(read()).toContain('まだ誰もログインしていません');
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
