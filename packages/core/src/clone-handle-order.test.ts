import type { query as sdkQuery, Options, Query, SDKMessage } from '@anthropic-ai/claude-agent-sdk';
import { describe, expect, it } from 'vitest';

import { ALWAYS_REDELIVER, createClone } from './clone.js';
import { waitFor } from './clone-test-harness.js';
import { createLocalRunner } from './runner-local.js';
import { createRunnerRegistry } from './runner-protocol.js';
import type { InboxEvent } from './schema.js';
import type { Stores } from './store.js';
import { createMemoryStores } from './testing.js';

const AT = '2026-08-12T00:00:00.000Z';

function markingSdk(order: string[], label: string): typeof sdkQuery {
  return ((params: { prompt: unknown; options?: Options }) => {
    async function* generate(): AsyncGenerator<SDKMessage, void> {
      yield {
        type: 'system',
        subtype: 'init',
        session_id: 'sess-order',
        uuid: 'uuid-init',
      } as unknown as SDKMessage;

      for await (const message of params.prompt as AsyncIterable<{
        message: { content: unknown };
      }>) {
        void message;
        order.push(label);
        yield {
          type: 'assistant',
          message: { content: [{ type: 'text', text: 'ok' }] },
          parent_tool_use_id: null,
          session_id: 'sess-order',
          uuid: 'uuid-assistant',
        } as unknown as SDKMessage;
        yield {
          type: 'result',
          subtype: 'success',
          result: 'ok',
          session_id: 'sess-order',
          uuid: 'uuid-result',
        } as unknown as SDKMessage;
      }
    }

    const generator = generate();
    return Object.assign(generator, {
      close: () => undefined,
      interrupt: async () => undefined,
    }) as unknown as Query;
  }) as unknown as typeof sdkQuery;
}

describe('Clone#handle — 未着手だった分岐の順序（characterization。Issue #1744 の一部）', () => {
  it('timer: turnInputEntry の書き込み → モデルへの入力 → completeScheduledRun、の順で呼ばれる', async () => {
    const order: string[] = [];
    const base = createMemoryStores();
    const stores: Stores = {
      ...base,
      journal: {
        ...base.journal,
        append: async (entry) => {
          if (
            entry.type === 'exchange' &&
            entry.with === 'self' &&
            entry.role === 'inbound' &&
            entry.text.includes('ターンの入力: timer')
          ) {
            order.push('journal-marker');
          }
          return base.journal.append(entry);
        },
      },
      schedules: {
        ...base.schedules,
        completeRun: async (kind, at, cause) => {
          order.push('complete-run');
          return base.schedules.completeRun(kind, at, cause);
        },
      },
    };

    await stores.schedules.put({
      kind: 'issue-round',
      spec: { type: 'daily', at: '09:00' },
      request: 'open issue を見て、着手できるものから進める',
      createdAt: '2026-08-11T00:00:00.000Z',
      updatedAt: '2026-08-11T00:00:00.000Z',
    });

    const fn = markingSdk(order, 'model-input');
    const clone = createClone({
      redeliveryGate: ALWAYS_REDELIVER,
      stores,
      queryFn: fn,
      env: {},
      runners: createRunnerRegistry([
        createLocalRunner({ workspacePath: '/work', queryFn: fn, env: {} }),
      ]),
    });

    const event: InboxEvent = {
      type: 'timer',
      id: 'evt-timer-order',
      at: AT,
      kind: 'issue-round',
      cause: 'manual',
    };
    clone.post(event);

    await waitFor(() => order.includes('complete-run'), 'completeScheduledRun が呼ばれる');
    // clone.stop() より前に読む: stop() 自身が蒸留の内部ターンをもう1本起こし、その 'model-input' が紛れ込むため
    expect(order).toEqual(['journal-marker', 'model-input', 'complete-run']);

    await clone.stop();
  });

  it('human_answer: 入力の印の日誌書き込み → モデルへの入力、の順で呼ばれる', async () => {
    const order: string[] = [];
    const base = createMemoryStores();
    const stores: Stores = {
      ...base,
      journal: {
        ...base.journal,
        append: async (entry) => {
          if (
            entry.type === 'exchange' &&
            entry.with === 'self' &&
            entry.role === 'inbound' &&
            entry.text.includes('ターンの入力: human_answer')
          ) {
            order.push('journal-marker');
          }
          return base.journal.append(entry);
        },
      },
    };

    await stores.jobs.putApproval({
      id: 'ap-order-1',
      createdAt: '2026-08-12T00:00:00.000Z',
      question: '本番へ出してよいか',
    });

    const fn = markingSdk(order, 'model-input');
    const clone = createClone({
      redeliveryGate: ALWAYS_REDELIVER,
      stores,
      queryFn: fn,
      env: {},
      runners: createRunnerRegistry([
        createLocalRunner({ workspacePath: '/work', queryFn: fn, env: {} }),
      ]),
    });

    await clone.answerApproval('ap-order-1', '(b) でお願いします');

    await waitFor(() => order.includes('model-input'), 'モデルへ入力が渡る');
    expect(order).toEqual(['journal-marker', 'model-input']);

    await clone.stop();
  });

  it('self_initiative: turnInputEntry の書き込み → モデルへの入力、の順で呼ばれる', async () => {
    const order: string[] = [];
    const base = createMemoryStores();
    const stores: Stores = {
      ...base,
      journal: {
        ...base.journal,
        append: async (entry) => {
          if (
            entry.type === 'exchange' &&
            entry.with === 'self' &&
            entry.role === 'inbound' &&
            entry.text.includes('ターンの入力: self_initiative')
          ) {
            order.push('journal-marker');
          }
          return base.journal.append(entry);
        },
      },
    };

    const fn = markingSdk(order, 'model-input');
    const clone = createClone({
      redeliveryGate: ALWAYS_REDELIVER,
      stores,
      queryFn: fn,
      env: {},
      runners: createRunnerRegistry([
        createLocalRunner({ workspacePath: '/work', queryFn: fn, env: {} }),
      ]),
    });

    const event: InboxEvent = {
      type: 'self_initiative',
      id: 'evt-self-order',
      at: AT,
      reason: '定期 tick: 記憶にある目的から次にやることを決める',
    };
    clone.post(event);

    await waitFor(() => order.includes('model-input'), 'モデルへ入力が渡る');
    expect(order).toEqual(['journal-marker', 'model-input']);

    await clone.stop();
  });
});
