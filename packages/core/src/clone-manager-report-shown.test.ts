import type { query as sdkQuery, Options, Query, SDKMessage } from '@anthropic-ai/claude-agent-sdk';
import { describe, expect, it } from 'vitest';

import { ALWAYS_REDELIVER, createClone } from './clone.js';
import { waitFor } from './clone-test-harness.js';
import type { CloneHost } from './host.js';
import { createRunnerRegistry } from './runner-protocol.js';
import { createLocalRunner } from './runner-local.js';
import type { Stores } from './store.js';
import { createMemoryStores } from './testing.js';
import { createCloneMcpServer, type ToolContext } from './tools.js';

// 担当の報告の全文を発言に載せたことの控え（`manager_report` の引き直しを畳む）。全文へ戻す条件は tick の要約の差分（DigestSessionDelta）と同じ口に乗る

interface Boot {
  clone: CloneHost;
  stores: Stores;
  inputs: string[];
  context: () => ToolContext;
}

interface Script {
  after?: (inputCount: number) => SDKMessage[];
  failFirstStarts?: number;
  failResultAt?: number;
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
  let starts = 0;
  let captured: ToolContext | undefined;
  const fn = ((params: { prompt: unknown; options?: Options }) => {
    starts += 1;
    if (starts <= (script.failFirstStarts ?? 0)) throw new Error('起動に失敗した');
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
  const stores = createMemoryStores();
  const clone = createClone({
    stores,
    queryFn: fn,
    env: {},
    inboxSettleMs: 0,
    reportSettleMs: 0,
    redeliveryGate: ALWAYS_REDELIVER,
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
    stores,
    inputs,
    context: () => {
      if (captured === undefined) throw new Error('道具の context がまだ組まれていない');
      return captured;
    },
  };
}

let seq = 0;

async function report(s: Boot, managerId: string, text: string): Promise<string> {
  const before = s.inputs.length;
  seq += 1;
  s.clone.post({
    type: 'manager_message',
    id: `evt-report-${seq}`,
    at: new Date().toISOString(),
    managerId,
    kind: 'report',
    text,
  });
  await waitFor(() => s.inputs.length > before, `報告の入力 ${before + 1} 本目`);
  return s.inputs[before] ?? '';
}

const body = (label: string, chars: number): string =>
  `${label}。${'報告の本文が続く。'.repeat(Math.ceil(chars / 9))}`.slice(0, chars);

describe('報告の全文を発言に載せたことの控え', () => {
  it('⭐ 全文を載せた報告は控えられ、同じ担当・同じ本文だけが当たる', async () => {
    const s = boot();
    const text = body('5K字の報告', 5_000);

    const input = await report(s, 'mgr-a', text);

    expect(input).toContain(text);
    const shownAt = s.context().managerReportShownAt?.('mgr-a', text);
    expect(shownAt).toBeInstanceOf(Date);
    expect(s.context().managerReportShownAt?.('mgr-b', text)).toBeNull();
    expect(s.context().managerReportShownAt?.('mgr-a', `${text}違う`)).toBeNull();
    await s.clone.stop();
  });

  it('⭐ 束の予算で切り詰めた報告は控えない（発言に全文が載っていない）', async () => {
    const s = boot();
    const text = body('大きな報告', 60_000);

    const input = await report(s, 'mgr-a', text);

    expect(input).not.toContain(text);
    expect(s.context().managerReportShownAt?.('mgr-a', text)).toBeNull();
    await s.clone.stop();
  });

  it('短い報告は控えない', async () => {
    const s = boot();

    await report(s, 'mgr-a', '短い報告');

    expect(s.context().managerReportShownAt?.('mgr-a', '短い報告')).toBeNull();
    await s.clone.stop();
  });

  it('⭐ 自動の要約が走った（compact_boundary）あとは控えが消える', async () => {
    const s = boot({ after: (n) => (n === 1 ? [compactBoundary] : []) });
    const text = body('要約の前の報告', 5_000);

    await report(s, 'mgr-a', text);

    await waitFor(
      () => s.context().managerReportShownAt?.('mgr-a', text) === null,
      '要約のあとに控えが消える',
    );
    await s.clone.stop();
  });

  it('⭐ 失敗したターンの報告は控えない', async () => {
    const s = boot({ failResultAt: 1 });
    const text = body('失敗するターンの報告', 5_000);

    await report(s, 'mgr-a', text);

    await waitFor(
      () => s.context().managerReportShownAt?.('mgr-a', text) === null,
      '失敗の後は控えが無い',
    );
    await s.clone.stop();
  });

  it('⭐ 入力を SDK へ押し込めなかった回（起動の失敗）は控えない', async () => {
    const s = boot({ failFirstStarts: 1 });
    const text = body('押し込めない報告', 5_000);
    seq += 1;
    s.clone.post({
      type: 'manager_message',
      id: `evt-report-${seq}`,
      at: new Date().toISOString(),
      managerId: 'mgr-a',
      kind: 'report',
      text,
    });
    // 入力は組まれた（日誌に行が残る）が、SDK へは入らなかった
    await waitFor(async () => {
      const rows = (await s.stores.journal.list({ types: ['exchange'] })) as { text: string }[];
      return rows.some((row) => row.text.includes(text));
    }, '失敗する報告の入力の行');
    expect(s.inputs).toEqual([]);
    // 道具の context は2回目の起動で組まれる。次に入った入力の後で、失敗した回の報告が控えにないことを見る
    const next = body('次の報告', 5_000);
    await report(s, 'mgr-b', next);

    expect(s.context().managerReportShownAt?.('mgr-b', next)).toBeInstanceOf(Date);
    expect(s.context().managerReportShownAt?.('mgr-a', text)).toBeNull();
    await s.clone.stop();
  });
});
