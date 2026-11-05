import type { query as sdkQuery, Options, Query, SDKMessage } from '@anthropic-ai/claude-agent-sdk';
import { describe, expect, it } from 'vitest';

import { createClone } from './clone.js';
import { waitFor } from './clone-test-harness.js';
import type { CloneHost } from './host.js';
import { createRunnerRegistry } from './runner-protocol.js';
import { createLocalRunner } from './runner-local.js';
import type { Stores } from './store.js';
import { createMemoryStores, humanMessage } from './testing.js';

// #5301: 記憶更新の頭（「記憶が更新された…」の説明）を、同じ会話の2回目から参照にする。
// 全文へ戻す条件は #4937 の控え（`DigestSessionDelta`）そのもの。ここで新しい条件は足していない。
// 載せる文書の本文（差分）・誰が書いたかの行・削除の行は畳まず毎回出る。

/** 全文にだけ在る説明の文（畳まれる側）。 */
const FULL_ONLY = '大きく変わっていなければ';
const FULL_ONLY_2 = 'このセッションを組んだ時点の索引';
/** 短い形にだけ在る印。 */
const REF_MARK = '読み方は前の更新と同じ';

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
  stores: Stores;
  inputs: string[];
  /** 文書を書き換えてから、人間の発言で1ターン回し、そのターンの入力を返す。 */
  update: (n: number) => Promise<string>;
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

  const stores = createMemoryStores();
  const clone = createClone({
    reportSettleMs: 2500,
    stores,
    queryFn: fn,
    env: script.env ?? {},
    runners: createRunnerRegistry([
      createLocalRunner({ workspacePath: '/work', queryFn: fn, env: {} }),
    ]),
  });

  const update = async (n: number): Promise<string> => {
    const before = inputs.length;
    await stores.persona.write(
      'notes',
      `# notes\n\n${Array.from({ length: n }, (_, i) => `メモ${String(i)}行目`).join('\n')}\n`,
    );
    clone.post(humanMessage(`発言${String(n)}`));
    await waitFor(() => inputs.length > before, `入力 ${String(before + 1)} 本目`);
    return inputs[before] ?? '';
  };
  return { clone, stores, inputs, update };
}

/** 変わらない文書を先に置き、最初のターン（差分なし）を回しておく。 */
async function bootWithBaseline(script: SdkScript = {}): Promise<Boot> {
  const s = boot(script);
  await s.stores.persona.write('about-me', '# about-me\n\n変わらない文書の本文\n');
  await s.update(1);
  return s;
}

/** 記憶更新の頭の部分（`[system] 記憶が更新された` から、最初の空行まで）。 */
function headOf(input: string): string {
  const at = input.indexOf('[system] 記憶が更新された');
  expect(at, '記憶更新の頭が入力に無い').toBeGreaterThanOrEqual(0);
  const rest = input.slice(at);
  const end = rest.indexOf('\n');
  // 頭は1行（誰が書いたかの行以降は別の行）
  return rest.slice(0, end < 0 ? undefined : end);
}

describe('記憶更新の頭は、同じ会話の2回目から短い形になる（#5301）', () => {
  it('⭐ 畳みが切り（既定）なら、2回目以降も記憶更新の頭が全文のまま', async () => {
    const s = await bootWithBaseline({ env: {} });
    const inputs = [await s.update(2), await s.update(3), await s.update(4)];
    const first = headOf(inputs[0] ?? '');
    for (const input of inputs) {
      const text = headOf(input);
      expect(text).toContain(FULL_ONLY);
      expect(text).toContain(FULL_ONLY_2);
      expect(text).not.toContain(REF_MARK);
      expect(text.length).toBe(first.length);
    }
    await s.clone.stop();
  });
});
