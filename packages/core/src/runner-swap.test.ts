import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { createRunnerRegistry } from './runner-protocol.js';
import type {
  RunnerAnswerOutcome,
  RunnerClient,
  RunnerCredentialFingerprint,
  RunnerManagerState,
  RunnerProfileFingerprint,
  RunnerProfileResult,
} from './runner-protocol.js';

class IdentifyingRunner implements RunnerClient {
  readonly runnerId: string;
  runnerIdKnown = true;
  readonly workspacePathKnown = true;
  readonly workspacePath = '/work/project';
  probes = 0;
  instanceId: string | undefined;
  claimedRunnerId: string;
  revision: { status: 'known'; commit: string; short: string; source: 'build' } | undefined;
  pendingEvents: number | undefined;
  oldestPendingAt: string | undefined;

  constructor(runnerId: string, instanceId: string | undefined) {
    this.runnerId = runnerId;
    this.claimedRunnerId = runnerId;
    this.instanceId = instanceId;
  }

  async identity(): Promise<
    | {
        runnerId?: string;
        instanceId?: string;
        revision?: IdentifyingRunner['revision'];
        pendingEvents?: number;
        oldestPendingAt?: string;
      }
    | undefined
  > {
    this.probes += 1;
    return {
      runnerId: this.claimedRunnerId,
      ...(this.instanceId === undefined ? {} : { instanceId: this.instanceId }),
      ...(this.revision === undefined ? {} : { revision: this.revision }),
      ...(this.pendingEvents === undefined ? {} : { pendingEvents: this.pendingEvents }),
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

class PingOnlyRunner extends IdentifyingRunner {
  override identity = undefined as unknown as IdentifyingRunner['identity'];

  async ping(): Promise<void> {
    this.probes += 1;
  }
}

beforeEach(() => {
  vi.useFakeTimers();
});

afterEach(() => {
  vi.useRealTimers();
});

describe('器の入れ替えを見分ける', () => {
  it('同じ宛先に別のプロセスが応え始めたら知らせる', async () => {
    const swaps: { label: string; runnerId?: string; before: string; after: string }[] = [];
    const runner = new IdentifyingRunner('runner-a', 'boot-1');
    const registry = createRunnerRegistry([], { onSwap: (event) => swaps.push(event) });
    await registry.register({ label: 'http://runner:4518', open: async () => runner });

    expect(runner.probes).toBe(0);
    expect(swaps).toEqual([]);

    await vi.advanceTimersByTimeAsync(10_000);
    expect(runner.probes).toBe(1);
    expect(swaps).toEqual([]);

    await vi.advanceTimersByTimeAsync(10_000);
    expect(runner.probes).toBe(2);
    expect(swaps).toEqual([]);

    runner.instanceId = 'boot-2';
    await vi.advanceTimersByTimeAsync(10_000);

    expect(swaps).toMatchObject([
      {
        label: 'http://runner:4518',
        runnerId: 'runner-a',
        before: 'boot-1',
        after: 'boot-2',
      },
    ]);

    await registry.stop();
  });

  it('いま応えているプロセスと、それを初めて見た時刻が名簿の状態として出る', async () => {
    const runner = new IdentifyingRunner('runner-a', 'boot-1');
    const registry = createRunnerRegistry([]);
    await registry.register({ label: 'http://runner:4518', open: async () => runner });

    const opened = registry.entries()[0];
    expect(opened?.instanceId).toBe('boot-1');
    const firstSeen = opened?.instanceSince;
    expect(firstSeen).toEqual(expect.any(String));

    // 同じ相手なら「初めて見た時刻」を動かさない: 動かすと入れ替わりの猶予が先送りされ続け、引き取れる時刻が来ない。
    await vi.advanceTimersByTimeAsync(20_000);
    expect(registry.entries()[0]?.instanceSince).toBe(firstSeen);

    runner.instanceId = 'boot-2';
    await vi.advanceTimersByTimeAsync(10_000);
    const swapped = registry.entries()[0];
    expect(swapped?.instanceId).toBe('boot-2');
    expect(Date.parse(swapped?.instanceSince ?? '')).toBeGreaterThan(Date.parse(firstSeen ?? ''));

    await registry.stop();
  });

  it('入れ替わるたびに知らせる', async () => {
    const swaps: { before: string; after: string }[] = [];
    const runner = new IdentifyingRunner('runner-a', 'boot-1');
    const registry = createRunnerRegistry([], { onSwap: (event) => swaps.push(event) });
    await registry.register({ label: 'http://runner:4518', open: async () => runner });

    await vi.advanceTimersByTimeAsync(10_000);
    runner.instanceId = 'boot-2';
    await vi.advanceTimersByTimeAsync(10_000);
    runner.instanceId = 'boot-3';
    await vi.advanceTimersByTimeAsync(10_000);

    expect(swaps).toMatchObject([
      { before: 'boot-1', after: 'boot-2' },
      { before: 'boot-2', after: 'boot-3' },
    ]);

    await registry.stop();
  });

  it('別の runner_id を名乗られても、宛先の名前は書き換えない', async () => {
    const swaps: { runnerId?: string }[] = [];
    const runner = new IdentifyingRunner('runner-a', 'boot-1');
    const registry = createRunnerRegistry([], { onSwap: (event) => swaps.push(event) });
    await registry.register({ label: 'http://runner:4518', open: async () => runner });

    await vi.advanceTimersByTimeAsync(10_000);

    runner.instanceId = 'boot-2';
    runner.claimedRunnerId = 'runner-imposter';
    await vi.advanceTimersByTimeAsync(10_000);

    expect(swaps).toMatchObject([{ runnerId: 'runner-a' }]);
    expect((await registry.get('runner-a'))?.runnerId).toBe('runner-a');
    expect(await registry.get('runner-imposter')).toBeNull();

    await registry.stop();
  });

  it('runnerId を聞けていない runner の入れ替えでは、runnerId を出さない（#330）', async () => {
    const swaps: { label: string; runnerId?: string; before: string; after: string }[] = [];
    const runner = new IdentifyingRunner('runner-primary', 'boot-1');
    runner.runnerIdKnown = false;
    const registry = createRunnerRegistry([], { onSwap: (event) => swaps.push(event) });
    await registry.register({ label: 'http://runner:4518', open: async () => runner });

    await vi.advanceTimersByTimeAsync(10_000);
    runner.instanceId = 'boot-2';
    await vi.advanceTimersByTimeAsync(10_000);

    expect(swaps).toMatchObject([
      { label: 'http://runner:4518', before: 'boot-1', after: 'boot-2' },
    ]);
    expect(swaps[0]).not.toHaveProperty('runnerId');

    await registry.stop();
  });

  it('identity() を持たない runner では判定しない（生死は今まで通り見る）', async () => {
    const swaps: unknown[] = [];
    const runner = new PingOnlyRunner('runner-old', undefined);
    const registry = createRunnerRegistry([], { onSwap: (event) => swaps.push(event) });
    await registry.register({ label: 'http://runner:4518', open: async () => runner });

    await vi.advanceTimersByTimeAsync(30_000);

    expect(runner.probes).toBe(3);
    expect(swaps).toEqual([]);
    expect(registry.entries()).toMatchObject([{ state: 'connected' }]);

    await registry.stop();
  });

  it('instanceId を名乗らない応答でも判定しない', async () => {
    const swaps: unknown[] = [];
    const runner = new IdentifyingRunner('runner-a', undefined);
    const registry = createRunnerRegistry([], { onSwap: (event) => swaps.push(event) });
    await registry.register({ label: 'http://runner:4518', open: async () => runner });

    await vi.advanceTimersByTimeAsync(30_000);

    expect(runner.probes).toBe(3);
    expect(swaps).toEqual([]);

    await registry.stop();
  });

  it('版を名乗らない runner（LocalRunner 相当）は connected でも unheard のまま——heartbeat が回っても動かない', async () => {
    const runner = new IdentifyingRunner('runner-fresh', 'boot-1');
    const registry = createRunnerRegistry();
    await registry.register({ label: 'http://runner-fresh:4518', open: async () => runner });

    expect(runner.probes).toBe(0);
    expect(registry.entries()).toMatchObject([
      { label: 'http://runner-fresh:4518', state: 'connected', revision: { status: 'unheard' } },
    ]);

    await vi.advanceTimersByTimeAsync(10_000);
    expect(runner.probes).toBe(1);
    expect(registry.entries()).toMatchObject([
      { label: 'http://runner-fresh:4518', revision: { status: 'unheard' } },
    ]);

    await registry.stop();
  });

  it('版を名乗る runner は、接続した瞬間（heartbeat 前）から known として見える', async () => {
    const runner = new IdentifyingRunner('runner-fresh', 'boot-1');
    runner.revision = {
      status: 'known',
      commit: 'c'.repeat(40),
      short: 'c'.repeat(12),
      source: 'build',
    };
    const registry = createRunnerRegistry();
    await registry.register({ label: 'http://runner-fresh:4518', open: async () => runner });

    expect(runner.probes).toBe(0);
    expect(registry.entries()).toMatchObject([
      {
        label: 'http://runner-fresh:4518',
        state: 'connected',
        revision: { status: 'known', commit: 'c'.repeat(40) },
      },
    ]);

    await registry.stop();
  });
});

describe('runner→デーモンの脚の滞留を heartbeat からも warm する（#358 案b の第2段）', () => {
  it('#probe が1周すると、値と観測時刻の両方が名簿に入る', async () => {
    const runner = new IdentifyingRunner('runner-a', 'boot-1');
    runner.pendingEvents = 5;
    runner.oldestPendingAt = '2026-08-20T00:00:00.000Z';
    const registry = createRunnerRegistry([], {});
    await registry.register({ label: 'http://runner:4518', open: async () => runner });

    expect(registry.entries()[0]).not.toHaveProperty('pendingEvents');

    await vi.advanceTimersByTimeAsync(10_000);
    expect(runner.probes).toBe(1);

    const entry = registry.entries()[0];
    expect(entry?.pendingEvents).toBe(5);
    expect(entry?.oldestPendingAt).toBe('2026-08-20T00:00:00.000Z');
    expect(entry?.pendingEventsObservedAt).toEqual(expect.any(String));

    await registry.stop();
  });

  it('pendingEvents が0のときも、そのまま記録される（0は「取れていない」ではない）', async () => {
    const runner = new IdentifyingRunner('runner-a', 'boot-1');
    runner.pendingEvents = 0;
    const registry = createRunnerRegistry([], {});
    await registry.register({ label: 'http://runner:4518', open: async () => runner });

    await vi.advanceTimersByTimeAsync(10_000);

    const entry = registry.entries()[0];
    expect(entry?.pendingEvents).toBe(0);
    expect(entry).not.toHaveProperty('oldestPendingAt');
    expect(entry?.pendingEventsObservedAt).toEqual(expect.any(String));

    await registry.stop();
  });

  it('identity() を持たない runner では、pendingEvents は一切書かれない（0で埋めない）', async () => {
    const runner = new PingOnlyRunner('runner-old', undefined);
    const registry = createRunnerRegistry([], {});
    await registry.register({ label: 'http://runner:4518', open: async () => runner });

    await vi.advanceTimersByTimeAsync(30_000);

    expect(runner.probes).toBe(3);
    expect(registry.entries()).toMatchObject([{ state: 'connected' }]);
    const entry = registry.entries()[0];
    expect(entry).not.toHaveProperty('pendingEvents');
    expect(entry).not.toHaveProperty('oldestPendingAt');
    expect(entry).not.toHaveProperty('pendingEventsObservedAt');

    await registry.stop();
  });

  it('pendingEvents を返さない回があっても、前回までの値は残る', async () => {
    const runner = new IdentifyingRunner('runner-a', 'boot-1');
    runner.pendingEvents = 3;
    const registry = createRunnerRegistry([], {});
    await registry.register({ label: 'http://runner:4518', open: async () => runner });

    await vi.advanceTimersByTimeAsync(10_000);
    expect(registry.entries()[0]?.pendingEvents).toBe(3);

    runner.pendingEvents = undefined;
    await vi.advanceTimersByTimeAsync(10_000);

    expect(registry.entries()[0]?.pendingEvents).toBe(3);

    await registry.stop();
  });
});
