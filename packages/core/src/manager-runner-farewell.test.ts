import type {
  query as sdkQuery,
  HookCallback,
  Options,
  Query,
  SDKMessage,
} from '@anthropic-ai/claude-agent-sdk';
import { writeFileSync } from 'node:fs';
import { join } from 'node:path';

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

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
  exit(): void;
  send(event: RunnerEvent): void;
  awaitStreamEndCalls: number;
}

let hosts: RunnerHost[] = [];
/** 失敗した回でも、止めた観測を解いて後始末（host.shutdown）が詰まらないようにする。 */
let releaseGateForCleanup: () => void = () => undefined;
afterEach(async () => {
  vi.useRealTimers();
  releaseGateForCleanup();
  releaseGateForCleanup = () => undefined;
  await Promise.all(hosts.map((host) => host.shutdown().catch(() => undefined)));
  hosts = [];
});

function hostBackedRunner(options: {
  runnerId: string;
  unpushedGate: Promise<void>;
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
    // daemon の境界を通す: スキーマに無い type はここで落ちる。
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
    finishUnpushedWorkFn: async () => {
      await options.unpushedGate;
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
  unpushedGate?: Promise<void>;
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
    unpushedGate: options.unpushedGate ?? Promise.resolve(),
    ...(options.withAwaitStreamEnd === undefined
      ? {}
      : { withAwaitStreamEnd: options.withAwaitStreamEnd }),
  });
  await fake.host.start({ managerId: job.id, request: '調べて', cwd: '/work/project' });
  const session = fake.sessions[0];
  if (session === undefined) throw new Error('セッションが開いていない');
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

const flush = async (): Promise<void> => {
  for (let i = 0; i < 10; i += 1) await new Promise((resolve) => setImmediate(resolve));
};

beforeEach(() => {
  // 実時間で待たない。締切（`settledWithin` の setTimeout と `Date.now()`）だけを偽の時計にする。
  vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout', 'Date'] });
});

describe('畳み始めた runner の最後の出来事を、デーモンの stop が待って受け取る（Issue #2749）', () => {
  it('(a) 名乗った runner を待つ: 遅れて出る archive と shutdown_unpushed_work が、stop() の返る時点で台帳に書かれている', async () => {
    let releaseUnpushed!: () => void;
    const unpushedGate = new Promise<void>((resolve) => {
      releaseUnpushed = resolve;
    });
    const { pool, stores, fake } = await setup({ managerId: 'mgr-a', unpushedGate });
    releaseGateForCleanup = releaseUnpushed;
    const archivedBefore = (await stores.archive.list()).length;

    const runnerShutdown = fake.host.shutdown();
    let stopped = false;
    const stopping = pool
      .stop({ farewellDeadlineAt: Date.now() + 5_000 })
      .then(() => (stopped = true));

    await flush();
    expect(stopped).toBe(false);
    expect((await ledgerOf(stores, 'mgr-a')).lastUnpushedWorkObservation).toBeUndefined();

    releaseUnpushed();
    await runnerShutdown;
    await flush();
    fake.exit();
    await stopping;

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
    const { pool, stores, fake } = await setup({ managerId: 'mgr-b' });

    void fake.host.shutdown();
    await flush();

    const deadlineAt = Date.now() + 200;
    let stopped = false;
    let stopping!: Promise<void>;
    const lines = await captureStderr(async () => {
      stopping = pool.stop({ farewellDeadlineAt: deadlineAt }).then(() => {
        stopped = true;
      });
      await vi.advanceTimersByTimeAsync(199);
      await flush();
      expect(stopped).toBe(false);
      await vi.advanceTimersByTimeAsync(1);
      await stopping;
    });
    expect(stopped).toBe(true);
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

    const lines = await captureStderr(async () => {
      // 締切は遠い。時計は進めない——待つなら、ここで返らずテストが時間切れになる。
      await pool.stop({ farewellDeadlineAt: Date.now() + 30_000 });
    });

    expect(fake.awaitStreamEndCalls).toBe(0);
    expect(lines.filter((line) => line.includes('stream-open'))).toEqual([]);
  });

  it('(c2) 名乗ったが、ストリームを持たない client（awaitStreamEnd が無い）も待たない', async () => {
    const { pool, fake } = await setup({ managerId: 'mgr-c2', withAwaitStreamEnd: false });
    void fake.host.shutdown();
    await flush();

    // 時計は進めない。待つなら、ここで返らずテストが時間切れになる。
    await pool.stop({ farewellDeadlineAt: Date.now() + 30_000 });
  });

  it('(d) 待っているあいだに hello が来ても、畳み中のデーモンでは引き取りを走らせない', async () => {
    const { pool, fake } = await setup({ managerId: 'mgr-d' });
    const listSpy = vi.spyOn(fake.runner, 'list');

    void fake.host.shutdown();
    await flush();
    const stopping = pool.stop({ farewellDeadlineAt: Date.now() + 5_000 });
    await flush();
    const listedBefore = listSpy.mock.calls.length;
    fake.send({ type: 'hello', runnerId: 'runner-primary' });
    await flush();
    expect(listSpy.mock.calls.length).toBe(listedBefore);

    fake.exit();
    await stopping;
  });
});
