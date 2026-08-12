import { describe, expect, it } from 'vitest';

import { measureCapacity } from './capacity.js';
import type {
  RunnerCapacity,
  RunnerClient,
  RunnerHealth,
  RunnerManagerState,
} from './runner-protocol.js';
import { createRunnerRegistry } from './runner-registry.js';

/**
 * 名簿の検証（roadmap M5）。
 *
 * ここで固定したいのは M5 の受け入れ基準と、その地雷である。
 *
 * - runner を2台以上登録できる（基準1）
 * - 落ちた器が分かり、生きている器へ寄せられる（基準4 の入口）
 * - 配置の材料は**実行環境の資源だけ**であり、**定員はどこにも無い**（基準5 / 地雷）
 *
 * 器の実装は問わないので、ここでは `RunnerClient` の口だけを持つ偽物を使う。
 */
interface FakeRunner extends RunnerClient {
  /** 生死を切り替える（落とすと health が投げる）。 */
  down: boolean;
  capacity: RunnerCapacity;
  healthCalls: number;
}

function fakeRunner(runnerId: string, capacity: Partial<RunnerCapacity> = {}): FakeRunner {
  const runner: FakeRunner = {
    runnerId,
    workspacePath: `/work/${runnerId}`,
    down: false,
    healthCalls: 0,
    capacity: {
      cpuCount: 4,
      load1m: 0,
      totalMemoryBytes: 8_000_000_000,
      freeMemoryBytes: 6_000_000_000,
      activeManagers: 0,
      uptimeSeconds: 100,
      ...capacity,
    },
    async health(): Promise<RunnerHealth> {
      runner.healthCalls += 1;
      if (runner.down) throw new Error(`${runnerId} へ届かない`);
      return {
        ok: true,
        runnerId,
        workspacePath: runner.workspacePath,
        managers: runner.capacity.activeManagers,
        pendingEvents: 0,
        capacity: runner.capacity,
      };
    },
    async connect() {},
    async start() {},
    async resume() {},
    async send() {},
    async answer() {
      return true;
    },
    async stop() {
      return true;
    },
    async list(): Promise<RunnerManagerState[]> {
      return [];
    },
    async transcript() {
      return null;
    },
    async close() {},
  };
  return runner;
}

/** 時計を手で進める（生存判定の猶予を実時間で待たない）。 */
function clock(start = 1_000_000) {
  let at = start;
  return {
    now: () => at,
    advance(ms: number) {
      at += ms;
    },
  };
}

describe('RunnerRegistry — 登録と生存判定', () => {
  it('2台以上を登録し、それぞれを id で引ける（M5 受け入れ基準1）', async () => {
    const a = fakeRunner('runner-a');
    const b = fakeRunner('runner-b');
    const registry = createRunnerRegistry([a, b]);

    expect((await registry.list()).map((runner) => runner.runnerId)).toEqual([
      'runner-a',
      'runner-b',
    ]);
    expect(await registry.get('runner-b')).toBe(b);
    expect(await registry.get('runner-x')).toBeNull();
  });

  it('あとから登録できる（runner を増やせること自体が M5 のゴール）', async () => {
    const registry = createRunnerRegistry([fakeRunner('runner-a')]);
    registry.register(fakeRunner('runner-b'));

    expect((await registry.list()).length).toBe(2);
    // 同じ相手を二重に登録しない（二重に繋ぐと同じ確認が2回降りる）
    const again = await registry.get('runner-b');
    if (again === null) throw new Error('登録した runner が引けない');
    registry.register(again);
    expect((await registry.list()).length).toBe(2);
  });

  it('まだ一度も聞いていない器は生きているものとして扱う（初回の委譲が宛先を失わない）', async () => {
    const registry = createRunnerRegistry([fakeRunner('runner-a')]);
    expect(registry.states()[0]?.alive).toBe(true);
    expect(registry.states()[0]?.lastSeenAt).toBeNull();
  });

  it('名乗りが返らなくなった器を、猶予を過ぎてから落ちたと見る', async () => {
    const time = clock();
    const a = fakeRunner('runner-a');
    const registry = createRunnerRegistry([a], {
      now: time.now,
      heartbeatIntervalMs: 1_000,
      livenessTimeoutMs: 3_000,
    });

    await registry.heartbeat();
    expect(registry.states()[0]?.alive).toBe(true);

    a.down = true;
    time.advance(1_000);
    await registry.heartbeat();
    // 1回の取りこぼしでは動かさない（生きている器から仕事を引き剥がさない）
    expect(registry.states()[0]).toMatchObject({ alive: true, misses: 1 });

    time.advance(3_000);
    await registry.heartbeat();
    const state = registry.states()[0];
    expect(state?.alive).toBe(false);
    expect(state?.misses).toBe(2);
    expect(state?.lastError).toContain('届かない');
    expect((await registry.live()).length).toBe(0);
  });

  it('落ちたと見えた瞬間に一度だけ知らせる（フェイルオーバーの契機）', async () => {
    const time = clock();
    const a = fakeRunner('runner-a');
    const registry = createRunnerRegistry([a], {
      now: time.now,
      heartbeatIntervalMs: 1_000,
      livenessTimeoutMs: 1_000,
    });
    const lost: string[] = [];
    registry.onLost((state) => lost.push(state.runnerId));

    await registry.heartbeat();
    a.down = true;
    time.advance(2_000);
    await registry.heartbeat();
    expect(lost).toEqual(['runner-a']);

    // 落ち続けていても鳴らし直さない（同じ仕事を何度も掴み直さないため）
    time.advance(2_000);
    await registry.heartbeat();
    expect(lost).toEqual(['runner-a']);

    // 戻ってくれば、また生きている側に入る
    a.down = false;
    time.advance(1_000);
    await registry.heartbeat();
    expect(registry.states()[0]?.alive).toBe(true);
    expect((await registry.live()).map((runner) => runner.runnerId)).toEqual(['runner-a']);
  });

  it('1台だけ聞き直せる（周期を待たずに宛先の生死を確かめる）', async () => {
    const time = clock();
    const a = fakeRunner('runner-a');
    const b = fakeRunner('runner-b');
    const registry = createRunnerRegistry([a, b], { now: time.now });

    const state = await registry.probe('runner-a');
    expect(state).toMatchObject({ runnerId: 'runner-a', alive: true });
    expect(a.healthCalls).toBe(1);
    expect(b.healthCalls).toBe(0);
    expect(await registry.probe('runner-x')).toBeNull();
  });

  /**
   * **接続を拒む器より、黙り込む器の方が危ない。**
   *
   * 拒まれるなら例外はすぐ返るが、TCP は繋がったまま応答が無い・パケットが落ちる・
   * half-open のまま残る相手では、期限を置かない限り約束が解けない。生存判定も
   * 配置も全 runner を待ち合わせるので、1台の沈黙が名簿ごと止める。
   */
  it('応答しない1台が、生存判定と配置を止めない（M5 受け入れ基準5）', async () => {
    const time = clock();
    const silent = fakeRunner('runner-silent');
    // 例外も返さず、ただ黙る器
    silent.health = () => new Promise<RunnerHealth>(() => undefined);
    const healthy = fakeRunner('runner-healthy');
    const registry = createRunnerRegistry([silent, healthy], {
      now: time.now,
      probeTimeoutMs: 30,
    });

    // 期限内に終わる（ここが返らなければ、落ちたことに誰も気づかない）
    const states = await registry.heartbeat();
    expect(states.find((state) => state.runnerId === 'runner-silent')?.alive).toBe(false);
    expect(states.find((state) => state.runnerId === 'runner-healthy')?.alive).toBe(true);
    expect(states.find((state) => state.runnerId === 'runner-silent')?.lastError).toContain('期限');

    // 新しい委譲も、黙っている器を待たずに健康な器へ置ける
    time.advance(20_000);
    const chosen = await registry.select();
    expect(chosen.runnerId).toBe('runner-healthy');

    // 落ちたことも1回だけ鳴る（期限切れは「まだ分からない」ではなく失敗である）
    const lost: string[] = [];
    const registry2 = createRunnerRegistry([silent], { now: time.now, probeTimeoutMs: 30 });
    registry2.onLost((state) => lost.push(state.runnerId));
    await registry2.heartbeat();
    expect(lost).toEqual(['runner-silent']);
  });
});

describe('RunnerRegistry — 配置（資源で決める。定員は置かない）', () => {
  it('空きメモリと負荷の大きい器を選ぶ', async () => {
    const busy = fakeRunner('runner-busy', { load1m: 4, freeMemoryBytes: 1_000_000_000 });
    const idle = fakeRunner('runner-idle', { load1m: 0, freeMemoryBytes: 7_000_000_000 });
    const registry = createRunnerRegistry([busy, idle]);

    expect((await registry.select()).runnerId).toBe('runner-idle');
  });

  it('大きい器はセッションをより多く引き受ける（CPU あたりの密度で見る）', async () => {
    // 16 コアの器に2本走っていても、2 コアの器に1本より密度は低い。
    const big = fakeRunner('runner-big', { cpuCount: 16, activeManagers: 2 });
    const small = fakeRunner('runner-small', { cpuCount: 2, activeManagers: 1 });
    const registry = createRunnerRegistry([big, small]);

    expect((await registry.select()).runnerId).toBe('runner-big');
  });

  it('続けて起こした委譲が同じ器に固まらない（観測の遅れを見込みで埋める）', async () => {
    const a = fakeRunner('runner-a');
    const b = fakeRunner('runner-b');
    const registry = createRunnerRegistry([a, b], { heartbeatIntervalMs: 60_000 });

    // 資源の報告が同じなら、置いた本数の少ない方へ移っていく。
    const placed = [
      (await registry.select()).runnerId,
      (await registry.select()).runnerId,
      (await registry.select()).runnerId,
      (await registry.select()).runnerId,
    ];
    expect(placed.filter((id) => id === 'runner-a').length).toBe(2);
    expect(placed.filter((id) => id === 'runner-b').length).toBe(2);
  });

  it('落ちている器は選ばないが、全部落ちて見えても置き先は返す（能力を削らない）', async () => {
    const time = clock();
    const a = fakeRunner('runner-a');
    const b = fakeRunner('runner-b');
    const registry = createRunnerRegistry([a, b], {
      now: time.now,
      heartbeatIntervalMs: 1_000,
      livenessTimeoutMs: 1_000,
    });

    a.down = true;
    time.advance(2_000);
    await registry.heartbeat();
    expect((await registry.select()).runnerId).toBe('runner-b');

    // 生存確認が全部失敗しても「委譲できない」にはしない。見えないのが観測側の
    // 失敗であることもあり、そのときは投げた先で本物の失敗が返る。
    b.down = true;
    time.advance(2_000);
    await registry.heartbeat();
    await expect(registry.select()).resolves.toBeDefined();
  });

  it('除外した器へは戻さない（落ちた器から移すため）', async () => {
    const registry = createRunnerRegistry([fakeRunner('runner-a'), fakeRunner('runner-b')]);
    expect((await registry.select({ exclude: ['runner-a'] })).runnerId).toBe('runner-b');
  });

  it('詰まっていても拒まない。1台も登録されていないときだけ投げる（M5 受け入れ基準5）', async () => {
    // どれだけ抱えていても、名簿は「もう置けない」と言わない。
    const loaded = fakeRunner('runner-loaded', {
      cpuCount: 1,
      load1m: 64,
      activeManagers: 128,
      freeMemoryBytes: 0,
    });
    const registry = createRunnerRegistry([loaded]);
    expect((await registry.select()).runnerId).toBe('runner-loaded');

    const empty = createRunnerRegistry([]);
    await expect(empty.select()).rejects.toThrow(/登録されていない/);
  });

  it('資源を報告しない器も配置から落とさない（報告が無いことは能力の欠落ではない）', async () => {
    const silent = fakeRunner('runner-silent');
    silent.health = async () => ({
      ok: true as const,
      runnerId: 'runner-silent',
      workspacePath: '/work',
      managers: 0,
      pendingEvents: 0,
    });
    const registry = createRunnerRegistry([silent]);

    await registry.heartbeat();
    expect(registry.states()[0]?.alive).toBe(true);
    expect(registry.states()[0]?.capacity).toBeUndefined();
    expect((await registry.select()).runnerId).toBe('runner-silent');
  });
});

describe('measureCapacity — 器の資源', () => {
  it('cgroup の上限があればホストの量より優先する（コンテナで実態から外れない）', () => {
    const capacity = measureCapacity(2, {
      cpuCount: () => 64,
      load1m: () => 1.5,
      totalMemoryBytes: () => 64_000_000_000,
      freeMemoryBytes: () => 32_000_000_000,
      uptimeSeconds: () => 12,
      readText: (path) => {
        if (path.endsWith('cpu.max')) return '200000 100000\n';
        if (path.endsWith('memory.max')) return '2147483648\n';
        if (path.endsWith('memory.current')) return '536870912\n';
        return null;
      },
    });

    expect(capacity).toEqual({
      cpuCount: 2,
      load1m: 1.5,
      totalMemoryBytes: 2_147_483_648,
      freeMemoryBytes: 2_147_483_648 - 536_870_912,
      activeManagers: 2,
      uptimeSeconds: 12,
    });
  });

  it('cgroup が無い / 上限なしならホストの量を使う', () => {
    const capacity = measureCapacity(0, {
      cpuCount: () => 8,
      load1m: () => 0,
      totalMemoryBytes: () => 16_000_000_000,
      freeMemoryBytes: () => 8_000_000_000,
      uptimeSeconds: () => 1,
      readText: (path) => (path.endsWith('cpu.max') ? 'max 100000\n' : null),
    });

    expect(capacity.cpuCount).toBe(8);
    expect(capacity.totalMemoryBytes).toBe(16_000_000_000);
    expect(capacity.freeMemoryBytes).toBe(8_000_000_000);
  });

  it('端数の CPU 割り当てを丸めない（0.5 コアを1コアと見ない）', () => {
    const capacity = measureCapacity(0, {
      readText: (path) => (path.endsWith('cpu.max') ? '50000 100000' : null),
    });
    expect(capacity.cpuCount).toBeCloseTo(0.5);
  });
});
