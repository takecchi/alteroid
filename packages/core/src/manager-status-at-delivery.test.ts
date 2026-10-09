import { describe, expect, it, vi } from 'vitest';

import { createManagerPool, type ManagerPool } from './manager.js';
import {
  createRunnerRegistry,
  type RunnerAnswerOutcome,
  type RunnerClient,
  type RunnerEvent,
  type RunnerManagerState,
} from './runner-protocol.js';
import type { InboxEvent, Job, JobStatus } from './schema.js';
import { createMemoryStores } from './testing.js';
import type { Stores } from './store.js';

interface ManualRunner {
  runner: RunnerClient;
  alive: RunnerManagerState[];
  report(
    managerId: string,
    text: string,
    status: JobStatus,
    fields?: { awaitingBackground?: { count: number; breakdown: string } },
  ): void;
  closed(managerId: string, status: 'done' | 'lost' | 'failed', reason: string): void;
  /** `waiting` が空のまま `waiting_human` で report すると `running` へ補正されるので、その前に確認を積むために使う。 */
  ask(managerId: string, requestId: string, summary: string): void;
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
  };

  return {
    runner,
    alive,
    report(managerId, text, status, fields = {}) {
      emit?.({ type: 'report', managerId, text, status, ...fields });
    },
    closed(managerId, status, reason) {
      const at = alive.findIndex((entry) => entry.managerId === managerId);
      if (at !== -1) alive.splice(at, 1);
      emit?.({ type: 'closed', managerId, status, reason });
    },
    ask(managerId, requestId, summary) {
      emit?.({
        type: 'ask',
        managerId,
        requestId,
        kind: 'permission',
        summary,
        askedAt: new Date().toISOString(),
      });
    },
  };
}

interface ManualSetup {
  pool: ManagerPool;
  stores: Stores;
  inbox: InboxEvent[];
  fake: ManualRunner;
}

async function runningManualSetup(managerId = 'mgr-sad'): Promise<ManualSetup> {
  const job: Job = {
    id: managerId,
    createdAt: '2026-09-01T00:00:00.000Z',
    updatedAt: '2026-09-01T00:00:00.000Z',
    status: 'running',
    summary: '調べ物',
    request: '調べて',
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
    request: '調べて',
    waiting: [],
    sessionId: job.sessionId,
  });

  const registry = createRunnerRegistry([fake.runner]);
  const inbox: InboxEvent[] = [];
  const clock = Date.parse('2026-09-01T00:00:00.000Z');
  const pool = createManagerPool({
    stores,
    post: (event) => inbox.push(event),
    runners: registry,
    now: () => clock,
  });

  await pool.restore();
  await vi.waitFor(() => {
    if (inbox.length === 0) throw new Error('reattach の知らせがまだ届いていない');
  });

  return { pool, stores, inbox, fake };
}

function managerMessages(inbox: InboxEvent[]) {
  return inbox.filter(
    (event): event is Extract<InboxEvent, { type: 'manager_message' }> =>
      event.type === 'manager_message',
  );
}

describe('manager.ts の producer 側: statusAtDelivery（issue #870）', () => {
  it('プレーンな report でも、text に status= の飾りが無いまま statusAtDelivery が付く', async () => {
    const { pool, inbox, fake } = await runningManualSetup();
    const before = managerMessages(inbox).length;

    // `waiting` が空だと waiting_human は running へ補正されるので、先に確認を積む。
    fake.ask('mgr-sad', 'req-sad-1', '確認したいことがある');
    await vi.waitFor(async () => {
      const summary = (await pool.list()).find((entry) => entry.managerId === 'mgr-sad');
      if ((summary?.waiting.length ?? 0) === 0) throw new Error('ask がまだ届いていない');
    });

    fake.report('mgr-sad', 'ただの報告です', 'waiting_human');

    const event = await vi.waitFor(() => {
      const found = managerMessages(inbox).slice(before);
      const hit = found.find((entry) => entry.kind === 'report');
      if (!hit) throw new Error('まだ届いていない');
      return hit;
    });

    expect(event.text).not.toContain('status=');
    expect(event.statusAtDelivery).toBe('waiting_human');

    await pool.stop();
  });

  it('唯一「status=」を散文に埋める経路でも、statusAtDelivery は散文を読まずに同じ値になる', async () => {
    const { pool, stores, inbox, fake } = await runningManualSetup();

    fake.report('mgr-sad', '完了を待つ', 'done', {
      awaitingBackground: { count: 1, breakdown: 'shell×1' },
    });
    // job.lastReport の更新では待たない: 畳む処理より手前で確定するので競走になる。decision 日誌を待つ。
    await vi.waitFor(async () => {
      const entries = await stores.journal.list({ types: ['decision'] });
      const found = entries.some((entry) =>
        JSON.stringify(entry).includes(
          '背景処理の完了待ちで畳んだターンの報告なので受信箱へは回さない',
        ),
      );
      if (!found) throw new Error('まだ畳まれていない');
    });

    const before = managerMessages(inbox).length;
    fake.closed('mgr-sad', 'lost', '接続が切れた');

    // 文言では選ばない: 文言一致で選ぶと「散文に依存しない」ことを選定側で破るので、位置（先頭の1本）で特定する。
    const event = await vi.waitFor(() => {
      const found = managerMessages(inbox).slice(before);
      const hit = found[0];
      if (!hit) throw new Error('まだ届いていない');
      return hit;
    });

    expect(event.text).toContain('status=lost');
    expect(event.statusAtDelivery).toBe('lost');

    await pool.stop();
  });
});
