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

interface AnsweredCall {
  requestId: string;
  message: string;
  decision?: 'allow' | 'deny';
}

interface ManualRunner {
  runner: RunnerClient;
  alive: RunnerManagerState[];
  answeredCalls: AnsweredCall[];
  report(managerId: string, text: string, status: JobStatus): void;
  ask(managerId: string, requestId: string, summary: string, askedAt?: string): void;
  closed(managerId: string, status: 'done' | 'lost' | 'failed', reason: string): void;
  denied(managerId: string, tool: string, fields?: { actor?: string; inputHead?: string }): void;
  toolUse(managerId: string, actor: string, tool: string): void;
}

function manualRunner(runnerId = 'runner-primary'): ManualRunner {
  let emit: ((event: RunnerEvent) => void) | null = null;
  const alive: RunnerManagerState[] = [];
  const answeredCalls: AnsweredCall[] = [];

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
    async answer(_managerId, answer): Promise<RunnerAnswerOutcome> {
      answeredCalls.push({
        requestId: answer.requestId,
        message: answer.message,
        ...(answer.decision === undefined ? {} : { decision: answer.decision }),
      });
      return { delivered: true };
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
    answeredCalls,
    report(managerId, text, status) {
      emit?.({ type: 'report', managerId, text, status });
    },
    ask(managerId, requestId, summary, askedAt) {
      emit?.({
        type: 'ask',
        managerId,
        requestId,
        kind: 'permission',
        summary,
        // 既定は実時間: 可変クロックと比べるテストは `askedAt` を明示する。
        askedAt: askedAt ?? new Date().toISOString(),
      });
    },
    closed(managerId, status, reason) {
      const at = alive.findIndex((entry) => entry.managerId === managerId);
      if (at !== -1) alive.splice(at, 1);
      emit?.({ type: 'closed', managerId, status, reason });
    },
    denied(managerId, tool, fields = {}) {
      emit?.({
        type: 'permission_denied',
        managerId,
        toolUseId: `${tool}:${String(Math.random())}`,
        tool,
        input: {},
        via: 'live',
        ...fields,
      });
    },
    toolUse(managerId, actor, tool) {
      emit?.({ type: 'tool_use', managerId, actor, tool });
    },
  };
}

interface ManualSetup {
  pool: ManagerPool;
  stores: Stores;
  inbox: InboxEvent[];
  fake: ManualRunner;
  advance: (ms: number) => void;
  nowIso: () => string;
}

async function runningManualSetup(managerId = 'mgr-denial-renotify-cross'): Promise<ManualSetup> {
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
  let clock = Date.parse('2026-09-01T00:00:00.000Z');
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

  return {
    pool,
    stores,
    inbox,
    fake,
    advance: (ms) => (clock += ms),
    nowIso: () => new Date(clock).toISOString(),
  };
}

async function waitForDenialJournaled(stores: Stores, tool: string): Promise<void> {
  await vi.waitFor(async () => {
    const entries = await stores.journal.list({ types: ['exchange'] });
    const matches = entries.filter((entry) =>
      JSON.stringify(entry).includes(`${tool} の実行が確認へ上がらずに止められた`),
    );
    if (matches.length < 1) {
      throw new Error(`${tool} の拒否がまだ日誌に載っていない`);
    }
  });
}

const TEN_MINUTES_MS = 10 * 60_000;

describe('renotifyStalledDenials のクロスtool starvation（横断レビュー14回目 s2・issue #1772）', () => {
  it(
    '無関係な道具の未決確認（waiting_human）が片付くのを待たずに、' +
      '10分以上前に拒否された別の道具の知らせ直しが届く',
    async () => {
      const { pool, stores, inbox, fake, advance } = await runningManualSetup();

      fake.denied('mgr-denial-renotify-cross', 'Bash', {
        actor: 'manager:mgr-denial-renotify-cross',
      });
      await waitForDenialJournaled(stores, 'Bash');

      advance(TEN_MINUTES_MS + 1);

      fake.ask('mgr-denial-renotify-cross', 'req-unrelated', '無関係などの許可確認');
      await new Promise((resolve) => setTimeout(resolve, 20));

      const before = inbox.length;
      await pool.renotifyStalledDenials();
      await new Promise((resolve) => setTimeout(resolve, 20));

      const delivered = inbox.slice(before).find((event) => event.type === 'manager_message');
      expect(
        delivered,
        'Bash の知らせ直しが届くべきだが、現行コードは無関係な未決確認の影響で止める',
      ).toBeDefined();

      await pool.stop();
    },
  );

  it(
    '知らせ直しより前から未決の無関係な確認は、requestId 無しの decision を黙って当てず断る' +
      '（issue #1772 段2。許しすぎる側の穴を塞ぐ）',
    async () => {
      const { pool, stores, fake, advance, nowIso } = await runningManualSetup();

      fake.denied('mgr-denial-renotify-cross', 'Bash', {
        actor: 'manager:mgr-denial-renotify-cross',
      });
      await waitForDenialJournaled(stores, 'Bash');
      advance(TEN_MINUTES_MS + 1);

      // `askedAt` は可変クロックの値を明示する: 既定の実時間だと知らせ直しとの前後関係が定まらない。
      fake.ask('mgr-denial-renotify-cross', 'req-unrelated-2', '無関係などの許可確認', nowIso());
      await new Promise((resolve) => setTimeout(resolve, 20));

      advance(1);
      await pool.renotifyStalledDenials();
      await new Promise((resolve) => setTimeout(resolve, 20));

      const result = await pool.send('mgr-denial-renotify-cross', 'よし、許可します', {
        decision: 'allow',
      });

      expect(result.outcome).toBe('unknown');
      expect(result.detail).toContain('req-unrelated-2');
      expect(result.detail).toContain('requestId');
      expect(result.detail).toContain('Bash');
      expect(fake.answeredCalls).toHaveLength(0);

      const explicit = await pool.send('mgr-denial-renotify-cross', 'よし', {
        decision: 'allow',
        requestId: 'req-unrelated-2',
      });
      expect(explicit.outcome).toBe('answered');
      expect(fake.answeredCalls).toHaveLength(1);
      expect(fake.answeredCalls[0]?.requestId).toBe('req-unrelated-2');

      await pool.stop();
    },
  );

  it(
    '対照: 知らせ直しの後にできた確認は、requestId 無しの decision でも今までどおり当たる' +
      '（issue #1772 段2で保つべき既存の能力。#313）',
    async () => {
      const { pool, stores, fake, advance } = await runningManualSetup();

      fake.denied('mgr-denial-renotify-cross', 'Bash', {
        actor: 'manager:mgr-denial-renotify-cross',
      });
      await waitForDenialJournaled(stores, 'Bash');
      advance(TEN_MINUTES_MS + 1);

      await pool.renotifyStalledDenials();
      await new Promise((resolve) => setTimeout(resolve, 20));

      fake.ask('mgr-denial-renotify-cross', 'req-after-renotify', '新しい許可確認');
      await new Promise((resolve) => setTimeout(resolve, 20));

      const result = await pool.send('mgr-denial-renotify-cross', 'よし', { decision: 'allow' });
      expect(result.outcome).toBe('answered');
      expect(fake.answeredCalls).toHaveLength(1);
      expect(fake.answeredCalls[0]?.requestId).toBe('req-after-renotify');

      await pool.stop();
    },
  );

  it(
    '対照: 知らせ直しが一度も届いていない委譲は、requestId 無しの decision で今までどおり当たる' +
      '（issue #1772 段2で保つべき既存の能力。#313）',
    async () => {
      const { pool, fake } = await runningManualSetup();

      fake.ask('mgr-denial-renotify-cross', 'req-no-renotify', '許可確認');
      await new Promise((resolve) => setTimeout(resolve, 20));

      const result = await pool.send('mgr-denial-renotify-cross', 'よし', { decision: 'allow' });
      expect(result.outcome).toBe('answered');
      expect(fake.answeredCalls).toHaveLength(1);
      expect(fake.answeredCalls[0]?.requestId).toBe('req-no-renotify');

      await pool.stop();
    },
  );
});
