import { describe, expect, it } from 'vitest';

import { ALWAYS_REDELIVER, createClone } from './clone.js';
import { fakeSdk, waitFor } from './clone-test-harness.js';
import type { ManagerStartInput, ManagerSummary } from './manager.js';
import type { InboxEvent, Job } from './schema.js';
import type { Stores } from './store.js';
import { createLocalRunner } from './runner-local.js';
import { createRunnerRegistry } from './runner-protocol.js';
import { createMemoryStores } from './testing.js';
import { createCloneMcpServer, createCloneTools } from './tools.js';
import type { ToolContext } from './tools.js';

const AT = '2026-10-08T00:00:00.000Z';

function job(id: string, conversationId?: string): Job {
  return {
    id,
    managerId: id,
    createdAt: AT,
    updatedAt: AT,
    status: 'done',
    summary: `${id} の依頼`,
    ...(conversationId === undefined ? {} : { conversationId }),
  };
}

function managerMessage(
  id: string,
  managerId: string,
  kind: 'report' | 'question',
  text: string,
): InboxEvent {
  return {
    type: 'manager_message',
    id,
    at: new Date().toISOString(),
    managerId,
    kind,
    text,
    ...(kind === 'question' ? { requestId: `req-${id}` } : {}),
  };
}

/** 報告のターンの中で道具の文脈を覗く。`inTurn` はそのターンの入力を受けて1度だけ呼ばれる。 */
function setupReportTurn(stores: Stores, inTurn: (context: ToolContext) => Promise<unknown>) {
  let captured: ToolContext | undefined;
  const pending: Promise<unknown>[] = [];
  const { fn, calls } = fakeSdk((input) => {
    if (captured !== undefined && pending.length === 0 && input.includes('マネージャー')) {
      pending.push(inTurn(captured));
    }
    return '読んだ';
  });
  const clone = createClone({
    redeliveryGate: ALWAYS_REDELIVER,
    stores,
    queryFn: fn,
    env: {},
    mcpServerFactory: (context) => {
      captured = context;
      return createCloneMcpServer(context);
    },
    runners: createRunnerRegistry([
      createLocalRunner({ workspacePath: '/work', queryFn: fakeSdk().fn, env: {} }),
    ]),
  });
  return { clone, calls, pending };
}

async function inputOf(
  calls: ReturnType<typeof fakeSdk>['calls'],
  body: string,
): Promise<string> {
  await waitFor(
    () => calls.some((call) => call.inputs.some((input) => input.includes(body))),
    '報告のターンが投げられる',
  );
  return calls.flatMap((call) => call.inputs).find((input) => input.includes(body)) ?? '';
}

describe('マネージャーからの一件は、委譲の起点の会話を名乗る（#4210）', () => {
  it('報告: 委譲が会話で頼まれていれば、その会話 id と「この会話へ書く」を入力に出す', async () => {
    const stores = createMemoryStores();
    await stores.jobs.putJob(job('mgr-hoge', 'conv-hoge'));
    const s = setupReportTurn(stores, async () => undefined);

    s.clone.post(managerMessage('r-1', 'mgr-hoge', 'report', 'Hoge の調査が終わった'));
    const input = await inputOf(s.calls, 'Hoge の調査が終わった');

    expect(input).toContain('起点の会話: conv-hoge');
    expect(input).toContain('`conversation_post` でこの会話へ書く');
    await s.clone.stop();
  });

  it('質問: 確認の入力にも起点の会話が出る', async () => {
    const stores = createMemoryStores();
    await stores.jobs.putJob(job('mgr-hoge', 'conv-hoge'));
    const s = setupReportTurn(stores, async () => undefined);

    s.clone.post(managerMessage('q-1', 'mgr-hoge', 'question', 'Hoge の本番に触ってよいか'));
    const input = await inputOf(s.calls, 'Hoge の本番に触ってよいか');

    expect(input).toContain('起点の会話: conv-hoge');
    await s.clone.stop();
  });

  it('会話の外で起こした委譲は「無し」、台帳に無い委譲は「分からない」と分けて出す', async () => {
    const stores = createMemoryStores();
    await stores.jobs.putJob(job('mgr-cron'));
    const s = setupReportTurn(stores, async () => undefined);

    s.clone.post(managerMessage('r-1', 'mgr-cron', 'report', '定期の見直しの報告'));
    const none = await inputOf(s.calls, '定期の見直しの報告');
    expect(none).toContain('起点の会話: 無し');

    s.clone.post(managerMessage('r-2', 'mgr-ghost', 'report', '台帳に無い委譲の報告'));
    const missing = await inputOf(s.calls, '台帳に無い委譲の報告');
    expect(missing).toContain('起点の会話: 分からない（台帳にこの委譲が見つからない');
    expect(missing).not.toContain('起点の会話: 無し');
    await s.clone.stop();
  });

  it('報告のターンは内部ターンのまま（返信の宛先は無い）で、仕事の会話だけが起点になる', async () => {
    const stores = createMemoryStores();
    await stores.jobs.putJob(job('mgr-hoge', 'conv-hoge'));
    const seen: Array<{ reply: string | undefined; work: string | undefined }> = [];
    const s = setupReportTurn(stores, async (context) => {
      seen.push({ reply: context.conversationId(), work: context.workConversationId?.() });
    });

    s.clone.post(managerMessage('r-1', 'mgr-hoge', 'report', 'Hoge の報告'));
    await inputOf(s.calls, 'Hoge の報告');
    await waitFor(() => seen.length > 0, '報告のターンの中で文脈を覗く');

    expect(seen[0]).toEqual({ reply: undefined, work: 'conv-hoge' });
    await s.clone.stop();
  });

  it('報告のターンで積んだ ask_human は、起点の会話に結びつく', async () => {
    const stores = createMemoryStores();
    await stores.jobs.putJob(job('mgr-hoge', 'conv-hoge'));
    const s = setupReportTurn(stores, async (context) => {
      const tool = createCloneTools(context).find((t) => t.name === 'ask_human');
      return tool?.handler({ question: 'Hoge を本番に出してよいか' } as never, {});
    });

    s.clone.post(managerMessage('r-1', 'mgr-hoge', 'report', 'Hoge の実装が終わった'));
    await inputOf(s.calls, 'Hoge の実装が終わった');
    await waitFor(async () => {
      await Promise.all(s.pending);
      return (await stores.jobs.listApprovals({ pendingOnly: true })).entries.length > 0;
    }, '承認が積まれる');

    const [approval] = (await stores.jobs.listApprovals({ pendingOnly: true })).entries;
    expect(approval?.conversationId).toBe('conv-hoge');
    await s.clone.stop();
  });
});

describe('道具: 仕事の会話（workConversationId）を委譲と承認へ写す（#4210）', () => {
  function build(options: { reply?: string; work?: string; stores?: Stores }) {
    const stores = options.stores ?? createMemoryStores();
    const started: ManagerStartInput[] = [];
    const managers = {
      async start(input: ManagerStartInput): Promise<ManagerSummary> {
        started.push(input);
        return {
          managerId: 'mgr-next',
          status: 'running',
          live: true,
          cwd: '/work',
          request: input.request,
          startedAt: AT,
          updatedAt: AT,
          waiting: [],
          runnerId: 'runner-a',
        };
      },
    } as never;
    const tools = createCloneTools({
      stores,
      emit: () => undefined,
      memoryCause: () => 'clone',
      conversationId: () => options.reply,
      workConversationId: () => options.work,
      managers,
    });
    const find = (name: string) => {
      const tool = tools.find((entry) => entry.name === name);
      if (tool === undefined) throw new Error(`${name} が無い`);
      return tool;
    };
    return { stores, started, find };
  }

  it('manager_start: 報告を受けた内部ターンで続きを委譲すると、起点の会話を引き継ぐ', async () => {
    const b = build({ work: 'conv-hoge' });
    await b.find('manager_start').handler({ request: 'Hoge の続き' } as never, {});
    expect(b.started[0]?.conversationId).toBe('conv-hoge');
  });

  it('manager_start: 起点の無い内部ターン（定期の仕事など）では、起点を持たないまま', async () => {
    const b = build({});
    await b.find('manager_start').handler({ request: '定期の見直し' } as never, {});
    expect(b.started[0]?.conversationId).toBeUndefined();
  });

  it('ask_human: 内部ターンで managerId を添えて回した確認は、その委譲の起点の会話に結びつく', async () => {
    const stores = createMemoryStores();
    await stores.jobs.putJob(job('mgr-fuga', 'conv-fuga'));
    // ターンの起点（Hoge）より、回す確認の委譲（Fuga）の起点を採る
    const b = build({ work: 'conv-hoge', stores });
    await b
      .find('ask_human')
      .handler({ question: 'Fuga の確認', managerId: 'mgr-fuga', requestId: 'req-1' } as never, {});

    const [approval] = (await stores.jobs.listApprovals({ pendingOnly: true })).entries;
    expect(approval?.conversationId).toBe('conv-fuga');
  });

  it('ask_human: 人間の会話のターンでは、これまでどおりその会話に結びつく', async () => {
    const stores = createMemoryStores();
    await stores.jobs.putJob(job('mgr-fuga', 'conv-fuga'));
    const b = build({ reply: 'conv-now', work: 'conv-now', stores });
    await b
      .find('ask_human')
      .handler({ question: 'Fuga の確認', managerId: 'mgr-fuga', requestId: 'req-1' } as never, {});

    const [approval] = (await stores.jobs.listApprovals({ pendingOnly: true })).entries;
    expect(approval?.conversationId).toBe('conv-now');
  });

  it('manager_list: 委譲ごとに起点の会話を出し、無いものと台帳に無いものを分けて名乗る', async () => {
    const stores = createMemoryStores();
    await stores.jobs.putJob(job('mgr-hoge', 'conv-hoge'));
    await stores.jobs.putJob(job('mgr-cron'));
    const summary = (managerId: string): ManagerSummary => ({
      managerId,
      status: 'done',
      live: true,
      cwd: '/work',
      request: `${managerId} の依頼`,
      startedAt: AT,
      updatedAt: AT,
      waiting: [],
    });
    const managers = {
      async list() {
        return ['mgr-hoge', 'mgr-cron', 'mgr-ghost'].map(summary);
      },
      denials: () => [],
      runnerBacklog: () => [],
    } as never;
    const tool = createCloneTools({
      stores,
      emit: () => undefined,
      memoryCause: () => 'clone',
      conversationId: () => undefined,
      managers,
    }).find((entry) => entry.name === 'manager_list');

    const result = (await tool?.handler({} as never, {})) as {
      content: Array<{ text: string }>;
    };
    const listing = result.content.map((block) => block.text).join('\n');
    const blockOf = (managerId: string) =>
      listing.slice(listing.indexOf(managerId)).split(/\n(?=\S)/u)[0] ?? '';

    expect(blockOf('mgr-hoge')).toContain('起点の会話: conv-hoge');
    expect(blockOf('mgr-cron')).toContain('起点の会話: 無し');
    expect(blockOf('mgr-ghost')).toContain('起点の会話: 分からない（台帳にこの委譲が見つからない');
  });

  it('request_permission: 内部ターンの承認も、仕事の会話に結びつく', async () => {
    const stores = createMemoryStores();
    const b = build({ work: 'conv-hoge', stores });
    await b.find('request_permission').handler(
      {
        rule: 'Bash(gh release edit:*)',
        allows: ['gh release edit v1 --draft'],
        denies: ['gh release delete v1'],
        reason: 'リリースの下書きを直したい',
      } as never,
      {},
    );

    const [approval] = (await stores.jobs.listApprovals({ pendingOnly: true })).entries;
    expect(approval?.conversationId).toBe('conv-hoge');
  });
});
