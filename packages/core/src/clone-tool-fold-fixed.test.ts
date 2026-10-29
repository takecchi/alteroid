import type { query as sdkQuery, Options, Query, SDKMessage } from '@anthropic-ai/claude-agent-sdk';
import { describe, expect, it } from 'vitest';

import { SITUATION_FULL_EVERY_TURNS, createClone } from './clone.js';
import { flushPendingMicrotasks, TOKEN_SAVING_ENABLED_ENV, waitFor } from './clone-test-harness.js';
import type { CloneHost } from './host.js';
import { createRunnerRegistry } from './runner-protocol.js';
import { createLocalRunner } from './runner-local.js';
import { createMemoryStores } from './testing.js';
import { createCloneMcpServer, type ToolContext } from './tools.js';

// 道具の応答の固定の文言（`ToolContext.foldFixed`。`manager_list` が使う）を、同じ会話の2回目から参照にする。
// 全文へ戻す条件（会話が変わった・要約が走った・失敗したターンの後・使用量が観測できない回）は tick の要約の差分（DigestSessionDelta）と同じ口に乗る

interface Boot {
  clone: CloneHost;
  inputs: string[];
  context: () => ToolContext;
}

interface Script {
  // クローンの env。既定は畳みを有効にした env（本番の既定は無効: `ALTEROID_TOKEN_SAVING_FOLD_FIXED_TEXT`）
  env?: NodeJS.ProcessEnv;
  after?: (inputCount: number) => SDKMessage[];
  failResultAt?: number;
  usageUnobservable?: boolean;
}

const compactBoundary = {
  type: 'system',
  subtype: 'compact_boundary',
  compact_metadata: { trigger: 'auto', pre_tokens: 100_000 },
  session_id: 'sess-fake',
  uuid: 'uuid-compact',
} as unknown as SDKMessage;

function boot(script: Script = {}): Boot {
  const inputs: string[] = [];
  let captured: ToolContext | undefined;
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
      getContextUsage: async () => {
        if (script.usageUnobservable === true) throw new Error('使用量が取れない');
        return {
          categories: [],
          totalTokens: 10_000,
          maxTokens: 1_000_000,
          rawMaxTokens: 1_000_000,
          percentage: 1,
          autoCompactThreshold: 200_000,
          isAutoCompactEnabled: true,
        };
      },
    }) as unknown as Query;
  }) as unknown as typeof sdkQuery;
  const clone = createClone({
    stores: createMemoryStores(),
    queryFn: fn,
    env: script.env ?? TOKEN_SAVING_ENABLED_ENV,
    inboxSettleMs: 0,
    reportSettleMs: 0,
    mcpServerFactory: (context) => {
      captured = context;
      return createCloneMcpServer(context);
    },
    runners: createRunnerRegistry([
      createLocalRunner({ workspacePath: '/work', queryFn: fn, env: {} }),
    ]),
  });
  return {
    clone,
    inputs,
    context: () => {
      if (captured === undefined) throw new Error('道具の context がまだ組まれていない');
      return captured;
    },
  };
}

let seq = 0;

async function turn(s: Boot): Promise<void> {
  const before = s.inputs.length;
  seq += 1;
  s.clone.post({
    type: 'manager_message',
    id: `evt-fold-${seq}`,
    at: new Date().toISOString(),
    managerId: 'mgr-a',
    kind: 'report',
    text: `報告 ${seq}`,
  });
  await waitFor(() => s.inputs.length > before, `入力 ${before + 1} 本目`);
  // ターンの後始末（失敗の reset・要約の reset）が済むまで待つ
  // 壁時計ではなく microtask を進める（待ちの相手は journal・使用量の読み取りの microtask の連鎖）
  await flushPendingMicrotasks();
}

const fold = (s: Boot): string | undefined => s.context().foldFixed?.('probe', '全文', '参照');

describe('道具の応答の固定の文言の控え（ToolContext.foldFixed）', () => {
  it('⭐ 同じ会話の次のターンで参照になる（ターン間の持ち越しの破棄に消されない）', async () => {
    const s = boot();
    await turn(s);

    expect(fold(s)).toBe('全文');
    expect(fold(s)).toBe('参照');
    await turn(s);
    expect(fold(s)).toBe('参照');
    await s.clone.stop();
  });

  it.each([
    ['未設定', {}],
    ['0', { ALTEROID_TOKEN_SAVING_FOLD_FIXED_TEXT: '0' }],
    ['off', { ALTEROID_TOKEN_SAVING_FOLD_FIXED_TEXT: 'off' }],
    ['false', { ALTEROID_TOKEN_SAVING_FOLD_FIXED_TEXT: 'false' }],
  ] as const)('⭐ 畳みが切り（%s）なら、何度呼んでもターンをまたいでも全文', async (_name, env) => {
    const s = boot({ env });
    await turn(s);

    expect(fold(s)).toBe('全文');
    expect(fold(s)).toBe('全文');
    await turn(s);
    expect(fold(s)).toBe('全文');
    expect(fold(s)).toBe('全文');
    await s.clone.stop();
  });

  it('⭐ 自動の要約が走った（compact_boundary）あとは全文へ戻る', async () => {
    const s = boot({ after: (n) => (n === 2 ? [compactBoundary] : []) });
    await turn(s);
    expect(fold(s)).toBe('全文');

    await turn(s);

    expect(fold(s)).toBe('全文');
    await s.clone.stop();
  });

  it('⭐ 失敗したターンの後は全文へ戻る', async () => {
    const s = boot({ failResultAt: 2 });
    await turn(s);
    expect(fold(s)).toBe('全文');

    await turn(s);

    expect(fold(s)).toBe('全文');
    await s.clone.stop();
  });

  it('⭐ 一定ターン（situation と同じ SITUATION_FULL_EVERY_TURNS）ごとに全文へ戻る（要約の合図を取りこぼしたときの保険）', async () => {
    const s = boot();
    await turn(s);
    expect(fold(s)).toBe('全文');

    // 最初の全文の回の次から数えて、周期の手前までは参照のまま
    for (let n = 2; n <= SITUATION_FULL_EVERY_TURNS; n += 1) {
      await turn(s);
      expect(fold(s)).toBe('参照');
    }
    await turn(s);

    expect(fold(s)).toBe('全文');
    expect(fold(s)).toBe('参照');
    await s.clone.stop();
  });

  it('⭐ 使用量が観測できない回は全文へ戻る', async () => {
    const s = boot({ usageUnobservable: true });
    await turn(s);
    expect(fold(s)).toBe('全文');

    await turn(s);

    expect(fold(s)).toBe('全文');
    await s.clone.stop();
  });
});
