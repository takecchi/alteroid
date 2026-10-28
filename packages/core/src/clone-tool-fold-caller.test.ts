import type { query as sdkQuery, Options, Query, SDKMessage } from '@anthropic-ai/claude-agent-sdk';
import { describe, expect, it } from 'vitest';

import { ALWAYS_REDELIVER, createClone } from './clone.js';
import { flushPendingMicrotasks, waitFor } from './clone-test-harness.js';
import type { CloneHost } from './host.js';
import { createRunnerRegistry } from './runner-protocol.js';
import { createLocalRunner } from './runner-local.js';
import { captureStderr, createMemoryStores } from './testing.js';
import { createCloneMcpServer, createCloneTools, type ToolContext } from './tools.js';

// 道具の応答の固定の文言の畳み（ToolContext.foldFixed）は、本体の会話の上の全文を指す。
// サブエージェントの呼びは畳まず、本体の控えも更新しない（#5428）。呼び手は PreToolUse の agent_id と、handler が読む extra._meta の tool_use_id で結ぶ

const FULL_MARK = 'インメモリ';
const REF_MARK = 'デーモンの再起動で作り直される。';

type Hook = (input: never, id: undefined, options: never) => Promise<unknown>;

interface Boot {
  clone: CloneHost;
  inputs: string[];
  context: () => ToolContext;
  hooks: () => { pre: Hook; post: Hook; failure: Hook; stop: Hook };
}

function boot(): Boot {
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
    stores: createMemoryStores(),
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
    inputs,
    context: () => {
      if (captured === undefined) throw new Error('道具の context がまだ組まれていない');
      return captured;
    },
    hooks: () => {
      const hooks = options?.hooks;
      const pre = hooks?.PreToolUse?.[0]?.hooks?.[0];
      const post = hooks?.PostToolUse?.[0]?.hooks?.[0];
      const failure = hooks?.PostToolUseFailure?.[0]?.hooks?.[0];
      const stop = hooks?.SubagentStop?.[0]?.hooks?.[0];
      if (!pre || !post || !failure || !stop) throw new Error('hook が登録されていない');
      return { pre, post, failure, stop } as unknown as ReturnType<Boot['hooks']>;
    },
  };
}

let seq = 0;

async function turn(s: Boot): Promise<void> {
  const before = s.inputs.length;
  seq += 1;
  s.clone.post({
    type: 'manager_message',
    id: `evt-caller-${seq}`,
    at: new Date().toISOString(),
    managerId: 'mgr-a',
    kind: 'report',
    text: `報告 ${seq}`,
  });
  await waitFor(() => s.inputs.length > before, `入力 ${before + 1} 本目`);
  await flushPendingMicrotasks();
}

const metaOf = (toolUseId: string): unknown => ({ _meta: { 'claudecode/toolUseId': toolUseId } });

// `runner_list` の末尾の固定文（`runner-list:since-note`）は、畳みの対象で、器が空でも必ず出る
async function runnerList(s: Boot, extra: unknown): Promise<string> {
  const tool = createCloneTools(s.context()).find((entry) => entry.name === 'runner_list');
  if (!tool) throw new Error('runner_list が無い');
  const result = await tool.handler({} as never, extra as never);
  return (result.content ?? []).map((block) => (block.type === 'text' ? block.text : '')).join('');
}

const preOf = (toolUseId: string, agentId?: string) =>
  ({
    tool_name: 'mcp__alteroid-clone__runner_list',
    tool_input: {},
    tool_use_id: toolUseId,
    ...(agentId === undefined ? {} : { agent_id: agentId }),
  }) as never;

const settleOf = (toolUseId: string) =>
  ({
    tool_name: 'mcp__alteroid-clone__runner_list',
    tool_input: {},
    tool_use_id: toolUseId,
    tool_response: 'ok',
    error: 'x',
  }) as never;

describe('固定の文言の畳みの呼び手の区別（#5428）', () => {
  it('⭐ (a) サブエージェントの呼びの後に本体が呼ぶと、本体は全文を受け取る', async () => {
    const s = boot();
    await turn(s);
    const { pre } = s.hooks();
    await pre(preOf('tu-sub', 'agent-1'), undefined, {} as never);
    await pre(preOf('tu-main'), undefined, {} as never);

    const sub = await runnerList(s, metaOf('tu-sub'));
    const main = await runnerList(s, metaOf('tu-main'));

    expect(sub).toContain(FULL_MARK);
    expect(main).toContain(FULL_MARK);
    await s.clone.stop();
  });

  it('⭐ (b) 本体の呼びの後のサブエージェントの呼びは全文で、本体の控えを更新しない', async () => {
    const s = boot();
    await turn(s);
    const { pre } = s.hooks();
    await pre(preOf('tu-main-1'), undefined, {} as never);
    await pre(preOf('tu-sub', 'agent-1'), undefined, {} as never);
    await pre(preOf('tu-main-2'), undefined, {} as never);

    const main1 = await runnerList(s, metaOf('tu-main-1'));
    const sub = await runnerList(s, metaOf('tu-sub'));
    const main2 = await runnerList(s, metaOf('tu-main-2'));

    expect(main1).toContain(FULL_MARK);
    expect(sub).toContain(FULL_MARK);
    expect(main2).not.toContain(FULL_MARK);
    expect(main2).toContain(REF_MARK);
    await s.clone.stop();
  });

  it('⭐ (c) tool_use_id が取れないときは今までどおり畳み、警告は1セッションで1回だけ', async () => {
    const s = boot();
    await turn(s);

    const lines = await captureStderr(async () => {
      const first = await runnerList(s, {});
      const second = await runnerList(s, { _meta: { 'claudecode/toolUseId': 42 } });
      const third = await runnerList(s, undefined);
      expect(first).toContain(FULL_MARK);
      expect(second).not.toContain(FULL_MARK);
      expect(third).not.toContain(FULL_MARK);
    });

    const warnings = lines.filter((line) => line.includes('tool_use_id'));
    expect(warnings.length).toBe(1);
    await s.clone.stop();
  });

  it('⭐ (d) 並列の呼び（サブと本体が重なる）は tool_use_id ごとに判定される', async () => {
    const s = boot();
    await turn(s);
    const { pre } = s.hooks();
    // 本体の呼びが走っている間にサブエージェントの呼びが始まり、決着の前に両方の handler が走る
    await pre(preOf('tu-main'), undefined, {} as never);
    await pre(preOf('tu-sub-a', 'agent-1'), undefined, {} as never);
    await pre(preOf('tu-sub-b', 'agent-2'), undefined, {} as never);

    const [main, subA, subB] = await Promise.all([
      runnerList(s, metaOf('tu-main')),
      runnerList(s, metaOf('tu-sub-a')),
      runnerList(s, metaOf('tu-sub-b')),
    ]);
    const mainAgain = await runnerList(s, metaOf('tu-main'));

    expect(main).toContain(FULL_MARK);
    expect(subA).toContain(FULL_MARK);
    expect(subB).toContain(FULL_MARK);
    expect(mainAgain).not.toContain(FULL_MARK);
    await s.clone.stop();
  });

  describe('(e) 印の掃除', () => {
    const isSub = (s: Boot, id: string): boolean => s.context().isSubagentCall?.(id) ?? false;

    it('空の agent_id は本体扱い（サブの印を立てない）', async () => {
      const s = boot();
      await turn(s);
      await s.hooks().pre(preOf('tu-1', ''), undefined, {} as never);
      expect(isSub(s, 'tu-1')).toBe(false);
      await s.clone.stop();
    });

    it('PostToolUse で消える', async () => {
      const s = boot();
      await turn(s);
      const { pre, post } = s.hooks();
      await pre(preOf('tu-1', 'agent-1'), undefined, {} as never);
      expect(isSub(s, 'tu-1')).toBe(true);
      await post(settleOf('tu-1'), undefined, {} as never);
      expect(isSub(s, 'tu-1')).toBe(false);
      await s.clone.stop();
    });

    it('PostToolUseFailure で消える', async () => {
      const s = boot();
      await turn(s);
      const { pre, failure } = s.hooks();
      await pre(preOf('tu-1', 'agent-1'), undefined, {} as never);
      expect(isSub(s, 'tu-1')).toBe(true);
      await failure(settleOf('tu-1'), undefined, {} as never);
      expect(isSub(s, 'tu-1')).toBe(false);
      await s.clone.stop();
    });

    it('SubagentStop で、その agent_id の漏れだけが掃かれる', async () => {
      const s = boot();
      await turn(s);
      const { pre, stop } = s.hooks();
      await pre(preOf('tu-1', 'agent-1'), undefined, {} as never);
      await pre(preOf('tu-2', 'agent-2'), undefined, {} as never);
      await stop({ agent_id: 'agent-1' } as never, undefined, {} as never);
      expect(isSub(s, 'tu-1')).toBe(false);
      expect(isSub(s, 'tu-2')).toBe(true);
      await s.clone.stop();
    });
  });
});
