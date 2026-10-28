import type { query as sdkQuery, Options, Query, SDKMessage } from '@anthropic-ai/claude-agent-sdk';
import { describe, expect, it } from 'vitest';

import { ALWAYS_REDELIVER, createClone } from './clone.js';
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
/** 短い形にも残す要点。 */
const KEEP_ASK_HUMAN = '`ask_human`';
const KEEP_JOURNAL_WRITE = '`journal_write`';

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
    stores: createMemoryStores(),
    queryFn: fn,
    env: {},
    inboxSettleMs: 0,
    reportSettleMs: 0,
    redeliveryGate: ALWAYS_REDELIVER,
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

const compactBoundary = {
  type: 'system',
  subtype: 'compact_boundary',
  compact_metadata: { trigger: 'auto', pre_tokens: 100_000 },
  session_id: 'sess-fake',
  uuid: 'uuid-compact',
} as unknown as SDKMessage;

describe('外部イベントの2行の指示は、同じ会話の2回目から短い形になる（#5301）', () => {
  it('⭐ 初回は全文。2回目以降は字数が減り、ask_human / journal_write の要点は残る。枠付けの安全の文は毎回出る', async () => {
    const s = boot();
    const firstInput = await deliver(s, externalEvent(1));
    const secondInput = await deliver(s, externalEvent(2));
    const thirdInput = await deliver(s, externalEvent(3));
    const first = instructionOf(firstInput);

    // (d) 初回は全文
    expect(first).toContain(INSTRUCTION_HEAD);
    expect(first).toContain(INSTRUCTION_TAIL);

    for (const input of [secondInput, thirdInput]) {
      const text = instructionOf(input);
      // (a) 字数が減る
      expect(text).not.toContain(INSTRUCTION_HEAD);
      expect(text).not.toContain(INSTRUCTION_TAIL);
      expect(text.length).toBeLessThan(first.length * 0.7);
      // (b) 要点は短い形にも残る
      expect(text).toContain(KEEP_ASK_HUMAN);
      expect(text).toContain(KEEP_JOURNAL_WRITE);
      // 安全の文は毎回出る
      expect(input).toContain(EXTERNAL_EVENT_FRAMING);
    }
    process.stderr.write(
      `[#5301 測定] 外部イベントの2行の指示 1回目 ${String(first.length)} 字 → 2回目 ${String(instructionOf(secondInput).length)} 字\n`,
    );
    await s.clone.stop();
  });

  it('⭐ 同じ入力の中で畳みを渡さない呼び出し（既定）は、全文のまま1文字も変わらない', () => {
    const plain = buildExternalEventPrompt({ source: 'ci', body: '本文' });
    expect(plain).toContain(INSTRUCTION_HEAD);
    expect(plain).toContain(INSTRUCTION_TAIL);
    expect(plain).toContain(EXTERNAL_EVENT_FRAMING);
  });

  it('⭐ 束ねた入力（まとめて渡す）も、2回目以降は短い形。枠付けは毎回出る。単発で出した全文と控えを共有する', async () => {
    const s = boot();
    const first = await deliver(s, externalEvent(1));
    expect(first).toContain(INSTRUCTION_HEAD);

    const before = s.inputs.length;
    s.clone.post(externalEvent(2) as never);
    s.clone.post(externalEvent(2) as never);
    await waitFor(() => s.inputs.length > before, '束の入力');
    const merged = s.inputs[before] ?? '';
    expect(merged, '同じ tick に積んだ2件は束の入力になる').toContain('まとめて渡す');
    expect(merged).not.toContain(INSTRUCTION_HEAD);
    expect(merged).toContain(KEEP_ASK_HUMAN);
    expect(merged).toContain(KEEP_JOURNAL_WRITE);
    expect(merged).toContain(EXTERNAL_EVENT_FRAMING);
    await s.clone.stop();
  });

  it('⭐ 他の控えの全文表示に影響されない: 担当の報告の応じ方を先に全文で出しても、外部イベントの初回は全文', async () => {
    const s = boot();
    await deliver(s, {
      type: 'manager_message',
      id: 'evt-report-1',
      at: new Date().toISOString(),
      managerId: 'mgr-x',
      kind: 'report',
      text: '報告',
    });
    const first = instructionOf(await deliver(s, externalEvent(1)));
    expect(first).toContain(INSTRUCTION_HEAD);
    const second = instructionOf(await deliver(s, externalEvent(2)));
    expect(second).not.toContain(INSTRUCTION_HEAD);
    await s.clone.stop();
  });

  it('⭐ 自動の要約が走った（compact_boundary）あとの入力は全文へ戻る', async () => {
    const s = boot({ after: (n) => (n === 2 ? [compactBoundary] : []) });
    await deliver(s, externalEvent(1));
    const second = instructionOf(await deliver(s, externalEvent(2)));
    const third = instructionOf(await deliver(s, externalEvent(3)));
    expect(second).not.toContain(INSTRUCTION_HEAD);
    expect(third).toContain(INSTRUCTION_HEAD);
    await s.clone.stop();
  });

  it('⭐ 自動の要約が走りうる入力（前の量に伸びを足すと閾値に届く）は全文を出す', async () => {
    const s = boot({ contextTotals: [150_000, 180_000, 185_000] });
    await deliver(s, externalEvent(1));
    const second = instructionOf(await deliver(s, externalEvent(2)));
    const third = instructionOf(await deliver(s, externalEvent(3)));
    expect(second).not.toContain(INSTRUCTION_HEAD);
    expect(third).toContain(INSTRUCTION_HEAD);
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
    await deliver(s, externalEvent(1));
    const second = instructionOf(await deliver(s, externalEvent(2)));
    const third = instructionOf(await deliver(s, externalEvent(3)));
    expect(second).not.toContain(INSTRUCTION_HEAD);
    expect(third).toContain(INSTRUCTION_HEAD);
    await s.clone.stop();
  });

  it('⭐ 使用量の観測が取れない入力は全文', async () => {
    const s = boot({ noUsage: true });
    await deliver(s, externalEvent(1));
    const second = instructionOf(await deliver(s, externalEvent(2)));
    expect(second).toContain(INSTRUCTION_HEAD);
    await s.clone.stop();
  });

  it('⭐ 失敗したターンの次の入力は全文。成功したターンの次は短い形のまま', async () => {
    const s = boot({ failResultAt: 2 });
    await deliver(s, externalEvent(1));
    expect(instructionOf(await deliver(s, externalEvent(2)))).not.toContain(INSTRUCTION_HEAD);
    expect(instructionOf(await deliver(s, externalEvent(3)))).toContain(INSTRUCTION_HEAD);
    expect(instructionOf(await deliver(s, externalEvent(4)))).not.toContain(INSTRUCTION_HEAD);
    await s.clone.stop();
  });
});
