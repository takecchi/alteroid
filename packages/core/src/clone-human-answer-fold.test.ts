import type { query as sdkQuery, Options, Query, SDKMessage } from '@anthropic-ai/claude-agent-sdk';
import { describe, expect, it } from 'vitest';

import { ALWAYS_REDELIVER, createClone } from './clone.js';
import { waitFor } from './clone-test-harness.js';
import type { CloneHost } from './host.js';
import { createRunnerRegistry } from './runner-protocol.js';
import { createLocalRunner } from './runner-local.js';
import { createMemoryStores } from './testing.js';

// #5301: 人間の答えを受けたターンの末尾（基準として記憶へ書く指示）を、同じ会話の2回目から参照にする。
// 全文へ戻す条件は #4937 の控え（`DigestSessionDelta`）そのもの。ここで新しい条件は足していない。

/** 全文にだけ在る説明の文（畳まれる側）。 */
const EXPLANATION = 'あなたが自分で決めるための材料である';
const REWRITE_DETAIL = '言葉に言い換えて記憶へ書くこと';
/** 短い形にも残す要点。 */
const CRITERIA_RULE = '拒否・条件付き・理由付きの答え';
const WRITE_TO_MEMORY = '基準として記憶へ書くこと';
const ASK_IF_UNCLEAR = '人間に訊くこと';

interface SdkScript {
  contextTotals?: readonly number[];
  noUsage?: boolean;
  failResultAt?: number;
  after?: (inputCount: number) => SDKMessage[];
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
    reportSettleMs: 2500,
    stores: createMemoryStores(),
    queryFn: fn,
    env: {},
    redeliveryGate: ALWAYS_REDELIVER,
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

const compactBoundary = {
  type: 'system',
  subtype: 'compact_boundary',
  compact_metadata: { trigger: 'auto', pre_tokens: 100_000 },
  session_id: 'sess-fake',
  uuid: 'uuid-compact',
} as unknown as SDKMessage;

describe('human_answer の末尾は、同じ会話の2回目から基準の指示が短い形になる（#5301）', () => {
  it('⭐ 初回は全文。2回目以降は字数が減り、要点（基準として記憶へ書く・読み取れなければ訊く）は残る', async () => {
    const s = boot();
    const firstInput = await deliver(s, answer(1));
    const secondInput = await deliver(s, answer(2));
    const thirdInput = await deliver(s, answer(3));
    const first = tailOf(firstInput);

    // (d) 初回は全文
    expect(first).toContain(EXPLANATION);
    expect(first).toContain(REWRITE_DETAIL);
    expect(first).toContain(CRITERIA_RULE);

    for (const input of [secondInput, thirdInput]) {
      const text = tailOf(input);
      // (a) 字数が減る
      expect(text).not.toContain(EXPLANATION);
      expect(text).not.toContain(REWRITE_DETAIL);
      expect(text.length).toBeLessThan(first.length * 0.7);
      // (b) 要点は短い形にも残る
      expect(text).toContain(CRITERIA_RULE);
      expect(text).toContain(WRITE_TO_MEMORY);
      expect(text).toContain(ASK_IF_UNCLEAR);
      // 回答そのものは毎回出る
      expect(input).toContain('回答: 答え');
    }
    expect(secondInput).toContain('回答: 答え2');
    process.stderr.write(
      `[#5301 測定] human_answer の末尾 1回目 ${String(first.length)} 字 → 2回目 ${String(tailOf(secondInput).length)} 字\n`,
    );
    await s.clone.stop();
  });

  it('⭐ 他の控えの全文表示に影響されない: 担当の報告の応じ方の全文を出しても、human_answer の初回は全文', async () => {
    const s = boot();
    // 他の固定文（報告の応じ方）の控えが先に全文で出ていても、この控えの id は別
    await deliver(s, { type: 'manager_message', managerId: 'mgr-x', kind: 'report', text: '報告' });
    const first = tailOf(await deliver(s, answer(1)));
    expect(first).toContain(EXPLANATION);
    const second = tailOf(await deliver(s, answer(2)));
    expect(second).not.toContain(EXPLANATION);
    await s.clone.stop();
  });

  it('⭐ 自動の要約が走った（compact_boundary）あとの入力は全文へ戻る', async () => {
    const s = boot({ after: (n) => (n === 2 ? [compactBoundary] : []) });
    await deliver(s, answer(1));
    const second = tailOf(await deliver(s, answer(2)));
    const third = tailOf(await deliver(s, answer(3)));
    expect(second).not.toContain(EXPLANATION);
    expect(third).toContain(EXPLANATION);
    await s.clone.stop();
  });

  it('⭐ 自動の要約が走りうる入力（前の量に伸びを足すと閾値に届く）は全文を出す', async () => {
    const s = boot({ contextTotals: [150_000, 180_000, 185_000] });
    await deliver(s, answer(1));
    const second = tailOf(await deliver(s, answer(2)));
    const third = tailOf(await deliver(s, answer(3)));
    expect(second).not.toContain(EXPLANATION);
    expect(third).toContain(EXPLANATION);
    await s.clone.stop();
  });

  it('⭐ 会話が変わった（init の session_id が変わった）あとの入力は全文へ戻る', async () => {
    const changedSession = {
      type: 'system',
      subtype: 'init',
      session_id: 'sess-other',
      uuid: 'uuid-init-2',
    } as unknown as SDKMessage;
    const s = boot({ after: (n) => (n === 2 ? [changedSession] : []) });
    await deliver(s, answer(1));
    const second = tailOf(await deliver(s, answer(2)));
    const third = tailOf(await deliver(s, answer(3)));
    expect(second).not.toContain(EXPLANATION);
    expect(third).toContain(EXPLANATION);
    await s.clone.stop();
  });

  it('⭐ 使用量の観測が取れない入力は全文', async () => {
    const s = boot({ noUsage: true });
    await deliver(s, answer(1));
    const second = tailOf(await deliver(s, answer(2)));
    expect(second).toContain(EXPLANATION);
    await s.clone.stop();
  });

  it('⭐ 失敗したターンの次の入力は全文。成功したターンの次は短い形のまま', async () => {
    const s = boot({ failResultAt: 2 });
    await deliver(s, answer(1));
    expect(tailOf(await deliver(s, answer(2)))).not.toContain(EXPLANATION);
    expect(tailOf(await deliver(s, answer(3)))).toContain(EXPLANATION);
    expect(tailOf(await deliver(s, answer(4)))).not.toContain(EXPLANATION);
    await s.clone.stop();
  });
});
