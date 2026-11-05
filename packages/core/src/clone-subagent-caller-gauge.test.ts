import type { query as sdkQuery, Options, Query, SDKMessage } from '@anthropic-ai/claude-agent-sdk';
import { describe, expect, it } from 'vitest';

import { createClone } from './clone.js';
import { flushPendingMicrotasks, waitFor } from './clone-test-harness.js';
import type { CloneHost } from './host.js';
import { createRunnerRegistry } from './runner-protocol.js';
import { createLocalRunner } from './runner-local.js';
import { captureStderr, createMemoryStores } from './testing.js';
import { createCloneMcpServer, createCloneTools, type ToolContext } from './tools.js';

// かつて「サブエージェント呼びの計器」が日誌（type=exchange・接頭辞 [計器]）へ残していた行は、もう出ない。
// 判定の結果を使う所が無かったため外した（道具が呼ぶ口 `ToolContext.isSubagentCall` だけは、次の PR まで何もしない形で残してある）。

const GAUGE_PHRASES = ['サブエージェント呼びの確認', '呼び手の判定'];

type Hook = (input: never, id: undefined, options: never) => Promise<unknown>;

type Stores = ReturnType<typeof createMemoryStores>;

interface Boot {
  clone: CloneHost;
  stores: Stores;
  inputs: string[];
  context: () => ToolContext;
  pre: () => Hook;
}

function boot(stores: Stores = createMemoryStores()): Boot {
  const inputs: string[] = [];
  let captured: ToolContext | undefined;
  let options: Options | undefined;
  const fn = ((params: { prompt: unknown; options?: Options }) => {
    options ??= params.options;
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
    stores,
    queryFn: fn,
    env: {},
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
    stores,
    inputs,
    context: () => {
      if (captured === undefined) throw new Error('道具の context がまだ組まれていない');
      return captured;
    },
    pre: () => {
      const pre = options?.hooks?.PreToolUse?.[0]?.hooks?.[0];
      if (!pre) throw new Error('hook が登録されていない');
      return pre as unknown as Hook;
    },
  };
}

let seq = 0;

async function turn(s: Boot): Promise<void> {
  const before = s.inputs.length;
  seq += 1;
  s.clone.post({
    type: 'manager_message',
    id: `evt-gauge-${seq}`,
    at: new Date().toISOString(),
    managerId: 'mgr-a',
    kind: 'report',
    text: `報告 ${seq}`,
  });
  await waitFor(() => s.inputs.length > before, `入力 ${before + 1} 本目`);
  await flushPendingMicrotasks();
}

const metaOf = (toolUseId: unknown): unknown => ({ _meta: { 'claudecode/toolUseId': toolUseId } });

async function runnerList(s: Boot, extra: unknown): Promise<void> {
  const tool = createCloneTools(s.context()).find((entry) => entry.name === 'runner_list');
  if (!tool) throw new Error('runner_list が無い');
  await tool.handler({} as never, extra as never);
}

const preOf = (toolName: string, toolUseId: string, agentId?: string, toolInput: unknown = {}) =>
  ({
    tool_name: toolName,
    tool_input: toolInput,
    tool_use_id: toolUseId,
    ...(agentId === undefined ? {} : { agent_id: agentId }),
  }) as never;

async function journalTexts(s: Boot): Promise<string[]> {
  await flushPendingMicrotasks();
  const rows = (await s.stores.journal.list({ limit: 1000 })) as { text?: string }[];
  return rows.map((row) => row.text ?? '');
}

describe('サブエージェント呼びの計器は日誌へ何も書かない', () => {
  it('hook（サブ・本体・各種の道具）と handler（_meta の有・無・型違い）の呼びのあとも、[計器] の呼び手の行は出ない', async () => {
    const s = boot();
    await turn(s);
    const before = (await journalTexts(s)).length;
    const pre = s.pre();
    await pre(preOf('mcp__alteroid__runner_list', 'tu-1', 'agent-1'), undefined, {} as never);
    await pre(preOf('Bash', 'tu-2', 'agent-1', { command: 'ls' }), undefined, {} as never);
    await pre(preOf('mcp__github__list', 'tu-3', 'agent-1'), undefined, {} as never);
    await pre(preOf('mcp__alteroid__runner_list', 'tu-4'), undefined, {} as never);
    await pre(preOf('mcp__alteroid__runner_list', 'tu-5', ''), undefined, {} as never);

    await runnerList(s, metaOf('tu-1'));
    await runnerList(s, metaOf('tu-4'));
    const stderr = await captureStderr(async () => {
      await runnerList(s, {});
      await runnerList(s, metaOf(42));
      await runnerList(s, metaOf(''));
    });

    const texts = await journalTexts(s);
    for (const phrase of GAUGE_PHRASES) {
      expect(texts.filter((text) => text.includes(phrase))).toEqual([]);
    }
    // hook と handler の呼びだけでは、日誌は1行も増えない
    expect(texts.length).toBe(before);
    expect(stderr.filter((line) => line.includes('tool_use_id'))).toEqual([]);
    await s.clone.stop();
  });

  it('道具が呼ぶ口 isSubagentCall は残してあり、常に本体の呼び（false）と答える', async () => {
    const s = boot();
    await turn(s);
    const pre = s.pre();
    await pre(preOf('mcp__alteroid__runner_list', 'tu-sub', 'agent-1'), undefined, {} as never);
    expect(s.context().isSubagentCall?.('tu-sub')).toBe(false);
    expect(s.context().isSubagentCall?.(undefined, 'missing')).toBe(false);
    await s.clone.stop();
  });
});
