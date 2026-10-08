import type {
  query as sdkQuery,
  CanUseTool,
  Options,
  PermissionResult,
  Query,
  SDKMessage,
} from '@anthropic-ai/claude-agent-sdk';
import { describe, expect, it } from 'vitest';

import { ALWAYS_REDELIVER, createClone } from './clone.js';
import { createManagerPool, type ManagerPool } from './manager.js';
import { createLocalRunner } from './runner-local.js';
import { createRunnerRegistry } from './runner-protocol.js';
import type { InboxEvent, PendingApproval } from './schema.js';
import type { Stores } from './store.js';
import { createMemoryStores } from './testing.js';
import { createCloneTools } from './tools.js';

function fakeManagerSdk() {
  const sessions: {
    options: Options;
    ask: (tool: string, id: string) => Promise<PermissionResult>;
  }[] = [];

  const fn = ((params: { prompt: unknown; options?: Options }) => {
    const options = params.options ?? {};

    sessions.push({
      options,
      ask(tool, id) {
        const canUseTool = options.canUseTool as CanUseTool;
        return canUseTool(tool, { command: `${tool}:${id}` }, {
          signal: new AbortController().signal,
          requestId: id,
          toolUseID: id,
        } as never) as Promise<PermissionResult>;
      },
    });

    // 閉じられる形にしておく: 閉じられないと `stop()` が読み取りを待って固まるため
    let finish: (() => void) | null = null;

    async function* generate(): AsyncGenerator<SDKMessage, void> {
      yield {
        type: 'system',
        subtype: 'init',
        session_id: 'sess-mgr',
        uuid: 'uuid-init',
      } as unknown as SDKMessage;
      await new Promise<void>((resolve) => {
        finish = resolve;
      });
    }

    return Object.assign(generate(), {
      close: () => finish?.(),
      interrupt: async () => undefined,
    }) as unknown as Query;
  }) as unknown as typeof sdkQuery;

  return { fn, sessions };
}

function fakeCloneSdk() {
  const inputs: string[] = [];

  const fn = ((params: { prompt: unknown; options?: Options }) => {
    async function* generate(): AsyncGenerator<SDKMessage, void> {
      yield {
        type: 'system',
        subtype: 'init',
        session_id: 'sess-clone',
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
          session_id: 'sess-clone',
          uuid: 'uuid-result',
        } as unknown as SDKMessage;
      }
    }

    return Object.assign(generate(), {
      close: () => undefined,
      interrupt: async () => undefined,
    }) as unknown as Query;
  }) as unknown as typeof sdkQuery;

  return { fn, inputs };
}

function handsOf(stores: Stores, managers: ManagerPool) {
  const tools = createCloneTools({
    stores,
    emit: () => undefined,
    managers,
    memoryCause: () => 'clone',
    conversationId: () => undefined,
  });
  const call = async (name: string, args: Record<string, unknown>) => {
    const tool = tools.find((entry) => entry.name === name);
    if (!tool) throw new Error(`ツール ${name} が無い`);
    const result = await tool.handler(args as never, {});
    return (result.content ?? []).map((b) => (b.type === 'text' ? b.text : '')).join('');
  };
  return { call };
}

describe('エスカレーション（受け入れ基準2）', () => {
  it('同じマネージャーの2件を人間へ回し、逆順に答えても、それぞれの仕事だけが再開する', async () => {
    const stores = createMemoryStores();
    const manager = fakeManagerSdk();
    const clone = fakeCloneSdk();

    const inbox: InboxEvent[] = [];
    const pool = createManagerPool({
      stores,
      post: (event) => inbox.push(event),
      runners: createRunnerRegistry([
        createLocalRunner({ workspacePath: '/work', queryFn: manager.fn, env: {} }),
      ]),
    });

    const host = createClone({
      stores,
      queryFn: clone.fn,
      managers: pool,
      redeliveryGate: ALWAYS_REDELIVER,
    });
    const hands = handsOf(stores, pool);

    const { managerId } = await pool.start({ request: '2つ確認してくる仕事' });
    const session = manager.sessions[0];
    if (!session) throw new Error('マネージャーのセッションが無い');

    const first = session.ask('Bash', 'req-first');
    const second = session.ask('WebFetch', 'req-second');
    await new Promise((resolve) => setTimeout(resolve, 0));

    const asked = inbox.filter((event) => event.type === 'manager_message');
    expect(asked.map((event) => event.requestId)).toEqual(['req-first', 'req-second']);

    for (const event of asked) {
      if (event.type !== 'manager_message') continue;
      await hands.call('ask_human', {
        question: event.text,
        managerId: event.managerId,
        requestId: event.requestId,
      });
    }

    const approvals = (await stores.jobs.listApprovals({ pendingOnly: true })).entries;
    expect(approvals).toHaveLength(2);
    expect(approvals.map((a) => [a.jobId, a.requestId])).toEqual([
      [managerId, 'req-first'],
      [managerId, 'req-second'],
    ]);

    const idOf = (requestId: string) =>
      (approvals.find((a) => a.requestId === requestId) as PendingApproval).id;

    await host.answerApproval(idOf('req-second'), 'それは駄目だ');
    await expect
      .poll(() => clone.inputs.some((input) => input.includes('req-second')), { timeout: 3000 })
      .toBe(true);

    const secondTurn = clone.inputs.find((input) => input.includes('req-second')) ?? '';
    expect(secondTurn).toContain(managerId);
    expect(secondTurn).toContain('それは駄目だ');
    expect(secondTurn).not.toContain('req-first');

    const reply = await hands.call('manager_send', {
      managerId,
      requestId: 'req-second',
      message: 'それは駄目だ',
      decision: 'deny',
    });
    expect(reply).toContain('回答した');

    expect(await second).toMatchObject({ behavior: 'deny', message: 'それは駄目だ' });
    expect(
      (await pool.list()).find((m) => m.managerId === managerId)?.waiting.map((w) => w.requestId),
    ).toEqual(['req-first']);

    await host.answerApproval(idOf('req-first'), 'それはよい');
    await expect
      .poll(() => clone.inputs.some((input) => input.includes('req-first')), { timeout: 3000 })
      .toBe(true);

    await hands.call('manager_send', {
      managerId,
      requestId: 'req-first',
      message: 'それはよい',
      decision: 'allow',
    });
    expect(await first).toEqual({ behavior: 'allow' });
    expect((await pool.list()).find((m) => m.managerId === managerId)?.waiting).toEqual([]);

    await host.stop();
  }, 15_000);

  it('宛先を落として人間へ回すと、答えても戻せないことが分かる（黙って通さない）', async () => {
    const stores = createMemoryStores();
    const manager = fakeManagerSdk();
    const inbox: InboxEvent[] = [];
    const pool = createManagerPool({
      stores,
      post: (event) => inbox.push(event),
      runners: createRunnerRegistry([
        createLocalRunner({ workspacePath: '/work', queryFn: manager.fn, env: {} }),
      ]),
    });

    const { managerId } = await pool.start({ request: '2件確認する仕事' });
    const session = manager.sessions[0];
    if (!session) throw new Error('マネージャーのセッションが無い');

    void session.ask('Bash', 'req-a');
    void session.ask('WebFetch', 'req-b');
    await new Promise((resolve) => setTimeout(resolve, 0));

    const blind = await pool.send(managerId, 'それは駄目だ', { decision: 'deny' });
    expect(blind.outcome).toBe('unknown');
    expect(blind.detail).toContain('requestId');
    expect((await pool.list()).find((m) => m.managerId === managerId)?.waiting).toHaveLength(2);

    await pool.stop();
  });
});

describe('クローンが記憶を根拠に、人間を経由せず答える経路（ask_human を通らない manager_send）', () => {
  it('ask_human を経由せず manager_send で返すと、日誌に残り、承認待ちは増えず、マネージャーへ届く', async () => {
    const stores = createMemoryStores();
    const manager = fakeManagerSdk();
    const inbox: InboxEvent[] = [];
    const pool = createManagerPool({
      stores,
      post: (event) => inbox.push(event),
      runners: createRunnerRegistry([
        createLocalRunner({ workspacePath: '/work', queryFn: manager.fn, env: {} }),
      ]),
    });
    const hands = handsOf(stores, pool);

    const { managerId } = await pool.start({ request: '1件確認してくる仕事' });
    const session = manager.sessions[0];
    if (!session) throw new Error('マネージャーのセッションが無い');

    const pending = session.ask('Bash', 'req-self');
    await new Promise((resolve) => setTimeout(resolve, 0));

    const asked = inbox.filter((event) => event.type === 'manager_message');
    expect(asked).toHaveLength(1);

    const reply = await hands.call('manager_send', {
      managerId,
      requestId: 'req-self',
      message: '過去に同種の許可を出している前例があるので進めてよい',
      decision: 'allow',
    });
    expect(reply).toContain('回答した');

    await hands.call('journal_write', {
      decision: `マネージャー ${managerId} の req-self へ、人間に聞かずに allow で答えた`,
      grounds: '記憶に同種の許可を出した前例がある',
    });

    const approvals = (await stores.jobs.listApprovals({ pendingOnly: true })).entries;
    expect(approvals).toHaveLength(0);

    const decisions = (await stores.journal.list({ types: ['decision'] })) as {
      type: 'decision';
      decision: string;
      grounds: string;
    }[];
    const found = decisions.find((d) => d.decision.includes('req-self'));
    expect(found).toBeDefined();
    expect(found?.grounds).toBe('記憶に同種の許可を出した前例がある');

    expect(await pending).toEqual({ behavior: 'allow' });
    expect((await pool.list()).find((m) => m.managerId === managerId)?.waiting).toEqual([]);

    await pool.stop();
  });
});
