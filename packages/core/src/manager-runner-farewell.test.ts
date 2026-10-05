import type {
  query as sdkQuery,
  HookCallback,
  Options,
  Query,
  SDKMessage,
} from '@anthropic-ai/claude-agent-sdk';
import { writeFileSync } from 'node:fs';
import { join } from 'node:path';

import { afterEach, describe, expect, it, vi } from 'vitest';

import { createManagerPool, type ManagerPool } from './manager.js';
import { createRunnerHost, type RunnerHost } from './runner.js';
import {
  createRunnerRegistry,
  runnerEventSchema,
  type RunnerAnswerOutcome,
  type RunnerClient,
  type RunnerEvent,
} from './runner-protocol.js';
import type { InboxEvent, Job } from './schema.js';
import type { Stores } from './store.js';
import { captureStderr, createMemoryStores } from './testing.js';
import { makeTempDirSync } from '../../../vitest.tmpdir.js';

/**
 * **Issue #2749: デーモンと runner が同じ反映で SIGTERM を受けたとき、runner が畳みの
 * 最後に出す `archive`（生ログ）と `shutdown_unpushed_work` が、デーモンの終了より先に
 * 失われない**ことを、競走そのものを再現して測る。
 *
 * - 出来事の出どころは**実物の `createRunnerHost`**（`Host#shutdown()` が `shutting_down`
 *   → 畳みの出来事の順に emit する）。デーモン側は**実物の `ManagerPool`** と実物の
 *   メモリ台帳。
 * - 偽物は `RunnerClient` だけ（`hostBackedRunner`）。**SSE が閉じる時刻**
 *   （`exit()`＝`awaitStreamEnd` の解決）と、**出来事が届く時刻**（host の emit）を
 *   テストが操れる。出来事は daemon の境界（`runnerEventSchema.safeParse`）を実際に通す。
 *
 * ## 測る
 * (a) 名乗った runner を待ち、遅れて出る `archive` / `shutdown_unpushed_work` が
 *     `stop()` の返る時点で台帳に書かれている
 * (b) 名乗ったが閉じない runner は、上限で諦めて閉じる側に倒れ、諦めの1行が出る
 * (c) 名乗らない runner は待たない（`awaitStreamEnd` を呼ばない・即座に返る）
 * (d) 待っているあいだに `hello` が来ても、畳み中のデーモンでは引き取りを走らせない
 */

function fakeSdk(): {
  fn: typeof sdkQuery;
  sessions: { postToolUse(input: unknown): Promise<unknown> }[];
} {
  const sessions: { postToolUse(input: unknown): Promise<unknown> }[] = [];
  const fn = ((params: { prompt: unknown; options?: Options }) => {
    const options = params.options ?? {};
    let finish: (() => void) | null = null;
    sessions.push({
      async postToolUse(input) {
        const hook = options.hooks?.PostToolUse?.[0]?.hooks?.[0] as HookCallback | undefined;
        if (hook === undefined) throw new Error('PostToolUse フックが登録されていない');
        return hook(input as never, undefined, { signal: new AbortController().signal } as never);
      },
    });
    async function* generate(): AsyncGenerator<SDKMessage, void> {
      yield {
        type: 'system',
        subtype: 'init',
        session_id: 'sess-farewell',
        uuid: 'uuid-init',
      } as unknown as SDKMessage;
      void (async () => {
        for await (const message of params.prompt as AsyncIterable<unknown>) void message;
      })();
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

interface HostBackedRunner {
  runner: RunnerClient;
  host: RunnerHost;
  /** SSE が閉じる（runner が exit する）。`awaitStreamEnd` が解ける。 */
  exit(): void;
  /** 名乗った・名乗らない runner の差を作るための、境界を通した手動の送り口。 */
  send(event: RunnerEvent): void;
  awaitStreamEndCalls: number;
}

let hosts: RunnerHost[] = [];
afterEach(async () => {
  await Promise.all(hosts.map((host) => host.shutdown().catch(() => undefined)));
  hosts = [];
});

function hostBackedRunner(options: {
  runnerId: string;
  unpushedDelayMs: number;
  /** false なら `awaitStreamEnd` を持たない client（ストリームを持たない実装）。 */
  withAwaitStreamEnd?: boolean;
}): HostBackedRunner & { sessions: { postToolUse(input: unknown): Promise<unknown> }[] } {
  let onEvent: ((event: RunnerEvent) => void) | null = null;
  let closeStream!: () => void;
  const streamEnd = new Promise<void>((resolve) => {
    closeStream = resolve;
  });
  const state = { awaitStreamEndCalls: 0 };

  const { fn, sessions } = fakeSdk();
  const send = (raw: RunnerEvent): void => {
    // **daemon の境界を実際に通す。** スキーマに無い type はここで落ちる。
    const parsed = runnerEventSchema.safeParse(JSON.parse(JSON.stringify(raw)) as unknown);
    if (!parsed.success) throw new Error(`境界で落ちた: ${parsed.error.message}`);
    onEvent?.(parsed.data);
  };
  const host = createRunnerHost({
    runnerId: options.runnerId,
    workspacePath: '/work/project',
    emit: send,
    queryFn: fn,
    env: { PATH: '/usr/bin' },
    readCgroupEventCountersFn: async () => ({}),
    // 畳みの最後に出る観測を、デーモンが先に終わりうるほど遅らせる。
    finishUnpushedWorkFn: async () => {
      await new Promise((resolve) => setTimeout(resolve, options.unpushedDelayMs));
      return { cwd: '/work/project', worktrees: [{ relativePath: '.', branch: 'feat/farewell' }] };
    },
  });
  hosts.push(host);

  const runner: RunnerClient = {
    runnerId: options.runnerId,
    runnerIdKnown: true,
    workspacePath: '/work/project',
    workspacePathKnown: true,
    async connect(handler) {
      onEvent = handler;
    },
    async start(): Promise<{ cwd?: string }> {
      return {};
    },
    async resume(): Promise<{ cwd?: string }> {
      return {};
    },
    async send() {
      return true;
    },
    async answer(): Promise<RunnerAnswerOutcome> {
      return { delivered: false };
    },
    async stop(managerId) {
      await host.stop(managerId);
    },
    async list() {
      return host.list();
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
      return { ok: true as const };
    },
    async close() {
      /* この検証では使わない */
    },
    async unpushedWork() {
      return undefined;
    },
    ...(options.withAwaitStreamEnd === false
      ? {}
      : {
          awaitStreamEnd(): Promise<void> {
            state.awaitStreamEndCalls += 1;
            return streamEnd;
          },
        }),
  };

  return {
    runner,
    host,
    sessions,
    exit: () => closeStream(),
    send,
    get awaitStreamEndCalls() {
      return state.awaitStreamEndCalls;
    },
  };
}

interface Setup {
  pool: ManagerPool;
  stores: Stores;
  inbox: InboxEvent[];
  fake: ReturnType<typeof hostBackedRunner>;
}

async function setup(options: {
  managerId: string;
  unpushedDelayMs?: number;
  withAwaitStreamEnd?: boolean;
}): Promise<Setup> {
  const job: Job = {
    id: options.managerId,
    createdAt: '2026-09-01T00:00:00.000Z',
    updatedAt: '2026-09-01T00:00:00.000Z',
    status: 'running',
    summary: '調べ物',
    request: '調べて',
    cwd: '/work/project',
    sessionId: `sess-${options.managerId}`,
    runnerId: 'runner-primary',
  };
  const stores = createMemoryStores();
  await stores.jobs.putJob(job);

  const fake = hostBackedRunner({
    runnerId: 'runner-primary',
    unpushedDelayMs: options.unpushedDelayMs ?? 150,
    ...(options.withAwaitStreamEnd === undefined
      ? {}
      : { withAwaitStreamEnd: options.withAwaitStreamEnd }),
  });
  await fake.host.start({ managerId: job.id, request: '調べて', cwd: '/work/project' });
  const session = fake.sessions[0];
  if (session === undefined) throw new Error('セッションが開いていない');
  // 畳むときに生ログを渡せるよう、transcript の場所を runner に覚えさせる。
  const dir = makeTempDirSync('farewell-');
  const transcriptPath = join(dir, 'transcript.jsonl');
  writeFileSync(transcriptPath, '畳む直前の生ログ（#2749）', 'utf8');
  await session.postToolUse({ tool_name: 'Bash', tool_input: {}, transcript_path: transcriptPath });

  const inbox: InboxEvent[] = [];
  const pool = createManagerPool({
    stores,
    post: (event) => inbox.push(event),
    runners: createRunnerRegistry([fake.runner]),
  });
  await pool.restore();
  await vi.waitFor(() => {
    if (inbox.length === 0) throw new Error('reattach の知らせがまだ届いていない');
  });
  return { pool, stores, inbox, fake };
}

async function ledgerOf(stores: Stores, managerId: string): Promise<Job> {
  const job = (await stores.jobs.listJobs()).find((entry) => entry.id === managerId);
  if (job === undefined) throw new Error(`${managerId} が台帳に居ない`);
  return job;
}

const sleep = (ms: number): Promise<void> => new Promise((resolve) => setTimeout(resolve, ms));

describe('畳み始めた runner の最後の出来事を、デーモンの stop が待って受け取る（Issue #2749）', () => {
  it('(a) 名乗った runner を待つ: 遅れて出る archive と shutdown_unpushed_work が、stop() の返る時点で台帳に書かれている', async () => {
    const { pool, stores, fake } = await setup({ managerId: 'mgr-a', unpushedDelayMs: 150 });
    const archivedBefore = (await stores.archive.list()).length;

    // runner が畳み始める: `shutting_down` は即座に、`archive` / `shutdown_unpushed_work` は
    // 遅れて（`unpushedDelayMs` のあと）出る。SSE が閉じるのは、それらを出し終えたあと。
    const runnerShutdown = fake.host.shutdown();
    let stopped = false;
    const stopping = pool
      .stop({ farewellDeadlineAt: Date.now() + 5_000 })
      .then(() => (stopped = true));

    // 畳みの最後の出来事がまだ出ていない間、stop は待っている（先に返らない）。
    await sleep(60);
    expect(stopped).toBe(false);
    expect((await ledgerOf(stores, 'mgr-a')).lastUnpushedWorkObservation).toBeUndefined();

    await runnerShutdown;
    // runner が出し切って exit する（SSE が閉じる）。
    await sleep(20);
    fake.exit();
    await stopping;

    // stop が返った時点で、両方が台帳にある。
    const job = await ledgerOf(stores, 'mgr-a');
    expect(job.lastUnpushedWorkObservation).toMatchObject({
      kind: 'observed',
      source: 'shutdown',
      worktrees: [{ relativePath: '.', branch: 'feat/farewell' }],
    });
    expect((await stores.archive.list()).length).toBeGreaterThan(archivedBefore);
    expect(job.archiveIds?.length ?? 0).toBeGreaterThan(0);
    expect(fake.awaitStreamEndCalls).toBe(1);
  });

  it('(b) 名乗ったが閉じない runner は、上限で諦めて閉じる側に倒れる。受け取れなかったものを1行残す', async () => {
    const { pool, stores, fake } = await setup({ managerId: 'mgr-b', unpushedDelayMs: 0 });

    void fake.host.shutdown(); // `shutting_down` を名乗る。`exit()` は呼ばない（閉じない）。
    await sleep(10);

    const startedAt = Date.now();
    const lines = await captureStderr(async () => {
      await pool.stop({ farewellDeadlineAt: startedAt + 200 });
    });
    const elapsed = Date.now() - startedAt;

    expect(elapsed).toBeGreaterThanOrEqual(150);
    expect(elapsed).toBeLessThan(2_000);
    const gaveUp = lines.filter(
      (line) => line.includes('runner-primary') && line.includes('stream-open'),
    );
    expect(gaveUp).toHaveLength(1);
    expect(gaveUp[0]).toContain('mgr-b');
    expect(gaveUp[0]).toContain('archive / shutdown_unpushed_work');
    void stores;
  });

  it('(c) 名乗らない runner は待たない: stop が即座に返り、awaitStreamEnd も呼ばない', async () => {
    const { pool, fake } = await setup({ managerId: 'mgr-c' });

    const startedAt = Date.now();
    const lines = await captureStderr(async () => {
      // 締切は十分に遠い。待つなら、ここで長くかかるはず。
      await pool.stop({ farewellDeadlineAt: startedAt + 30_000 });
    });

    expect(Date.now() - startedAt).toBeLessThan(1_000);
    expect(fake.awaitStreamEndCalls).toBe(0);
    expect(lines.filter((line) => line.includes('stream-open'))).toEqual([]);
  });

  it('(c2) 名乗ったが、ストリームを持たない client（awaitStreamEnd が無い）も待たない', async () => {
    const { pool, fake } = await setup({ managerId: 'mgr-c2', withAwaitStreamEnd: false });
    void fake.host.shutdown();
    await sleep(10);

    const startedAt = Date.now();
    await pool.stop({ farewellDeadlineAt: startedAt + 30_000 });
    expect(Date.now() - startedAt).toBeLessThan(1_000);
  });

  it('(d) 待っているあいだに hello が来ても、畳み中のデーモンでは引き取りを走らせない', async () => {
    const { pool, fake } = await setup({ managerId: 'mgr-d', unpushedDelayMs: 0 });
    const listSpy = vi.spyOn(fake.runner, 'list');

    void fake.host.shutdown();
    await sleep(10);
    const stopping = pool.stop({ farewellDeadlineAt: Date.now() + 5_000 });
    await sleep(10);
    const listedBefore = listSpy.mock.calls.length;
    fake.send({ type: 'hello', runnerId: 'runner-primary' });
    await sleep(20);
    // `#reattach` は runner に生死を聞く（`list()`）。畳み中は聞かない。
    expect(listSpy.mock.calls.length).toBe(listedBefore);

    fake.exit();
    await stopping;
  });
});
