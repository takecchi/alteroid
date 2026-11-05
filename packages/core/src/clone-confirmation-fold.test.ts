import type { query as sdkQuery, Options, Query, SDKMessage } from '@anthropic-ai/claude-agent-sdk';
import { describe, expect, it } from 'vitest';

import { createClone } from './clone.js';
import { TOKEN_SAVING_ENABLED_ENV, waitFor } from './clone-test-harness.js';
import type { CloneHost } from './host.js';
import { createRunnerRegistry } from './runner-protocol.js';
import { createLocalRunner } from './runner-local.js';
import { createMemoryStores, humanMessage } from './testing.js';

// #5299: マネージャーからの質問・許可確認（いま待たれているもの）の応じ方の骨組みを、同じ会話の2回目から参照にする。
// 全文へ戻す条件は #4937 の控え（`DigestSessionDelta`）そのもの。ここで新しい条件は足していない。

const MANAGER_ID = 'mgr-aaaa1111';
const SKELETON = 'のこの1件だけが止まっている';
const ASK_HUMAN_SKELETON = '人間の回答が届いてから同じ宛先へ';
const DECISION = '`decision` に allow / deny を明示すること';

interface SdkScript {
  contextTotals?: readonly number[];
  noUsage?: boolean;
  failResultAt?: number;
  after?: (inputCount: number) => SDKMessage[];
  // クローンの env。既定は畳みを有効にした env（本番の既定は無効: `ALTEROID_TOKEN_SAVING_FOLD_FIXED_TEXT`）
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

  // 確認が「いま待たれている」ことにする（managers.list() が waiting を返す）
  const now = new Date().toISOString();
  const waiting = Array.from({ length: 12 }, (_, index) => ({
    requestId: `rq${String(index + 1)}`,
    kind: 'question',
    askedAt: now,
    summary: 's',
  }));
  const managers = {
    list: async () => [
      {
        managerId: MANAGER_ID,
        status: 'running',
        live: true,
        cwd: '/work',
        request: '依頼',
        startedAt: now,
        updatedAt: now,
        waiting,
      },
    ],
    runners: async () => ({
      runners: [],
      unassigned: [],
      daemonRevision: { status: 'unknown', reason: 't' },
    }),
    denials: () => [],
    pushHealthOf: () => undefined,
    runnerBacklog: () => [],
    runnerIdOf: async () => undefined,
    runningManagerOwning: () => undefined,
    restore: async () => [],
    resumeStoppedByUsage: async () => [],
    reattachRunner: async () => undefined,
    probeTurnEnds: async () => undefined,
    flushWithheldReports: async () => undefined,
    settleStalledUsageWakes: async () => [],
    renotifyStalledDenials: async () => undefined,
    stop: async () => undefined,
  } as never;

  const clone = createClone({
    stores: createMemoryStores(),
    queryFn: fn,
    env: script.env ?? TOKEN_SAVING_ENABLED_ENV,
    managers,
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
    id: `evt-confirm-${String(seq)}`,
    at: new Date().toISOString(),
    ...event,
  } as never);
  await waitFor(() => s.inputs.length > before, `入力 ${String(before + 1)} 本目`);
  return s.inputs[before] ?? '';
}

const confirmation = (kind: 'question' | 'permission', requestId: string) => ({
  type: 'manager_message',
  managerId: MANAGER_ID,
  kind,
  text: kind === 'question' ? '質問の本文' : '実行の許可確認の本文',
  requestId,
});

/** 確認の包みのうち、宛先の行を含む「応じ方」の部分（起点の会話の行より後ろ）だけを返す。 */
function guideOf(input: string): string {
  const lines = input.split('\n');
  const start = lines.findIndex((line) => line.startsWith('起点の会話'));
  expect(start, '起点の会話の行が入力に無い').toBeGreaterThanOrEqual(0);
  const next = lines.slice(start + 1);
  const end = next.findIndex((line) => line.startsWith('[system]'));
  return next.slice(0, end < 0 ? undefined : end).join('\n');
}

describe('マネージャーの質問・許可確認の応じ方は、同じ会話の2回目から骨組みが参照になる（#5299）', () => {
  it('⭐ 畳みが切り（既定）なら、質問も許可確認も2回目以降も応じ方が全文のまま', async () => {
    for (const kind of ['question', 'permission'] as const) {
      const s = boot({ env: {} });
      const first = guideOf(await deliver(s, confirmation(kind, 'rq1')));
      const second = guideOf(await deliver(s, confirmation(kind, 'rq2')));
      const third = guideOf(await deliver(s, confirmation(kind, 'rq3')));

      for (const [text, requestId] of [
        [first, 'rq1'],
        [second, 'rq2'],
        [third, 'rq3'],
      ] as const) {
        expect(text).toContain(SKELETON);
        expect(text).toContain(ASK_HUMAN_SKELETON);
        expect(text).toContain(`managerId: "${MANAGER_ID}", requestId: "${requestId}"`);
        if (kind === 'permission') expect(text).toContain(DECISION);
      }
      expect(second.length).toBe(first.length);
      expect(third.length).toBe(first.length);
      await s.clone.stop();
    }
  });
});

// 人間の発言などの無関係な入力では起きない: 確認の分岐だけが対象
describe('確認の分岐以外は変わらない', () => {
  it('人間の発言の入力に、確認の応じ方は出ない', async () => {
    const s = boot();
    const before = s.inputs.length;
    s.clone.post(humanMessage('こんにちは'));
    await waitFor(() => s.inputs.length > before, '入力');
    expect(s.inputs[before]).not.toContain(SKELETON);
    await s.clone.stop();
  });
});
