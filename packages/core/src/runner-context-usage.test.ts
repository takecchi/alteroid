import type { Options, Query, SDKMessage, query as sdkQuery } from '@anthropic-ai/claude-agent-sdk';
import { describe, expect, it, vi } from 'vitest';

import { createManagerPool } from './manager.js';
import { createRunnerHost } from './runner.js';
import { createLocalRunner } from './runner-local.js';
import { createRunnerRegistry, type RunnerEvent } from './runner-protocol.js';
import type { InboxEvent } from './schema.js';
import type { Stores } from './store.js';
import { createMemoryStores } from './testing.js';

interface FakeSession {
  finish(text: string, options?: { subtype?: string; isError?: boolean }): Promise<void>;
}

function fixedModelUsage() {
  return {
    'claude-opus-5': {
      inputTokens: 10,
      outputTokens: 20,
      cacheReadInputTokens: 0,
      cacheCreationInputTokens: 0,
      webSearchRequests: 0,
      costUSD: 1,
    },
  };
}

function fakeSdk(options: { getContextUsage?: (callIndex: number) => unknown } = {}) {
  const sessions: FakeSession[] = [];

  const fn = ((params: { prompt: unknown; options?: Options }) => {
    const callIndex = sessions.length;
    let emit: ((message: SDKMessage | null) => void) | null = null;
    const buffered: SDKMessage[] = [];
    let finishes = 0;
    const push = (message: SDKMessage) => {
      if (emit) emit(message);
      else buffered.push(message);
    };

    sessions.push({
      async finish(text, finishOptions = {}) {
        push({
          type: 'result',
          subtype: finishOptions.subtype ?? 'success',
          result: text,
          session_id: 'sess-mgr',
          uuid: `uuid-result-${(finishes += 1)}`,
          modelUsage: fixedModelUsage(),
          ...(finishOptions.isError === undefined ? {} : { is_error: finishOptions.isError }),
        } as unknown as SDKMessage);
        await new Promise((resolve) => setTimeout(resolve, 0));
      },
    });

    async function* generate(): AsyncGenerator<SDKMessage, void> {
      yield {
        type: 'system',
        subtype: 'init',
        session_id: 'sess-mgr',
        uuid: 'uuid-init',
      } as unknown as SDKMessage;

      void (async () => {
        for await (const message of params.prompt as AsyncIterable<unknown>) void message;
      })();

      for (;;) {
        const next = buffered.shift();
        if (next !== undefined) {
          yield next;
          continue;
        }
        const message = await new Promise<SDKMessage | null>((resolve) => {
          emit = resolve;
        });
        emit = null;
        if (message === null) return;
        yield message;
      }
    }

    const generator = generate();
    return Object.assign(generator, {
      close: () => {
        if (emit) emit(null);
      },
      interrupt: async () => undefined,
      ...(options.getContextUsage === undefined
        ? {}
        : { getContextUsage: async () => options.getContextUsage!(callIndex) }),
    }) as unknown as Query;
  }) as unknown as typeof sdkQuery;

  return { fn, sessions };
}

function setup(
  options: {
    getContextUsage?: (callIndex: number) => unknown;
    contextUsageTimeoutMs?: number;
  } = {},
): {
  pool: ReturnType<typeof createManagerPool>;
  stores: Stores;
  sessions: FakeSession[];
  inbox: InboxEvent[];
} {
  const { fn, sessions } = fakeSdk(options);
  const stores = createMemoryStores();
  const inbox: InboxEvent[] = [];
  const registry = createRunnerRegistry([
    createLocalRunner({
      runnerId: 'runner-test',
      workspacePath: '/work/project',
      queryFn: fn,
      env: { PATH: '/usr/bin' },
      ...(options.contextUsageTimeoutMs === undefined
        ? {}
        : { contextUsageTimeoutMs: options.contextUsageTimeoutMs }),
    }),
  ]);
  const pool = createManagerPool({
    stores,
    post: (event) => inbox.push(event),
    runners: registry,
    synthesizedNoticeWindowMs: 100,
  });
  return { pool, stores, sessions, inbox };
}

async function turnUsageRows(stores: Stores) {
  const entries = await stores.journal.list({ types: ['turn_usage'] });
  return entries.flatMap((entry) => (entry.type === 'turn_usage' ? [entry] : []));
}

async function contextUsageRows(stores: Stores) {
  const entries = await stores.journal.list({ types: ['context_usage'] });
  return entries.flatMap((entry) => (entry.type === 'context_usage' ? [entry] : []));
}

async function firstSession(sessions: FakeSession[]): Promise<FakeSession> {
  return vi.waitFor(() => {
    const found = sessions[0];
    if (!found) throw new Error('セッションがまだ開いていない');
    return found;
  });
}

/** `context_usage` の行（文脈占有の唯一の記録）が届くまで待って、その `contextUsage` を返す。 */
async function contextUsageOf(stores: Stores) {
  const rows = await vi.waitFor(async () => {
    const found = await contextUsageRows(stores);
    if (found.length === 0) throw new Error('context_usage がまだ日誌に無い');
    return found;
  });
  const row = rows[0];
  if (row === undefined) throw new Error('context_usage が日誌に無い');
  return row.contextUsage;
}

describe('委譲層（ランナー）の contextUsage 配線（Issue #977 / #976）', () => {
  it('⭐ 成功したターンの文脈占有は context_usage の行にだけ載り、turn_usage には載らない', async () => {
    const s = setup({
      getContextUsage: () => ({
        totalTokens: 12_000,
        rawMaxTokens: 200_000,
        percentage: 6,
      }),
    });
    await s.pool.start({ request: '調べて' });
    const session = await firstSession(s.sessions);
    await session.finish('できました');

    const rows = await vi.waitFor(async () => {
      const found = await turnUsageRows(s.stores);
      if (found.length === 0) throw new Error('turn_usage がまだ日誌に無い');
      return found;
    });
    expect(rows[0]).not.toHaveProperty('contextUsage');
    expect(await contextUsageOf(s.stores)).toEqual({
      durationMs: expect.any(Number),
      totalTokens: 12_000,
      rawMaxTokens: 200_000,
      percentage: 6,
    });

    await s.pool.stop();
  });

  it('⭐ ワイヤ上も文脈占有は context_usage の出来事に一本化され、usage の出来事には載らない', async () => {
    const { fn, sessions } = fakeSdk({
      getContextUsage: () => ({ totalTokens: 12_000, rawMaxTokens: 200_000, percentage: 6 }),
    });
    const events: RunnerEvent[] = [];
    const host = createRunnerHost({
      runnerId: 'runner-test',
      workspacePath: '/work/project',
      emit: (event) => events.push(event),
      queryFn: fn,
      env: { PATH: '/usr/bin' },
    });
    try {
      await host.resume({
        managerId: 'mgr-wire',
        sessionId: 'sess-mgr',
        cwd: '/work/project',
        request: '調べて',
        entries: [{ type: 'user', message: { role: 'user', content: '前回の続き' } }],
      });
      const session = await firstSession(sessions);
      await session.finish('できました');

      await vi.waitFor(() => {
        if (!events.some((event) => event.type === 'usage'))
          throw new Error('usage がまだ出ていない');
      });
      const usage = events.find((event) => event.type === 'usage');
      expect(usage).toBeDefined();
      expect(usage).not.toHaveProperty('contextUsage');
      expect(events.filter((event) => event.type === 'context_usage')).toHaveLength(1);
    } finally {
      await host.shutdown();
    }
  });

  it('messageBreakdown は畳まれて context_usage.contextUsage に載り、SDK が返さない回は欄を作らない', async () => {
    const s = setup({
      getContextUsage: (callIndex) => ({
        totalTokens: 12_000,
        rawMaxTokens: 200_000,
        percentage: 6,
        ...(callIndex === 0
          ? {
              messageBreakdown: {
                toolCallTokens: 30,
                toolResultTokens: 500,
                attachmentTokens: 4,
                assistantMessageTokens: 70,
                userMessageTokens: 20,
                toolCallsByType: [
                  { name: 'Read', callTokens: 10, resultTokens: 100 },
                  { name: 'Bash', callTokens: 20, resultTokens: 400 },
                ],
              },
            }
          : {}),
      }),
    });
    await s.pool.start({ request: '調べて' });
    const session = await firstSession(s.sessions);
    await session.finish('できました');

    const context = await contextUsageOf(s.stores);
    expect(context.messageBreakdown).toEqual({
      toolCallTokens: 30,
      toolResultTokens: 500,
      attachmentTokens: 4,
      assistantMessageTokens: 70,
      userMessageTokens: 20,
      toolsByName: [
        { name: 'Bash', callTokens: 20, resultTokens: 400 },
        { name: 'Read', callTokens: 10, resultTokens: 100 },
      ],
    });

    await s.pool.stop();
  });

  it('SDK が messageBreakdown を返さない回は、欄そのものを作らない（0 を置かない）', async () => {
    const s = setup({
      getContextUsage: () => ({ totalTokens: 12_000, rawMaxTokens: 200_000, percentage: 6 }),
    });
    await s.pool.start({ request: '調べて' });
    const session = await firstSession(s.sessions);
    await session.finish('できました');

    expect(await contextUsageOf(s.stores)).not.toHaveProperty('messageBreakdown');

    await s.pool.stop();
  });

  it('失敗したターンでも contextUsage は context_usage として残る（#976 の直った後の挙動）', async () => {
    const s = setup({
      getContextUsage: () => ({
        totalTokens: 12_000,
        rawMaxTokens: 200_000,
        percentage: 6,
      }),
    });
    await s.pool.start({ request: '調べて' });
    const session = await firstSession(s.sessions);
    // `is_error` だけでは `isSuccessResult`（`subtype` だけを見る）が真のままなので、`subtype` も `success` 以外にする。
    await session.finish('', { subtype: 'error_during_execution', isError: true });

    await vi.waitFor(
      () => {
        if (s.inbox.length === 0) throw new Error('報告がまだ届いていない');
      },
      { timeout: 5000 },
    );

    expect(await turnUsageRows(s.stores)).toHaveLength(0);

    const contextRows = await vi.waitFor(async () => {
      const found = await contextUsageRows(s.stores);
      if (found.length === 0) throw new Error('context_usage がまだ日誌に無い');
      return found;
    });
    expect(contextRows[0]?.turnSucceeded).toBe(false);
    expect(contextRows[0]?.contextUsage).toEqual({
      durationMs: expect.any(Number),
      totalTokens: 12_000,
      rawMaxTokens: 200_000,
      percentage: 6,
    });

    await s.pool.stop();
  });

  it('`getContextUsage()` が例外を投げても、ターンの成否には影響しない', async () => {
    const s = setup({
      getContextUsage: () => {
        throw new Error('観測に失敗（テスト用）');
      },
    });
    await s.pool.start({ request: '調べて' });
    const session = await firstSession(s.sessions);
    await session.finish('できました');

    const context = await contextUsageOf(s.stores);
    expect(context.error).toBeDefined();
    expect(context.totalTokens).toBeUndefined();

    await s.pool.stop();
  });

  it('`getContextUsage` を実装していない `Query`（実機で未対応のときと同じ形）でも、ターンは止まらない', async () => {
    const s = setup();
    await s.pool.start({ request: '調べて' });
    const session = await firstSession(s.sessions);
    await session.finish('できました');

    const context = await contextUsageOf(s.stores);
    expect(context.error).toBeDefined();
    expect(typeof context.durationMs).toBe('number');

    await s.pool.stop();
  });

  // CLI が生きたまま答えないと、ターンの終わりの処理が先へ進まず、報告も closed も出ないまま running で残っていた（#4649）
  it('⭐ `getContextUsage()` が返らなくても、期限で打ち切って報告を出し、打ち切りを error として残す', async () => {
    const s = setup({
      getContextUsage: () => new Promise(() => undefined),
      contextUsageTimeoutMs: 50,
    });
    await s.pool.start({ request: '調べて' });
    const session = await firstSession(s.sessions);
    await session.finish('できました');

    await vi.waitFor(
      () => {
        if (!s.inbox.some((event) => event.type === 'manager_message' && event.kind === 'report')) {
          throw new Error('報告がまだ届いていない');
        }
      },
      { timeout: 3000 },
    );
    const context = await contextUsageOf(s.stores);
    expect(context.error).toContain('返らなかった');
    expect(context.totalTokens).toBeUndefined();

    await s.pool.stop();
  });
});
