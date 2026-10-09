import type {
  query as sdkQuery,
  CanUseTool,
  Options,
  PermissionResult,
  Query,
  SDKMessage,
} from '@anthropic-ai/claude-agent-sdk';
import { describe, expect, it } from 'vitest';

import { createManagerPool } from './manager.js';
import { createLocalRunner } from './runner-local.js';
import {
  createRunnerRegistry,
  type RunnerClient,
  type RunnerEvent,
  type RunnerManagerState,
} from './runner-protocol.js';
import type { InboxEvent } from './schema.js';
import { createMemoryStores } from './testing.js';

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

const tick = () => new Promise((resolve) => setTimeout(resolve, 0));

describe('解決済みの許可確認が再送されたとき', () => {
  it('runner は二度目の ask を出さず、同じ結果をそのまま返す', async () => {
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

    const { managerId } = await pool.start({ request: '確認してくる仕事' });
    const session = manager.sessions[0];
    if (!session) throw new Error('マネージャーのセッションが無い');

    const first = session.ask('Bash', 'req-1');
    await tick();
    const askedFor = (requestId: string) =>
      inbox.filter((event) => event.type === 'manager_message' && event.requestId === requestId);
    expect(askedFor('req-1')).toHaveLength(1);

    const answered = await pool.send(managerId, 'それはよい', {
      requestId: 'req-1',
      decision: 'allow',
    });
    expect(answered.outcome).toBe('answered');
    expect(await first).toEqual({ behavior: 'allow' });
    await tick();
    expect((await pool.list()).find((m) => m.managerId === managerId)?.waiting).toEqual([]);

    const again = session.ask('Bash', 'req-1');
    await tick();

    expect(askedFor('req-1')).toHaveLength(1);
    expect(await again).toEqual({ behavior: 'allow' });
    expect((await pool.list()).find((m) => m.managerId === managerId)?.waiting).toEqual([]);

    await pool.stop();
  }, 15_000);

  it('デーモンは同じ requestId の ask を二度積まない（解けた後に来ても）', async () => {
    let emit: ((event: RunnerEvent) => void) | null = null;
    const alive: RunnerManagerState[] = [];
    const runner: RunnerClient = {
      runnerId: 'runner-primary',
      runnerIdKnown: true,
      workspacePathKnown: true,
      workspacePath: '/work',
      async connect(onEvent) {
        emit = onEvent;
      },
      async start(command): Promise<{ cwd?: string }> {
        alive.push({
          managerId: command.managerId,
          status: 'running',
          cwd: command.cwd,
          request: command.request,
          waiting: [],
        });
        return {};
      },
      async resume(): Promise<{ cwd?: string }> {
        /* この検証では使わない */
        return {};
      },
      async send() {
        /* この検証では使わない */
        return true;
      },
      async answer() {
        return { delivered: true };
      },
      async stop() {
        /* この検証では使わない */
      },
      async list() {
        return [...alive];
      },
      async transcript() {
        return null;
      },
      async credentials() {
        return [];
      },
      async setCredentials() {
        return [];
      },
      async profile() {
        return undefined;
      },
      async setProfile() {
        return { ok: true };
      },
      async close() {
        /* この検証では使わない */
      },
    };

    const stores = createMemoryStores();
    const inbox: InboxEvent[] = [];
    const pool = createManagerPool({
      stores,
      post: (event) => inbox.push(event),
      runners: createRunnerRegistry([runner]),
    });

    const { managerId } = await pool.start({ request: '確認してくる仕事' });
    const send = (event: RunnerEvent) => {
      if (emit === null) throw new Error('デーモンが runner に繋がっていない');
      emit(event);
    };

    const ask = {
      type: 'ask' as const,
      managerId,
      requestId: 'req-1',
      kind: 'permission' as const,
      summary: 'Bash の実行許可: ls',
      askedAt: '2026-08-01T00:00:00.000Z',
    };

    send(ask);
    send(ask); // 再送
    await tick();

    const askedFor = (requestId: string) =>
      inbox.filter((event) => event.type === 'manager_message' && event.requestId === requestId);
    expect(askedFor('req-1')).toHaveLength(1);
    expect((await pool.list()).find((m) => m.managerId === managerId)?.waiting).toHaveLength(1);

    send({ type: 'settled', managerId, requestId: 'req-1' });
    await tick();
    send(ask);
    await tick();

    expect(askedFor('req-1')).toHaveLength(1);
    expect((await pool.list()).find((m) => m.managerId === managerId)?.waiting).toEqual([]);

    await pool.stop();
  }, 15_000);
});
