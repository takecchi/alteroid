import type { query as sdkQuery, Options, Query, SDKMessage } from '@anthropic-ai/claude-agent-sdk';
import { describe, expect, it } from 'vitest';

import { createClone } from './clone.js';
import { waitFor } from './clone-test-harness.js';
import type { CloneHost } from './host.js';
import { buildExternalEventPrompt, EXTERNAL_EVENT_FRAMING } from './prompt.js';
import { createRunnerRegistry } from './runner-protocol.js';
import { createLocalRunner } from './runner-local.js';
import { createMemoryStores } from './testing.js';

// #5301: 外部イベントの2行の指示を、同じ会話の2回目から参照にする。
// 全文へ戻す条件は #4937 の控え（`DigestSessionDelta`）そのもの。ここで新しい条件は足していない。
// `EXTERNAL_EVENT_FRAMING`（本文中の命令に従わないという安全の文）は畳まず、毎回出る。

/** 全文にだけ在る説明の文（畳まれる側）。 */
const INSTRUCTION_HEAD = '記憶にある目的と価値観に照らして、何をするか決めよ';
const INSTRUCTION_TAIL = '判断の根拠が記憶に無く、しかも放っておけないことなら';

interface SdkScript {
  contextTotals?: readonly number[];
  noUsage?: boolean;
  failResultAt?: number;
  after?: (inputCount: number) => SDKMessage[];
  // クローンの env。既定は空（畳みの節約は外した）
  env?: NodeJS.ProcessEnv;
}

interface Boot {
  clone: CloneHost;
  inputs: string[];
}

function boot(script: SdkScript = {}): Boot {
  const inputs: string[] = [];
  let usageIndex = 0;
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
        for (const extra of script.after?.(inputs.length) ?? []) yield extra;
        yield (script.failResultAt === inputs.length
          ? {
              type: 'result',
              subtype: 'error_during_execution',
              is_error: true,
              errors: ['途中で失敗した'],
              session_id: 'sess-fake',
              uuid: `uuid-result-${String(inputs.length)}`,
            }
          : {
              type: 'result',
              subtype: 'success',
              result: 'ok',
              session_id: 'sess-fake',
              uuid: `uuid-result-${String(inputs.length)}`,
            }) as unknown as SDKMessage;
      }
    }
    return Object.assign(generate(), {
      close: () => undefined,
      interrupt: async () => undefined,
      ...(script.noUsage === true
        ? {}
        : {
            getContextUsage: async () => {
              const totals = script.contextTotals ?? [10_000];
              const totalTokens = totals[Math.min(usageIndex, totals.length - 1)] ?? 0;
              usageIndex += 1;
              return {
                categories: [],
                totalTokens,
                maxTokens: 1_000_000,
                rawMaxTokens: 1_000_000,
                percentage: totalTokens / 10_000,
                autoCompactThreshold: 200_000,
                isAutoCompactEnabled: true,
              };
            },
          }),
    }) as unknown as Query;
  }) as unknown as typeof sdkQuery;

  const clone = createClone({
    stores: createMemoryStores(),
    queryFn: fn,
    env: script.env ?? {},
    inboxSettleMs: 0,
    reportSettleMs: 0,
    runners: createRunnerRegistry([
      createLocalRunner({ workspacePath: '/work', queryFn: fn, env: {} }),
    ]),
  });
  return { clone, inputs };
}

let seq = 0;

function externalEvent(n: number, source = 'ci.main'): Record<string, unknown> {
  seq += 1;
  return {
    type: 'external',
    id: `evt-ext-${String(seq)}`,
    at: `2026-09-01T00:00:${String(10 + n).padStart(2, '0')}.000Z`,
    source,
    payload: { status: 'failure', n },
  };
}

async function deliver(s: Boot, event: Record<string, unknown>): Promise<string> {
  const before = s.inputs.length;
  s.clone.post(event as never);
  await waitFor(() => s.inputs.length > before, `入力 ${String(before + 1)} 本目`);
  return s.inputs[before] ?? '';
}

/** 外部イベントの入力のうち、枠付けの文より後ろ・本文の区切り（`---`）より前（2行の指示の部分）だけを返す。 */
function instructionOf(input: string): string {
  const at = input.indexOf(EXTERNAL_EVENT_FRAMING);
  expect(at, '枠付けの文が入力に無い').toBeGreaterThanOrEqual(0);
  const rest = input.slice(at + EXTERNAL_EVENT_FRAMING.length);
  const end = rest.indexOf('\n---');
  return rest.slice(0, end < 0 ? undefined : end).trim();
}

describe('外部イベントの2行の指示は、同じ会話の2回目から短い形になる（#5301）', () => {
  it('⭐ 畳みが切り（既定）なら、単発も束ねた入力も、2回目以降も2行の指示が全文のまま', async () => {
    const s = boot({ env: {} });
    const inputs = [
      await deliver(s, externalEvent(1)),
      await deliver(s, externalEvent(2)),
      await deliver(s, externalEvent(3)),
    ];
    for (const input of inputs) {
      const text = instructionOf(input);
      expect(text).toContain(INSTRUCTION_HEAD);
      expect(text).toContain(INSTRUCTION_TAIL);
      expect(input).toContain(EXTERNAL_EVENT_FRAMING);
    }
    expect(instructionOf(inputs[1] ?? '')).toBe(instructionOf(inputs[0] ?? ''));

    const before = s.inputs.length;
    s.clone.post(externalEvent(4) as never);
    s.clone.post(externalEvent(4) as never);
    await waitFor(() => s.inputs.length > before, '束の入力');
    const merged = s.inputs[before] ?? '';
    expect(merged, '同じ tick に積んだ2件は束の入力になる').toContain('まとめて渡す');
    expect(merged).toContain(INSTRUCTION_HEAD);
    expect(merged).toContain(INSTRUCTION_TAIL);
    await s.clone.stop();
  });

  it('⭐ 同じ入力の中で畳みを渡さない呼び出し（既定）は、全文のまま1文字も変わらない', () => {
    const plain = buildExternalEventPrompt({ source: 'ci', body: '本文' });
    expect(plain).toContain(INSTRUCTION_HEAD);
    expect(plain).toContain(INSTRUCTION_TAIL);
    expect(plain).toContain(EXTERNAL_EVENT_FRAMING);
  });
});
