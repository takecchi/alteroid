import type { Options, Query, SDKMessage, query as sdkQuery } from '@anthropic-ai/claude-agent-sdk';
import { afterEach, describe, expect, it, vi } from 'vitest';

import { createManagerPool, type ManagerPool, type ManagerSummary } from './manager.js';
import { createRunnerHost, type RunnerHost } from './runner.js';
import { createRunnerRegistry, type RunnerClient, type RunnerEvent } from './runner-protocol.js';
import { createMemoryStores } from './testing.js';

// `createLocalRunner` は使わない: `LocalRunner#close()` が `#onEvent` を `null` にしてから
// `Host#shutdown()` を呼ぶので、shutdown が emit する `settled`/`report` がデーモンへ届かない。

interface FakeSession {
  say(text: string): Promise<void>;
  requestPermission(toolName: string, input: Record<string, unknown>): void;
}

function fakeSdk(): { fn: typeof sdkQuery; sessions: FakeSession[] } {
  const sessions: FakeSession[] = [];

  const fn = ((params: { prompt: unknown; options?: Options }) => {
    const options = params.options ?? {};
    let emit: ((message: SDKMessage | null) => void) | null = null;
    const buffered: SDKMessage[] = [];
    const push = (message: SDKMessage) => {
      if (emit) {
        const resolve = emit;
        emit = null;
        resolve(message);
      } else {
        buffered.push(message);
      }
    };

    sessions.push({
      async say(text) {
        push({
          type: 'assistant',
          message: { role: 'assistant', content: [{ type: 'text', text }] },
          parent_tool_use_id: null,
          session_id: 'sess-e2e',
          uuid: `uuid-say-${String(Math.random())}`,
        } as unknown as SDKMessage);
        await new Promise((resolve) => setTimeout(resolve, 0));
      },
      requestPermission(toolName, input) {
        if (options.canUseTool === undefined) {
          throw new Error('canUseTool が登録されていない');
        }
        void options.canUseTool(toolName, input, {
          signal: new AbortController().signal,
        } as never);
      },
    });

    async function* generate(): AsyncGenerator<SDKMessage, void> {
      yield {
        type: 'system',
        subtype: 'init',
        session_id: 'sess-e2e',
        uuid: 'uuid-init',
      } as unknown as SDKMessage;

      void (async () => {
        for await (const message of params.prompt as AsyncIterable<unknown>) void message;
      })();

      for (;;) {
        const next = buffered.shift();
        if (next !== undefined) {
          yield next;
          continue;
        }
        const message = await new Promise<SDKMessage | null>((resolve) => {
          emit = resolve;
        });
        emit = null;
        if (message === null) return;
        yield message;
      }
    }

    const generator = generate();
    return Object.assign(generator, {
      close: () => {
        if (emit) {
          const resolve = emit;
          emit = null;
          resolve(null);
        }
      },
      interrupt: async () => undefined,
    }) as unknown as Query;
  }) as unknown as typeof sdkQuery;

  return { fn, sessions };
}

function bridgeRunner(queryFn: typeof sdkQuery): { runnerClient: RunnerClient; host: RunnerHost } {
  let onEvent: ((event: RunnerEvent) => void) | null = null;
  const buffered: RunnerEvent[] = [];
  const host = createRunnerHost({
    runnerId: 'runner-bridge',
    workspacePath: '/work/project',
    emit: (event) => {
      if (onEvent) onEvent(event);
      else buffered.push(event);
    },
    queryFn,
    env: { PATH: '/usr/bin' },
  });

  const runnerClient: RunnerClient = {
    runnerId: 'runner-bridge',
    runnerIdKnown: true,
    workspacePath: '/work/project',
    workspacePathKnown: true,
    async connect(onEventCb) {
      onEvent = onEventCb;
      while (buffered.length > 0) {
        const event = buffered.shift();
        if (event !== undefined) onEventCb(event);
      }
    },
    async start(command): Promise<{ cwd?: string }> {
      await host.start(command);
      return {};
    },
    async resume(command): Promise<{ cwd?: string }> {
      await host.resume(command);
      return {};
    },
    async send(managerId, text) {
      return host.send(managerId, text);
    },
    async answer(managerId, answer) {
      return host.answer(managerId, answer);
    },
    async stop(managerId) {
      await host.stop(managerId);
    },
    async list() {
      return host.list();
    },
    async transcript(managerId) {
      return host.transcript(managerId);
    },
    async credentials() {
      return host.credentials();
    },
    async setCredentials(credentials) {
      return host.setCredentials(credentials);
    },
    async profile() {
      return host.profile();
    },
    async setProfile(script) {
      return host.setProfile(script);
    },
    async close() {
      // no-op: afterEach の `pool.stop()` 経由で二重の `shutdown()` を起こさないため。
    },
  };

  return { runnerClient, host };
}

let hosts: RunnerHost[] = [];
let pools: ManagerPool[] = [];

afterEach(async () => {
  await Promise.all(pools.map((pool) => pool.stop().catch(() => undefined)));
  pools = [];
  await Promise.all(hosts.map((host) => host.shutdown().catch(() => undefined)));
  hosts = [];
});

async function setup() {
  const { fn, sessions } = fakeSdk();
  const { runnerClient, host } = bridgeRunner(fn);
  hosts.push(host);
  const stores = createMemoryStores();
  const registry = createRunnerRegistry([runnerClient]);
  const pool = createManagerPool({ stores, post: () => undefined, runners: registry });
  pools.push(pool);
  return { pool, sessions, host };
}

async function firstSession(sessions: readonly FakeSession[]): Promise<FakeSession> {
  return vi.waitFor(() => {
    const found = sessions[0];
    if (!found) throw new Error('セッションがまだ開いていない');
    return found;
  });
}

async function summaryOf(
  pool: ManagerPool,
  managerId: string,
): Promise<ManagerSummary | undefined> {
  const list = await pool.list();
  return list.find((entry) => entry.managerId === managerId);
}

describe('#1592 の副作用の疑い: settled → report(waiting_human) の順で届くと、waiting が空でも job.status が waiting_human のまま残る', () => {
  it('器の入れ替え（Host#shutdown。デーモンは stop を指示していない）: 喋った本文があり、未決の確認1件を残したまま畳むと、waiting は空になるのに status が waiting_human のまま残る', async () => {
    const { pool, sessions, host } = await setup();
    const summary = await pool.start({ request: '調べて' });
    const managerId = summary.managerId;
    const session = await firstSession(sessions);

    session.requestPermission('Bash', { command: 'rm -rf /tmp/x' });
    await vi.waitFor(async () => {
      const found = await summaryOf(pool, managerId);
      if ((found?.waiting.length ?? 0) === 0) throw new Error('ask がまだ届いていない');
    });
    {
      const beforeStop = await summaryOf(pool, managerId);
      expect(beforeStop?.status).toBe('waiting_human');
    }

    await session.say('途中まで調べた内容（未決の確認を残したまま畳まれる）');

    await host.shutdown();

    await vi.waitFor(async () => {
      const found = await summaryOf(pool, managerId);
      if (found === undefined) throw new Error('まだ台帳に見えていない');
      if (found.waiting.length !== 0) throw new Error('waiting がまだ残っている');
    });
    await vi.waitFor(async () => {
      const jobs = await pool.list();
      const job = jobs.find((entry) => entry.managerId === managerId);
      if (job === undefined) throw new Error('まだ台帳に見えていない');
    });
    await new Promise((resolve) => setTimeout(resolve, 30));

    const final = await summaryOf(pool, managerId);
    expect(final?.waiting).toEqual([]);
    // `case 'settled'` が waiting を空にしたとき running へ戻すのと揃える。
    expect(final?.status).toBe('running');
  });

  it('manager_stop（pool.abort）: 同じ状況で abort() 経由で止めると、最後は stopped になる', async () => {
    const { pool, sessions } = await setup();
    const summary = await pool.start({ request: '調べて' });
    const managerId = summary.managerId;
    const session = await firstSession(sessions);

    session.requestPermission('Bash', { command: 'rm -rf /tmp/x' });
    await vi.waitFor(async () => {
      const found = await summaryOf(pool, managerId);
      if ((found?.waiting.length ?? 0) === 0) throw new Error('ask がまだ届いていない');
    });

    await session.say('途中まで調べた内容（未決の確認を残したまま止められる）');

    const result = await pool.abort(managerId, '人間が止めた');
    expect(result.outcome).toBe('stopped');

    await new Promise((resolve) => setTimeout(resolve, 30));

    const final = await summaryOf(pool, managerId);
    expect(final?.status).toBe('stopped');
  });
});
