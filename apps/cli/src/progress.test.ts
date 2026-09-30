import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { describeProgress } from '@alteroid/core';

import { captureStdout } from './test-support.js';

/**
 * Issue #2241 の 3: `alteroid progress`。`GET /progress` の応答を人間が読める形で出す。
 * 固定したいのは (1) 登録 (2) 出力の中身 (3) null を 0 と書かない・率を出さない
 * (4) forecast の3状態 (5) 400 は daemon の文言で失敗する。
 */
vi.mock('./target.js', async () => {
  const actual = await vi.importActual<typeof import('./target.js')>('./target.js');
  return {
    ...actual,
    resolveTarget: vi.fn(() =>
      Promise.resolve({ baseUrl: 'http://127.0.0.1:4517', headers: {}, note: null, remote: false }),
    ),
  };
});

const { progressCommand } = await import('./progress.js');
const { program } = await import('./index.js');

let sent: string[] = [];
let originalFetch: typeof fetch;
let replies: { status: number; body: unknown }[] = [];

beforeEach(() => {
  originalFetch = globalThis.fetch;
  sent = [];
  replies = [];
  globalThis.fetch = ((input: unknown) => {
    const request = input as { url?: string };
    sent.push(typeof input === 'string' ? input : (request.url ?? String(input)));
    const reply = replies.shift() ?? { status: 200, body: {} };
    return Promise.resolve(
      new Response(JSON.stringify(reply.body), {
        status: reply.status,
        headers: { 'content-type': 'application/json' },
      }),
    );
  }) as typeof fetch;
});

afterEach(() => {
  globalThis.fetch = originalFetch;
  vi.restoreAllMocks();
  vi.clearAllMocks();
});

const basis = {
  open: 12,
  closedInWindow: 6,
  openedInWindow: 4,
  windowHours: 168,
  method: 'open / (closedInWindow / windowHours)',
  unreadable: 0,
  minClosedInWindow: 3,
};

function body(overrides: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    observedAt: '2026-09-30T12:00:00.000Z',
    window: { hours: 168, from: '2026-09-23T12:00:00.000Z', to: '2026-09-30T12:00:00.000Z' },
    backlog: {
      total: 12,
      byOrigin: { human: 7, manager: 3, external: 1, self: 1 },
      age: {
        oldestAt: '2026-09-20T12:00:00.000Z',
        medianHours: 30.25,
        buckets: { under1h: 1, under24h: 3, under7d: 5, over7d: 3 },
      },
      byState: { untouched: 2, responded: 5, delegated: 3, notApplicable: 5 },
      completeness: { unreadable: 0, trimmedClosed: 0 },
    },
    inProgress: {
      running: 2,
      awaitingHuman: 1,
      lost: 0,
      lastReport: {
        oldestAt: '2026-09-30T09:00:00.000Z',
        newestAt: '2026-09-30T11:30:00.000Z',
        withoutReport: 1,
      },
    },
    throughput: {
      commitmentsOpened: 4,
      commitmentsClosed: 6,
      delegationsEnded: { count: 9, basis: 'updatedAt' },
    },
    forecast: {
      state: 'estimated',
      hoursToDrain: 336,
      basis,
      notice: '推定であり約束ではない。窓の中の流入は数えていない',
    },
    github: { state: 'not_observed', reason: 'デーモンは GitHub を見に行かない' },
    ...overrides,
  };
}

describe('alteroid progress の登録', () => {
  it('program に progress と --window-hours が在る', () => {
    const command = program.commands.find((c) => c.name() === 'progress');
    expect(command).toBeDefined();
    expect(command?.options.map((o) => o.long)).toContain('--window-hours');
  });
});

describe('progressCommand', () => {
  it('GET /progress を叩き、windowHours を渡す', async () => {
    replies.push({ status: 200, body: body() });
    captureStdout();
    await progressCommand({ windowHours: '24' });
    expect(sent).toHaveLength(1);
    expect(sent[0]).toBe('http://127.0.0.1:4517/progress?windowHours=24');
  });

  it('指定が無ければ windowHours を付けない', async () => {
    replies.push({ status: 200, body: body() });
    captureStdout();
    await progressCommand();
    expect(sent[0]).toBe('http://127.0.0.1:4517/progress');
  });

  it('積み上がり・実施中・消化・見込み・GitHub・観測時刻を出す', async () => {
    replies.push({ status: 200, body: body() });
    const read = captureStdout();
    await progressCommand();
    const text = read();
    expect(text).toContain('観測時刻: 2026-09-30T12:00:00.000Z');
    expect(text).toContain('積み上がり（台帳の未了）: 12 件');
    expect(text).toContain('人間 7 / マネージャー 3 / 外部 1 / 自発 1');
    expect(text).toContain('中央値 30.3時間');
    expect(text).toContain('1時間未満 1 / 24時間未満 3 / 7日未満 5 / 7日以上 3');
    expect(text).toContain('未着手 2 / 返答済み・未クローズ 5 / 委譲あり 3');
    expect(text).toContain('実行中 2 / 人間待ち 1 / 行方不明 0');
    expect(text).toContain('報告無し 1 件');
    expect(text).toContain('受けた 4 件 / 閉じた 6 件');
    expect(text).toContain('basis: updatedAt');
    expect(text).toContain('あと約 336時間');
    expect(text).toContain('推定であり約束ではない');
    expect(text).toContain('観測していない（0 件ではない）');
    expect(text).not.toContain('%');
    expect(text).not.toContain('数が欠けうる');
  });

  it('completeness が 0 でなければ「数が欠けうる」を出す', async () => {
    const base = body() as { backlog: Record<string, unknown> };
    replies.push({
      status: 200,
      body: body({
        backlog: { ...base.backlog, completeness: { unreadable: 2, trimmedClosed: 0 } },
      }),
    });
    const read = captureStdout();
    await progressCommand();
    expect(read()).toContain('数が欠けうる（読めなかった行 2 件');
  });

  it('欄 unreadableJobs の無い古いデーモンの応答でも、「undefined」を書かず、読めない委譲について何も言わない（#2382）', async () => {
    // `body()` の completeness は、もともと unreadableJobs の無い形（古い応答）。
    replies.push({ status: 200, body: body() });
    const read = captureStdout();
    await progressCommand();
    const text = read();
    expect(text).toContain('積み上がり');
    expect(text).not.toContain('undefined');
    expect(text).not.toContain('読めない委譲');
  });

  it('対照: unreadableJobs が 0 なら何も言わず、1 以上なら言う（#2382）', async () => {
    const base = body() as { backlog: Record<string, unknown> };
    const withCount = (unreadableJobs: number): Record<string, unknown> =>
      body({
        backlog: {
          ...base.backlog,
          completeness: { unreadable: 0, trimmedClosed: 0, unreadableJobs },
        },
      });
    replies.push({ status: 200, body: withCount(0) });
    const readZero = captureStdout();
    await progressCommand();
    expect(readZero()).not.toContain('読めない委譲');

    replies.push({ status: 200, body: withCount(2) });
    const readTwo = captureStdout();
    await progressCommand();
    expect(readTwo()).toContain('※ 読めない委譲の行が 2 件ある');
  });

  it('400 は daemon の文言で失敗する（stdout には書かない）', async () => {
    replies.push({ status: 400, body: { error: 'windowHours は有限の正数（時間）で指定する' } });
    const read = captureStdout();
    await expect(progressCommand({ windowHours: 'abc' })).rejects.toThrow(
      'windowHours は有限の正数（時間）で指定する',
    );
    expect(read()).toBe('');
  });

  it('401 は describeAuthFailure の文言を書いて戻る', async () => {
    replies.push({ status: 401, body: {} });
    const read = captureStdout();
    await progressCommand();
    expect(read()).toContain('認証されませんでした');
  });
});

describe('describeProgress', () => {
  it('null は「—」で、0 と書かない', () => {
    const base = body() as {
      backlog: { age: Record<string, unknown> } & Record<string, unknown>;
      inProgress: Record<string, unknown>;
    };
    const text = describeProgress({
      ...body(),
      backlog: {
        ...base.backlog,
        total: 0,
        age: { ...base.backlog.age, oldestAt: null, medianHours: null },
      },
      inProgress: {
        running: 0,
        awaitingHuman: 0,
        lost: 0,
        lastReport: { oldestAt: null, newestAt: null, withoutReport: 0 },
      },
    } as never);
    expect(text).toContain('最古 — / 中央値 —');
    expect(text).toContain('最古 — / 最新 — / 報告無し 0 件');
    expect(text).not.toContain('中央値 0');
  });

  it('not_converging は状態を言い、時間を作らない', () => {
    const text = describeProgress(
      body({
        forecast: { state: 'not_converging', basis: { ...basis, openedInWindow: 9 } },
      }) as never,
    );
    expect(text).toContain('not_converging');
    expect(text).not.toContain('あと約');
    expect(text).not.toContain('時間で未了が空');
  });

  it('unavailable は理由をそのまま言い、時間を作らない', () => {
    const text = describeProgress(
      body({
        forecast: {
          state: 'unavailable',
          reason: 'closed_too_few',
          basis: { ...basis, closedInWindow: 1 },
        },
      }) as never,
    );
    expect(text).toContain('unavailable（closed_too_few）');
    expect(text).not.toContain('あと約');
  });
});
