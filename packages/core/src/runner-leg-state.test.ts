import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { createManagerPool } from './manager.js';
import { createMemoryStores } from './testing.js';
import { createRunnerRegistry } from './runner-protocol.js';
import type {
  RunnerAnswerOutcome,
  RunnerClient,
  RunnerCredentialFingerprint,
  RunnerLegState,
  RunnerManagerState,
  RunnerPlacementResources,
  RunnerProfileFingerprint,
  RunnerProfileResult,
} from './runner-protocol.js';

const ALL_RUNNER_LEG_STATUSES: Record<RunnerLegState['status'], true> = {
  connected: true,
  down: true,
  'never-connected': true,
};

describe('RunnerLegState の網羅性', () => {
  it('3状態がすべて記録されている（対象が空でないことを先に確かめる）', () => {
    const statuses = Object.keys(ALL_RUNNER_LEG_STATUSES);
    expect(statuses.length).toBeGreaterThan(0);
    for (const status of statuses) {
      expect(['connected', 'down', 'never-connected']).toContain(status);
    }
    expect(statuses).toHaveLength(3);
  });
});

class LegStateRunner implements RunnerClient {
  readonly runnerId: string;
  readonly runnerIdKnown = true;
  readonly workspacePathKnown = true;
  readonly workspacePath = '/work/project';
  instanceId: string | undefined;
  pendingEvents: number | undefined;
  oldestPendingAt: string | undefined;
  legState: RunnerLegState | undefined;

  constructor(runnerId: string, instanceId: string | undefined) {
    this.runnerId = runnerId;
    this.instanceId = instanceId;
  }

  async identity(): Promise<
    | { runnerId?: string; instanceId?: string; pendingEvents?: number; oldestPendingAt?: string }
    | undefined
  > {
    return {
      runnerId: this.runnerId,
      ...(this.instanceId === undefined ? {} : { instanceId: this.instanceId }),
      ...(this.pendingEvents === undefined ? {} : { pendingEvents: this.pendingEvents }),
      ...(this.oldestPendingAt === undefined ? {} : { oldestPendingAt: this.oldestPendingAt }),
    };
  }

  async resources(): Promise<RunnerPlacementResources | undefined> {
    if (this.pendingEvents === undefined) return undefined;
    return {
      managers: 0,
      pendingEvents: this.pendingEvents,
      ...(this.oldestPendingAt === undefined ? {} : { oldestPendingAt: this.oldestPendingAt }),
    };
  }

  async connect(): Promise<void> {}
  async start(): Promise<{ cwd?: string }> {
    return {};
  }
  async resume(): Promise<{ cwd?: string }> {
    return {};
  }
  async send(): Promise<boolean> {
    return true;
  }
  async answer(): Promise<RunnerAnswerOutcome> {
    return { delivered: false };
  }
  async stop(): Promise<void> {}
  async list(): Promise<RunnerManagerState[]> {
    return [];
  }
  async transcript(): Promise<string | null> {
    return null;
  }
  async credentials(): Promise<RunnerCredentialFingerprint[]> {
    return [];
  }
  async setCredentials(): Promise<RunnerCredentialFingerprint[]> {
    return [];
  }
  async profile(): Promise<RunnerProfileFingerprint | undefined> {
    return undefined;
  }
  async setProfile(): Promise<RunnerProfileResult> {
    return { ok: true };
  }
  async close(): Promise<void> {}
}

describe('RunnerRegistry#entries() は client.legState をその場で読む', () => {
  it('legState を持つ実装では、そのまま entries() に出る（キャッシュしない・毎回読み直す）', async () => {
    const runner = new LegStateRunner('runner-a', 'boot-1');
    runner.legState = { status: 'connected', since: '2026-08-27T00:00:00.000Z' };
    const registry = createRunnerRegistry([runner]);
    await registry.register({ label: 'http://runner:4518', open: async () => runner });

    expect(registry.entries()[0]?.legState).toEqual({
      status: 'connected',
      since: '2026-08-27T00:00:00.000Z',
    });

    runner.legState = { status: 'down', lastFailureReason: 'boom' };
    expect(registry.entries()[0]?.legState).toEqual({ status: 'down', lastFailureReason: 'boom' });

    await registry.stop();
  });

  it("legState を持たない実装では、entries() に legState 自体が出ない（'never-connected' へ倒さない）", async () => {
    const runner = new LegStateRunner('runner-a', 'boot-1');
    const registry = createRunnerRegistry([runner]);
    await registry.register({ label: 'http://runner:4518', open: async () => runner });

    const entry = registry.entries()[0];
    expect(entry).not.toHaveProperty('legState');

    await registry.stop();
  });
});

describe('ManagerPool.runnerBacklog() が legState と、観測時に凍結した instanceId から instanceSwapped を付け足す', () => {
  beforeEach(() => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date('2026-08-27T00:00:00.000Z'));
  });
  afterEach(() => {
    vi.useRealTimers();
  });

  it('legState をそのまま写す（新しい往復はしない——identity() の呼び出し回数は heartbeat の周期どおり）', async () => {
    const runner = new LegStateRunner('runner-a', 'boot-1');
    runner.pendingEvents = 5;
    runner.legState = { status: 'connected', since: '2026-08-27T00:00:00.000Z' };
    const stores = createMemoryStores();
    const registry = createRunnerRegistry([runner]);
    const pool = createManagerPool({ stores, post: () => undefined, runners: registry });

    await vi.advanceTimersByTimeAsync(10_000);

    expect(pool.runnerBacklog!()).toEqual([
      {
        runnerId: 'runner-a',
        pendingEvents: 5,
        observedAt: '2026-08-27T00:00:10.000Z',
        instanceIdAtObservation: 'boot-1',
        legState: { status: 'connected', since: '2026-08-27T00:00:00.000Z' },
        instanceSwapped: false,
      },
    ]);

    await pool.stop();
    await registry.stop();
  });

  it('legState を持たない runner では、legState 欄ごと省く（観測していない）', async () => {
    const runner = new LegStateRunner('runner-a', 'boot-1');
    runner.pendingEvents = 5;
    const stores = createMemoryStores();
    const registry = createRunnerRegistry([runner]);
    const pool = createManagerPool({ stores, post: () => undefined, runners: registry });

    await vi.advanceTimersByTimeAsync(10_000);

    const snapshot = pool.runnerBacklog!()[0];
    expect(snapshot).not.toHaveProperty('legState');

    await pool.stop();
    await registry.stop();
  });

  it('滞留を観測した後に器が入れ替わったら instanceSwapped: true', async () => {
    const runner = new LegStateRunner('runner-a', 'boot-1');
    runner.pendingEvents = 5;
    runner.legState = { status: 'connected', since: '2026-08-27T00:00:10.000Z' };
    const stores = createMemoryStores();
    const registry = createRunnerRegistry([runner]);
    const pool = createManagerPool({ stores, post: () => undefined, runners: registry });

    await vi.advanceTimersByTimeAsync(10_000);
    expect(pool.runnerBacklog!()).toEqual([
      {
        runnerId: 'runner-a',
        pendingEvents: 5,
        observedAt: '2026-08-27T00:00:10.000Z',
        instanceIdAtObservation: 'boot-1',
        legState: { status: 'connected', since: '2026-08-27T00:00:10.000Z' },
        instanceSwapped: false,
      },
    ]);

    runner.instanceId = 'boot-2';
    runner.pendingEvents = undefined;
    runner.legState = { status: 'connected', since: '2026-08-27T00:00:20.000Z' };
    await vi.advanceTimersByTimeAsync(10_000);

    const snapshot = pool.runnerBacklog!()[0];
    expect(snapshot?.pendingEvents).toBe(5);
    expect(snapshot?.observedAt).toBe('2026-08-27T00:00:10.000Z');
    expect(snapshot?.instanceIdAtObservation).toBe('boot-1');
    expect(snapshot?.legState).toEqual({ status: 'connected', since: '2026-08-27T00:00:20.000Z' });
    expect(snapshot?.instanceSwapped).toBe(true);

    await pool.stop();
    await registry.stop();
  });

  it('滞留を観測した時点で instanceId を一度も聞けていなければ、その後の初めての名乗りを入れ替えと誤読しない（偽陽性の確認）', async () => {
    const runner = new LegStateRunner('runner-a', undefined);
    const stores = createMemoryStores();
    const registry = createRunnerRegistry([runner]);
    const pool = createManagerPool({ stores, post: () => undefined, runners: registry });

    runner.pendingEvents = 9;
    runner.oldestPendingAt = '2026-08-20T00:00:00.000Z';
    await pool.runners({ resources: true });

    let snapshot = pool.runnerBacklog!()[0];
    expect(snapshot?.pendingEvents).toBe(9);
    expect(snapshot).not.toHaveProperty('instanceIdAtObservation');
    expect(snapshot).not.toHaveProperty('instanceSwapped');

    runner.pendingEvents = undefined;
    runner.instanceId = 'boot-1';
    await vi.advanceTimersByTimeAsync(10_000);

    snapshot = pool.runnerBacklog!()[0];
    expect(snapshot?.pendingEvents).toBe(9);
    expect(snapshot?.instanceSwapped).not.toBe(true);
    expect(snapshot).not.toHaveProperty('instanceSwapped');

    await pool.stop();
    await registry.stop();
  });

  it('instanceId を一度も聞けていない runner では instanceSwapped を付けない（判定できない）', async () => {
    const runner = new LegStateRunner('runner-a', undefined);
    runner.pendingEvents = 5;
    runner.legState = { status: 'connected', since: '2026-08-27T00:00:10.000Z' };
    const stores = createMemoryStores();
    const registry = createRunnerRegistry([runner]);
    const pool = createManagerPool({ stores, post: () => undefined, runners: registry });

    await vi.advanceTimersByTimeAsync(10_000);

    const snapshot = pool.runnerBacklog!()[0];
    expect(snapshot).not.toHaveProperty('instanceSwapped');

    await pool.stop();
    await registry.stop();
  });
});
