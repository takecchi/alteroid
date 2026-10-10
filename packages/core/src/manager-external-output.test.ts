import { describe, expect, it, vi } from 'vitest';

import { createManagerPool, type ManagerPool, type ManagerSummary } from './manager.js';
import { describeExternalOutputs } from './tools.js';
import {
  createRunnerRegistry,
  runnerEventSchema,
  type RunnerAnswerOutcome,
  type RunnerClient,
  type RunnerEvent,
  type RunnerManagerState,
} from './runner-protocol.js';
import { externalOutputLimits, type ExternalOutput, type InboxEvent, type Job } from './schema.js';
import { createMemoryStores } from './testing.js';
import type { Stores } from './store.js';

interface ManualRunner {
  runner: RunnerClient;
  alive: RunnerManagerState[];
  externalOutput(managerId: string, output: ExternalOutput): void;
}

function manualRunner(runnerId = 'runner-primary'): ManualRunner {
  let emit: ((event: RunnerEvent) => void) | null = null;
  const alive: RunnerManagerState[] = [];

  const runner: RunnerClient = {
    runnerId,
    runnerIdKnown: true,
    workspacePath: '/work/project',
    workspacePathKnown: true,
    async connect(onEvent) {
      emit = onEvent;
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
      const at = alive.findIndex((entry) => entry.managerId === managerId);
      if (at !== -1) alive.splice(at, 1);
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
      return { ok: true as const };
    },
    async close() {
      /* この検証では使わない */
    },
    async unpushedWork() {
      return undefined;
    },
  };

  return {
    runner,
    alive,
    externalOutput(managerId, output) {
      // daemon の境界（`runnerEventSchema.safeParse`）を通す: スキーマに無い欄は黙って落ちるため
      const parsed = runnerEventSchema.safeParse(
        JSON.parse(JSON.stringify({ type: 'external_output', managerId, output })) as unknown,
      );
      if (!parsed.success) throw new Error(`境界で落ちた: ${parsed.error.message}`);
      emit?.(parsed.data);
    },
  };
}

async function runningSetup(
  managerId: string,
): Promise<{ pool: ManagerPool; stores: Stores; fake: ManualRunner }> {
  const job: Job = {
    id: managerId,
    createdAt: '2026-09-01T00:00:00.000Z',
    updatedAt: '2026-09-01T00:00:00.000Z',
    status: 'running',
    summary: '連絡',
    request: '先方に連絡して',
    cwd: '/work/project',
    sessionId: `sess-${managerId}`,
    runnerId: 'runner-primary',
  };
  const stores = createMemoryStores();
  await stores.jobs.putJob(job);

  const fake = manualRunner();
  fake.alive.push({
    managerId: job.id,
    status: 'running',
    cwd: '/work/project',
    request: job.request ?? '',
    waiting: [],
    sessionId: job.sessionId,
  });

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
  return { pool, stores, fake };
}

async function listedOf(pool: ManagerPool, managerId: string): Promise<ManagerSummary> {
  const found = (await pool.list()).find((m) => m.managerId === managerId);
  if (!found) throw new Error(`${managerId} が一覧に居ない`);
  return found;
}

function outputAt(index: number): ExternalOutput {
  return {
    at: new Date(Date.UTC(2026, 9, 10, 1, index)).toISOString(),
    kind: 'mail',
    where: `to: person-${String(index)}@example.com`,
  };
}

describe('委譲の記録の externalOutputs（#2987）', () => {
  it('external_output が委譲の記録に残り（器にも書かれ）、status には触れない', async () => {
    const { pool, stores, fake } = await runningSetup('mgr-out');
    fake.externalOutput('mgr-out', {
      at: '2026-10-10T01:00:00.000Z',
      kind: 'calendar',
      where: 'https://calendar.example.com/event/123',
      summary: '打ち合わせを登録した',
    });
    await vi.waitFor(async () => {
      expect((await listedOf(pool, 'mgr-out')).externalOutputs).toHaveLength(1);
    });
    const listed = await listedOf(pool, 'mgr-out');
    expect(listed.status).toBe('running');
    expect(listed.externalOutputs?.[0]).toEqual({
      at: '2026-10-10T01:00:00.000Z',
      kind: 'calendar',
      where: 'https://calendar.example.com/event/123',
      summary: '打ち合わせを登録した',
    });
    const stored = (await stores.jobs.listJobs()).find((job) => job.id === 'mgr-out');
    expect(stored?.externalOutputs).toHaveLength(1);
    await pool.stop();
  });

  it(`直近 ${String(externalOutputLimits.keptPerJob)} 件だけを残し、古いほうから落とす`, async () => {
    const { pool, fake } = await runningSetup('mgr-many');
    const total = externalOutputLimits.keptPerJob + 3;
    for (let i = 0; i < total; i += 1) fake.externalOutput('mgr-many', outputAt(i));
    await vi.waitFor(async () => {
      const kept = (await listedOf(pool, 'mgr-many')).externalOutputs ?? [];
      expect(kept.at(-1)?.where).toBe(`to: person-${String(total - 1)}@example.com`);
    });
    const kept = (await listedOf(pool, 'mgr-many')).externalOutputs ?? [];
    expect(kept).toHaveLength(externalOutputLimits.keptPerJob);
    expect(kept[0]?.where).toBe('to: person-3@example.com');
    await pool.stop();
  });
});

describe('describeExternalOutputs（manager_list / manager_report の行）', () => {
  const manager = (externalOutputs?: ExternalOutput[]): ManagerSummary =>
    ({ ...(externalOutputs === undefined ? {} : { externalOutputs }) }) as ManagerSummary;

  it('記録が無ければ行を作らない', () => {
    expect(describeExternalOutputs(manager(), 'full')).toBeNull();
    expect(describeExternalOutputs(manager([]), 'brief')).toBeNull();
  });

  it('一覧は件数と最後の1件だけ、報告は全件を出す', () => {
    const outputs = [outputAt(0), { ...outputAt(1), summary: '返信した' }];
    const brief = describeExternalOutputs(manager(outputs), 'brief') ?? '';
    expect(brief.split('\n')).toHaveLength(1);
    expect(brief).toContain('2 件');
    expect(brief).toContain('to: person-1@example.com（返信した）');
    expect(brief).not.toContain('person-0');

    const full = describeExternalOutputs(manager(outputs), 'full') ?? '';
    expect(full.split('\n')).toHaveLength(3);
    expect(full).toContain('mail: to: person-0@example.com');
    expect(full).toContain('mail: to: person-1@example.com（返信した）');
  });
});
