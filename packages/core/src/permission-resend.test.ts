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

/**
 * 解決済みの許可確認の**再送**。
 *
 * SDK は同じ封筒（同じ `requestId`）をもう一度降ろしてくることがある。そのとき
 * 「もう解けた」という事実が runner にもデーモンにも残っていないと、こうなる:
 *
 * 1. runner が新しい待ちを積んでクローンへ `ask` を再配送する
 * 2. その再送は SDK 側では既に中断済みなので即 `settle` する
 * 3. デーモンが `waiting` からその確認を消す
 *
 * → クローンが答えたときには「その確認は待っていない」。**答えたのに答えられない。**
 *
 * 「送った／受理した」と「効いた／届いた」は別の観測である（#38 / #39 と同じ形）。
 * 解決という事実を、runner とデーモンの**両方**で観測できる形にする。
 */

/** マネージャー側の SDK の代わり。`canUseTool` を外から好きなだけ叩けるようにする。 */
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

    // --- 1件の確認がクローンへ降り、クローンが答える -------------------------
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

    // --- SDK が同じ封筒を再送する -------------------------------------------
    const again = session.ask('Bash', 'req-1');
    await tick();

    // クローンへ二度目は出ない。出すと、答えた確認がもう一度届く。
    expect(askedFor('req-1')).toHaveLength(1);
    // 覚えている結果をそのまま返す（新しい待ちを積まない）。
    expect(await again).toEqual({ behavior: 'allow' });
    expect((await pool.list()).find((m) => m.managerId === managerId)?.waiting).toEqual([]);

    await pool.stop();
  }, 15_000);

  it('デーモンは同じ requestId の ask を二度積まない（解けた後に来ても）', async () => {
    // runner 側が直っていても、`ask` が二度届く経路は他にもありうる（再接続・
    // 器の入れ替え）。**受け取る側でも requestId で冪等**にしておく。
    let emit: ((event: RunnerEvent) => void) | null = null;
    const alive: RunnerManagerState[] = [];
    const runner: RunnerClient = {
      runnerId: 'runner-primary',
      runnerIdKnown: true,
      workspacePath: '/work',
      async connect(onEvent) {
        emit = onEvent;
      },
      async start(command) {
        alive.push({
          managerId: command.managerId,
          status: 'running',
          cwd: command.cwd,
          request: command.request,
          waiting: [],
        });
      },
      async resume() {
        /* この検証では使わない */
      },
      async send() {
        /* この検証では使わない */
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

    // 解けた後の再送でも、待ちを積み直さない（積むと誰も答えられない待ちが残る）。
    send({ type: 'settled', managerId, requestId: 'req-1' });
    await tick();
    send(ask);
    await tick();

    expect(askedFor('req-1')).toHaveLength(1);
    expect((await pool.list()).find((m) => m.managerId === managerId)?.waiting).toEqual([]);

    await pool.stop();
  }, 15_000);
});
