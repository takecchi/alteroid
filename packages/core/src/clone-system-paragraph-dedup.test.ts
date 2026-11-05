import type { query as sdkQuery, Options, Query, SDKMessage } from '@anthropic-ai/claude-agent-sdk';
import { describe, expect, it } from 'vitest';

import {
  DENIAL_ASK_AFTER_ANSWER_PARAGRAPH,
  DENIAL_ASK_AFTER_ANSWER_PARAGRAPH_BASH_RULE,
} from './classifier-denial-streak.js';
import { createClone } from './clone.js';
import { waitFor } from './clone-test-harness.js';
import type { CloneHost } from './host.js';
import { createRunnerRegistry } from './runner-protocol.js';
import { createLocalRunner } from './runner-local.js';
import { createMemoryStores } from './testing.js';

// #4943: システムが作った長い段落は、同じ会話の2回目以降も全文のまま出す（畳みは外した）

/** 畳んでいた頃に長い段落の代わりに出していた参照の文。出ないことを見る。 */
const SYSTEM_PARAGRAPH_REF = '（前に出した段落と同じ。会話の上にある）';

interface Boot {
  clone: CloneHost;
  inputs: string[];
  fire: () => Promise<void>;
}

interface Script {
  /** n 番目（1始まり）の入力を、成功ではなく失敗の result で終える。 */
  failResultAt?: number;
  /** n 番目（1始まり）の入力を受けたあとで、結果の前に流す出来事。 */
  after?: (inputCount: number) => SDKMessage[];
  /** 起動そのものを失敗させる回数（先頭から）。 */
  failFirstStarts?: number;
  /** 1ターンへ束ねる合図の上限（`createClone` の `mergedBatchLimit`）。 */
  mergedBatchLimit?: number;
  /** クローンの env。既定は空（畳みの節約は外した）。 */
  env?: NodeJS.ProcessEnv;
}

function boot(script: Script = {}): Boot {
  const inputs: string[] = [];
  const captured: { options: Options | undefined } = { options: undefined };
  let starts = 0;
  const fn = ((params: { prompt: unknown; options?: Options }) => {
    starts += 1;
    if (starts <= (script.failFirstStarts ?? 0)) throw new Error('起動に失敗した');
    captured.options ??= params.options;
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
      // 使用量の観測が取れない回は全文に戻す（#4941）ので、畳む側を見るために閾値から遠い観測を返す
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
    stores: createMemoryStores(),
    queryFn: fn,
    env: script.env ?? {},
    inboxSettleMs: 0,
    reportSettleMs: 0,
    ...(script.mergedBatchLimit === undefined ? {} : { mergedBatchLimit: script.mergedBatchLimit }),
    runners: createRunnerRegistry([
      createLocalRunner({ workspacePath: '/work', queryFn: fn, env: {} }),
    ]),
  });
  return {
    clone,
    inputs,
    fire: async () => {
      const hook = captured.options?.hooks?.PreCompact?.[0]?.hooks?.[0];
      if (hook === undefined) throw new Error('PreCompact フックが登録されていない');
      await hook({ session_id: 'sess-fake' } as never, undefined, {
        signal: new AbortController().signal,
      } as never);
    },
  };
}

let seq = 0;

/** runner の `#onPermissionDenied` が組む確認の本文と同じ形（段落は空行で分ける）。 */
function denialAsk(
  reason: string,
  head: string,
  paragraph: string = DENIAL_ASK_AFTER_ANSWER_PARAGRAPH,
): string {
  return (
    `分類器が manager の Bash 呼び出しを拒否した。この1回だけ許可しますか。\n\n` +
    `${paragraph}\n\n` +
    `理由: ${reason}\n` +
    `入力の先頭（伏せ字・最大160字。issue #1105 P0）: ${head}`
  );
}

async function send(s: Boot, event: Record<string, unknown>): Promise<string> {
  const before = s.inputs.length;
  seq += 1;
  s.clone.post({
    id: `evt-${String(seq)}`,
    at: new Date().toISOString(),
    ...event,
  } as never);
  await waitFor(() => s.inputs.length > before, `入力 ${String(before + 1)} 本目`);
  return s.inputs[before] ?? '';
}

function denial(s: Boot, reason: string, head: string, paragraph?: string): Promise<string> {
  return send(s, {
    type: 'manager_message',
    managerId: 'mgr-1',
    kind: 'permission',
    requestId: `toolu_${String(seq + 1)}`,
    text: denialAsk(reason, head, paragraph),
  });
}

describe('システムが作った長い段落は、同じ会話の2回目から短い参照になる（#4943）', () => {
  it('⭐ 畳みが切り（既定）なら、分類器の拒否の確認が何回来ても固定の説明は毎回全文で、参照の行が出ない', async () => {
    const s = boot({ env: {} });

    const first = await denial(s, '破壊的な操作に見えた（1回目）', 'rm -rf ./a');
    const second = await denial(s, '外部への送信に見えた（2回目）', 'curl -X POST ./b');
    const third = await denial(
      s,
      '外部への送信に見えた（3回目）',
      'git push origin c',
      DENIAL_ASK_AFTER_ANSWER_PARAGRAPH_BASH_RULE,
    );

    for (const text of [first, second]) {
      expect(text).toContain(DENIAL_ASK_AFTER_ANSWER_PARAGRAPH);
    }
    expect(third).toContain(DENIAL_ASK_AFTER_ANSWER_PARAGRAPH_BASH_RULE);
    for (const text of [first, second, third]) {
      expect(text).not.toContain(SYSTEM_PARAGRAPH_REF);
    }
    expect(second).toContain('理由: 外部への送信に見えた（2回目）');
    await s.clone.stop();
  });
});
