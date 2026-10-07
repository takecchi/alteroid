import type {
  query as sdkQuery,
  ModelUsage,
  Options,
  Query,
  SDKMessage,
} from '@anthropic-ai/claude-agent-sdk';
import { describe, expect, it, vi } from 'vitest';

import { ALWAYS_REDELIVER, createClone } from './clone.js';
import type { CloneHost } from './host.js';
import { createLocalRunner } from './runner-local.js';
import { createRunnerRegistry } from './runner-protocol.js';
import type { Stores } from './store.js';
import { createMemoryStores } from './testing.js';

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

interface FakeOptions {
  usage?: () => Promise<unknown>;
  resultUsage?: Record<string, ModelUsage>;
}

interface Fake {
  fn: typeof sdkQuery;
  inputs: string[];
  usageCalls: () => number;
  order: string[];
  crash: (reason: string) => void;
}

function fakeSdk(options: FakeOptions = {}): Fake {
  const inputs: string[] = [];
  const order: string[] = [];
  let usageCalls = 0;
  let crashWith: ((error: Error) => void) | null = null;
  let pending: Error | null = null;

  const fn = ((params: { prompt: unknown; options?: Options }) => {
    async function* generate(): AsyncGenerator<SDKMessage, void> {
      yield {
        type: 'system',
        subtype: 'init',
        session_id: 'sess-clone',
        uuid: 'uuid-init',
      } as unknown as SDKMessage;

      const crashed = new Promise<never>((_, reject) => {
        crashWith = reject;
        if (pending !== null) reject(pending);
      });
      crashed.catch(() => undefined);

      const reader = (params.prompt as AsyncIterable<{ message: { content: unknown } }>)[
        Symbol.asyncIterator
      ]();
      for (;;) {
        const next = await Promise.race([reader.next(), crashed]);
        if (next.done === true) return;
        inputs.push(String(next.value.message.content));
        yield {
          type: 'assistant',
          message: { content: [{ type: 'text', text: 'ok' }] },
          parent_tool_use_id: null,
          session_id: 'sess-clone',
          uuid: 'uuid-assistant',
        } as unknown as SDKMessage;
        yield {
          type: 'result',
          subtype: 'success',
          result: 'ok',
          session_id: 'sess-clone',
          uuid: 'uuid-result',
          ...(options.resultUsage === undefined ? {} : { modelUsage: options.resultUsage }),
        } as unknown as SDKMessage;
      }
    }

    return Object.assign(generate(), {
      close: () => {
        order.push('close');
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

  return {
    fn,
    inputs,
    usageCalls: () => usageCalls,
    order,
    crash: (reason) => {
      const error = new Error(reason);
      if (crashWith === null) pending = error;
      else crashWith(error);
    },
  };
}

function bootClone(stores: Stores, fake: Fake): CloneHost {
  return createClone({
    redeliveryGate: ALWAYS_REDELIVER,
    stores,
    queryFn: fake.fn,
    env: {},
    runners: createRunnerRegistry([
      createLocalRunner({ workspacePath: '/work', queryFn: fakeSdk().fn, env: {} }),
    ]),
  });
}

async function runOneTurn(clone: CloneHost, fake: Fake): Promise<void> {
  clone.post({
    type: 'self_initiative',
    id: 'evt-flush',
    at: '2026-09-01T00:00:00.000Z',
    reason: '枠切れで落ちる前に少し使う',
  });
  await vi.waitFor(() => expect(fake.inputs.length).toBeGreaterThanOrEqual(1), { timeout: 3000 });
}

async function cloneRows(stores: Stores) {
  const aggregate = await stores.usage.aggregate({});
  return aggregate.rows.filter((row) => row.layer === 'clone');
}

describe('クローンも畳む直前に累積を1回読む', () => {
  it('デーモンの停止で畳まれても、result を1度も出していないセッションの累積が台帳へ載る', async () => {
    const stores = createMemoryStores();
    const fake = fakeSdk({
      usage: async () => getUsageResponse({ 'claude-fable-5': modelUsage(0.42) }),
    });
    const clone = bootClone(stores, fake);
    await runOneTurn(clone, fake);

    await clone.stop();

    const rows = await cloneRows(stores);
    expect(rows).toHaveLength(1);
    expect(rows[0]?.layer).toBe('clone');
    expect(rows[0]?.site).toBe('session');
    expect(rows[0]?.totals.costUsd).toBe(0.42);
    expect(fake.order).toEqual(['usage', 'close']);
  });

  it('セッションが落ちた経路（result なしで終了）でも台帳へ載る', async () => {
    const stores = createMemoryStores();
    const fake = fakeSdk({
      usage: async () => getUsageResponse({ 'claude-fable-5': modelUsage(0.17) }),
    });
    const clone = bootClone(stores, fake);
    await runOneTurn(clone, fake);

    fake.crash('Claude AI usage limit reached');
    await vi.waitFor(async () => expect(await cloneRows(stores)).toHaveLength(1), {
      timeout: 3000,
    });

    const rows = await cloneRows(stores);
    expect(rows[0]?.totals.costUsd).toBe(0.17);
    expect(fake.usageCalls()).toBe(1);
    await clone.stop();
  });

  it('全部ゼロなら降ろさない（「記録が無い」が「$0.00 使った」に化けない）', async () => {
    const stores = createMemoryStores();
    const fake = fakeSdk({
      usage: async () => getUsageResponse({ 'claude-fable-5': modelUsage(0, 0) }),
    });
    const clone = bootClone(stores, fake);
    await runOneTurn(clone, fake);

    await clone.stop();

    expect(fake.usageCalls()).toBe(1);
    expect(await cloneRows(stores)).toHaveLength(0);
  });

  it('口が無い SDK でも畳める（実験的な口の改名・削除で経路が落ちない）', async () => {
    const stores = createMemoryStores();
    const fake = fakeSdk();
    const clone = bootClone(stores, fake);
    await runOneTurn(clone, fake);

    await clone.stop();

    expect(await cloneRows(stores)).toHaveLength(0);
    expect(fake.order).toEqual(['close']);
  });

  it('読み取りが投げても畳める（ターン中の control 要求は実測で失敗する）', async () => {
    const stores = createMemoryStores();
    const fake = fakeSdk({
      usage: async () => {
        throw new Error('ProcessTransport is not ready for writing');
      },
    });
    const clone = bootClone(stores, fake);
    await runOneTurn(clone, fake);

    await clone.stop();

    expect(fake.usageCalls()).toBe(1);
    expect(await cloneRows(stores)).toHaveLength(0);
  });

  it('result で記録済みの累積と重なっても二重計上しない', async () => {
    const stores = createMemoryStores();
    const cumulative = { 'claude-fable-5': modelUsage(0.42) };
    const fake = fakeSdk({
      usage: async () => getUsageResponse(cumulative),
      resultUsage: cumulative,
    });
    const clone = bootClone(stores, fake);
    await runOneTurn(clone, fake);
    await vi.waitFor(async () => expect(await cloneRows(stores)).toHaveLength(1), {
      timeout: 3000,
    });

    await clone.stop();

    const rows = await cloneRows(stores);
    expect(rows).toHaveLength(1);
    expect(rows[0]?.totals.costUsd).toBe(0.42);
  });
});
