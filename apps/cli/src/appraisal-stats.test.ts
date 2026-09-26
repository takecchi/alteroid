import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { captureStdout } from './test-support.js';

/**
 * Issue #1620: `GET /appraisal-stats`（評定の内訳。#1278 で足した）は HTTP API
 * にしか入口が無く、CLI から読む口が無かった（PRD「入口の等価性」違反）。
 *
 * `appraisal-stats.ts` はこの穴の CLI 側だけを埋める（Web 側は担当 C の領域）。
 * ここで固定したいのは3つ——(1) `alteroid appraisal-stats` が `program` に
 * 登録されていること (2) 応答を `describeAppraisalStats`（core）へそのまま渡し、
 * 中身（内訳・突き合わせ）を欠かさず表示すること (3) HTTP の失敗の扱いが
 * 既存の読み取り系（`usage.ts` / `dropped.ts` / `permission.ts` の
 * `permissionListCommand`）と同じ形（例外を投げず `stdout` へ書いて正常終了）
 * であること。
 *
 * **`fetch` を差し替える。** `appraisal-stats.ts` は `createClient`（hono/client）
 * 経由で `fetch` を叩くので、`permission.test.ts` / `interrupt.test.ts` と同じ
 * スタブで足りる。
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

const { appraisalStatsCommand } = await import('./appraisal-stats.js');
const target = await import('./target.js');
const { program } = await import('./index.js');

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
  vi.clearAllMocks();
});

/** `GET /appraisal-stats` の応答（`appraisalStatsResponseSchema`）を満たす最小の値。 */
function statsBody(overrides: Partial<Record<string, unknown>> = {}): Record<string, unknown> {
  return {
    journal: {
      commitments: { good: 3, bad: 1, unclear: 0, other: 0, total: 4 },
      jobs: { good: 2, bad: 0, unclear: 1, other: 0, total: 3 },
      byWorkKind: { commitments: [], jobs: [] },
    },
    jobCoverage: {
      byStatus: [{ status: 'done', total: 5, appraised: 3, unappraised: 2 }],
      terminalTotal: 5,
      terminalAppraised: 3,
      terminalUnappraised: 2,
      nonTerminalTotal: 1,
    },
    reconciliation: {
      commitments: { transitions: [], totalPairs: 0, matched: 0, mismatched: 0, undetermined: 0 },
      jobs: { transitions: [], totalPairs: 0, matched: 0, mismatched: 0, undetermined: 0 },
    },
    ...overrides,
  };
}

describe('alteroid appraisal-stats（サブコマンドの登録）', () => {
  it('program に appraisal-stats が登録されている', () => {
    const names = program.commands.map((command) => command.name());
    expect(names).toContain('appraisal-stats');
  });
});

describe('appraisalStatsCommand', () => {
  it('GET /appraisal-stats を叩く', async () => {
    replies.push({ status: 200, body: statsBody() });
    captureStdout();

    await appraisalStatsCommand();

    expect(sent).toHaveLength(1);
    expect(sent[0]?.url).toBe('http://127.0.0.1:4517/appraisal-stats');
    expect(sent[0]?.method).toBe('GET');
  });

  it('ログインしていなければ note をそのまま書き、appraisal-stats を叩かない', async () => {
    vi.mocked(target.resolveTarget).mockResolvedValueOnce({
      baseUrl: 'https://runner.example.com',
      headers: {},
      note: 'https://runner.example.com にログインしていません（alteroid login）',
      remote: true,
    });
    const read = captureStdout();

    await appraisalStatsCommand();

    expect(sent).toHaveLength(0);
    expect(read()).toBe('https://runner.example.com にログインしていません（alteroid login）\n');
  });

  /**
   * 応答の中身（評定の内訳・仕事の種類ごとの内訳・委譲の評定の有無・
   * (b)/(c) の食い違い）を欠かさず表示すること。`describeAppraisalStats`
   * （core）の見出しと数値をそのまま経由しているかを、代表的な数値で見る。
   */
  it('journal / jobCoverage / reconciliation の中身をそれぞれ表示する', async () => {
    replies.push({ status: 200, body: statsBody() });
    const read = captureStdout();

    await appraisalStatsCommand();

    const text = read();
    // journal（引き受けた仕事・委譲は別の軸——混ぜて読まない注意ごと出る）
    expect(text).toContain('評定行 4 件');
    expect(text).toContain('評定行 3 件');
    expect(text).toContain('混ぜて比べないこと');
    // jobCoverage（終端した委譲の評定の有無）
    expect(text).toContain('done: 終端 5 件（評定あり 3 / 評定なし 2）');
    expect(text).toContain('running/waiting_human で終端していない委譲が 1 件');
    // reconciliation（(b) 人間 と (c) クローンの食い違い）
    expect(text).toContain('(b) 人間 と (c) クローンの食い違い');
    expect(text).toContain('判定できない');
  });

  it('404 は「読めませんでした」を書いて正常終了する（読み取り専用の作法）', async () => {
    replies.push({ status: 404, body: {} });
    const read = captureStdout();

    await appraisalStatsCommand();

    expect(read()).toContain('評定の内訳を読めませんでした（HTTP 404）');
  });

  it('500 も例外を投げず、stdout へ書いて正常終了する（usage.ts / dropped.ts と同じ作法）', async () => {
    replies.push({ status: 500, body: { error: '内部エラー' } });
    const read = captureStdout();

    await expect(appraisalStatsCommand()).resolves.toBeUndefined();
    expect(read()).toContain('評定の内訳を読めませんでした（HTTP 500）');
  });

  it('401 は describeAuthFailure の文言を書いて正常終了する（permissionListCommand と同じ形）', async () => {
    replies.push({ status: 401, body: {} });
    const read = captureStdout();

    await appraisalStatsCommand();

    expect(read()).toBe(
      '認証されませんでした。デーモンを起動し直してください（alteroid daemon stop && alteroid chat）\n',
    );
  });

  it('403 は describeAuthFailure の文言（access grant の案内）を書いて正常終了する', async () => {
    replies.push({ status: 403, body: {} });
    const read = captureStdout();

    await appraisalStatsCommand();

    expect(read()).toContain('access grant');
  });
});
