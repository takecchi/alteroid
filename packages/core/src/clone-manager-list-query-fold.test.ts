import type { query as sdkQuery, Options, Query, SDKMessage } from '@anthropic-ai/claude-agent-sdk';
import { describe, expect, it } from 'vitest';

import { createClone } from './clone.js';
import { flushPendingMicrotasks, TOKEN_SAVING_ENABLED_ENV, waitFor } from './clone-test-harness.js';
import type { CloneHost } from './host.js';
import type { ManagerPool, ManagerSummary } from './manager.js';
import { createRunnerRegistry } from './runner-protocol.js';
import { createLocalRunner } from './runner-local.js';
import { createMemoryStores } from './testing.js';
import { createCloneMcpServer, createCloneTools, type ToolContext } from './tools.js';

// manager_list を q で1件だけ引く呼びを、本番と同じ経路（createClone → ToolContext.foldFixed）で同じ会話の中で繰り返す。
// 冒頭の注意書き（件数の行の固定の読み方）と末尾の受信箱の内訳が、2回目から要点の1行に畳まれること

const AT = '2026-09-05T00:00:00.000Z';

function summary(id: string, extra: Partial<ManagerSummary> = {}): ManagerSummary {
  return {
    managerId: id,
    status: 'done',
    live: true,
    cwd: '/work',
    request: `依頼 ${id}`,
    startedAt: AT,
    updatedAt: AT,
    waiting: [],
    ...extra,
  } as ManagerSummary;
}

function pool(managers: () => ManagerSummary[]): ManagerPool {
  const notUsed = () => {
    throw new Error('この歯では使わない');
  };
  return {
    start: notUsed,
    send: notUsed,
    abort: notUsed,
    list: () => Promise.resolve(managers()),
    denials: () => [],
    runnerBacklog: () => [],
    runners: () =>
      Promise.resolve({
        runners: [],
        unassigned: [],
        daemonRevision: { status: 'unheard' },
      }),
    unpushedWork: async () => ({ kind: 'none' }),
    stop: () => Promise.resolve(),
  } as unknown as ManagerPool;
}

interface Boot {
  clone: CloneHost;
  inputs: string[];
  context: () => ToolContext;
  setInbox: (entries: unknown[], unreadable?: unknown[]) => void;
  setManagers: (next: ManagerSummary[]) => void;
  switchSession: (id: string) => void;
  preToolUse: (input: Record<string, unknown>) => Promise<void>;
}

interface Script {
  env?: NodeJS.ProcessEnv;
  after?: (inputCount: number) => SDKMessage[];
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
  const stores = createMemoryStores();
  let captured: ToolContext | undefined;
  let options: Options | undefined;
  let managers: ManagerSummary[] = [];
  let inbox: unknown[] = [];
  let inboxUnreadable: unknown[] = [];
  let sessionId = 'sess-fake';
  let pendingSession: string | undefined;
  (stores.inbox as { peekPending: () => Promise<unknown> }).peekPending = async () => ({
    entries: inbox,
    unreadable: inboxUnreadable,
  });
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
        if (pendingSession !== undefined) {
          sessionId = pendingSession;
          pendingSession = undefined;
          yield {
            type: 'system',
            subtype: 'init',
            session_id: sessionId,
            uuid: `uuid-init-${sessionId}`,
          } as unknown as SDKMessage;
        }
        for (const extra of script.after?.(inputs.length) ?? []) yield extra;
        yield (script.failResultAt === inputs.length
          ? {
              type: 'result',
              subtype: 'error_during_execution',
              is_error: true,
              errors: ['途中で失敗した'],
              session_id: sessionId,
              uuid: `uuid-result-${String(inputs.length)}`,
            }
          : {
              type: 'result',
              subtype: 'success',
              result: 'ok',
              session_id: sessionId,
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
  const clone = createClone({
    stores,
    queryFn: fn,
    // 既定は畳みを有効にした env（本番の既定は無効: `ALTEROID_TOKEN_SAVING_FOLD_FIXED_TEXT`）
    env: script.env ?? TOKEN_SAVING_ENABLED_ENV,
    inboxSettleMs: 0,
    reportSettleMs: 0,
    managers: pool(() => managers),
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
    setInbox: (entries, unreadable = []) => {
      inbox = entries;
      inboxUnreadable = unreadable;
    },
    setManagers: (next) => {
      managers = next;
    },
    switchSession: (id) => {
      pendingSession = id;
    },
    preToolUse: async (input) => {
      const pre = options?.hooks?.PreToolUse?.[0]?.hooks?.[0];
      if (!pre) throw new Error('hook が登録されていない');
      await (
        pre as unknown as (input: unknown, id: undefined, options: unknown) => Promise<unknown>
      )(input, undefined, {});
    },
  };
}

let seq = 0;

async function turn(s: Boot): Promise<void> {
  const before = s.inputs.length;
  seq += 1;
  s.clone.post({
    type: 'manager_message',
    id: `evt-mlq-${seq}`,
    at: new Date().toISOString(),
    managerId: 'mgr-a',
    kind: 'report',
    text: `報告 ${seq}`,
  });
  await waitFor(() => s.inputs.length > before, `入力 ${before + 1} 本目`);
  await flushPendingMicrotasks();
}

async function managerList(
  s: Boot,
  args: Record<string, unknown> = {},
  extra: unknown = {},
): Promise<string> {
  const tool = createCloneTools(s.context()).find((entry) => entry.name === 'manager_list');
  if (!tool) throw new Error('manager_list が無い');
  const result = await tool.handler(args as never, extra as never);
  return (result.content ?? []).map((block) => (block.type === 'text' ? block.text : '')).join('');
}

const stuckInbox = (n = 12): unknown[] =>
  Array.from({ length: n }, (_, i) => ({
    id: `ev${String(i)}`,
    at: new Date(Date.UTC(2026, 9, 27, 0, 0, 0) - i * 3_600_000).toISOString(),
    deliveries: i % 3,
    event:
      i % 2 === 1
        ? { type: 'human_message', text: 'x', conversationId: 'c1' }
        : { type: 'manager_message', managerId: `mgr-${String(i)}`, text: 'y' },
  }));

const fleet = (): ManagerSummary[] => [
  summary('mgr-target', { status: 'running' }),
  summary('mgr-other-1'),
  summary('mgr-other-2'),
];

// 冒頭の注意書き（件数の行）と受信箱の内訳の、全文にだけ在る字面
const RUNNING_FULL = '**「走行中」は「進んでいる」ではない**';
const INBOX_FULL = '種類: human_message';
const INBOX_HEADER = '⚠ クローンの受信箱に未処理の合図が';

const q = { q: 'mgr-target' };

describe('manager_list を q で引く呼びの固定の文言の畳み', () => {
  it('⭐ 同じ会話の2回目は、注意書きと受信箱の内訳が要点の1行になり短くなる', async () => {
    const s = boot();
    s.setManagers(fleet());
    s.setInbox(stuckInbox());
    await turn(s);

    const first = await managerList(s, q);
    const second = await managerList(s, q);

    expect(first).toContain(RUNNING_FULL);
    expect(first).toContain(INBOX_FULL);
    expect(second).not.toContain(INBOX_FULL);
    expect(first).toContain('mgr-target');
    expect(second).not.toContain(RUNNING_FULL);
    expect(second).toContain('mgr-target');
    expect(second).toContain('動いている本数は「話しかけられる」ほうで数える');
    expect(second.length).toBeLessThan(first.length);
    await s.clone.stop();
  });

  it('⭐ 畳みが切り（env が空＝本番の既定）なら、同じ内訳で何度呼んでも全文', async () => {
    const s = boot({ env: {} });
    s.setManagers(fleet());
    s.setInbox(stuckInbox());
    await turn(s);

    const first = await managerList(s, q);
    const second = await managerList(s, q);

    for (const text of [first, second]) {
      expect(text).toContain(RUNNING_FULL);
      expect(text).toContain(INBOX_FULL);
      expect(text).not.toContain('は前回と同じ');
    }
    await s.clone.stop();
  });

  it('⭐ compaction のあとは全文へ戻る', async () => {
    const s = boot({ after: (n) => (n === 2 ? [compactBoundary] : []) });
    s.setManagers(fleet());
    s.setInbox(stuckInbox());
    await turn(s);
    await managerList(s, q);
    expect(await managerList(s, q)).not.toContain(INBOX_FULL);

    await turn(s);
    const afterCompaction = await managerList(s, q);

    expect(afterCompaction).toContain(RUNNING_FULL);
    expect(afterCompaction).toContain(INBOX_FULL);
    await s.clone.stop();
  });

  it('⭐ 新しい会話（session_id が替わる）の後は全文へ戻る', async () => {
    const s = boot();
    s.setManagers(fleet());
    s.setInbox(stuckInbox());
    await turn(s);
    await managerList(s, q);
    expect(await managerList(s, q)).not.toContain(INBOX_FULL);

    s.switchSession('sess-second');
    await turn(s);
    const afterSwitch = await managerList(s, q);

    expect(afterSwitch).toContain(RUNNING_FULL);
    expect(afterSwitch).toContain(INBOX_FULL);
    await s.clone.stop();
  });

  it('⭐ 失敗したターンの後は全文へ戻る', async () => {
    const s = boot({ failResultAt: 2 });
    s.setManagers(fleet());
    s.setInbox(stuckInbox());
    await turn(s);
    await managerList(s, q);
    expect(await managerList(s, q)).not.toContain(INBOX_FULL);

    await turn(s);
    const afterFailure = await managerList(s, q);

    expect(afterFailure).toContain(RUNNING_FULL);
    expect(afterFailure).toContain(INBOX_FULL);
    await s.clone.stop();
  });

  it('⭐ 受信箱の内訳が変わったら全文、同じなら1行', async () => {
    const s = boot();
    s.setManagers(fleet());
    s.setInbox(stuckInbox(12));
    await turn(s);
    const first = await managerList(s, q);
    const same = await managerList(s, q);
    s.setInbox(stuckInbox(5));
    const changed = await managerList(s, q);
    const changedAgain = await managerList(s, q);

    expect(first).toContain(`${INBOX_HEADER} 12 件`);
    expect(first).toContain(INBOX_FULL);
    // 見出し（件数・最も古い時刻）は畳んでも残り、内訳は1行になる
    expect(same).toContain(`${INBOX_HEADER} 12 件`);
    expect(same).toContain('内訳（計 12 件）は前回と同じ');
    expect(same).toContain('refetch: true');
    expect(same).not.toContain(INBOX_FULL);
    expect(changed).toContain(`${INBOX_HEADER} 5 件`);
    expect(changed).toContain(INBOX_FULL);
    expect(changedAgain).not.toContain(INBOX_FULL);
    await s.clone.stop();
  });

  it('⭐ refetch: true は同じ内訳も全文で出し直す', async () => {
    const s = boot();
    s.setManagers(fleet());
    s.setInbox(stuckInbox(12));
    await turn(s);
    await managerList(s, q);
    expect(await managerList(s, q)).not.toContain(INBOX_FULL);

    expect(await managerList(s, { ...q, refetch: true })).toContain(INBOX_FULL);
    await s.clone.stop();
  });

  it('⭐ 読めない受信箱の行が在る回は内訳を畳まない', async () => {
    const s = boot();
    s.setManagers(fleet());
    s.setInbox(stuckInbox(12), [{ id: 'bad-1', reason: '壊れた行' }]);
    await turn(s);
    await managerList(s, q);

    expect(await managerList(s, q)).toContain(INBOX_FULL);
    await s.clone.stop();
  });

  it('⭐ A → B（読めない行あり）→ A の3回目は全文（読めない行の回も控えを最新にする）', async () => {
    const s = boot();
    s.setManagers(fleet());
    s.setInbox(stuckInbox(12));
    await turn(s);
    await managerList(s, q);
    s.setInbox(stuckInbox(5), [{ id: 'bad-1', reason: '壊れた行' }]);
    expect(await managerList(s, q)).toContain('種類: human_message');
    s.setInbox(stuckInbox(12));

    expect(await managerList(s, q)).toContain(INBOX_FULL);
    await s.clone.stop();
  });

  it.each([
    ['空', [] as unknown[], [] as unknown[]],
    ['読めない行だけ', [] as unknown[], [{ id: 'bad-1', reason: '壊れた行' }]],
  ])('⭐ A → %s → A の3回目は全文（空の回で控えを捨てる）', async (_name, entries, unreadable) => {
    const s = boot();
    s.setManagers(fleet());
    s.setInbox(stuckInbox(12));
    await turn(s);
    await managerList(s, q);
    s.setInbox(entries, unreadable);
    await managerList(s, q);
    s.setInbox(stuckInbox(12));

    expect(await managerList(s, q)).toContain(INBOX_FULL);
    await s.clone.stop();
  });

  it('⭐ 受信箱の内訳が A→B→A と変わったとき、2回前の A を「同じ」と畳まない', async () => {
    const s = boot();
    s.setManagers(fleet());
    s.setInbox(stuckInbox(12));
    await turn(s);
    await managerList(s, q);
    s.setInbox(stuckInbox(5));
    await managerList(s, q);
    s.setInbox(stuckInbox(12));

    expect(await managerList(s, q)).toContain(INBOX_FULL);
    await s.clone.stop();
  });

  it('⭐ サブエージェントの呼びは常に全文で、本体の控えを更新しない', async () => {
    const s = boot();
    s.setManagers(fleet());
    s.setInbox(stuckInbox());
    await turn(s);
    const meta = (id: string) => ({ _meta: { 'claudecode/toolUseId': id } });
    const preOf = (id: string, agentId?: string) => ({
      tool_name: 'mcp__alteroid-clone__manager_list',
      tool_input: q,
      tool_use_id: id,
      ...(agentId === undefined ? {} : { agent_id: agentId }),
    });
    await s.preToolUse(preOf('tu-sub-1', 'agent-1'));
    await s.preToolUse(preOf('tu-sub-2', 'agent-1'));
    await s.preToolUse(preOf('tu-main-1'));
    await s.preToolUse(preOf('tu-main-2'));

    const sub1 = await managerList(s, q, meta('tu-sub-1'));
    const sub2 = await managerList(s, q, meta('tu-sub-2'));
    const main1 = await managerList(s, q, meta('tu-main-1'));
    const main2 = await managerList(s, q, meta('tu-main-2'));

    expect(sub1).toContain(INBOX_FULL);
    expect(sub2).toContain(INBOX_FULL);
    expect(main1).toContain(INBOX_FULL);
    expect(main2).not.toContain(INBOX_FULL);
    await s.clone.stop();
  });

  it('⭐ lost の行は畳み続けず全文のまま出る', async () => {
    const s = boot();
    s.setManagers([summary('mgr-target', { status: 'lost', live: false }), ...fleet().slice(1)]);
    s.setInbox([]);
    await turn(s);
    await managerList(s, q);

    const second = await managerList(s, q);

    expect(second).toContain('⚠ 前のセッションへ戻れなかった');
    expect(second).toContain('mgr-target');
    await s.clone.stop();
  });
});
