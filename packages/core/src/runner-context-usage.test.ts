import type { Options, Query, SDKMessage, query as sdkQuery } from '@anthropic-ai/claude-agent-sdk';
import { describe, expect, it, vi } from 'vitest';

import { createManagerPool } from './manager.js';
import { createLocalRunner } from './runner-local.js';
import { createRunnerRegistry } from './runner-protocol.js';
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

function setup(options: { getContextUsage?: (callIndex: number) => unknown } = {}): {
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

describe('委譲層（ランナー）の contextUsage 配線（Issue #977 / #976）', () => {
  it('成功したターンは turn_usage.contextUsage に値が載る', async () => {
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
    expect(rows[0]?.contextUsage).toEqual({
      durationMs: expect.any(Number),
      totalTokens: 12_000,
      rawMaxTokens: 200_000,
      percentage: 6,
    });

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

    const rows = await vi.waitFor(async () => {
      const found = await turnUsageRows(s.stores);
      if (found.length === 0) throw new Error('turn_usage がまだ日誌に無い');
      return found;
    });
    expect(rows[0]?.contextUsage?.error).toBeDefined();
    expect(rows[0]?.contextUsage?.totalTokens).toBeUndefined();

    await s.pool.stop();
  });

  it('`getContextUsage` を実装していない `Query`（実機で未対応のときと同じ形）でも、ターンは止まらない', async () => {
    const s = setup();
    await s.pool.start({ request: '調べて' });
    const session = await firstSession(s.sessions);
    await session.finish('できました');

    const rows = await vi.waitFor(async () => {
      const found = await turnUsageRows(s.stores);
      if (found.length === 0) throw new Error('turn_usage がまだ日誌に無い');
      return found;
    });
    expect(rows[0]?.contextUsage?.error).toBeDefined();
    expect(typeof rows[0]?.contextUsage?.durationMs).toBe('number');

    await s.pool.stop();
  });
});
