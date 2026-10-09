import { describe, expect, it } from 'vitest';

import {
  createRunnerRegistry,
  describePidsSaturation,
  pidsSaturationFrom,
} from './runner-protocol.js';
import type {
  RunnerAnswerOutcome,
  RunnerClient,
  RunnerCredentialFingerprint,
  RunnerManagerState,
  RunnerPlacementResources,
  RunnerProfileFingerprint,
  RunnerProfileResult,
} from './runner-protocol.js';

class FakeRunner implements RunnerClient {
  readonly runnerId: string;
  readonly runnerIdKnown = true;
  readonly workspacePathKnown = true;
  readonly workspacePath = '/work/project';
  report: RunnerPlacementResources | undefined;
  fails = false;

  constructor(runnerId: string, report?: RunnerPlacementResources) {
    this.runnerId = runnerId;
    this.report = report;
  }

  async resources(): Promise<RunnerPlacementResources | undefined> {
    if (this.fails) throw new Error('資源を聞けない');
    return this.report;
  }
  async ping(): Promise<void> {}
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

const MEMORY = { limitBytes: 8_000_000_000, usedBytes: 4_000_000_000, source: 'cgroup' } as const;
const CPU = { cores: 8, source: 'cgroup' } as const;
/** 歯の側でも手で書く（実装の定数を import すると両側で同時に動いて緑のまま通る）。 */
const WINDOW_MS = 5 * 60_000;

async function fleet(now: () => number, ...runners: FakeRunner[]) {
  const registry = createRunnerRegistry([], { now });
  for (const runner of runners) {
    await registry.register({ label: `http://${runner.runnerId}`, open: async () => runner });
  }
  return registry;
}

describe('pidsSaturationFrom（判定。純関数）', () => {
  it('現在値が上限に達していれば飽和（材料は at-limit）', () => {
    expect(pidsSaturationFrom({ pids: { current: 1000, max: 1000 }, signs: [] })).toEqual({
      basis: [{ kind: 'at-limit', current: 1000, max: 1000 }],
      windowMs: WINDOW_MS,
    });
  });

  it('上限の1つ手前は飽和ではない（境目は current >= max）', () => {
    expect(pidsSaturationFrom({ pids: { current: 999, max: 1000 }, signs: [] })).toBeUndefined();
  });

  it('EAGAIN と fork 拒否の印は、現在値が読めなくても飽和にする（材料ごとに数える）', () => {
    expect(pidsSaturationFrom({ signs: ['eagain', 'eagain', 'fork-denied'] })?.basis).toEqual([
      { kind: 'eagain', count: 2 },
      { kind: 'fork-denied', count: 1 },
    ]);
  });

  it('材料が何も無いときは値ごと作らない（取れないことを「飽和ではない」に変えない）', () => {
    expect(pidsSaturationFrom({ signs: [] })).toBeUndefined();
    expect(pidsSaturationFrom({ pids: { current: 5, max: 0 }, signs: [] })).toBeUndefined();
  });

  it('describe は判定に使った材料を全部言う', () => {
    const text = describePidsSaturation(
      pidsSaturationFrom({ pids: { current: 1000, max: 1000 }, signs: ['eagain'] })!,
    );
    expect(text).toContain('pids 1000/1000 で上限に達している');
    expect(text).toContain('EAGAIN で失敗 1 回');
  });
});

describe('飽和した器は自動配置から外れる', () => {
  // 登録順は saturated → healthy。点数では saturated が勝つ諸元（managers 0 対 4）にして、
  // 「点数で負けたから外れた」ではなく「飽和だから外れた」ことを測る。
  const roomy = { memory: MEMORY, cpu: CPU, pids: { current: 100, max: 1000 } } as const;

  it('現在値が上限に達した器は、飽和していない器が居れば選ばれない', async () => {
    const registry = await fleet(
      () => 1_000_000,
      new FakeRunner('runner-saturated', {
        ...roomy,
        pids: { current: 1000, max: 1000 },
        managers: 0,
      }),
      new FakeRunner('runner-healthy', { ...roomy, managers: 4 }),
    );
    for (let i = 0; i < 3; i += 1) {
      expect((await registry.select({})).runnerId).toBe('runner-healthy');
    }
    await registry.stop();
  });

  it('対照: 飽和でなければ（999/1000）段は分かれず、点数の高い方が勝つ', async () => {
    const near = { ...roomy, pids: { current: 999, max: 1000 } } as const;
    const registry = await fleet(
      () => 1_000_000,
      new FakeRunner('runner-near', { ...near, managers: 0 }),
      new FakeRunner('runner-other', { ...near, managers: 4 }),
    );
    expect((await registry.select({})).runnerId).toBe('runner-near');
    await registry.stop();
  });

  it('EAGAIN の印がある器は、現在値が下がっていても窓の間は選ばれず、窓が過ぎれば戻る', async () => {
    let clock = 1_000_000;
    const registry = await fleet(
      () => clock,
      new FakeRunner('runner-burned', { ...roomy, managers: 0 }),
      new FakeRunner('runner-healthy', { ...roomy, managers: 4 }),
    );
    registry.notePidsSaturationSign?.('runner-burned', 'eagain');
    expect((await registry.select({})).runnerId).toBe('runner-healthy');

    clock += WINDOW_MS - 1;
    expect((await registry.select({})).runnerId).toBe('runner-healthy');

    clock += 1;
    expect((await registry.select({})).runnerId).toBe('runner-burned');
    await registry.stop();
  });

  it('fork 拒否の印も同じく外す', async () => {
    const registry = await fleet(
      () => 1_000_000,
      new FakeRunner('runner-burned', { ...roomy, managers: 0 }),
      new FakeRunner('runner-healthy', { ...roomy, managers: 4 }),
    );
    registry.notePidsSaturationSign?.('runner-burned', 'fork-denied');
    expect((await registry.select({})).runnerId).toBe('runner-healthy');
    await registry.stop();
  });

  it('資源を聞けなかった器でも、印があれば聞けた器より後ろに回る', async () => {
    const dead = new FakeRunner('runner-silent');
    dead.fails = true;
    const registry = await fleet(
      () => 1_000_000,
      dead,
      new FakeRunner('runner-healthy', { ...roomy, managers: 4 }),
    );
    registry.notePidsSaturationSign?.('runner-silent', 'eagain');
    expect((await registry.select({})).runnerId).toBe('runner-healthy');
    await registry.stop();
  });

  it('現在値が上限の器は、資源を聞けなかった器よりも後ろに回る（起こせないと分かっているため）', async () => {
    const silent = new FakeRunner('runner-silent');
    silent.fails = true;
    const registry = await fleet(
      () => 1_000_000,
      new FakeRunner('runner-full', { ...roomy, pids: { current: 1000, max: 1000 }, managers: 0 }),
      silent,
    );
    expect((await registry.select({})).runnerId).toBe('runner-silent');
    await registry.stop();
  });

  it('全台が飽和していても断らず、その中の最良を返す（#712・禁止2）', async () => {
    const registry = await fleet(
      () => 1_000_000,
      new FakeRunner('runner-a', { ...roomy, pids: { current: 1000, max: 1000 }, managers: 0 }),
      new FakeRunner('runner-b', { ...roomy, managers: 4 }),
    );
    registry.notePidsSaturationSign?.('runner-b', 'eagain');
    for (let i = 0; i < 3; i += 1) {
      expect((await registry.select({})).runnerId).toBe('runner-b');
    }
    await registry.stop();
  });

  it('飽和の印を1つも知らせない艦隊では、配置は以前と変わらない', async () => {
    const registry = await fleet(
      () => 1_000_000,
      new FakeRunner('runner-a', { ...roomy, managers: 0 }),
      new FakeRunner('runner-b', { ...roomy, managers: 4 }),
    );
    expect((await registry.select({})).runnerId).toBe('runner-a');
    await registry.stop();
  });
});

describe('pidsSaturationOf（名簿が覚えている材料）', () => {
  it('何も無ければ undefined。印を知らせると材料つきで返り、窓で忘れる', async () => {
    let clock = 1_000_000;
    const registry = await fleet(() => clock, new FakeRunner('runner-a', {}));
    expect(registry.pidsSaturationOf?.('runner-a')).toBeUndefined();

    registry.notePidsSaturationSign?.('runner-a', 'eagain');
    registry.notePidsSaturationSign?.('runner-a', 'eagain');
    expect(registry.pidsSaturationOf?.('runner-a')?.basis).toEqual([{ kind: 'eagain', count: 2 }]);
    expect(registry.pidsSaturationOf?.('runner-other')).toBeUndefined();

    clock += WINDOW_MS;
    expect(registry.pidsSaturationOf?.('runner-a')).toBeUndefined();
    await registry.stop();
  });

  it('渡した現在値が上限に達していれば at-limit を足す', async () => {
    const registry = await fleet(() => 1_000_000, new FakeRunner('runner-a', {}));
    expect(registry.pidsSaturationOf?.('runner-a', { current: 1000, max: 1000 })?.basis).toEqual([
      { kind: 'at-limit', current: 1000, max: 1000 },
    ]);
    expect(registry.pidsSaturationOf?.('runner-a', { current: 15, max: 1000 })).toBeUndefined();
    await registry.stop();
  });

  it('配置で聞いた現在値が上限なら覚え、次に下がっていたら忘れる（manager_start の応答の材料）', async () => {
    const a = new FakeRunner('runner-a', {
      memory: MEMORY,
      cpu: CPU,
      pids: { current: 1000, max: 1000 },
      managers: 0,
    });
    const b = new FakeRunner('runner-b', {
      memory: MEMORY,
      cpu: CPU,
      pids: { current: 10, max: 1000 },
      managers: 0,
    });
    const registry = await fleet(() => 1_000_000, a, b);
    await registry.select({});
    expect(registry.pidsSaturationOf?.('runner-a')?.basis).toEqual([
      { kind: 'at-limit', current: 1000, max: 1000 },
    ]);
    expect(registry.pidsSaturationOf?.('runner-b')).toBeUndefined();

    a.report = { ...a.report, pids: { current: 15, max: 1000 } };
    await registry.select({});
    expect(registry.pidsSaturationOf?.('runner-a')).toBeUndefined();
    await registry.stop();
  });
});
