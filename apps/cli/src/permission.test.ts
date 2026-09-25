import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { captureStdout } from './test-support.js';

/**
 * `alteroid permission` — 人間が承認した Bash 許可（Issue #863）を CLI から
 * 一覧・取り消しできること。`request_permission` / `answerApproval` 自体の
 * 意味論（何が記録されるか）は `packages/core/src/clone.test.ts` /
 * `packages/core/src/tools.test.ts` が持つ——ここで固定したいのは、CLI が
 * `GET /permission-grants` / `POST /permission-grants/:id/revoke`
 * （`apps/daemon/src/app.ts`）と交わす契約と、規則の広さの表示（判定は
 * `describePermissionRuleBreadth`。`packages/core/src/permission-rule.test.ts`
 * が意味論を固定しているので、ここでは「表示に出ること」だけを見る）。
 *
 * **`fetch` を差し替える。** `permission.ts` は `createClient`（hono/client）
 * 経由で `fetch` を叩くので、`inbox.test.ts` の `alteroid inbox show` と同じ
 * 形（globalThis.fetch のスタブ）で足りる——hono/client は素の `fetch` を
 * 内部で呼ぶだけである。
 */
vi.mock('./target.js', async (importOriginal) => ({
  ...(await importOriginal<typeof import('./target.js')>()),
  resolveTarget: () =>
    Promise.resolve({
      baseUrl: 'http://127.0.0.1:4517',
      headers: {},
      note: null,
      remote: false,
    }),
}));

const { permissionListCommand, permissionRevokeCommand } = await import('./permission.js');

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

function grant(overrides: Partial<Record<string, unknown>> = {}): Record<string, unknown> {
  return {
    id: 'grant-1',
    rule: 'Bash(gh release edit --repo x --draft=false:*)',
    allows: ['gh release edit --repo x --draft=false <tag>'],
    denies: ['gh release delete --repo x <tag>'],
    approvalId: 'approval-1',
    answer: '許可します',
    grantedAt: '2026-09-20T00:00:00.000Z',
    route: { principalKind: 'account', accountId: 'acc-1' },
    ...overrides,
  };
}

describe('alteroid permission list', () => {
  it('GET /permission-grants を叩く', async () => {
    replies.push({ status: 200, body: { grants: [] } });
    captureStdout();

    await permissionListCommand();

    expect(sent).toHaveLength(1);
    expect(sent[0]?.url).toBe('http://127.0.0.1:4517/permission-grants');
    expect(sent[0]?.method).toBe('GET');
  });

  it('既定では取り消し済みを除く', async () => {
    replies.push({
      status: 200,
      body: {
        grants: [
          grant({ id: 'active-1' }),
          grant({ id: 'revoked-1', revokedAt: '2026-09-21T00:00:00.000Z' }),
        ],
      },
    });
    const read = captureStdout();

    await permissionListCommand();

    const text = read();
    expect(text).toContain('active-1');
    expect(text).not.toContain('revoked-1');
    expect(text).toContain('計 2 件（有効 1 件・取り消し済み 1 件）');
    expect(text).toContain('--all で取り消し済みも見られます');
  });

  it('--all を渡すと取り消し済みも出す', async () => {
    replies.push({
      status: 200,
      body: {
        grants: [
          grant({ id: 'active-1' }),
          grant({ id: 'revoked-1', revokedAt: '2026-09-21T00:00:00.000Z' }),
        ],
      },
    });
    const read = captureStdout();

    await permissionListCommand({ all: true });

    const text = read();
    expect(text).toContain('active-1');
    expect(text).toContain('revoked-1');
    expect(text).toContain('[取り消し済み]');
    expect(text).toContain('取り消し: 2026-09-21T00:00:00.000Z');
    // --all のときは「--all で見られます」の案内を重ねて出さない。
    expect(text).not.toContain('--all で取り消し済みも見られます');
  });

  it('有効な許可が無ければそう言う', async () => {
    replies.push({ status: 200, body: { grants: [] } });
    const read = captureStdout();

    await permissionListCommand();

    expect(read()).toContain('有効な許可はありません');
  });

  it('誰がいつ承認したか（route.accountId と grantedAt）を出す', async () => {
    replies.push({ status: 200, body: { grants: [grant()] } });
    const read = captureStdout();

    await permissionListCommand();

    const text = read();
    expect(text).toContain('承認: 2026-09-20T00:00:00.000Z（acc-1・"許可します"）');
  });

  it('最終使用が無ければ「まだ使われていません」と出す', async () => {
    replies.push({ status: 200, body: { grants: [grant()] } });
    const read = captureStdout();

    await permissionListCommand();

    expect(read()).toContain('（まだ使われていません）');
  });

  it('最終使用があればその時刻を出す', async () => {
    replies.push({
      status: 200,
      body: { grants: [grant({ lastUsedAt: '2026-09-22T00:00:00.000Z' })] },
    });
    const read = captureStdout();

    await permissionListCommand();

    expect(read()).toContain('最終使用: 2026-09-22T00:00:00.000Z');
  });

  /**
   * **規則の広さの段階表示**（#193 から畳んだ #863 の残項目）。判定そのもの
   * （語数の境界）は `permission-rule.test.ts` が固定しているので、ここでは
   * 「一覧に広さが出ること」と「狭い規則と広い規則が違う表示になること」
   * だけを見る。
   */
  it('規則の広さを段階で出す——狭い（3語）と広い（1語）は違う表示になる', async () => {
    replies.push({
      status: 200,
      body: {
        grants: [
          grant({ id: 'narrow-1', rule: 'Bash(gh pr merge:*)' }),
          grant({ id: 'broad-1', rule: 'Bash(gh:*)' }),
          grant({ id: 'exact-1', rule: 'Bash(gh pr view)' }),
        ],
      },
    });
    const read = captureStdout();

    await permissionListCommand();

    const text = read();
    expect(text).toContain('前方一致・狭い（固定 3 語まで一致）');
    expect(text).toContain('前方一致・広い（固定 1 語のみ');
    expect(text).toContain('完全一致（最も狭い');
  });

  it('壊れた規則は「不正」と出す（黙って広いに倒さない）', async () => {
    replies.push({
      status: 200,
      body: { grants: [grant({ rule: 'not a valid rule' })] },
    });
    const read = captureStdout();

    await permissionListCommand();

    expect(read()).toContain('規則が不正');
  });

  it('403 は stdout へ書いて正常終了する（読み取り専用の作法）', async () => {
    replies.push({
      status: 403,
      body: { error: 'このアカウントには alteroid を使う許可が無い' },
    });
    const read = captureStdout();

    await permissionListCommand();

    expect(read()).toContain('access grant');
  });
});

describe('alteroid permission revoke', () => {
  it('POST /permission-grants/:id/revoke を叩く', async () => {
    replies.push({ status: 200, body: { ok: true } });
    const read = captureStdout();

    await permissionRevokeCommand('grant-1');

    expect(sent).toEqual([
      { url: 'http://127.0.0.1:4517/permission-grants/grant-1/revoke', method: 'POST' },
    ]);
    expect(read()).toContain('許可を取り消しました: grant-1');
  });

  it('404 は例外を投げる（消えたかどうかを終了コードで区別する）', async () => {
    replies.push({ status: 404, body: { error: 'not found' } });

    await expect(permissionRevokeCommand('missing')).rejects.toThrow(/該当する許可がありません/);
  });

  it('403 は例外を投げる', async () => {
    replies.push({
      status: 403,
      body: { error: 'このアカウントには alteroid を使う許可が無い' },
    });

    await expect(permissionRevokeCommand('grant-1')).rejects.toThrow(/access grant/);
  });
});
