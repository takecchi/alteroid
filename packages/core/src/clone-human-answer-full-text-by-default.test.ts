import type { query as sdkQuery, Options, Query, SDKMessage } from '@anthropic-ai/claude-agent-sdk';
import { describe, expect, it } from 'vitest';

import { createClone } from './clone.js';
import { waitFor } from './clone-test-harness.js';
import type { CloneHost } from './host.js';
import { createRunnerRegistry } from './runner-protocol.js';
import { createLocalRunner } from './runner-local.js';
import { createMemoryStores } from './testing.js';

// #5301: 人間の答えを受けたターンの末尾（基準として記憶へ書く指示）は、2回目以降も全文のまま出す（同じ会話の中でも省略しない）。

/** 全文にだけ在る説明の文。 */
const EXPLANATION = 'あなたが自分で決めるための材料である';
const REWRITE_DETAIL = '言葉に言い換えて記憶へ書くこと';
const CRITERIA_RULE = '拒否・条件付き・理由付きの答え';

interface Boot {
  clone: CloneHost;
  inputs: string[];
}

function boot(env: NodeJS.ProcessEnv = {}): Boot {
  const inputs: string[] = [];
  const fn = ((params: { prompt: unknown; options?: Options }) => {
    async function* generate(): AsyncGenerator<SDKMessage, void> {
      yield {
        type: 'system',
        subtype: 'init',
        session_id: 'sess-fake',
        uuid: 'uuid-init',
      } as unknown as SDKMessage;
      for await (const message of params.prompt as AsyncIterable<{
        message: { content: unknown };
      }>) {
        inputs.push(String(message.message.content));
        yield {
          type: 'result',
          subtype: 'success',
          result: 'ok',
          session_id: 'sess-fake',
          uuid: `uuid-result-${String(inputs.length)}`,
        } as unknown as SDKMessage;
      }
    }
    return Object.assign(generate(), {
      close: () => undefined,
      interrupt: async () => undefined,
      getContextUsage: async () => ({
        categories: [],
        totalTokens: 10_000,
        maxTokens: 1_000_000,
        rawMaxTokens: 1_000_000,
        percentage: 1,
        autoCompactThreshold: 200_000,
        isAutoCompactEnabled: true,
      }),
    }) as unknown as Query;
  }) as unknown as typeof sdkQuery;

  const clone = createClone({
    reportSettleMs: 2500,
    stores: createMemoryStores(),
    queryFn: fn,
    env,
    runners: createRunnerRegistry([
      createLocalRunner({ workspacePath: '/work', queryFn: fn, env: {} }),
    ]),
  });
  return { clone, inputs };
}

let seq = 0;

async function deliver(s: Boot, event: Record<string, unknown>): Promise<string> {
  const before = s.inputs.length;
  seq += 1;
  s.clone.post({
    id: `evt-answer-${String(seq)}`,
    at: new Date().toISOString(),
    ...event,
  } as never);
  await waitFor(() => s.inputs.length > before, `入力 ${String(before + 1)} 本目`);
  return s.inputs[before] ?? '';
}

const answer = (n: number) => ({
  type: 'human_answer',
  approvalId: `appr-${String(n)}`,
  answer: `答え${String(n)}`,
});

/** 末尾の「この回答に沿って続きを進めよ。」より後ろ（基準の指示）だけを返す。 */
function tailOf(input: string): string {
  const marker = 'この回答に沿って続きを進めよ。';
  const at = input.indexOf(marker);
  expect(at, '「この回答に沿って続きを進めよ。」が入力に無い').toBeGreaterThanOrEqual(0);
  return input.slice(at + marker.length).trim();
}

describe('human_answer の末尾は、同じ会話の2回目以降も基準の指示が全文のまま（#5301）', () => {
  it('⭐ 2回目以降も基準の指示が全文のまま', async () => {
    const s = boot();
    const inputs = [
      await deliver(s, answer(1)),
      await deliver(s, answer(2)),
      await deliver(s, answer(3)),
    ];
    const first = tailOf(inputs[0] ?? '');
    for (const input of inputs) {
      const text = tailOf(input);
      expect(text).toContain(EXPLANATION);
      expect(text).toContain(REWRITE_DETAIL);
      expect(text).toContain(CRITERIA_RULE);
      expect(text.length).toBe(first.length);
    }
    await s.clone.stop();
  });
});
