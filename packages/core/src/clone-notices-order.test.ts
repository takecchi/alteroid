import type { Options, Query, SDKMessage, query as sdkQuery } from '@anthropic-ai/claude-agent-sdk';
import { describe, expect, it, vi } from 'vitest';

import { ALWAYS_REDELIVER, createClone } from './clone.js';
import { CloneNotices } from './clone-notices.js';
import type { TurnNoticeKey } from './clone-notices.js';
import { createLocalRunner } from './runner-local.js';
import { createRunnerRegistry } from './runner-protocol.js';
import { createMemoryStores, humanMessage } from './testing.js';

function fakeSdk(): { fn: typeof sdkQuery } {
  const fn = ((params: { prompt: unknown; options?: Options }) => {
    async function* generate(): AsyncGenerator<SDKMessage, void> {
      yield {
        type: 'system',
        subtype: 'init',
        session_id: 'sess-fake',
        uuid: 'uuid-init',
        model: 'claude-fake-init-model-xyz',
        claude_code_version: '9.9.9-fake',
        apiKeySource: 'user',
        permissionMode: 'default',
        mcp_servers: [{ name: 'alteroid', status: 'connected' }],
      } as unknown as SDKMessage;

      const prompt = params.prompt;
      for await (const message of prompt as AsyncIterable<{ message: { content: unknown } }>) {
        void message;
        yield {
          type: 'assistant',
          message: { content: [{ type: 'text', text: 'わかった' }] },
          parent_tool_use_id: null,
          session_id: 'sess-fake',
          uuid: 'uuid-assistant',
        } as unknown as SDKMessage;
        yield {
          type: 'result',
          subtype: 'success',
          result: 'わかった',
          session_id: 'sess-fake',
          uuid: 'uuid-result',
        } as unknown as SDKMessage;
        return;
      }
    }

    const generator = generate();
    return Object.assign(generator, {
      close: () => undefined,
      interrupt: async () => undefined,
    }) as unknown as Query;
  }) as unknown as typeof sdkQuery;

  return { fn };
}

describe('Issue #1744: Clone#pump — #notices.set の呼び出し順（characterization）', () => {
  it(
    'human_message を1件処理する反復では、mergedBatchTruncation のリセット→' +
      'redelivery→commitment→situation→validity→superseded の順で ' +
      '#notices.set が呼ばれる（noteRedeliveryPredicateHitB は human_message では ' +
      '条件を満たさないので鳴らない・上の doc を参照）',
    async () => {
      const order: TurnNoticeKey[] = [];
      const originalSet = CloneNotices.prototype.set;
      let resolveDone: (() => void) | undefined;
      const done = new Promise<void>((resolve) => {
        resolveDone = resolve;
      });
      vi.spyOn(CloneNotices.prototype, 'set').mockImplementation(function (
        this: CloneNotices,
        key: TurnNoticeKey,
        text: string,
      ) {
        order.push(key);
        const result = originalSet.call(this, key, text);
        if (key === 'superseded') resolveDone?.();
        return result;
      });

      const stores = createMemoryStores();
      const { fn } = fakeSdk();
      const clone = createClone({
        redeliveryGate: ALWAYS_REDELIVER,
        stores,
        queryFn: fn,
        env: {},
        runners: createRunnerRegistry([
          createLocalRunner({ workspacePath: '/work', queryFn: fakeSdk().fn, env: {} }),
        ]),
      });
      clone.subscribe('conv-1', () => undefined);

      clone.post(humanMessage('順序を確かめる'));
      await done;

      expect(order).toEqual([
        'mergedBatchTruncation',
        'redelivery',
        'commitment',
        'situation',
        'validity',
        'superseded',
      ] satisfies TurnNoticeKey[]);

      await clone.stop();
    },
  );
});
