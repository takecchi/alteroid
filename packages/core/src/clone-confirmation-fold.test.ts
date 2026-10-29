import type { query as sdkQuery, Options, Query, SDKMessage } from '@anthropic-ai/claude-agent-sdk';
import { describe, expect, it } from 'vitest';

import { ALWAYS_REDELIVER, createClone } from './clone.js';
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

const compactBoundary = {
  type: 'system',
  subtype: 'compact_boundary',
  compact_metadata: { trigger: 'auto', pre_tokens: 100_000 },
  session_id: 'sess-fake',
  uuid: 'uuid-compact',
} as unknown as SDKMessage;

describe('マネージャーの質問・許可確認の応じ方は、同じ会話の2回目から骨組みが参照になる（#5299）', () => {
  it('⭐ 初回は全文。2回目以降は短い形になり字数が減る。宛先（managerId・requestId）は毎回出る', async () => {
    const s = boot();
    const first = guideOf(await deliver(s, confirmation('question', 'rq1')));
    const second = guideOf(await deliver(s, confirmation('question', 'rq2')));
    const third = guideOf(await deliver(s, confirmation('question', 'rq3')));

    // 初回は全文
    expect(first).toContain(SKELETON);
    expect(first).toContain(ASK_HUMAN_SKELETON);
    expect(first).toContain(`managerId: "${MANAGER_ID}", requestId: "rq1"`);
    expect(first).not.toContain(DECISION);

    for (const [text, requestId] of [
      [second, 'rq2'],
      [third, 'rq3'],
    ] as const) {
      expect(text).not.toContain(SKELETON);
      expect(text).not.toContain(ASK_HUMAN_SKELETON);
      expect(text).toContain(`managerId: "${MANAGER_ID}", requestId: "${requestId}"`);
      expect(text.length).toBeLessThan(first.length * 0.7);
    }
    process.stderr.write(
      `[#5299 測定] 質問の応じ方 1回目 ${String(first.length)} 字 → 2回目 ${String(second.length)} 字\n`,
    );
    await s.clone.stop();
  });

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

  it('⭐ 許可確認も同じ。decision（allow / deny）の指定は短い形にも残る', async () => {
    const s = boot();
    const first = guideOf(await deliver(s, confirmation('permission', 'rq1')));
    const second = guideOf(await deliver(s, confirmation('permission', 'rq2')));

    expect(first).toContain(DECISION);
    expect(first).toContain(SKELETON);
    expect(second).not.toContain(SKELETON);
    expect(second).toContain(DECISION);
    expect(second).toContain(`managerId: "${MANAGER_ID}", requestId: "rq2"`);
    expect(second.length).toBeLessThan(first.length * 0.7);
    process.stderr.write(
      `[#5299 測定] 許可確認の応じ方 1回目 ${String(first.length)} 字 → 2回目 ${String(second.length)} 字\n`,
    );
    await s.clone.stop();
  });

  it('⭐ 質問で全文を出した後の許可確認の初回は全文（控えの id が別）。その次は短い形', async () => {
    const s = boot();
    await deliver(s, confirmation('question', 'rq1'));
    const permissionFirst = guideOf(await deliver(s, confirmation('permission', 'rq2')));
    expect(permissionFirst).toContain(SKELETON);
    expect(permissionFirst).toContain(DECISION);
    const permissionSecond = guideOf(await deliver(s, confirmation('permission', 'rq3')));
    expect(permissionSecond).not.toContain(SKELETON);
    // 質問の側も、すでに全文を出しているので短い形のまま
    const questionSecond = guideOf(await deliver(s, confirmation('question', 'rq4')));
    expect(questionSecond).not.toContain(SKELETON);
    await s.clone.stop();
  });

  it('⭐ 自動の要約が走った（compact_boundary）あとの入力は全文へ戻る', async () => {
    const s = boot({ after: (n) => (n === 2 ? [compactBoundary] : []) });
    await deliver(s, confirmation('question', 'rq1'));
    const second = guideOf(await deliver(s, confirmation('question', 'rq2')));
    const third = guideOf(await deliver(s, confirmation('question', 'rq3')));
    expect(second).not.toContain(SKELETON);
    expect(third).toContain(SKELETON);
    expect(third).toContain('requestId: "rq3"');
    await s.clone.stop();
  });

  it('⭐ 自動の要約が走りうる入力（前の量に伸びを足すと閾値に届く）は全文を出す', async () => {
    const s = boot({ contextTotals: [150_000, 180_000, 185_000] });
    await deliver(s, confirmation('question', 'rq1'));
    const second = guideOf(await deliver(s, confirmation('question', 'rq2')));
    const third = guideOf(await deliver(s, confirmation('question', 'rq3')));
    expect(second).not.toContain(SKELETON);
    expect(third).toContain(SKELETON);
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
    await deliver(s, confirmation('permission', 'rq1'));
    const second = guideOf(await deliver(s, confirmation('permission', 'rq2')));
    const third = guideOf(await deliver(s, confirmation('permission', 'rq3')));
    expect(second).not.toContain(SKELETON);
    expect(third).toContain(SKELETON);
    expect(third).toContain(DECISION);
    await s.clone.stop();
  });

  it('⭐ 使用量の観測が取れない入力は全文', async () => {
    const s = boot({ noUsage: true });
    await deliver(s, confirmation('question', 'rq1'));
    const second = guideOf(await deliver(s, confirmation('question', 'rq2')));
    expect(second).toContain(SKELETON);
    await s.clone.stop();
  });

  it('⭐ 失敗したターンの次の入力は全文。成功したターンの次は短い形のまま', async () => {
    const s = boot({ failResultAt: 2 });
    await deliver(s, confirmation('question', 'rq1'));
    const second = guideOf(await deliver(s, confirmation('question', 'rq2')));
    expect(second).not.toContain(SKELETON);
    const third = guideOf(await deliver(s, confirmation('question', 'rq3')));
    expect(third).toContain(SKELETON);
    const fourth = guideOf(await deliver(s, confirmation('question', 'rq4')));
    expect(fourth).not.toContain(SKELETON);
    expect(fourth).toContain('requestId: "rq4"');
    await s.clone.stop();
  });
});

describe('根拠が無いときの ask_human の宛先の指定は、短い形にも残る', () => {
  it.each(['question', 'permission'] as const)('%s の2回目', async (kind) => {
    const s = boot();
    await deliver(s, confirmation(kind, 'rq1'));
    const second = guideOf(await deliver(s, confirmation(kind, 'rq2')));
    expect(second).not.toContain(SKELETON);
    expect(second).toContain(
      `返事は \`manager_send\`、根拠が無ければ \`ask_human\`。どちらにも宛先 managerId: "${MANAGER_ID}", requestId: "rq2" を添える`,
    );
    expect(second).toContain('添え損ねると人間が答えても再開できない');
    await s.clone.stop();
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
