import type { Options, Query, SDKMessage, query as sdkQuery } from '@anthropic-ai/claude-agent-sdk';
import { afterEach, describe, expect, it, vi } from 'vitest';

import { createManagerPool, type ManagerPool, type ManagerSummary } from './manager.js';
import { createRunnerHost, type RunnerHost } from './runner.js';
import { createRunnerRegistry, type RunnerClient, type RunnerEvent } from './runner-protocol.js';
import { createMemoryStores } from './testing.js';

/**
 * **Issue #1592 の副作用の疑いを、runner（`RunnerSession#stop()`）とデーモン
 * （`Pool`/`manager.ts`）を実際に繋いで確かめる結合テスト。**
 *
 * ## 疑いの形（マネージャーからの依頼文の要約）
 *
 * #1592 は `stop()` の並びを変え、`#settleAll(reason)`（未決の確認を解く。
 * 各 `settle` が `settled` を emit し、runner 内の `#status` を `running` へ
 * 戻す）→ `query.close()` → `#reader` → `#shipArchive()` →
 * `#flushUnreported(reason, statusAtStop)`（`statusAtStop` は `#settleAll`
 * より前に控えた値。喋った本文が在れば `report` を emit）という順にした。
 *
 * デーモン側（`manager.ts`）は `case 'settled'` で `record.waiting` を空にし
 * 空なら `record.job.status` を `running` に戻すが、`case 'report'` は
 * `record.job.status = event.status` を無条件で書く（`record.job.status ===
 * 'stopped'` の早期 return 以外に条件が無い）。
 *
 * ⟹ `settled` → `report(waiting_human)` の順で届くと、台帳は「`waiting` は
 * 0件なのに `job.status = 'waiting_human'`」になるはず、という疑いを
 * 本物の `RunnerSession#stop()` の並びと本物の `manager.ts` の分岐で確かめる。
 *
 * ## 使う足場
 *
 * `manager-withheld-reports.test.ts` の「足場2: fakeSdk + createLocalRunner
 * （通しの歯）」と同じ考え方——偽の `queryFn` から `createRunnerHost`
 * （`runner.ts`）→ `RunnerEvent` → `createManagerPool`（`manager.ts`）まで
 * 実物のまま通す。**ただし `createLocalRunner` はそのまま使わない** —
 * `LocalRunner#close()` は `#onEvent` を `null` へ落としてから
 * `Host#shutdown()` を呼ぶ（同一プロセス構成の作法）ので、`Host#shutdown()`
 * が emit する `settled`/`report` がデーモン側の `onEvent` へ届かない。
 * 依頼が疑っている経路（**デーモンは繋いだまま、runner 側の器だけが
 * `Host#shutdown()` を起こす** = 器の入れ替え）を再現するには、`onEvent`
 * を `shutdown()` の前後で切らない橋渡しが要るので、この歯専用に組み立てる。
 */

interface FakeSession {
  /** マネージャーが本文を1つ喋る（`result` は伴わない）。 */
  say(text: string): Promise<void>;
  /**
   * 未決の確認を1件作る。**解決しない** — 実際の未決の確認と同じく、
   * `#settleAll()`（`RunnerSession#stop()` の内部）が解くまで宙に浮いた
   * ままにする。
   */
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
        // fire-and-forget。settle するのは `#settleAll()` だけ。
        // `extra` の完全な型（`suggestions` 等）はこの歯では使わないので、
        // `shutdown-report.test.ts` の `postToolUse` と同じく `as never` で
        // 縮める。
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

/**
 * `createRunnerHost` を、`onEvent` を `Host#shutdown()` の前後で切らない形で
 * `RunnerClient` へ橋渡しする（`runner-local.ts` の `LocalRunner` の複製では
 * ない——上のファイル doc の理由で複製できない）。デーモンから見た顔は
 * `RunnerClient` そのものなので、`createManagerPool` はこれが本物の HTTP
 * runner か同一プロセスの runner かを区別しない。
 */
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
    async start(command) {
      await host.start(command);
    },
    async resume(command) {
      await host.resume(command);
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
      // この歯では使わない — 「器の入れ替え」は `host.shutdown()` を直接
      // 呼んで再現する（`pool.stop()` の afterEach 経由でここへ来ても、
      // 二重の `shutdown()` を起こさないための no-op）。
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

    // **未決の確認を1件作る。** `#onPermission` が `#pending` へ積み、
    // `#status` を `waiting_human` にし、`ask` を emit する。
    session.requestPermission('Bash', { command: 'rm -rf /tmp/x' });
    await vi.waitFor(async () => {
      const found = await summaryOf(pool, managerId);
      if ((found?.waiting.length ?? 0) === 0) throw new Error('ask がまだ届いていない');
    });
    {
      const beforeStop = await summaryOf(pool, managerId);
      expect(beforeStop?.status).toBe('waiting_human');
    }

    // **喋った本文を作る。** `result` は伴わない — `#turnTally` に `said` が
    // 積まれるだけで、`#flushUnreported` の材料になる。
    await session.say('途中まで調べた内容（未決の確認を残したまま畳まれる）');

    // **器の入れ替え。** デーモンはこの委譲へ stop を指示していない——runner
    // 側の器だけが `Host#shutdown()` を起こす（依頼文が名指しする経路）。
    await host.shutdown();

    // `settled` によって `record.waiting` が空になるまで待つ。
    await vi.waitFor(async () => {
      const found = await summaryOf(pool, managerId);
      if (found === undefined) throw new Error('まだ台帳に見えていない');
      if (found.waiting.length !== 0) throw new Error('waiting がまだ残っている');
    });
    // `report` が届いて `lastReport` が更新されるまで待つ（`report` は
    // `settled` より後に届くので、これを待てば両方処理済みと言える）。
    await vi.waitFor(async () => {
      const jobs = await pool.list();
      const job = jobs.find((entry) => entry.managerId === managerId);
      if (job === undefined) throw new Error('まだ台帳に見えていない');
    });
    // 少し余裕を持って、非同期処理が全部終わっていることを確かめる。
    await new Promise((resolve) => setTimeout(resolve, 30));

    const final = await summaryOf(pool, managerId);
    // **実測（生の値）。** これが疑いの核心 — waiting は空なのに status が
    // waiting_human のまま残るかどうかを、そのまま出す。
    expect(final?.waiting).toEqual([]);
    // 直した後はここが 'running' になるはず（`case 'settled'` が空のとき
    // running に戻すのと揃える）。直す前はここが 'waiting_human' のまま残る
    // ことを期待する——このテストは「直す前は赤、直した後は緑」の歯である。
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

    // **manager_stop 経路。** `abort()` → `#confirmStoppedAndReleaseLease` →
    // `runner.stop(managerId)` →（このテストの橋渡しでは）`host.stop(managerId)`
    // → `RunnerSession#stop()`。デーモン自身が指示した停止である。
    const result = await pool.abort(managerId, '人間が止めた');
    expect(result.outcome).toBe('stopped');

    await new Promise((resolve) => setTimeout(resolve, 30));

    const final = await summaryOf(pool, managerId);
    // **実測。** `abort()` が確認後に `record.job.status = 'stopped'` を
    // 無条件で書くので、`settled` → `report(waiting_human)` の順で途中の
    // 台帳が乱れても、最後は `stopped` で上書きされるはず。
    expect(final?.status).toBe('stopped');
  });
});
