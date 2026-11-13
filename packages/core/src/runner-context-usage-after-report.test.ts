import type { Options, Query, SDKMessage, query as sdkQuery } from '@anthropic-ai/claude-agent-sdk';
import { describe, expect, it, vi } from 'vitest';

import { createRunnerHost } from './runner.js';
import type { RunnerEvent } from './runner-protocol.js';

// 担当: ターン終わりの `getContextUsage`（最大 10s）を待たずに `report` を出し、`context_usage` は後から出す。
const usage = { totalTokens: 12_000, rawMaxTokens: 200_000, percentage: 6 };

/** 実時間で待たず、イベントループを数周回す（unhandled rejection の通知もこの間に出る）。 */
async function settle(rounds = 20): Promise<void> {
  for (let i = 0; i < rounds; i += 1) await new Promise((resolve) => setImmediate(resolve));
}

function gate() {
  let open!: () => void;
  const opened = new Promise<void>((resolve) => {
    open = resolve;
  });
  return { open, opened };
}

function fakeSdk(getContextUsage: (callIndex: number) => Promise<unknown>) {
  let finishes = 0;
  let calls = 0;
  const pushers: ((message: SDKMessage) => void)[] = [];
  const fn = ((params: { prompt: unknown; options?: Options }) => {
    let emit: ((message: SDKMessage | null) => void) | null = null;
    const buffered: SDKMessage[] = [];
    const push = (message: SDKMessage) => {
      if (emit) emit(message);
      else buffered.push(message);
    };
    pushers.push(push);
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
    return Object.assign(generate(), {
      close: () => {
        if (emit) emit(null);
      },
      interrupt: async () => undefined,
      getContextUsage: () => getContextUsage((calls += 1) - 1),
    }) as unknown as Query;
  }) as unknown as typeof sdkQuery;
  const finish = async (text: string) => {
    const push = pushers[0];
    if (push === undefined) throw new Error('セッションがまだ開いていない');
    push({
      type: 'result',
      subtype: 'success',
      result: text,
      session_id: 'sess-mgr',
      uuid: `uuid-result-${(finishes += 1)}`,
      modelUsage: {},
    } as unknown as SDKMessage);
    await new Promise((resolve) => setTimeout(resolve, 0));
  };
  return { fn, finish, pushers };
}

async function start(
  getContextUsage: (callIndex: number) => Promise<unknown>,
  contextUsageTimeoutMs?: number,
) {
  const sdk = fakeSdk(getContextUsage);
  const events: RunnerEvent[] = [];
  const host = createRunnerHost({
    runnerId: 'runner-test',
    workspacePath: '/work/project',
    emit: (event) => events.push(event),
    queryFn: sdk.fn,
    env: { PATH: '/usr/bin' },
    ...(contextUsageTimeoutMs === undefined ? {} : { contextUsageTimeoutMs }),
  });
  await host.resume({
    managerId: 'mgr-wire',
    sessionId: 'sess-mgr',
    cwd: '/work/project',
    request: '調べて',
    entries: [{ type: 'user', message: { role: 'user', content: '前回の続き' } }],
  });
  await vi.waitFor(() => {
    if (sdk.pushers.length === 0) throw new Error('セッションがまだ開いていない');
  });
  return { host, events, sdk };
}

const typesOf = (events: RunnerEvent[]) => events.map((event) => event.type);

describe('担当（ランナー）— context_usage は report の後ろで取って出す', () => {
  it('⭐ getContextUsage が返らなくても report は出て、返った後で同じ中身の context_usage が出る', async () => {
    const g = gate();
    const { host, events, sdk } = await start(async () => {
      await g.opened;
      return usage;
    });
    try {
      await sdk.finish('できました');
      await vi.waitFor(() => {
        if (!typesOf(events).includes('report')) throw new Error('report がまだ出ていない');
      });
      expect(typesOf(events)).not.toContain('context_usage');

      g.open();
      await vi.waitFor(() => {
        if (!typesOf(events).includes('context_usage'))
          throw new Error('context_usage がまだ出ていない');
      });
      const found = events.filter((event) => event.type === 'context_usage');
      expect(found).toHaveLength(1);
      expect(found[0]).toMatchObject({
        managerId: 'mgr-wire',
        sessionId: 'sess-mgr',
        turnSucceeded: true,
        contextUsage: { durationMs: expect.any(Number), ...usage },
      });
      expect(typesOf(events).indexOf('report')).toBeLessThan(
        typesOf(events).indexOf('context_usage'),
      );
    } finally {
      await host.shutdown();
    }
  });

  it('観測が失敗しても report は出て、error 付きの context_usage が今までどおり出る', async () => {
    const { host, events, sdk } = await start(() => Promise.reject(new Error('テスト用')));
    try {
      await sdk.finish('できました');
      await vi.waitFor(() => {
        const types = typesOf(events);
        if (!types.includes('report') || !types.includes('context_usage'))
          throw new Error('まだ出ていない');
      });
      const found = events.find((event) => event.type === 'context_usage');
      expect(found).toMatchObject({ contextUsage: { error: expect.any(String) } });
    } finally {
      await host.shutdown();
    }
  });

  it('期限を過ぎたら、返らなかった旨の error 付きの context_usage が出る', async () => {
    const { host, events, sdk } = await start(() => new Promise(() => undefined), 30);
    try {
      await sdk.finish('できました');
      await vi.waitFor(() => {
        if (!typesOf(events).includes('context_usage')) throw new Error('まだ出ていない');
      });
      const found = events.find((event) => event.type === 'context_usage');
      expect(found).toMatchObject({
        contextUsage: { error: expect.stringContaining('返らなかった') },
      });
    } finally {
      await host.shutdown();
    }
  });

  it('⭐ 観測の途中で shutdown しても、観測の完了を待ってから閉じ、context_usage は欠けず例外も出ない', async () => {
    const g = gate();
    const { host, events, sdk } = await start(async () => {
      await g.opened;
      return usage;
    });
    const unhandled: unknown[] = [];
    const onUnhandled = (reason: unknown) => unhandled.push(reason);
    process.on('unhandledRejection', onUnhandled);
    try {
      await sdk.finish('できました');
      await vi.waitFor(() => {
        if (!typesOf(events).includes('report')) throw new Error('report がまだ出ていない');
      });
      let stopped = false;
      const shutting = host.shutdown().then(() => {
        stopped = true;
      });
      // 畳みが終わる（待たない作りなら、実 I/O を含めて数十周回で終わる）か、十分回るまで回す。実時間では待たない
      for (let i = 0; i < 300 && !stopped; i += 1) await settle(1);
      // 観測が返るまで、畳みはセッションを閉じずに待つ
      expect(stopped).toBe(false);
      expect(typesOf(events)).not.toContain('closed');
      g.open();
      await shutting;
      expect(events.filter((event) => event.type === 'context_usage')).toHaveLength(1);
      const types = typesOf(events);
      const closed = types.indexOf('closed');
      if (closed !== -1) expect(types.indexOf('context_usage')).toBeLessThan(closed);
      await settle();
      expect(unhandled).toEqual([]);
    } finally {
      process.off('unhandledRejection', onUnhandled);
    }
  });

  it('⭐ 連続した2ターンで、観測は重ならず、ターンの順に出る', async () => {
    const gates = [gate(), gate()];
    let inFlight = 0;
    let maxInFlight = 0;
    let reads = 0;
    const { host, events, sdk } = await start(async (callIndex) => {
      reads += 1;
      inFlight += 1;
      maxInFlight = Math.max(maxInFlight, inFlight);
      await gates[callIndex]?.opened;
      inFlight -= 1;
      return { ...usage, totalTokens: 1_000 * (callIndex + 1) };
    });
    try {
      await sdk.finish('1回目');
      await sdk.finish('2回目');
      await settle();
      // 1つ目が返るまで、2つ目は始まらない
      expect(reads).toBe(1);
      gates[0]?.open();
      await vi.waitFor(() => {
        if (reads !== 2) throw new Error('2つ目がまだ始まっていない');
      });
      gates[1]?.open();
      await vi.waitFor(() => {
        if (events.filter((event) => event.type === 'context_usage').length !== 2)
          throw new Error('まだ2件出ていない');
      });
      expect(maxInFlight).toBe(1);
      const totals = events.flatMap((event) =>
        event.type === 'context_usage' ? [event.contextUsage.totalTokens] : [],
      );
      expect(totals).toEqual([1_000, 2_000]);
    } finally {
      await host.shutdown();
    }
  });
});
