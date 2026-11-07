import { describe, expect, it } from 'vitest';

import { createClone } from './clone.js';
import { fakeSdk, waitFor, wireEvents } from './clone-test-harness.js';
import type { FakeCall } from './clone-test-harness.js';
import type { InboxEvent, Job } from './schema.js';
import type { Stores } from './store.js';
import { createLocalRunner } from './runner-local.js';
import { createRunnerRegistry } from './runner-protocol.js';
import { createMemoryStores, humanMessage } from './testing.js';
import { createCloneMcpServer, createCloneTools } from './tools.js';
import type { ToolContext } from './tools.js';

// 宛先の会話の決め方の、端の振る舞いを「いまのまま」固定する歯（振る舞いは変えていない）。
// 既に固定されている分岐は clone-manager-origin-conversation.test.ts（#4210 / #4216）と tools.test.ts の task_add・task_say が持つ。ここは、その隙間だけを持つ。
// 連鎖（ask_human）: 人間のターンの会話 → managerId の委譲の起点 → 作業会話（報告ターンの委譲の起点）→ 無ければ会話なしの承認。

const AT = '2026-11-04T00:00:00.000Z';

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

const PERMISSION = {
  rule: 'Bash(gh release edit:*)',
  allows: ['gh release edit v1 --draft'],
  denies: ['gh release delete v1'],
  reason: 'リリースの下書きを直したい',
} as never;

/** 返信の宛先（conv）と仕事の会話（work）を明示して、道具だけを作る。 */
function build(options: {
  stores?: Stores;
  reply?: string;
  work?: string;
  withWork?: boolean;
  posted?: Array<{ conversationId: string; text: string }>;
}) {
  const stores = options.stores ?? createMemoryStores();
  const tools = createCloneTools({
    stores,
    emit: () => undefined,
    memoryCause: () => 'clone',
    conversationId: () => options.reply,
    ...(options.withWork === false ? {} : { workConversationId: () => options.work }),
    ...(options.posted === undefined
      ? {}
      : {
          postToConversation: (id: string, body: string) =>
            options.posted?.push({ conversationId: id, text: body }),
        }),
  });
  const find = (name: string) => {
    const tool = tools.find((entry) => entry.name === name);
    if (tool === undefined) throw new Error(`${name} が無い`);
    return tool;
  };
  return { stores, find };
}

async function approvals(stores: Stores) {
  return (await stores.jobs.listApprovals({ pendingOnly: true })).entries;
}

describe('ask_human の宛先 — 委譲の起点が使えないとき作業会話へ落ちる', () => {
  it('managerId の委譲が台帳に無い → 作業会話（分岐1）', async () => {
    const b = build({ work: 'conv-work' });
    await b.find('ask_human').handler({ question: 'q', managerId: 'mgr-ghost' } as never, {});
    expect((await approvals(b.stores))[0]?.conversationId).toBe('conv-work');
  });

  it('managerId の委譲が会話の外で起こされている（起点なし）→ 作業会話（分岐1）', async () => {
    const stores = createMemoryStores();
    await stores.jobs.putJob(job('mgr-cron'));
    const b = build({ stores, work: 'conv-work' });
    await b.find('ask_human').handler({ question: 'q', managerId: 'mgr-cron' } as never, {});
    expect((await approvals(stores))[0]?.conversationId).toBe('conv-work');
  });

  it('台帳を読めない（listJobs が投げる）→ 握りつぶして作業会話（分岐2）', async () => {
    const stores = createMemoryStores();
    stores.jobs.listJobs = async () => {
      throw new Error('台帳が読めない');
    };
    const b = build({ stores, work: 'conv-work' });
    await b.find('ask_human').handler({ question: 'q', managerId: 'mgr-x' } as never, {});
    expect((await approvals(stores))[0]?.conversationId).toBe('conv-work');
  });

  it('会話も作業会話も無い tick のターンでも、managerId の委譲の起点には結びつく（分岐3）', async () => {
    const stores = createMemoryStores();
    await stores.jobs.putJob(job('mgr-fuga', 'conv-fuga'));
    const b = build({ stores });
    await b.find('ask_human').handler({ question: 'q', managerId: 'mgr-fuga' } as never, {});
    expect((await approvals(stores))[0]?.conversationId).toBe('conv-fuga');
  });

  it('何も無ければ会話なしの承認（conversationId の欄ごと無い。分岐3）', async () => {
    const b = build({});
    await b.find('ask_human').handler({ question: 'q' } as never, {});
    const [approval] = await approvals(b.stores);
    expect(approval).toBeDefined();
    expect(approval).not.toHaveProperty('conversationId');
  });
});

describe('request_permission の宛先（分岐4）', () => {
  it('人間の会話のターンでは、その会話に結びつく', async () => {
    const b = build({ reply: 'conv-now', work: 'conv-now' });
    await b.find('request_permission').handler(PERMISSION, {});
    expect((await approvals(b.stores))[0]?.conversationId).toBe('conv-now');
  });

  it('作業会話が無い tick のターンでは、会話なしの承認になる', async () => {
    const b = build({});
    await b.find('request_permission').handler(PERMISSION, {});
    const [approval] = await approvals(b.stores);
    expect(approval).toBeDefined();
    expect(approval).not.toHaveProperty('conversationId');
  });

  it('workConversationId を渡さない器は、返信の宛先（conv）と同じになる', async () => {
    const b = build({ reply: 'conv-reply', withWork: false });
    await b.find('request_permission').handler(PERMISSION, {});
    expect((await approvals(b.stores))[0]?.conversationId).toBe('conv-reply');
  });
});

describe('task_say は返信の宛先（conv）と比べる — 作業会話とは比べない（分岐7）', () => {
  async function seedTask(stores: Stores, originConversationId: string): Promise<void> {
    await stores.tasks.add({
      id: 't1',
      createdAt: AT,
      updatedAt: AT,
      status: 'queued',
      origin: 'self',
      originConversationId,
      title: '知らせる件',
      body: '本文',
    });
  }

  it('報告のターン（conv なし・作業会話=task の起点）でも、その起点の会話へ書ける', async () => {
    const posted: Array<{ conversationId: string; text: string }> = [];
    const b = build({ work: 'conv-a', posted });
    await seedTask(b.stores, 'conv-a');
    await b.find('task_say').handler({ taskId: 't1', text: '報告の知らせ' } as never, {});
    expect(posted).toEqual([{ conversationId: 'conv-a', text: '報告の知らせ' }]);
  });
});

// ---- クローンを通した試験（混合の束・失敗の1行） ----

function managerReport(id: string, managerId: string): InboxEvent {
  return {
    type: 'manager_message',
    id,
    at: new Date().toISOString(),
    managerId,
    kind: 'report',
    text: `${managerId} の報告 ${id}`,
  };
}

interface Seen {
  reply: string | undefined;
  work: string | undefined;
}

/** 先客の人間のターンのあとに合図を一度に積み、束のターンの中で道具を呼ぶ。 */
async function mixedBatchTurn(jobs: readonly Job[], managerIds: readonly string[]) {
  const stores = createMemoryStores();
  for (const entry of jobs) await stores.jobs.putJob(entry);
  let captured: ToolContext | undefined;
  const seen: Seen[] = [];
  const pending: Promise<unknown>[] = [];
  const { fn, calls } = fakeSdk((input) => {
    if (captured !== undefined && pending.length === 0 && input.includes('[system] マネージャー')) {
      const context = captured;
      const find = (name: string) => {
        const tool = createCloneTools(context).find((entry) => entry.name === name);
        if (tool === undefined) throw new Error(`${name} が無い`);
        return tool;
      };
      seen.push({ reply: context.conversationId(), work: context.workConversationId?.() });
      pending.push(
        (async () => {
          await find('ask_human').handler({ question: 'q-none' } as never, {});
          const first = managerIds[0];
          await find('ask_human').handler({ question: 'q-with', managerId: first } as never, {});
          await find('request_permission').handler(PERMISSION, {});
          await find('task_add').handler({ title: '束のターンの用事', body: 'b' } as never, {});
        })(),
      );
    }
    return '読んだ';
  });
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
      createLocalRunner({ workspacePath: '/work', queryFn: fakeSdk().fn, env: {} }),
    ]),
  });
  clone.post(humanMessage('先客'));
  await waitFor(() => (calls[0]?.inputs.length ?? 0) === 1, '先客のターンが投げられる');
  managerIds.forEach((managerId, index) => {
    clone.post(managerReport(`r${String(index)}`, managerId));
  });
  await waitFor(
    () => ((calls[0] as FakeCall).inputs[1] ?? '').includes(`${managerIds.at(-1) ?? ''} の報告`),
    '束のターンが投げられる',
  );
  await waitFor(async () => {
    await Promise.all(pending);
    return pending.length > 0;
  }, '束のターンの中で道具を呼ぶ');
  await Promise.all(pending);
  return { clone, stores, seen };
}

describe('混合の束の宛先（分岐5）', () => {
  it('起点が違う束: 作業会話は無くなる。確認は managerId の起点だけに結びつき、許可確認は会話なし、task_add は新しい id', async () => {
    const { clone, stores, seen } = await mixedBatchTurn(
      [job('mgr-A', 'conv-1'), job('mgr-B', 'conv-2')],
      ['mgr-A', 'mgr-B'],
    );

    expect(seen[0]).toEqual({ reply: undefined, work: undefined });
    const found = await approvals(stores);
    const byQuestion = (q: string) => found.find((entry) => entry.question.startsWith(q));
    expect(byQuestion('q-none')).not.toHaveProperty('conversationId');
    expect(byQuestion('q-with')?.conversationId).toBe('conv-1');
    expect(found.find((entry) => entry.permissionRequest !== undefined)).not.toHaveProperty(
      'conversationId',
    );
    const [task] = (await stores.tasks.list()).entries;
    expect(task?.originConversationId).toMatch(/^[0-9a-f-]{36}$/);
    await clone.stop();
  }, 15_000);

  it('起点が同じ束: その起点が作業会話になり、確認も許可確認も task_add もそこへ結びつく', async () => {
    const { clone, stores, seen } = await mixedBatchTurn(
      [job('mgr-A', 'conv-1'), job('mgr-B', 'conv-1')],
      ['mgr-A', 'mgr-B'],
    );

    expect(seen[0]).toEqual({ reply: undefined, work: 'conv-1' });
    const found = await approvals(stores);
    expect(found).toHaveLength(3);
    for (const approval of found) expect(approval.conversationId).toBe('conv-1');
    const [task] = (await stores.tasks.list()).entries;
    expect(task?.originConversationId).toBe('conv-1');
    await clone.stop();
  }, 15_000);
});

describe('失敗の1行の宛先 — 報告のターンの失敗は、人間の会話へ書かず日誌だけに残す（分岐6）', () => {
  const REFUSAL_TEXT =
    "Claude Opus 5.5's safeguards flagged this session as potentially violating our usage policy. Details: [cyber]";

  it('起点 conv-origin の委譲の報告ターンが2回弾かれても、人間の会話（conv-origin・直近の conv-1）へは何も書かれない', async () => {
    const stores = createMemoryStores();
    await stores.jobs.putJob(job('mgr-origin', 'conv-origin'));
    const state = { mode: 'ok' as 'ok' | 'refuse' };
    const sdk = fakeSdk(() => 'わかった', {
      resultFor: () =>
        state.mode === 'refuse'
          ? { subtype: 'error_during_execution', text: REFUSAL_TEXT, isError: true }
          : { subtype: 'success', text: 'わかった' },
    });
    const clone = createClone({
      stores,
      queryFn: sdk.fn,
      env: {},
      inboxSettleMs: 0,
      reportSettleMs: 0,
      runners: createRunnerRegistry([
        createLocalRunner({ workspacePath: '/work', queryFn: fakeSdk().fn, env: {} }),
      ]),
    });
    const { events } = wireEvents(clone, 'conv-1');
    clone.post(humanMessage('先客'));
    await waitFor(() => events.some((e) => e.type === 'done'), '先客のターンが終わる');
    state.mode = 'refuse';

    const rows = async () =>
      (await stores.journal.list({ types: ['exchange'] })) as Array<{
        with: string;
        role: string;
        text: string;
        conversationId?: string;
      }>;
    const internalFailures = async () =>
      (await rows()).filter(
        (row) => row.with === 'self' && row.text.includes('内部ターンが失敗した'),
      ).length;
    clone.post(managerReport('r1', 'mgr-origin'));
    await waitFor(async () => (await internalFailures()) >= 1, '1件目の内部ターンが失敗する');
    clone.post(managerReport('r2', 'mgr-origin'));
    await waitFor(async () => (await internalFailures()) >= 2, '2件目の内部ターンが失敗する');
    await waitFor(
      async () =>
        (await rows()).some(
          (row) => row.with === 'self' && row.text.includes('セッションごと弾かれていると見る'),
        ),
      '日誌に判断の行が残る',
    );
    await clone.stop();

    // 内部のターン（報告）の失敗は日誌だけに残し、人間の会話へは書かない（関係のない会話へ書き込まないため）
    const told = (await rows()).filter(
      (row) => row.with === 'human' && row.text.includes('開き直'),
    );
    expect(told).toEqual([]);
  }, 20_000);
});
