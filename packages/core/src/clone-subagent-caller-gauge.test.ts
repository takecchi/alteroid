import type { query as sdkQuery, Options, Query, SDKMessage } from '@anthropic-ai/claude-agent-sdk';
import { describe, expect, it } from 'vitest';

import { ALWAYS_REDELIVER, createClone } from './clone.js';
import { flushPendingMicrotasks, TOKEN_SAVING_ENABLED_ENV, waitFor } from './clone-test-harness.js';
import type { CloneHost } from './host.js';
import { createRunnerRegistry } from './runner-protocol.js';
import { createLocalRunner } from './runner-local.js';
import { captureStderr, createMemoryStores } from './testing.js';
import { createCloneMcpServer, createCloneTools, type ToolContext } from './tools.js';
import {
  CALLER_VERDICT_GAUGE_PHRASE,
  MAIN_GAUGE_LIMIT,
  SUBAGENT_GAUGE_LIMIT,
  SUBAGENT_HOOK_GAUGE_PHRASE,
} from './subagent-caller-gauge.js';

// サブエージェント呼びの計器（日誌の type=exchange・接頭辞 [計器]）。有無・種類・件数だけを残し、値は残さない。
// 計器は判定（全文を返すか畳むか）を変えない。

const FULL_MARK = 'インメモリ';

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
    env: TOKEN_SAVING_ENABLED_ENV,
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

async function runnerList(s: Boot, extra: unknown): Promise<string> {
  const tool = createCloneTools(s.context()).find((entry) => entry.name === 'runner_list');
  if (!tool) throw new Error('runner_list が無い');
  const result = await tool.handler({} as never, extra as never);
  return (result.content ?? []).map((block) => (block.type === 'text' ? block.text : '')).join('');
}

const preOf = (toolName: string, toolUseId: string, agentId?: string, toolInput: unknown = {}) =>
  ({
    tool_name: toolName,
    tool_input: toolInput,
    tool_use_id: toolUseId,
    ...(agentId === undefined ? {} : { agent_id: agentId }),
  }) as never;

const RUNNER_LIST = 'mcp__alteroid__runner_list';

async function gaugeTexts(s: Boot, phrase: string): Promise<string[]> {
  await flushPendingMicrotasks();
  const rows = (await s.stores.journal.list({ types: ['exchange'], limit: 1000 })) as {
    text: string;
  }[];
  // 並びに依存しない（list の順は実装次第）: 文字列順に揃える
  return rows
    .map((row) => row.text)
    .filter((text) => text.includes(phrase))
    .sort();
}

describe('サブエージェント呼びの計器: hook 側', () => {
  it('サブの呼び（agent_id が非空）は、道具の種類つきで [計器] の行になる', async () => {
    const s = boot();
    await turn(s);
    const pre = s.pre();
    await pre(preOf(RUNNER_LIST, 'tu-1', 'agent-1'), undefined, {} as never);
    await pre(preOf('Bash', 'tu-2', 'agent-1', { command: 'ls' }), undefined, {} as never);
    await pre(preOf('mcp__github__list', 'tu-3', 'agent-1'), undefined, {} as never);

    const lines = await gaugeTexts(s, SUBAGENT_HOOK_GAUGE_PHRASE);
    expect(lines).toEqual(
      [
        `[計器] ${SUBAGENT_HOOK_GAUGE_PHRASE}（hook: サブの呼び・道具の種類 mcp-alteroid）`,
        `[計器] ${SUBAGENT_HOOK_GAUGE_PHRASE}（hook: サブの呼び・道具の種類 組込み）`,
        `[計器] ${SUBAGENT_HOOK_GAUGE_PHRASE}（hook: サブの呼び・道具の種類 mcp-他）`,
      ].sort(),
    );
    await s.clone.stop();
  });

  it('本体の呼び（agent_id が無い・空）は基準として「本体の呼び」の行になる', async () => {
    const s = boot();
    await turn(s);
    const pre = s.pre();
    await pre(preOf(RUNNER_LIST, 'tu-1'), undefined, {} as never);
    await pre(preOf('mcp__alteroid-peer__peer_run', 'tu-2', ''), undefined, {} as never);

    const lines = await gaugeTexts(s, SUBAGENT_HOOK_GAUGE_PHRASE);
    // agent_id が欠ける呼びも空文字の呼びも、同じ「本体の呼び」の種類として2回数えられる
    expect(lines).toEqual([
      `[計器] ${SUBAGENT_HOOK_GAUGE_PHRASE}（hook: 本体の呼び・道具の種類 mcp-alteroid）`,
      `[計器] ${SUBAGENT_HOOK_GAUGE_PHRASE}（hook: 本体の呼び・道具の種類 mcp-alteroid）`,
    ]);
    await s.clone.stop();
  });
});

describe('サブエージェント呼びの計器: handler 側', () => {
  it('_meta の有／無／型違いと、サブ／本体の判定が行になる', async () => {
    const s = boot();
    await turn(s);
    const pre = s.pre();
    await pre(preOf(RUNNER_LIST, 'tu-sub', 'agent-1'), undefined, {} as never);
    await pre(preOf(RUNNER_LIST, 'tu-main'), undefined, {} as never);

    await runnerList(s, metaOf('tu-sub'));
    await runnerList(s, metaOf('tu-main'));
    await captureStderr(async () => {
      await runnerList(s, {});
      await runnerList(s, metaOf(42));
      await runnerList(s, metaOf(''));
    });

    const lines = await gaugeTexts(s, CALLER_VERDICT_GAUGE_PHRASE);
    // 型違い（数値）と空文字は同じ種類として2回数えられる
    expect(lines).toEqual(
      [
        `[計器] ${CALLER_VERDICT_GAUGE_PHRASE}（_meta の toolUseId: 有・サブと判定）`,
        `[計器] ${CALLER_VERDICT_GAUGE_PHRASE}（_meta の toolUseId: 有・本体と判定）`,
        `[計器] ${CALLER_VERDICT_GAUGE_PHRASE}（_meta の toolUseId: 無・本体と判定）`,
        `[計器] ${CALLER_VERDICT_GAUGE_PHRASE}（_meta の toolUseId: 型違い・本体と判定）`,
        `[計器] ${CALLER_VERDICT_GAUGE_PHRASE}（_meta の toolUseId: 型違い・本体と判定）`,
      ].sort(),
    );
    await s.clone.stop();
  });
});

describe('サブエージェント呼びの計器: 値は書かない', () => {
  it('tool_use_id・agent_id・入力の本文は、どの行にも出ない', async () => {
    const s = boot();
    await turn(s);
    const pre = s.pre();
    await pre(
      preOf('Bash', 'tu-secret-ZZ9', 'agent-secret-ZZ9', { command: 'echo token-secret-ZZ9' }),
      undefined,
      {} as never,
    );
    await pre(preOf(RUNNER_LIST, 'tu-secret-ZZ9', 'agent-secret-ZZ9'), undefined, {} as never);
    await runnerList(s, metaOf('tu-secret-ZZ9'));

    const lines = [
      ...(await gaugeTexts(s, SUBAGENT_HOOK_GAUGE_PHRASE)),
      ...(await gaugeTexts(s, CALLER_VERDICT_GAUGE_PHRASE)),
    ];
    expect(lines.length).toBe(3);
    for (const line of lines) expect(line).not.toContain('secret-ZZ9');
    await s.clone.stop();
  });
});

describe('サブエージェント呼びの計器: 上限', () => {
  it(`サブの呼びは種類ごとに最初の ${String(SUBAGENT_GAUGE_LIMIT)} 回だけ書かれ、超えたら間引きの1行が1回だけ出る`, async () => {
    const s = boot();
    await turn(s);
    const pre = s.pre();
    for (let i = 0; i < SUBAGENT_GAUGE_LIMIT + 10; i += 1) {
      await pre(preOf('Bash', `tu-${String(i)}`, 'agent-1'), undefined, {} as never);
    }
    // 別の種類は別に数える
    await pre(preOf(RUNNER_LIST, 'tu-other', 'agent-1'), undefined, {} as never);

    const lines = await gaugeTexts(s, SUBAGENT_HOOK_GAUGE_PHRASE);
    const builtin = lines.filter((line) => line.includes('組込み'));
    expect(builtin.length).toBe(SUBAGENT_GAUGE_LIMIT + 1);
    expect(builtin.filter((line) => line.includes('以降は間引く')).length).toBe(1);
    expect(builtin.find((line) => line.includes('以降は間引く'))).toContain(
      `以降は間引く（累計 ${String(SUBAGENT_GAUGE_LIMIT + 1)}）`,
    );
    expect(lines.filter((line) => line.includes('mcp-alteroid')).length).toBe(1);
    await s.clone.stop();
  });

  it(`本体の呼びは種類ごとに最初の ${String(MAIN_GAUGE_LIMIT)} 回だけ`, async () => {
    const s = boot();
    await turn(s);
    const pre = s.pre();
    for (let i = 0; i < MAIN_GAUGE_LIMIT + 4; i += 1) {
      await pre(preOf('Bash', `tu-${String(i)}`), undefined, {} as never);
    }

    const lines = await gaugeTexts(s, SUBAGENT_HOOK_GAUGE_PHRASE);
    expect(lines.length).toBe(MAIN_GAUGE_LIMIT + 1);
    expect(lines.filter((line) => line.includes('以降は間引く')).length).toBe(1);
    await s.clone.stop();
  });

  it(`handler 側の「サブと判定」は最初の ${String(SUBAGENT_GAUGE_LIMIT)} 回だけ書かれ、超えたら間引きの1行が1回だけ出る`, async () => {
    const s = boot();
    await turn(s);
    const pre = s.pre();
    const total = SUBAGENT_GAUGE_LIMIT + 5;
    for (let i = 0; i < total; i += 1) {
      await pre(preOf(RUNNER_LIST, `tu-sub-${String(i)}`, 'agent-1'), undefined, {} as never);
    }
    for (let i = 0; i < total; i += 1) {
      await runnerList(s, metaOf(`tu-sub-${String(i)}`));
    }
    const lines = (await gaugeTexts(s, CALLER_VERDICT_GAUGE_PHRASE)).filter((line) =>
      line.includes('toolUseId: 有・サブと判定'),
    );
    expect(lines.length).toBe(SUBAGENT_GAUGE_LIMIT + 1);
    expect(lines.filter((line) => line.includes('以降は間引く')).length).toBe(1);
    await s.clone.stop();
  });

  it('handler 側も同じ上限で間引く', async () => {
    const s = boot();
    await turn(s);
    for (let i = 0; i < MAIN_GAUGE_LIMIT + 4; i += 1) {
      await runnerList(s, metaOf(`tu-main-${String(i)}`));
    }
    const lines = await gaugeTexts(s, CALLER_VERDICT_GAUGE_PHRASE);
    expect(lines.length).toBe(MAIN_GAUGE_LIMIT + 1);
    expect(lines.filter((line) => line.includes('以降は間引く')).length).toBe(1);
    await s.clone.stop();
  });
});

describe('サブエージェント呼びの計器: 日誌が書けなくても判定は変わらない', () => {
  it('サブの呼びは全文、本体の2回目は畳みのまま', async () => {
    const stores = createMemoryStores();
    stores.journal.append = () => Promise.reject(new Error('日誌が書けない'));
    const s = boot(stores);
    await turn(s);
    const pre = s.pre();
    await pre(preOf(RUNNER_LIST, 'tu-sub', 'agent-1'), undefined, {} as never);
    await pre(preOf(RUNNER_LIST, 'tu-main-1'), undefined, {} as never);
    await pre(preOf(RUNNER_LIST, 'tu-main-2'), undefined, {} as never);

    await captureStderr(async () => {
      const main1 = await runnerList(s, metaOf('tu-main-1'));
      const sub = await runnerList(s, metaOf('tu-sub'));
      const main2 = await runnerList(s, metaOf('tu-main-2'));
      expect(main1).toContain(FULL_MARK);
      expect(sub).toContain(FULL_MARK);
      expect(main2).not.toContain(FULL_MARK);
    });
    await s.clone.stop();
  });
});
