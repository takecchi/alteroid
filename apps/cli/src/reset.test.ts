import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { captureStdout } from './test-support.js';

/**
 * `alteroid reset` — ワークスペースのリセット（`POST /reset`）。
 *
 * **`--yes` を渡して対話プロンプトを飛ばす。** `confirm()` は `readline` を
 * 使うので、ここでは全テストとも確認ダイアログの外側（`options.yes: true`）
 * から始める——対話そのものは別の関心事である。
 *
 * `credential.test.ts` と同じ作法——`fetch` を `method + path` の応答表で
 * 差し替え、`./target.js` は `resolveTarget` だけ差し替えて `forbiddenKindOf` /
 * `describeAuthFailure` は本物を使う。
 */
vi.mock('./target.js', async (importOriginal) => ({
  ...(await importOriginal<typeof import('./target.js')>()),
  resolveTarget: () =>
    Promise.resolve({ baseUrl: 'http://127.0.0.1:4517', headers: {}, note: null, remote: false }),
}));

const { resetCommand } = await import('./reset.js');

interface Reply {
  status: number;
  body: unknown;
}

let reply: Reply;
let sent: { url: string; method: string; body: unknown }[];
let originalFetch: typeof fetch;

function stubFetch(): void {
  globalThis.fetch = ((input: unknown, init?: RequestInit) => {
    const request = input as { url?: string; method?: string };
    const url = typeof input === 'string' ? input : (request.url ?? String(input));
    const method = init?.method ?? request.method ?? 'GET';
    const body =
      typeof init?.body === 'string' && init.body.length > 0
        ? (JSON.parse(init.body) as unknown)
        : undefined;
    sent.push({ url, method, body });
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
  reply = { status: 200, body: { cleared: {} } };
  sent = [];
  stubFetch();
});

afterEach(() => {
  globalThis.fetch = originalFetch;
  vi.restoreAllMocks();
});

describe('alteroid reset --yes', () => {
  it('confirm: true を伴って POST /reset を叩き、消した件数を報告する', async () => {
    reply = {
      status: 200,
      body: {
        cleared: {
          memory: 3,
          journal: 1,
          jobs: 0,
          approvals: 0,
          schedules: 0,
          schedulePhases: 0,
          inbox: 0,
          commitments: 0,
          archive: 0,
          sessions: 0,
          profile: 0,
          usageDaily: 0,
          usageBaseline: 0,
          usageLedger: 0,
          usageTurns: 0,
        },
      },
    };
    const read = captureStdout();

    await resetCommand({ yes: true });

    expect(sent).toEqual([
      expect.objectContaining({
        url: 'http://127.0.0.1:4517/reset',
        method: 'POST',
        body: { confirm: true },
      }),
    ]);
    const text = read();
    expect(text).toContain('リセットしました');
    expect(text).toContain('記憶: 3');
    expect(text).toContain('日誌: 1');
    // 触れていないものを明示する。
    expect(text).toContain('認証トークンのプール・マネージャーへ降ろす環境変数・Web UI のログイン');
  });

  /**
   * **issue #1198 でこの経路の門が `requireOperator` から `requireOwner` へ
   * 変わった。** 未宣言（`access grant` は済んでいるが `access owner` を
   * まだ打っていない）で拒まれたときの案内は、`alteroid access owner <id>` を
   * 打つ形にする（`credential.test.ts` の同種の歯と同じ理由）。
   */
  it('403（未宣言 owner）なら、access owner を打てと言う', async () => {
    reply = {
      status: 403,
      // **デーモンが実際に返す文言そのもの**（`requireOwner` の逐語。
      // `grep -Fn -- '実行環境の持ち主として宣言されたアカウントだけが操作できる' apps/cli/src/target.ts`）。
      body: { error: '実行環境の持ち主として宣言されたアカウントだけが操作できる' },
    };

    const message = await resetCommand({ yes: true }).catch((error: unknown) =>
      error instanceof Error ? error.message : String(error),
    );

    expect(message).toContain('alteroid access list');
    expect(message).toContain('alteroid access owner <アカウント id>');
    expect(message).not.toContain('access grant <アカウント id>');
  });

  it('403（未 grant）なら、access grant を打てと言う', async () => {
    reply = {
      status: 403,
      body: { error: 'このアカウントには alteroid を使う許可が無い' },
    };

    const message = await resetCommand({ yes: true }).catch((error: unknown) =>
      error instanceof Error ? error.message : String(error),
    );

    expect(message).toContain('alteroid access grant <アカウント id>');
  });

  /**
   * **`requireOwner` はこの経路の門であって `requireOperator` ではない**
   * （`reset.ts` の doc）。⟹ `not_operator` の本文は実際には来ないはずだが、
   * `ForbiddenKind` はこの値を持てる型なので、来た場合に当てずっぽうの案内
   * （旧 `docker compose exec …`）を出さないことを固定する。
   */
  it('403（not_operator の本文。この経路では実際には来ないはず）は、案内を出さない', async () => {
    reply = {
      status: 403,
      body: { error: '実行環境の持ち主だけが操作できる' },
    };

    const message = await resetCommand({ yes: true }).catch((error: unknown) =>
      error instanceof Error ? error.message : String(error),
    );

    expect(message).toContain('理由を判別できなかった');
    expect(message).not.toContain('docker compose exec');
    expect(message).not.toContain('access grant');
    expect(message).not.toContain('access owner');
  });
});
