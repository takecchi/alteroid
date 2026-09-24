import type {
  query as sdkQuery,
  ModelUsage,
  Options,
  Query,
  SDKMessage,
} from '@anthropic-ai/claude-agent-sdk';
import { beforeEach, describe, expect, it, vi } from 'vitest';

import { makeTempDirSync } from '../../../vitest.tmpdir.js';

import { createManagerPool } from './manager.js';
import { createLocalRunner } from './runner-local.js';
import { createRunnerRegistry, type RunnerEvent } from './runner-protocol.js';
import { createRunnerHost, type RunnerHost } from './runner.js';
import { createMemoryStores } from './testing.js';
import { summarizeUsage } from './usage.js';

/**
 * **`result` を出さずに終わった委譲の消費が、台帳から丸ごと落ちないこと。**
 *
 * 台帳へ入るのは `result.modelUsage` だけなので、器の入れ替え・`manager_stop`・
 * クラッシュで畳まれたセッションは1行も残さない。実測では30分走って PR をマージ
 * まで運んだ委譲が消えており、しかも一覧にも現れないので**欠けていること自体が
 * 見えなかった**。ここで固定するのは「畳む直前に累積を1回読む」ことと、その
 * 読み取りが**失敗しても畳む経路を縛らない**ことである。
 */

/** SDK の `ModelUsage`（`costUSD` の綴りが他と違うので、テスト側でも本物の型で書く）。 */
function modelUsage(costUsd: number, tokens = 100): ModelUsage {
  return {
    inputTokens: tokens,
    outputTokens: tokens,
    cacheReadInputTokens: 0,
    cacheCreationInputTokens: 0,
    webSearchRequests: 0,
    costUSD: costUsd,
    contextWindow: 200_000,
    maxOutputTokens: 64_000,
  };
}

/** control channel の `get_usage` の応答（`SDKControlGetUsageResponse` の要る所だけ）。 */
function getUsageResponse(models: Record<string, ModelUsage>): unknown {
  return {
    session: {
      total_cost_usd: 0,
      total_api_duration_ms: 0,
      total_duration_ms: 0,
      total_lines_added: 0,
      total_lines_removed: 0,
      model_usage: models,
    },
    subscription_type: 'max',
    rate_limits_available: false,
    rate_limits: null,
  };
}

interface FakeSession {
  /** 1ターンを成功で終える（`result.modelUsage` に累積を載せる）。 */
  report(text: string, models?: Record<string, ModelUsage>, extra?: Record<string, unknown>): void;
  /** ストリームが終わる（`result` は出ないまま閉じる）。 */
  end(): void;
  /** ストリームが落ちる（`result` は出ない）。 */
  crash(reason: string): void;
}

interface FakeSdkOptions {
  /**
   * control channel の `get_usage`。
   *
   * **省略すると口そのものが無いセッションになる。** SDK が改名・削除した世界を
   * そのまま再現するためで、既存のテストの偽 `query` も同じ状態である。
   */
  usage?: () => Promise<unknown>;
}

function fakeSdk(options: FakeSdkOptions = {}): {
  fn: typeof sdkQuery;
  sessions: FakeSession[];
  usageCalls: () => number;
  /**
   * 起きた順（`'usage'` = 累積を読みに来た / `'close'` = セッションを閉じた）。
   *
   * **順序そのものが保証である。** 閉じた後の control channel からは何も取れない
   * ので、「読んだ」だけでは足りず「閉じるより先に読んだ」でなければならない。
   */
  order: string[];
} {
  const sessions: FakeSession[] = [];
  const order: string[] = [];
  let usageCalls = 0;

  const fn = ((params: { prompt: AsyncIterable<unknown>; options: Options }) => {
    const buffered: (SDKMessage | Error | null)[] = [];
    let waiting: ((next: SDKMessage | Error | null) => void) | null = null;

    const push = (next: SDKMessage | Error | null): void => {
      if (waiting) {
        const resolve = waiting;
        waiting = null;
        resolve(next);
        return;
      }
      buffered.push(next);
    };

    async function* generate(): AsyncGenerator<SDKMessage, void> {
      yield {
        type: 'system',
        subtype: 'init',
        session_id: 'sess-1',
        uuid: 'uuid-init',
      } as unknown as SDKMessage;

      // クローンからの入力は読み捨てる（ここで見たいのは畳むときの挙動だけ）。
      // **読み手は要る** — 誰も読まないと runner 側の `#inputStream` が起きない。
      void (async () => {
        const reader = params.prompt[Symbol.asyncIterator]();
        for (;;) {
          const next = await reader.next();
          if (next.done === true) return;
        }
      })();

      for (;;) {
        const next =
          buffered.length > 0
            ? (buffered.shift() as SDKMessage | Error | null)
            : await new Promise<SDKMessage | Error | null>((resolve) => {
                waiting = resolve;
              });
        if (next === null) return;
        if (next instanceof Error) throw next;
        yield next;
      }
    }

    sessions.push({
      report(text, models, extra) {
        push({
          type: 'result',
          subtype: 'success',
          result: text,
          session_id: 'sess-1',
          uuid: 'uuid-result',
          ...(models === undefined ? {} : { modelUsage: models }),
          ...extra,
        } as unknown as SDKMessage);
      },
      end() {
        push(null);
      },
      crash(reason) {
        push(new Error(reason));
      },
    });

    return Object.assign(generate(), {
      close: () => {
        order.push('close');
        push(null);
      },
      interrupt: async () => undefined,
      ...(options.usage === undefined
        ? {}
        : {
            usage_EXPERIMENTAL_MAY_CHANGE_DO_NOT_RELY_ON_THIS_API_YET: () => {
              usageCalls += 1;
              order.push('usage');
              return options.usage!();
            },
          }),
    }) as unknown as Query;
  }) as unknown as typeof sdkQuery;

  return { fn, sessions, usageCalls: () => usageCalls, order };
}

let dir: string;

beforeEach(() => {
  dir = makeTempDirSync('alteroid-usage-flush-');
});

function hostWith(fake: { fn: typeof sdkQuery }): { host: RunnerHost; events: RunnerEvent[] } {
  const events: RunnerEvent[] = [];
  const host = createRunnerHost({
    runnerId: 'runner-flush',
    workspacePath: dir,
    emit: (event) => events.push(event),
    queryFn: fake.fn,
    env: { PATH: process.env.PATH ?? '' },
  });
  return { host, events };
}

function usageEvents(events: RunnerEvent[]): Extract<RunnerEvent, { type: 'usage' }>[] {
  return events.filter((event): event is Extract<RunnerEvent, { type: 'usage' }> => {
    return event.type === 'usage';
  });
}

describe('畳む直前に累積を1回読む', () => {
  it('器の入れ替えで畳まれても、result を1度も出していない委譲の累積が降りる', async () => {
    const fake = fakeSdk({
      usage: async () => getUsageResponse({ 'claude-opus-4-8': modelUsage(0.93) }),
    });
    const { host, events } = hostWith(fake);
    await host.start({ managerId: 'mgr-1', request: '30分走ってマージまで運ぶ', cwd: dir });

    // **`result` を1つも出さないまま器が畳む**（実測で消えた形そのもの）。
    await host.shutdown();

    const usage = usageEvents(events);
    expect(usage).toHaveLength(1);
    expect(usage[0]?.managerId).toBe('mgr-1');
    expect(usage[0]?.models['claude-opus-4-8']?.costUsd).toBe(0.93);
    // **ターンの境界ではないので、応答が返ったとは言わない**（欄を付けない。
    // `runner-protocol.ts` の `answered` の doc）。
    expect(usage[0] !== undefined && 'answered' in usage[0]).toBe(false);
    // **閉じるより先に読んでいること。** 閉じた後の control channel からは何も
    // 取れないので、順序が逆なら実機ではいつも空振りする（テストの偽物は答える）。
    expect(fake.order).toEqual(['usage', 'close']);
    // セッションは畳まれている（読み取りを挟んでも畳む経路は完走する）。
    expect(host.list()).toHaveLength(0);
  });

  it('セッションが落ちた経路（result なしで終了）でも降りる', async () => {
    const fake = fakeSdk({
      usage: async () => getUsageResponse({ 'claude-sonnet-5': modelUsage(0.12) }),
    });
    const { host, events } = hostWith(fake);
    await host.start({ managerId: 'mgr-2', request: 'clone して2分で死ぬ', cwd: dir });

    fake.sessions[0]?.crash('ProcessTransport closed');
    await vi.waitFor(() => expect(events.some((event) => event.type === 'closed')).toBe(true));

    const usage = usageEvents(events);
    expect(usage).toHaveLength(1);
    expect(usage[0]?.models['claude-sonnet-5']?.costUsd).toBe(0.12);
    expect(events.findIndex((event) => event.type === 'usage')).toBeLessThan(
      events.findIndex((event) => event.type === 'closed'),
    );
  });

  it('全部ゼロなら降ろさない（「記録が無い」が「$0.00 使った」に化けない）', async () => {
    const fake = fakeSdk({
      usage: async () => getUsageResponse({ 'claude-opus-4-8': modelUsage(0, 0) }),
    });
    const { host, events } = hostWith(fake);
    await host.start({ managerId: 'mgr-3', request: '起動直後に死ぬ', cwd: dir });

    await host.shutdown();

    // 呼びには行っている（＝読めなかったのではなく、読めた値がゼロだった）。
    expect(fake.usageCalls()).toBe(1);
    expect(usageEvents(events)).toHaveLength(0);
    expect(host.list()).toHaveLength(0);
  });

  it('口が無い SDK でも畳める（実験的な口の改名・削除で経路が落ちない）', async () => {
    const fake = fakeSdk();
    const { host, events } = hostWith(fake);
    await host.start({ managerId: 'mgr-4', request: '口が無い世界', cwd: dir });

    await host.shutdown();

    expect(usageEvents(events)).toHaveLength(0);
    expect(fake.order).toEqual(['close']);
    expect(host.list()).toHaveLength(0);
  });

  it('読み取りが投げても畳める（ターン中の control 要求は実測で失敗する）', async () => {
    const fake = fakeSdk({
      usage: async () => {
        throw new Error('ProcessTransport is not ready for writing');
      },
    });
    const { host, events } = hostWith(fake);
    await host.start({ managerId: 'mgr-5', request: 'ターンを回している最中', cwd: dir });

    await host.shutdown();

    expect(fake.usageCalls()).toBe(1);
    expect(usageEvents(events)).toHaveLength(0);
    expect(host.list()).toHaveLength(0);
  });

  it('応答が返ってこなくても締め切りで諦めて畳む（畳む経路を観測に縛らない）', async () => {
    vi.useFakeTimers();
    try {
      const fake = fakeSdk({ usage: () => new Promise<unknown>(() => undefined) });
      const { host, events } = hostWith(fake);
      await host.start({ managerId: 'mgr-6', request: '返事が返らない', cwd: dir });

      const shutdown = host.shutdown();
      // 締め切り（5秒）まで進めないと畳み終わらない＝待ちは本当に効いている。
      let settled = false;
      void shutdown.then(() => {
        settled = true;
      });
      await vi.advanceTimersByTimeAsync(1_000);
      expect(settled).toBe(false);

      await vi.advanceTimersByTimeAsync(5_000);
      await shutdown;

      expect(usageEvents(events)).toHaveLength(0);
      expect(host.list()).toHaveLength(0);
    } finally {
      vi.useRealTimers();
    }
  });
});

describe('台帳まで届く', () => {
  function poolWith(fake: { fn: typeof sdkQuery }) {
    const stores = createMemoryStores();
    const runner = createLocalRunner({
      runnerId: 'runner-flush',
      workspacePath: dir,
      queryFn: fake.fn,
      env: { PATH: process.env.PATH ?? '' },
    });
    const pool = createManagerPool({
      stores,
      post: () => undefined,
      runners: createRunnerRegistry([runner]),
    });
    return { pool, stores };
  }

  it('result を出さずに止められた委譲が台帳に載る', async () => {
    const fake = fakeSdk({
      usage: async () => getUsageResponse({ 'claude-opus-4-8': modelUsage(0.93) }),
    });
    const { pool, stores } = poolWith(fake);
    const started = await pool.start({ request: '止められる仕事', cwd: dir });

    await pool.abort(started.managerId, '人間が止めた');
    await vi.waitFor(async () => {
      expect((await stores.usage.aggregate({})).rows).toHaveLength(1);
    });

    const aggregate = await stores.usage.aggregate({});
    const row = aggregate.rows[0];
    expect(row?.managerId).toBe(started.managerId);
    expect(row?.layer).toBe('manager');
    expect(row?.site).toBe('session');
    expect(row?.totals.costUsd).toBe(0.93);
    await pool.stop();
  });

  it('result で記録済みの累積と重なっても二重計上しない', async () => {
    const cumulative = { 'claude-opus-4-8': modelUsage(0.93) };
    const fake = fakeSdk({ usage: async () => getUsageResponse(cumulative) });
    const { pool, stores } = poolWith(fake);
    const started = await pool.start({ request: '1ターン終えてから止められる', cwd: dir });

    // ターン終わりの `result` で同じ累積が台帳へ入る。
    fake.sessions[0]?.report('終わった', cumulative);
    await vi.waitFor(async () => {
      expect((await stores.usage.aggregate({})).rows).toHaveLength(1);
    });

    // そのうえで畳む。**累積なので増分は 0** — 行も合計も動かない。
    await pool.abort(started.managerId, '人間が止めた');
    await vi.waitFor(async () => {
      const jobs = await stores.jobs.listJobs();
      expect(jobs.find((job) => job.id === started.managerId)?.status).not.toBe('running');
    });

    const aggregate = await stores.usage.aggregate({});
    expect(aggregate.rows).toHaveLength(1);
    expect(summarizeUsage(aggregate.rows, aggregate.turnRows).total.costUsd).toBe(0.93);
    await pool.stop();
  });
});

/**
 * **`usage` の到着は「応答が返った」ではない（2026-09-24 の無限の往復）。**
 *
 * 枠に当たったターンは `subtype: 'success'` / `is_error: true` で返るので、
 * 台帳の問い（`isSuccessResult`）は通り、`usage` は降りる。受け手（`manager.ts`
 * の `case 'usage'`）がこれを成功と読むと、回し手が `recovered` →委譲を起こす→
 * また枠、を無限に往復する。**応答として返ったかは `answered` で別に運ぶ。**
 */
describe('usage は応答として返ったかを別の欄で運ぶ', () => {
  it('ふつうに答えたターンは answered: true', async () => {
    const fake = fakeSdk();
    const { host, events } = hostWith(fake);
    await host.start({ managerId: 'mgr-ok', request: '1ターンだけ', cwd: dir });

    fake.sessions[0]?.report('終わった', { 'claude-opus-4-8': modelUsage(0.5) });
    await vi.waitFor(() => expect(usageEvents(events)).toHaveLength(1));

    expect(usageEvents(events)[0]?.answered).toBe(true);
    await host.shutdown();
  });

  it('🔴 枠で落ちた is_error のターンは、消費は降ろすが answered: false', async () => {
    const fake = fakeSdk();
    const { host, events } = hostWith(fake);
    await host.start({ managerId: 'mgr-limit', request: '枠に当たる', cwd: dir });

    fake.sessions[0]?.report(
      "You've hit your org's monthly spend limit · ask your admin to raise it at claude.ai/admin-settings/usage · your session limit resets 6:40pm (Asia/Tokyo)",
      { 'claude-opus-4-8': modelUsage(0.5) },
      { is_error: true },
    );
    await vi.waitFor(() => expect(usageEvents(events)).toHaveLength(1));

    const [event] = usageEvents(events);
    // **消費は本物なので台帳へは降ろす**（従来どおり）。
    expect(event?.models['claude-opus-4-8']?.costUsd).toBe(0.5);
    // **ただし応答ではない。** これが真だと回し手が「通る鍵に戻った」と読む。
    expect(event?.answered).toBe(false);
    // 枠の知らせは従来どおり出ている（こちらが exhausted を作る側）。
    expect(events.some((e) => e.type === 'usage_notice')).toBe(true);
    await host.shutdown();
  });
});
