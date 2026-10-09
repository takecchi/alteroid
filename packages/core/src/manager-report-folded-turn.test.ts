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
import type { RateLimitFacts, UsageLimitNotice } from './usage-limits.js';
import type { Stores } from './store.js';

interface ManualRunner {
  runner: RunnerClient;
  alive: RunnerManagerState[];
  report(
    managerId: string,
    text: string,
    status: JobStatus,
    fields?: {
      failure?: { code: string; via: string };
      unreported?: { reason: string };
      synthesized?: string;
    },
  ): void;
  rateLimit(managerId: string, facts: RateLimitFacts): void;
  usageNotice(managerId: string, notice: UsageLimitNotice): void;
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
      /* 使わない */
    },
  };

  return {
    runner,
    alive,
    report(managerId, text, status, fields = {}) {
      emit?.({ type: 'report', managerId, text, status, ...fields });
    },
    rateLimit(managerId, facts) {
      emit?.({ type: 'rate_limit', managerId, facts });
    },
    usageNotice(managerId, notice) {
      emit?.({ type: 'usage_notice', managerId, notice });
    },
  };
}

interface ManualSetup {
  pool: ManagerPool;
  stores: Stores;
  inbox: InboxEvent[];
  fake: ManualRunner;
}

async function runningManualSetup(
  managerId = 'mgr-folded',
  synthesizedNoticeWindowMs = 30,
): Promise<ManualSetup> {
  const stores = createMemoryStores();
  const fake = manualRunner();
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
  await stores.jobs.putJob(job);
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
  const pool = createManagerPool({
    stores,
    post: (event) => inbox.push(event),
    runners: registry,
    synthesizedNoticeWindowMs,
  });

  await pool.restore();
  await vi.waitFor(() => {
    if (inbox.length < 1) throw new Error('reattach の知らせがまだ届いていない');
  });

  return { pool, stores, inbox, fake };
}

function reportsOf(inbox: InboxEvent[]) {
  return inbox.filter((event) => event.type === 'manager_message' && event.kind === 'report') as {
    text: string;
    foldedTurn?: true;
  }[];
}

describe('manager.ts → 受信箱: event.failure / event.unreported が manager_message.foldedTurn として届く（Issue #1848）', () => {
  it('event.failure が付く回（runner.ts の failedReportText 経由、synthesized: "turn_failed"）は foldedTurn: true が届く', async () => {
    const { pool, inbox, fake } = await runningManualSetup();
    const before = reportsOf(inbox).length;

    fake.report(
      'mgr-folded',
      '（このターンは応答を返さずに終わった: success/429 / result_is_error）' +
        "You've hit your individual spend limit for this account.",
      'done',
      { failure: { code: 'success/429', via: 'result_is_error' }, synthesized: 'turn_failed' },
    );

    await vi.waitFor(() => {
      if (reportsOf(inbox).length <= before)
        throw new Error('report がまだ合流窓から配られていない');
    });

    const delivered = reportsOf(inbox).slice(before);
    expect(delivered).toHaveLength(1);
    expect(delivered[0]?.text).toContain('このターンは応答を返さずに終わった');
    expect(delivered[0]?.foldedTurn).toBe(true);

    await pool.stop();
  });

  it('event.unreported が付く回（runner.ts の #flushUnreported 経由、synthesized を伴わない）は foldedTurn: true が届く', async () => {
    const { pool, inbox, fake } = await runningManualSetup();
    const before = reportsOf(inbox).length;

    fake.report(
      'mgr-folded',
      '（このターンは結果を受け取らないまま畳まれた: デーモンから停止を指示された。）\n' +
        '（以下は畳まれる前にマネージャーが書いていた本文である。ターンの途中の発言が' +
        '混ざっていることがある）\n\n途中まで調べた内容',
      'running',
      { unreported: { reason: 'デーモンから停止を指示された。' } },
    );

    await vi.waitFor(() => {
      if (reportsOf(inbox).length <= before) throw new Error('report がまだ届いていない');
    });

    const delivered = reportsOf(inbox).slice(before);
    expect(delivered).toHaveLength(1);
    expect(delivered[0]?.text).toContain('結果を受け取らないまま畳まれた');
    expect(delivered[0]?.foldedTurn).toBe(true);

    await pool.stop();
  });

  it('failure も unreported も無い、普通に完了した report では foldedTurn はキーごと付かない', async () => {
    const { pool, inbox, fake } = await runningManualSetup();
    const before = reportsOf(inbox).length;

    fake.report('mgr-folded', '普通に完遂した報告の本文', 'done');

    await vi.waitFor(() => {
      if (reportsOf(inbox).length <= before) throw new Error('report がまだ届いていない');
    });

    const delivered = reportsOf(inbox).slice(before);
    expect(delivered).toHaveLength(1);
    expect(delivered[0]?.text).toBe('普通に完遂した報告の本文');
    expect(delivered[0]?.foldedTurn).toBeUndefined();
    expect(Object.hasOwn(delivered[0] as object, 'foldedTurn')).toBe(false);

    await pool.stop();
  });
});

// 同じ族（`turn_failed`）で本文が違う回は1本へ寄らず別々に flush されるので、
// 合流を起こすのは完全な重複か族の異なる断片だけ（同じ族・違う本文はここでは扱わない）。
describe('合流窓で複数件が1本へ寄る回（arrived > 1）でも foldedTurn は正しく立つ（Issue #1848）', () => {
  it('turn_failed の完全な重複が3通、同じ窓に届く（×3 として1件へ寄る）と foldedTurn: true のまま', async () => {
    const { pool, inbox, fake } = await runningManualSetup();
    const before = reportsOf(inbox).length;

    const same = '（このターンは応答を返さずに終わった: success/429 / result_is_error）';
    for (let i = 0; i < 3; i += 1) {
      fake.report('mgr-folded', same, 'done', {
        failure: { code: 'success/429', via: 'result_is_error' },
        synthesized: 'turn_failed',
      });
    }

    await vi.waitFor(() => {
      if (reportsOf(inbox).length <= before)
        throw new Error('report がまだ合流窓から配られていない');
    });

    const delivered = reportsOf(inbox).slice(before);
    expect(delivered).toHaveLength(1);
    expect(delivered[0]?.text).toContain('×3');
    expect(delivered[0]?.foldedTurn).toBe(true);

    await pool.stop();
  });

  it('turn_failed と rate_limit（別の族）が同じ窓で合流しても foldedTurn: true のまま（束の中の1つが turn_failed なら立つ）', async () => {
    const { pool, inbox, fake } = await runningManualSetup();
    const before = reportsOf(inbox).length;

    fake.rateLimit('mgr-folded', { status: 'rejected', kind: 'five_hour' });
    fake.report('mgr-folded', '（このターンは応答を返さずに終わった: 混在の回）', 'done', {
      failure: { code: 'success/429', via: 'result_is_error' },
      synthesized: 'turn_failed',
    });

    await vi.waitFor(() => {
      if (reportsOf(inbox).length <= before)
        throw new Error('report がまだ合流窓から配られていない');
    });

    const delivered = reportsOf(inbox).slice(before);
    expect(delivered).toHaveLength(1);
    expect(delivered[0]?.text).toContain('枠から追い返された');
    expect(delivered[0]?.text).toContain('混在の回');
    expect(delivered[0]?.foldedTurn).toBe(true);

    await pool.stop();
  });

  it('rate_limit と usage_notice だけが合流し、turn_failed が無ければ foldedTurn はキーごと付かない', async () => {
    const { pool, inbox, fake } = await runningManualSetup();
    const before = reportsOf(inbox).length;

    fake.rateLimit('mgr-folded', { status: 'rejected', kind: 'five_hour' });
    fake.usageNotice('mgr-folded', { kind: 'reached', text: '上限に当たった' });

    await vi.waitFor(() => {
      if (reportsOf(inbox).length <= before)
        throw new Error('report がまだ合流窓から配られていない');
    });

    const delivered = reportsOf(inbox).slice(before);
    expect(delivered).toHaveLength(1);
    expect(delivered[0]?.foldedTurn).toBeUndefined();
    expect(Object.hasOwn(delivered[0] as object, 'foldedTurn')).toBe(false);

    await pool.stop();
  });
});
