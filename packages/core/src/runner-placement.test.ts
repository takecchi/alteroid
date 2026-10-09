import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { createRunnerRegistry } from './runner-protocol.js';
import { createMemoryStores } from './testing.js';
import { createCloneTools } from './tools.js';
import type {
  RunnerAnswerOutcome,
  RunnerClient,
  RunnerCredentialFingerprint,
  RunnerManagerState,
  RunnerPlacementResources,
  RunnerProfileFingerprint,
  RunnerProfileResult,
} from './runner-protocol.js';

// `select` は常に置き先を返す: 資源は「どこに置くか」の材料であって、「置けるか」を決める定員にしない（north_star 禁止2）。
// cgroup とホストの値の違いは `runner-resources.test.ts` が押さえている。ここは受け取った報告の使い方だけを見る。

class FakeRunner implements RunnerClient {
  readonly runnerId: string;
  readonly runnerIdKnown = true;
  readonly workspacePathKnown = true;
  readonly workspacePath = '/work/project';
  report: RunnerPlacementResources | undefined;
  fails = false;
  hangs = false;
  asked = 0;
  started: string[] = [];

  constructor(runnerId: string, report?: RunnerPlacementResources) {
    this.runnerId = runnerId;
    this.report = report;
  }

  async resources(): Promise<RunnerPlacementResources | undefined> {
    this.asked += 1;
    if (this.fails) throw new Error('資源を聞けない');
    if (this.hangs) return new Promise<RunnerPlacementResources | undefined>(() => {});
    return this.report;
  }

  async ping(): Promise<void> {}
  async connect(): Promise<void> {}
  async start(command: { managerId: string }): Promise<{ cwd?: string }> {
    this.started.push(command.managerId);
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

async function registryOf(
  ...runners: FakeRunner[]
): Promise<ReturnType<typeof createRunnerRegistry>> {
  const registry = createRunnerRegistry();
  for (const runner of runners) {
    await registry.register({ label: `http://${runner.runnerId}`, open: async () => runner });
  }
  return registry;
}

describe('資源による配置', () => {
  it('メモリに余裕がある方へ置く（登録の順番では決めない）', async () => {
    const tight = new FakeRunner('runner-tight', {
      memory: { limitBytes: 32_000_000_000, usedBytes: 30_000_000_000, source: 'cgroup' },
      managers: 4,
    });
    const roomy = new FakeRunner('runner-roomy', {
      memory: { limitBytes: 32_000_000_000, usedBytes: 1_000_000_000, source: 'cgroup' },
      managers: 0,
    });
    const registry = await registryOf(tight, roomy);

    const chosen = await registry.select({});
    expect(chosen.runnerId).toBe('runner-roomy');

    await registry.stop();
  });

  it('メモリが同じなら、新しい1本の取り分が大きい方へ置く（CPU と稼働本数）', async () => {
    const memory = {
      limitBytes: 32_000_000_000,
      usedBytes: 8_000_000_000,
      source: 'cgroup',
    } as const;
    const small = new FakeRunner('runner-small', {
      memory,
      cpu: { cores: 4, source: 'cgroup' },
      managers: 2,
    });
    const large = new FakeRunner('runner-large', {
      memory,
      cpu: { cores: 32, source: 'cgroup' },
      managers: 4,
    });
    const registry = await registryOf(small, large);

    expect((await registry.select({})).runnerId).toBe('runner-large');

    await registry.stop();
  });

  it('資源を報告しない古い器を締め出さない（報告するのは M4 からある稼働本数だけ）', async () => {
    const reporting = new FakeRunner('runner-reporting', {
      memory: { limitBytes: 32_000_000_000, usedBytes: 31_500_000_000, source: 'cgroup' },
      cpu: { cores: 32, source: 'cgroup' },
      managers: 4,
    });
    const legacy = new FakeRunner('runner-legacy', { managers: 0 });
    const registry = await registryOf(reporting, legacy);

    expect((await registry.select({})).runnerId).toBe('runner-legacy');

    await registry.stop();
  });

  it('誰も資源を報告しないなら、抱えている本数の少ない方へ置く', async () => {
    const busy = new FakeRunner('runner-busy', { managers: 5 });
    const idle = new FakeRunner('runner-idle', { managers: 1 });
    const registry = await registryOf(busy, idle);

    expect((await registry.select({})).runnerId).toBe('runner-idle');

    await registry.stop();
  });

  it('資源を1つも名乗らない器（口の無い実装）でも置き先になる', async () => {
    const silent = new FakeRunner('runner-silent');
    const registry = await registryOf(silent);

    expect((await registry.select({})).runnerId).toBe('runner-silent');

    await registry.stop();
  });

  it('全部が使い切っていても置き先を返す（0点でも断らない）', async () => {
    const full = {
      limitBytes: 32_000_000_000,
      usedBytes: 32_000_000_000,
      source: 'cgroup',
    } as const;
    const first = new FakeRunner('runner-full-a', { memory: full, managers: 3 });
    const second = new FakeRunner('runner-full-b', { memory: full, managers: 9 });
    const registry = await registryOf(first, second);

    const chosen = await registry.select({});
    expect(chosen.runnerId).toBe('runner-full-a');

    await registry.stop();
  });

  it('資源を聞けない1台が混ざっても、聞けた報告で配置する', async () => {
    const broken = new FakeRunner('runner-broken', { managers: 0 });
    broken.fails = true;
    const tight = new FakeRunner('runner-tight', {
      memory: { limitBytes: 32_000_000_000, usedBytes: 30_000_000_000, source: 'cgroup' },
      managers: 4,
    });
    const roomy = new FakeRunner('runner-roomy', {
      memory: { limitBytes: 32_000_000_000, usedBytes: 1_000_000_000, source: 'cgroup' },
      managers: 0,
    });
    const registry = await registryOf(broken, tight, roomy);

    expect((await registry.select({})).runnerId).toBe('runner-roomy');
    expect(broken.asked).toBe(1);

    await registry.stop();
  });

  it('どれからも資源を聞けなくても置き先を返す（聞けないことを理由に断らない）', async () => {
    const first = new FakeRunner('runner-mute-a');
    const second = new FakeRunner('runner-mute-b');
    first.fails = true;
    second.fails = true;
    const registry = await registryOf(first, second);

    expect((await registry.select({})).runnerId).toBe('runner-mute-a');

    await registry.stop();
  });

  it('1台しか無いなら資源を聞きに行かない（委譲に往復を足さない）', async () => {
    const only = new FakeRunner('runner-only', { managers: 0 });
    const registry = await registryOf(only);

    expect((await registry.select({})).runnerId).toBe('runner-only');
    expect(only.asked).toBe(0);

    await registry.stop();
  });
});

describe('配置の材料としての pids（#712）', () => {
  const MEMORY = {
    limitBytes: 32_000_000_000,
    usedBytes: 8_000_000_000,
    source: 'cgroup',
  } as const;
  const CPU = { cores: 8, source: 'cgroup' } as const;

  it('他の材料が同じなら、プロセス数の余りが多い方へ置く（登録の順番では決めない）', async () => {
    const full = new FakeRunner('runner-full', {
      memory: MEMORY,
      cpu: CPU,
      pids: { current: 999, max: 1000 },
      managers: 2,
    });
    const room = new FakeRunner('runner-room', {
      memory: MEMORY,
      cpu: CPU,
      pids: { current: 3, max: 1000 },
      managers: 2,
    });
    const registry = await registryOf(full, room);

    expect((await registry.select({})).runnerId).toBe('runner-room');

    await registry.stop();
  });

  it('pids の欄を抜くと勝者が変わる（点数が pids を読んでいる、の変異による証明）', async () => {
    const withPids = await registryOf(
      new FakeRunner('runner-full', {
        memory: MEMORY,
        cpu: CPU,
        pids: { current: 999, max: 1000 },
        managers: 0,
      }),
      new FakeRunner('runner-room', {
        memory: MEMORY,
        cpu: CPU,
        pids: { current: 5, max: 1000 },
        managers: 1,
      }),
    );
    const withoutPids = await registryOf(
      new FakeRunner('runner-full', { memory: MEMORY, cpu: CPU, managers: 0 }),
      new FakeRunner('runner-room', { memory: MEMORY, cpu: CPU, managers: 1 }),
    );

    expect((await withoutPids.select({})).runnerId).toBe('runner-full');
    expect((await withPids.select({})).runnerId).toBe('runner-room');
    expect((await withPids.select({})).runnerId).not.toBe((await withoutPids.select({})).runnerId);

    await withPids.stop();
    await withoutPids.stop();
  });

  it('落ちて空いた満杯の器へ吸い込まれない（#712 の輪を切る）', async () => {
    const burned = new FakeRunner('runner-burned', {
      memory: MEMORY,
      cpu: CPU,
      pids: { current: 998, max: 1000 },
      managers: 1,
    });
    const healthy = new FakeRunner('runner-healthy', {
      memory: MEMORY,
      cpu: CPU,
      pids: { current: 115, max: 1000 },
      managers: 3,
    });
    const registry = await registryOf(burned, healthy);

    for (let i = 0; i < 3; i += 1) {
      expect((await registry.select({})).runnerId).toBe('runner-healthy');
    }

    await registry.stop();
  });

  it('pids を名乗らない器は、名乗った器の平均として競う（不当に不利にも有利にもならない）', async () => {
    const saturated = () =>
      new FakeRunner('runner-saturated', {
        memory: MEMORY,
        cpu: CPU,
        pids: { current: 980, max: 1000 },
        managers: 0,
      });
    const silent = () => new FakeRunner('runner-silent', { memory: MEMORY, cpu: CPU, managers: 0 });

    const roomyWins = await registryOf(
      saturated(),
      new FakeRunner('runner-roomy', {
        memory: MEMORY,
        cpu: CPU,
        pids: { current: 20, max: 1000 },
        managers: 0,
      }),
      silent(),
    );
    expect((await roomyWins.select({})).runnerId).toBe('runner-roomy');

    const silentWins = await registryOf(
      saturated(),
      new FakeRunner('runner-roomy', {
        memory: MEMORY,
        cpu: CPU,
        pids: { current: 20, max: 1000 },
        managers: 20,
      }),
      silent(),
    );
    expect((await silentWins.select({})).runnerId).toBe('runner-silent');

    await roomyWins.stop();
    await silentWins.stop();
  });

  it('memory も pids も名乗らない器は、実測した器の積を上回らない（#794）', async () => {
    const cpu = { cores: 8, source: 'cgroup' } as const;
    const registry = await registryOf(
      new FakeRunner('runner-b', {
        memory: { limitBytes: 1000, usedBytes: 0, source: 'cgroup' },
        cpu,
        pids: { current: 900, max: 1000 },
        managers: 0,
      }),
      new FakeRunner('runner-c', {
        memory: { limitBytes: 1000, usedBytes: 900, source: 'cgroup' },
        cpu,
        pids: { current: 0, max: 1000 },
        managers: 0,
      }),
      new FakeRunner('runner-a-silent', { cpu, managers: 0 }),
    );

    expect((await registry.select({})).runnerId).toBe('runner-b');

    await registry.stop();
  });

  it('pids を1台も名乗らない艦隊では、点数が #712 以前と1ミリも変わらない', async () => {
    const fleet = (pids?: { current: number; max: number }) =>
      registryOf(
        new FakeRunner('runner-small', {
          memory: MEMORY,
          cpu: { cores: 4, source: 'cgroup' },
          managers: 2,
          ...(pids === undefined ? {} : { pids }),
        }),
        new FakeRunner('runner-large', {
          memory: MEMORY,
          cpu: { cores: 32, source: 'cgroup' },
          managers: 4,
          ...(pids === undefined ? {} : { pids }),
        }),
      );

    const none = await fleet();
    const uniform = await fleet({ current: 500, max: 1000 });

    expect((await none.select({})).runnerId).toBe('runner-large');
    expect((await uniform.select({})).runnerId).toBe('runner-large');

    await none.stop();
    await uniform.stop();
  });

  it('pids まで全部使い切っていても置き先を返す（0点でも断らない）', async () => {
    const full = {
      limitBytes: 32_000_000_000,
      usedBytes: 32_000_000_000,
      source: 'cgroup',
    } as const;
    const first = new FakeRunner('runner-dead-a', {
      memory: full,
      cpu: CPU,
      pids: { current: 1000, max: 1000 },
      managers: 3,
    });
    const second = new FakeRunner('runner-dead-b', {
      memory: full,
      cpu: CPU,
      pids: { current: 1000, max: 1000 },
      managers: 9,
    });
    const registry = await registryOf(first, second);

    expect((await registry.select({})).runnerId).toBe('runner-dead-a');

    await registry.stop();
  });
});

// 落ちると `/health` の `managers` が減る側は `apps/runner/src/health-managers-on-failure.test.ts` が固定している。
// 勝者を3回続けて確かめる: `chooseByResources` は状態を持たない純関数で、決定的に同じ答えを返すことがこの輪の性質である。
describe('起動失敗が、その器の点数を上げない（#712）', () => {
  const MEMORY = {
    limitBytes: 8_000_000_000,
    usedBytes: 4_000_000_000,
    source: 'cgroup',
  } as const;
  const CPU = { cores: 8, source: 'cgroup' } as const;
  const PIDS = { current: 200, max: 1000 } as const;

  async function measuredFleet(runner2Managers: number) {
    return registryOf(
      new FakeRunner('runner-primary', { memory: MEMORY, cpu: CPU, pids: PIDS, managers: 3 }),
      new FakeRunner('runner-2', {
        memory: MEMORY,
        cpu: CPU,
        pids: PIDS,
        managers: runner2Managers,
      }),
      new FakeRunner('runner-3', { memory: MEMORY, cpu: CPU, pids: PIDS, managers: 3 }),
    );
  }

  async function winsThreeTimes(
    registry: ReturnType<typeof createRunnerRegistry>,
    runnerId: string,
  ): Promise<void> {
    for (let i = 0; i < 3; i += 1) {
      expect((await registry.select({})).runnerId).toBe(runnerId);
    }
  }

  it('落ちて空いた器へ吸い込まれない（pids に差が無い艦隊でも輪が切れる）', async () => {
    const ignored = await measuredFleet(1);
    const counted = await measuredFleet(1);
    counted.noteManagerFailed('runner-2');
    counted.noteManagerFailed('runner-2');

    await winsThreeTimes(ignored, 'runner-2');
    await winsThreeTimes(counted, 'runner-primary');

    await ignored.stop();
    await counted.stop();
  });

  it('落ちる前の答えへ戻すだけである（罰ではない）', async () => {
    const before = await measuredFleet(3);
    const after = await measuredFleet(1);
    after.noteManagerFailed('runner-2');
    after.noteManagerFailed('runner-2');

    expect((await before.select({})).runnerId).toBe('runner-primary');
    expect((await after.select({})).runnerId).toBe('runner-primary');

    await before.stop();
    await after.stop();
  });

  it('同点のときだけ、直近に落とした器を後ろへ回す（登録順の先に居ても勝たせない）', async () => {
    const registry = await registryOf(
      new FakeRunner('runner-burned', { memory: MEMORY, cpu: CPU, pids: PIDS, managers: 0 }),
      new FakeRunner('runner-healthy', { memory: MEMORY, cpu: CPU, pids: PIDS, managers: 2 }),
    );
    registry.noteManagerFailed('runner-burned');
    registry.noteManagerFailed('runner-burned');

    await winsThreeTimes(registry, 'runner-healthy');

    await registry.stop();
  });

  it('同点の判定を === でやらない（誤差ぶんだけ大きい点数に負けない）', async () => {
    // 浮動小数の誤差: runner-noise は 0.020000000000000004、runner-clean は 0.02。`===` で同点を判定すると分岐が効かなくなる
    const registry = await registryOf(
      new FakeRunner('runner-noise', {
        memory: { limitBytes: 1000, usedBytes: 900, source: 'cgroup' },
        cpu: { cores: 8, source: 'cgroup' },
        pids: { current: 800, max: 1000 },
        managers: 2,
      }),
      new FakeRunner('runner-clean', {
        memory: { limitBytes: 1000, usedBytes: 980, source: 'cgroup' },
        cpu: { cores: 8, source: 'cgroup' },
        pids: { current: 0, max: 1000 },
        managers: 3,
      }),
    );
    registry.noteManagerFailed('runner-noise');

    await winsThreeTimes(registry, 'runner-clean');

    await registry.stop();
  });

  it('点数に意味のある差が在れば、失敗数は効かない（同点のときだけの分岐である）', async () => {
    const registry = await registryOf(
      new FakeRunner('runner-burned-but-roomy', {
        memory: MEMORY,
        cpu: { cores: 32, source: 'cgroup' },
        pids: { current: 10, max: 1000 },
        managers: 0,
      }),
      new FakeRunner('runner-clean-but-tight', {
        memory: MEMORY,
        cpu: { cores: 2, source: 'cgroup' },
        pids: { current: 900, max: 1000 },
        managers: 8,
      }),
    );
    registry.noteManagerFailed('runner-burned-but-roomy');
    registry.noteManagerFailed('runner-burned-but-roomy');

    await winsThreeTimes(registry, 'runner-burned-but-roomy');

    await registry.stop();
  });

  it('失敗を1本も数えていない艦隊では、点数が #712 以前と1ミリも変わらない', async () => {
    const registry = await registryOf(
      new FakeRunner('runner-small', {
        memory: MEMORY,
        cpu: { cores: 4, source: 'cgroup' },
        managers: 2,
      }),
      new FakeRunner('runner-large', {
        memory: MEMORY,
        cpu: { cores: 32, source: 'cgroup' },
        managers: 4,
      }),
    );

    await winsThreeTimes(registry, 'runner-large');

    await registry.stop();
  });

  it('全部が落としていても置き先を返す（0点でも断らない、を失敗の軸へも伸ばす）', async () => {
    const full = {
      limitBytes: 32_000_000_000,
      usedBytes: 32_000_000_000,
      source: 'cgroup',
    } as const;
    const registry = await registryOf(
      new FakeRunner('runner-burned-a', {
        memory: full,
        cpu: CPU,
        pids: { current: 1000, max: 1000 },
        managers: 3,
      }),
      new FakeRunner('runner-burned-b', {
        memory: full,
        cpu: CPU,
        pids: { current: 1000, max: 1000 },
        managers: 9,
      }),
    );
    for (let i = 0; i < 20; i += 1) {
      registry.noteManagerFailed('runner-burned-a');
      registry.noteManagerFailed('runner-burned-b');
    }

    const chosen = await registry.select({});
    expect(chosen.runnerId).toBe('runner-burned-a');

    await registry.stop();
  });
});

// 時計は注入する: `vi.useFakeTimers()` は名乗りを聞きに行く `setInterval` と `withDeadline` の `setTimeout` まで巻き込む。
describe('失敗の記憶が消える条件（#712）', () => {
  const MEMORY = {
    limitBytes: 8_000_000_000,
    usedBytes: 4_000_000_000,
    source: 'cgroup',
  } as const;
  const CPU = { cores: 8, source: 'cgroup' } as const;
  const PIDS = { current: 200, max: 1000 } as const;
  // `PLACEMENT_FAILURE_MEMORY_MS` を import しない: 値を動かす変更が両側で動いて緑のまま通る。
  const MEMORY_MS = 5 * 60_000;

  async function fleetWithClock(now: () => number) {
    const registry = createRunnerRegistry([], { now });
    for (const runner of [
      new FakeRunner('runner-burned', { memory: MEMORY, cpu: CPU, pids: PIDS, managers: 0 }),
      new FakeRunner('runner-healthy', { memory: MEMORY, cpu: CPU, pids: PIDS, managers: 2 }),
    ]) {
      await registry.register({ label: `http://${runner.runnerId}`, open: async () => runner });
    }
    return registry;
  }

  it('窓の内側では覚えていて、窓の外では忘れる（境目は「ちょうど」で忘れる側）', async () => {
    let clock = 1_000_000;
    const registry = await fleetWithClock(() => clock);

    registry.noteManagerFailed('runner-burned');
    registry.noteManagerFailed('runner-burned');
    expect((await registry.select({})).runnerId).toBe('runner-healthy');

    clock += MEMORY_MS - 1;
    expect((await registry.select({})).runnerId).toBe('runner-healthy');

    clock += 1;
    expect((await registry.select({})).runnerId).toBe('runner-burned');

    await registry.stop();
  });

  it('落ち続けるあいだは窓が更新される（連続して落ちる形は取りこぼさない）', async () => {
    let clock = 1_000_000;
    const registry = await fleetWithClock(() => clock);

    registry.noteManagerFailed('runner-burned');
    registry.noteManagerFailed('runner-burned');
    clock += MEMORY_MS - 1;
    registry.noteManagerFailed('runner-burned');
    registry.noteManagerFailed('runner-burned');
    clock += 2;

    expect((await registry.select({})).runnerId).toBe('runner-healthy');

    await registry.stop();
  });
});

class SwappableRunner extends FakeRunner {
  instanceId: string;

  constructor(runnerId: string, instanceId: string, report: RunnerPlacementResources) {
    super(runnerId, report);
    this.instanceId = instanceId;
  }

  async identity(): Promise<{ runnerId?: string; instanceId?: string }> {
    return { runnerId: this.runnerId, instanceId: this.instanceId };
  }
}

describe('器が入れ替わったら失敗の記憶を捨てる（#712）', () => {
  const MEMORY = {
    limitBytes: 8_000_000_000,
    usedBytes: 4_000_000_000,
    source: 'cgroup',
  } as const;
  const CPU = { cores: 8, source: 'cgroup' } as const;
  const PIDS = { current: 200, max: 1000 } as const;

  beforeEach(() => {
    vi.useFakeTimers();
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  it('入れ替わりを検知したら、その runnerId の失敗は数え直しになる', async () => {
    const burned = new SwappableRunner('runner-burned', 'boot-1', {
      memory: MEMORY,
      cpu: CPU,
      pids: PIDS,
      managers: 0,
    });
    const healthy = new SwappableRunner('runner-healthy', 'boot-1', {
      memory: MEMORY,
      cpu: CPU,
      pids: PIDS,
      managers: 2,
    });
    const registry = createRunnerRegistry();
    for (const runner of [burned, healthy]) {
      await registry.register({ label: `http://${runner.runnerId}`, open: async () => runner });
    }

    registry.noteManagerFailed('runner-burned');
    registry.noteManagerFailed('runner-burned');
    expect((await registry.select({})).runnerId).toBe('runner-healthy');

    await vi.advanceTimersByTimeAsync(30_000);
    expect((await registry.select({})).runnerId).toBe('runner-healthy');

    burned.instanceId = 'boot-2';
    await vi.advanceTimersByTimeAsync(30_000);

    expect((await registry.select({})).runnerId).toBe('runner-burned');

    await registry.stop();
  });
});

describe('runner_list の説明文が名乗る点数の式（#712 / C-3）', () => {
  const MEMORY = { limitBytes: 8_000_000_000, usedBytes: 4_000_000_000, source: 'cgroup' } as const;
  const CPU = { cores: 8, source: 'cgroup' } as const;
  const PIDS = { current: 200, max: 1000 } as const;

  async function twinFleet() {
    return registryOf(
      new FakeRunner('runner-a', { memory: MEMORY, cpu: CPU, pids: PIDS, managers: 1 }),
      new FakeRunner('runner-b', { memory: MEMORY, cpu: CPU, pids: PIDS, managers: 1 }),
    );
  }

  it('実装側: 失敗を数えると勝者が変わる（＝ failures は点数の項である）', async () => {
    const control = await twinFleet();
    expect((await control.select({})).runnerId).toBe('runner-a');
    await control.stop();

    const counted = await twinFleet();
    counted.noteManagerFailed('runner-a');
    counted.noteManagerFailed('runner-a');
    for (let i = 0; i < 3; i += 1) {
      expect((await counted.select({})).runnerId).toBe('runner-b');
    }
    await counted.stop();
  });

  it('説明文側: runner_list の説明文が、起動失敗も点数に効くことを名乗る', () => {
    const tools = createCloneTools({
      stores: createMemoryStores(),
      emit: () => undefined,
      memoryCause: () => 'clone',
      conversationId: () => undefined,
    });
    const description = tools.find((entry) => entry.name === 'runner_list')?.description ?? '';
    expect(
      /点数[\s\S]{0,200}失敗/.test(description),
      '【赤の意味】runner_list の説明文が名乗る点数の式に、起動失敗の項が無い。' +
        '実装の分母には `failures`（recentFailures）が在り、直上の歯がそのふるまいを固定している——' +
        'クローンは道具の説明しか読まないので、この式を読んで配置を予測すると外れる',
    ).toBe(true);
  });
});

describe('聞けなかった器は、聞けた器より前に出ない（#712 の残り半分）', () => {
  const MEMORY = {
    limitBytes: 32_000_000_000,
    usedBytes: 8_000_000_000,
    source: 'cgroup',
  } as const;
  const CPU = { cores: 8, source: 'cgroup' } as const;

  it('B1: 聞けなかった器が先に居て、後から聞けた器が来る（登録順 = unreachable, readable）⟹ 聞けた器が勝つ', async () => {
    const broken = new FakeRunner('runner-broken', { managers: 0 });
    broken.fails = true;
    const healthy = new FakeRunner('runner-healthy', { memory: MEMORY, cpu: CPU, managers: 0 });
    const registry = await registryOf(broken, healthy);

    expect((await registry.select({})).runnerId).toBe('runner-healthy');
    expect(broken.asked).toBe(1);

    await registry.stop();
  });

  it('B2: 聞けた器が先に居て、後から聞けなかった器が来る（登録順 = readable, unreachable）⟹ 聞けた器が勝つ', async () => {
    const healthy = new FakeRunner('runner-healthy', { memory: MEMORY, cpu: CPU, managers: 0 });
    const broken = new FakeRunner('runner-broken', { managers: 0 });
    broken.fails = true;
    const registry = await registryOf(healthy, broken);

    expect((await registry.select({})).runnerId).toBe('runner-healthy');

    await registry.stop();
  });

  it('B3 ⭐: 逆相関の艦隊では、聞けなかった器（平均の積 2.42）が実測した全器の積（各 0.8）を上回っていたが、直すと負ける', async () => {
    const unreachable = new FakeRunner('runner-unreachable', { managers: 0 });
    unreachable.fails = true;
    const roomyMemory = new FakeRunner('runner-roomy-memory', {
      memory: { limitBytes: 1000, usedBytes: 0, source: 'cgroup' },
      cpu: { cores: 8, source: 'cgroup' },
      pids: { current: 900, max: 1000 },
      managers: 0,
    });
    const roomyPids = new FakeRunner('runner-roomy-pids', {
      memory: { limitBytes: 1000, usedBytes: 900, source: 'cgroup' },
      cpu: { cores: 8, source: 'cgroup' },
      pids: { current: 0, max: 1000 },
      managers: 0,
    });
    const registry = await registryOf(unreachable, roomyMemory, roomyPids);

    const chosen = await registry.select({});
    expect(chosen.runnerId).not.toBe('runner-unreachable');
    expect(chosen.runnerId).toBe('runner-roomy-memory');

    await registry.stop();
  });

  it('B3b: 聞けなかった器は、聞けた器と点数が同点になっても前に出ない（艦隊が2台なら平均は報告した1台の写しになる）', async () => {
    const unreachable = new FakeRunner('runner-unreachable', { managers: 0 });
    unreachable.fails = true;
    const healthy = new FakeRunner('runner-healthy', {
      memory: { limitBytes: 32_000_000_000, usedBytes: 4_000_000_000, source: 'cgroup' },
      cpu: CPU,
      pids: { current: 150, max: 1000 },
      managers: 0,
    });
    const registry = await registryOf(unreachable, healthy);

    expect((await registry.select({})).runnerId).toBe('runner-healthy');

    await registry.stop();
  });

  it('B4: 全台が聞けなかった艦隊でも置き先を返す（断らない、の失敗軸版）', async () => {
    const first = new FakeRunner('runner-first', { managers: 0 });
    const second = new FakeRunner('runner-second', { managers: 3 });
    first.fails = true;
    second.fails = true;
    const registry = await registryOf(first, second);

    expect((await registry.select({})).runnerId).toBe('runner-first');

    await registry.stop();
  });

  it('B5: 聞けた器どうしの比較は1ミリも変わらない（unreachable を渡さない呼び出しの後方互換）', async () => {
    const registry = await registryOf(
      new FakeRunner('runner-burned', {
        memory: { limitBytes: 8_000_000_000, usedBytes: 4_000_000_000, source: 'cgroup' },
        cpu: CPU,
        pids: { current: 998, max: 1000 },
        managers: 1,
      }),
      new FakeRunner('runner-healthy', {
        memory: { limitBytes: 8_000_000_000, usedBytes: 4_000_000_000, source: 'cgroup' },
        cpu: CPU,
        pids: { current: 115, max: 1000 },
        managers: 3,
      }),
    );
    registry.noteManagerFailed('runner-burned');

    expect((await registry.select({})).runnerId).toBe('runner-healthy');

    await registry.stop();
  });

  it('B6: resources() が throw する器は「聞けなかった」に落ちる（失敗数の有利では取り戻せない）', async () => {
    const broken = new FakeRunner('runner-broken', { managers: 0 });
    broken.fails = true;
    const healthy = new FakeRunner('runner-healthy', { memory: MEMORY, cpu: CPU, managers: 0 });
    const registry = await registryOf(broken, healthy);
    registry.noteManagerFailed('runner-healthy');

    expect((await registry.select({})).runnerId).toBe('runner-healthy');
    expect(broken.asked).toBe(1);

    await registry.stop();
  });

  it('B7: resources() が PLACEMENT_PROBE_MS で期限切れになる器も「聞けなかった」に落ちる', async () => {
    // `PLACEMENT_PROBE_MS` を import しない: 値を動かす変更が両側で動いて緑のまま通る
    const PROBE_MS = 2_000;
    vi.useFakeTimers();
    try {
      const slow = new FakeRunner('runner-slow', { managers: 0 });
      slow.hangs = true;
      const healthy = new FakeRunner('runner-healthy', { memory: MEMORY, cpu: CPU, managers: 0 });
      const registry = await registryOf(slow, healthy);

      const pending = registry.select({});
      await vi.advanceTimersByTimeAsync(PROBE_MS + 1);
      expect((await pending).runnerId).toBe('runner-healthy');

      await registry.stop();
    } finally {
      vi.useRealTimers();
    }
  });

  it('B8: 口の無い実装／undefined を返す古い器は「聞けなかった」に落ちない（平均埋めのまま、締め出されない）', async () => {
    const broken = new FakeRunner('runner-broken', { managers: 0 });
    broken.fails = true;
    const legacy = new FakeRunner('runner-legacy');
    const registry = await registryOf(broken, legacy);

    expect((await registry.select({})).runnerId).toBe('runner-legacy');

    await registry.stop();
  });

  it('B9: 聞けなかった器でも recentFailures が落ちない（段の導入で #712 前半のふるまいを壊していない）', async () => {
    const burned = new FakeRunner('runner-burned', { managers: 0 });
    burned.fails = true;
    const quiet = new FakeRunner('runner-quiet', { managers: 0 });
    quiet.fails = true;
    const registry = await registryOf(burned, quiet);
    registry.noteManagerFailed('runner-burned');
    registry.noteManagerFailed('runner-burned');

    expect((await registry.select({})).runnerId).toBe('runner-quiet');

    await registry.stop();
  });
});

describe('配置の resources を配置の外へ渡す（RunnerRegistryOptions.onPlacementResources、#1394）', () => {
  it('配置が決まった直後に、#place が既に払った resources の結果をそのまま渡す（新しい往復を足さない）', async () => {
    const a = new FakeRunner('runner-a', { managers: 0, pids: { current: 900, max: 1000 } });
    const b = new FakeRunner('runner-b', { managers: 0, pids: { current: 100, max: 1000 } });
    const received: { runnerId: string; resources: RunnerPlacementResources | undefined }[][] = [];
    const registry = createRunnerRegistry([a, b], {
      onPlacementResources: (reports) => {
        received.push([...reports]);
      },
    });

    await registry.select({});

    expect(received).toHaveLength(1);
    expect(new Set(received[0]?.map((r) => r.runnerId))).toEqual(new Set(['runner-a', 'runner-b']));
    expect(received[0]?.find((r) => r.runnerId === 'runner-a')?.resources).toEqual(a.report);
    expect(received[0]?.find((r) => r.runnerId === 'runner-b')?.resources).toEqual(b.report);
    expect(a.asked).toBe(1);
    expect(b.asked).toBe(1);

    await registry.stop();
  });

  it('1台しか無ければ #place を経由しないので、onPlacementResources も呼ばれない（既知の制約）', async () => {
    const only = new FakeRunner('runner-only', { managers: 0, pids: { current: 999, max: 1000 } });
    let called = false;
    const registry = createRunnerRegistry([only], {
      onPlacementResources: () => {
        called = true;
      },
    });

    await registry.select({});

    expect(called).toBe(false);
    expect(only.asked).toBe(0);

    await registry.stop();
  });

  it('runnerId をまだ聞けていない器（runnerIdKnown が false）は渡さない（既定値との取り違えを避ける）', async () => {
    const known = new FakeRunner('runner-known', {
      managers: 0,
      pids: { current: 900, max: 1000 },
    });
    const unknownInner = new FakeRunner('runner-primary', {
      managers: 0,
      pids: { current: 900, max: 1000 },
    });
    const unknown = new Proxy(unknownInner, {
      get(target, prop, receiver) {
        if (prop === 'runnerIdKnown') return false;
        return Reflect.get(target, prop, receiver);
      },
    }) as FakeRunner;
    const received: { runnerId: string }[][] = [];
    const registry = createRunnerRegistry([known, unknown], {
      onPlacementResources: (reports) => {
        received.push([...reports]);
      },
    });

    await registry.select({});

    expect(received).toHaveLength(1);
    expect(received[0]?.map((r) => r.runnerId)).toEqual(['runner-known']);

    await registry.stop();
  });

  it('資源を聞けなかった（unreachable）器も、runnerId が分かっていれば resources: undefined として渡す（居なかったことにしない）', async () => {
    const broken = new FakeRunner('runner-broken', { managers: 0 });
    broken.fails = true;
    const healthy = new FakeRunner('runner-healthy', {
      managers: 0,
      pids: { current: 900, max: 1000 },
    });
    const received: { runnerId: string; resources: RunnerPlacementResources | undefined }[][] = [];
    const registry = createRunnerRegistry([broken, healthy], {
      onPlacementResources: (reports) => {
        received.push([...reports]);
      },
    });

    await registry.select({});

    expect(received).toHaveLength(1);
    const brokenReport = received[0]?.find((r) => r.runnerId === 'runner-broken');
    expect(brokenReport).toBeDefined();
    expect(brokenReport?.resources).toBeUndefined();

    await registry.stop();
  });
});
